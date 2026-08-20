import { describe, expect, it, vi } from 'vitest';

import { executeToolCall } from '../../../src/tools/pipeline.js';
import {
  createRegistry,
  type PermissionDecision,
  type ToolCtx,
} from '../../../src/tools/registry.js';
import {
  askUserTool,
  type AskUserAnswers,
  type AskUserInput,
} from '../../../src/tools/askUser/askUser.js';

const registry = createRegistry([askUserTool]);

function call(
  input: unknown,
  requestPermission?: ToolCtx['requestPermission'],
) {
  return executeToolCall(
    registry,
    { id: 'ask-user-1', name: 'ask_user', input },
    {
      runDir: '/tmp/unused-ask-user',
      ...(requestPermission === undefined ? {} : { requestPermission }),
    },
  );
}

function allowWith(answers: AskUserAnswers) {
  return async (request: { input: unknown }): Promise<PermissionDecision> => ({
    behavior: 'allow',
    updatedInput: { ...(request.input as object), answers },
  });
}

describe('ask_user tool', () => {
  it('is an exclusive interactive tool with the ask_user name', () => {
    expect(askUserTool.name).toBe('ask_user');
    expect(askUserTool.requiresUserInteraction).toBe(true);
    expect(askUserTool.getAccess({ question: 'Continue?' })).toEqual({
      reads: [],
      writes: [],
      exclusive: true,
    });
  });

  it('accepts optional context and exactly two to four unique options', () => {
    const base = {
      question: 'Which account should Sherlock inspect?',
      context: 'The report lists two authorized test accounts.',
    };
    expect(askUserTool.inputSchema.safeParse(base).success).toBe(true);
    expect(
      askUserTool.inputSchema.safeParse({
        ...base,
        options: [
          { label: 'Primary', description: 'The current test account' },
          { label: 'Secondary' },
        ],
      }).success,
    ).toBe(true);
    expect(
      askUserTool.inputSchema.safeParse({
        ...base,
        options: ['A', 'B', 'C', 'D'].map((label) => ({ label })),
      }).success,
    ).toBe(true);
  });

  it('rejects malformed, legacy, ambiguous, and overly long questions', () => {
    const invalidInputs = [
      {},
      { question: '   ' },
      { question: 'x'.repeat(501) },
      { question: 'Pick one', context: '   ' },
      { question: 'Pick one', options: [{ label: 'Only one' }] },
      {
        question: 'Pick one',
        options: ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label })),
      },
      {
        question: 'Pick one',
        options: [{ label: 'Same' }, { label: 'Same' }],
      },
      { question: 'Pick one', multi_select: true },
      { question: 'Pick one', header: 'Legacy' },
    ];

    for (const input of invalidInputs) {
      expect(askUserTool.inputSchema.safeParse(input).success).toBe(false);
    }
  });

  it('passes question, context, and options through the permission bridge', async () => {
    const input: AskUserInput = {
      question: 'May I continue with the selected account?',
      context: 'The page is waiting at an authenticated handoff.',
      options: [
        { label: 'Continue', description: 'Use the account already selected' },
        { label: 'Stop', description: 'Leave the account untouched' },
      ],
    };
    const requestPermission = vi.fn(async (request) => ({
      behavior: 'allow' as const,
      updatedInput: {
        ...(request.input as object),
        answers: {
          chosen: ['Continue'],
          freeText: 'stop before submitting anything',
        },
      },
    }));

    const result = await call(input, requestPermission);

    expect(result).toEqual({
      toolCallId: 'ask-user-1',
      isError: false,
      content:
        'User chose: "Continue". User answered: "stop before submitting anything"',
    });
    expect(requestPermission).toHaveBeenCalledWith({
      toolName: 'ask_user',
      input,
    });
  });

  it('returns a free-text answer or explicit guidance for an empty answer', async () => {
    const freeText = await call(
      { question: 'What should I do next?' },
      allowWith({ chosen: [], freeText: '  collect only public rows  ' }),
    );
    expect(freeText).toMatchObject({
      isError: false,
      content: 'User answered: "collect only public rows"',
    });

    const empty = await call(
      { question: 'Anything else?' },
      allowWith({ chosen: [], freeText: '  ' }),
    );
    expect(empty.isError).toBe(false);
    expect(empty.content).toMatch(/submitted no answer/i);
    expect(empty.content).toMatch(/report the limitation/i);
  });

  it.each([
    ['denied', 'The user declined this action.'],
    ['cancelled', 'The run was cancelled while waiting for the user.'],
  ])('returns model-readable permission feedback when %s', async (_case, feedback) => {
    const result = await call(
      { question: 'Continue?' },
      async () => ({ behavior: 'deny', feedback }),
    );

    expect(result).toEqual({
      toolCallId: 'ask-user-1',
      isError: true,
      errorKind: 'permission_denied',
      content: feedback,
    });
  });

  it('fails closed with actionable feedback in a headless environment', async () => {
    const result = await call({ question: 'Can you sign in?' });

    expect(result).toMatchObject({
      isError: true,
      errorKind: 'permission_denied',
    });
    expect(result.content).toMatch(/does not support/i);
    expect(result.content).toMatch(/report the blocker/i);
  });

  it('fails as an execution error if an allow decision omits answers', async () => {
    const result = await call(
      { question: 'Continue?' },
      async (request) => ({
        behavior: 'allow',
        updatedInput: request.input,
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      errorKind: 'execution_error',
    });
    expect(result.content).toMatch(/valid answer.*permission gate/i);
  });
});

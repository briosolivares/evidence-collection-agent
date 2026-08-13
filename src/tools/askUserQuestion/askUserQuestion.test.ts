import { describe, expect, it } from 'vitest';

import { executeToolCall } from '../pipeline.js';
import {
  createRegistry,
  type PermissionDecision,
  type ToolCtx,
  type ToolDef,
} from '../registry.js';
import { askUserQuestionTool, type AskUserAnswers } from './askUserQuestion.js';

const registry = createRegistry([askUserQuestionTool as ToolDef]);

/** Execute one ask_user_question call through the pipeline with a fake
 * user whose dialog resolves the given answers. */
function ask(input: unknown, answers?: AskUserAnswers) {
  const ctx: ToolCtx = {
    runDir: '/tmp/unused',
    requestPermission: async (request): Promise<PermissionDecision> => ({
      behavior: 'allow',
      updatedInput: { ...(request.input as object), answers },
    }),
  };
  return executeToolCall(
    registry,
    { id: 'ask-1', name: 'ask_user_question', input },
    ctx,
  );
}

describe('ask_user_question tool', () => {
  it('returns chosen options as natural-language prose', async () => {
    const result = await ask(
      {
        question: 'Which account should I use?',
        options: [{ label: 'Test account' }, { label: 'Skip login' }],
      },
      { chosen: ['Test account'] },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe('User chose: "Test account".');
  });

  it('returns free text as a quoted user answer', async () => {
    const result = await ask(
      { question: 'Tell me when you have finished logging in.' },
      { chosen: [], freeText: 'ok done, there was an email code but I handled it' },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe(
      'User answered: "ok done, there was an email code but I handled it"',
    );
  });

  it('combines chosen options with an added free-text note', async () => {
    const result = await ask(
      {
        question: 'How should I proceed?',
        options: [{ label: 'Continue' }, { label: 'Stop' }],
        multi_select: true,
      },
      { chosen: ['Continue', 'Stop'], freeText: 'continue but stop at page 2' },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe(
      'User chose: "Continue", "Stop". ' +
        'User answered: "continue but stop at page 2"',
    );
  });

  it('handles an empty submission with explicit guidance', async () => {
    const result = await ask(
      { question: 'Anything to add?' },
      { chosen: [] },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('no answer');
    expect(result.content).toContain('Continue without');
  });

  it('errors when executed without gate-provided answers', async () => {
    const ctx: ToolCtx = {
      runDir: '/tmp/unused',
      requestPermission: async (request) => ({
        behavior: 'allow',
        // A broken UI that forgot to merge answers.
        updatedInput: request.input,
      }),
    };
    const result = await executeToolCall(
      registry,
      { id: 'ask-2', name: 'ask_user_question', input: { question: 'Hm?' } },
      ctx,
    );

    expect(result).toMatchObject({ isError: true, errorKind: 'execution_error' });
    expect(result.content).toContain('permission gate');
  });

  it('bounds the schema: at most 4 options, header of at most 12 chars', async () => {
    const tooManyOptions = await ask({
      question: 'Pick one?',
      options: [
        { label: 'a' },
        { label: 'b' },
        { label: 'c' },
        { label: 'd' },
        { label: 'e' },
      ],
    });
    expect(tooManyOptions).toMatchObject({
      isError: true,
      errorKind: 'invalid_input',
    });

    const longHeader = await ask({
      question: 'Pick one?',
      header: 'much-too-long-header',
    });
    expect(longHeader).toMatchObject({
      isError: true,
      errorKind: 'invalid_input',
    });

    const missingQuestion = await ask({});
    expect(missingQuestion).toMatchObject({
      isError: true,
      errorKind: 'invalid_input',
    });
  });

  it('is marked interactive and fails closed without a user', async () => {
    expect(askUserQuestionTool.requiresUserInteraction).toBe(true);

    const result = await executeToolCall(
      registry,
      { id: 'ask-3', name: 'ask_user_question', input: { question: 'Hm?' } },
      { runDir: '/tmp/unused' },
    );

    expect(result).toMatchObject({
      isError: true,
      errorKind: 'permission_denied',
    });
    expect(result.content).toContain('Proceed without it');
  });
});

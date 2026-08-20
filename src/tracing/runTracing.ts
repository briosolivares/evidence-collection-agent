import { Buffer } from 'node:buffer';

import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider, startObservation } from '@langfuse/tracing';
import { TraceFlags, type SpanContext } from '@opentelemetry/api';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { knownModelUsageFromError, type ModelDriver } from '../model/modelDriver.js';
import { modelMessagesLogView } from '../model/logView.js';
import type { ModelRole } from '../run/runBudget.js';
import { inlineImageTraceView, isInlineImageToolOutput } from '../tools/inlineImage.js';
import type { ToolCtx, ToolDef, ToolRegistry } from '../tools/registry.js';

const RUN_OBSERVATION_NAME = 'run-evidence-agent';
const MODEL_OBSERVATION_NAME = 'call-model';

/** Optional dependencies and environment for one run's tracing. */
export interface CreateRunTracingOptions {
  /** Span processor to use instead of constructing the production Langfuse
   * exporter. Primarily useful for local exporters and tests; the caller
   * retains ownership, so close flushes but does not shut it down. */
  spanProcessor?: SpanProcessor;
  /** Environment containing Langfuse configuration; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Tracing decorators and lifecycle controls scoped to one agent run. */
export interface RunTracing {
  /** Announce the durable run directory as soon as composition creates or
   * resumes it. Optional so non-UI tracing implementations remain source
   * compatible; the TUI uses it to cover tool-free terminal paths. */
  announceRunDir?(runDir: string): void;
  /** Return a model driver with one generation observation per invocation. */
  wrapModelDriver(driver: ModelDriver, model: string, role: ModelRole): ModelDriver;
  /** Return a registry with one tool observation per executor invocation. */
  wrapRegistry(registry: ToolRegistry): ToolRegistry;
  /** Run an operation inside the run's root agent observation. */
  traceRun<T>(taskText: string, operation: () => Promise<T>): Promise<T>;
  /** Release tracing resources and remove the isolated provider. */
  close(): Promise<void>;
}

/**
 * Create failure-isolated tracing decorators for one evidence-agent run.
 *
 * @param options - an optional span processor, or an environment containing
 *   both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY (and optionally
 *   LANGFUSE_BASE_URL); without either complete configuration, tracing is a
 *   clean no-op
 * @returns run-scoped decorators that preserve model, tool, and run results
 *   and errors; tracing setup, observation updates, export, and shutdown never
 *   make the underlying work fail, and close removes the isolated provider
 */
export function createRunTracing(options: CreateRunTracingOptions = {}): RunTracing {
  const env = options.env ?? process.env;
  if (
    options.spanProcessor === undefined &&
    (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY)
  ) {
    return createNoopRunTracing();
  }

  let provider: NodeTracerProvider | undefined;
  try {
    const spanProcessor =
      options.spanProcessor ??
      new LangfuseSpanProcessor({
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        ...(env.LANGFUSE_BASE_URL === undefined ? {} : { baseUrl: env.LANGFUSE_BASE_URL }),
      });
    provider = new NodeTracerProvider({ spanProcessors: [spanProcessor] });
    setLangfuseTracerProvider(provider);
  } catch {
    safelyClearProvider();
    safelyStartShutdown(provider);
    return createNoopRunTracing();
  }

  return createEnabledRunTracing(provider, options.spanProcessor === undefined);
}

function createNoopRunTracing(): RunTracing {
  return {
    wrapModelDriver: (driver) => driver,
    wrapRegistry: (registry) => registry,
    traceRun: (_taskText, operation) => operation(),
    close: async () => {},
  };
}

function createEnabledRunTracing(
  provider: NodeTracerProvider,
  shutdownOnClose: boolean,
): RunTracing {
  let enabled = true;
  let activeRootContext: SpanContext | undefined;
  let turnCount = 0;
  const toolsUsed = new Set<string>();

  const wrapModelDriver = (driver: ModelDriver, model: string, role: ModelRole): ModelDriver => ({
    async generate(options) {
      if (!enabled) return driver.generate(options);

      if (role === 'worker') turnCount += 1;
      const generation = safelyStartObservation(() =>
        startObservation(
          MODEL_OBSERVATION_NAME,
          {
            input: modelMessagesLogView(options.messages),
            model,
            metadata: { role },
          },
          {
            asType: 'generation',
            ...(activeRootContext === undefined ? {} : { parentSpanContext: activeRootContext }),
          },
        ),
      );

      try {
        const accepted = await driver.generate(options);
        safelyObserve(() =>
          generation?.update({
            output: accepted.response,
            usageDetails: usageDetails(accepted.usage),
          }),
        );
        return accepted;
      } catch (error) {
        const usage = knownModelUsageFromError(error);
        if (usage !== undefined) {
          safelyObserve(() =>
            generation?.update({
              usageDetails: usageDetails(usage),
            }),
          );
        }
        safelyRecordError(generation, error);
        throw error;
      } finally {
        safelyObserve(() => generation?.end());
      }
    },
  });

  const wrapRegistry = (registry: ToolRegistry): ToolRegistry => {
    if (!enabled) return registry;

    const wrappedRegistry = new Map<string, ToolDef>();
    for (const [name, tool] of registry) {
      wrappedRegistry.set(name, {
        ...tool,
        execute: async (input: unknown, ctx: ToolCtx) => {
          if (!enabled) return tool.execute(input, ctx);

          toolsUsed.add(tool.name);
          const observation = safelyStartObservation(() =>
            startObservation(
              `execute-${tool.name}`,
              { input },
              {
                asType: 'tool',
                ...(activeRootContext === undefined
                  ? {}
                  : { parentSpanContext: activeRootContext }),
              },
            ),
          );

          try {
            const output = await tool.execute(input, ctx);
            const resultBytes = getResultSizeBytes(output);
            const observedOutput = isInlineImageToolOutput(output)
              ? inlineImageTraceView(output)
              : output;
            safelyObserve(() =>
              observation?.update({
                output: observedOutput,
                ...(resultBytes === undefined ? {} : { metadata: { resultBytes } }),
              }),
            );
            return output;
          } catch (error) {
            safelyRecordError(observation, error);
            throw error;
          } finally {
            safelyObserve(() => observation?.end());
          }
        },
      });
    }
    return wrappedRegistry;
  };

  const traceRun = async <T>(taskText: string, operation: () => Promise<T>): Promise<T> => {
    if (!enabled) return operation();

    const startedMs = Date.now();
    const root = safelyStartObservation(() =>
      startObservation(RUN_OBSERVATION_NAME, { input: taskText }, { asType: 'agent' }),
    );
    activeRootContext =
      root === undefined
        ? undefined
        : {
            traceId: root.traceId,
            spanId: root.id,
            traceFlags: TraceFlags.SAMPLED,
            isRemote: false,
          };

    try {
      const result = await operation();
      safelyObserve(() =>
        root?.update({
          output: result,
          metadata: runMetadata(startedMs, turnCount, toolsUsed),
        }),
      );
      return result;
    } catch (error) {
      safelyObserve(() =>
        root?.update({
          metadata: runMetadata(startedMs, turnCount, toolsUsed),
        }),
      );
      safelyRecordError(root, error);
      throw error;
    } finally {
      activeRootContext = undefined;
      safelyObserve(() => root?.end());
    }
  };

  return {
    wrapModelDriver,
    wrapRegistry,
    traceRun,
    close: async () => {
      if (!enabled) return;
      enabled = false;
      safelyClearProvider();
      try {
        await provider.forceFlush();
      } catch {
        // Best effort only; shutdown still gets a chance to release resources.
      }
      if (!shutdownOnClose) return;
      try {
        await provider.shutdown();
      } catch {
        // Tracing cleanup must not alter the completed run's outcome.
      } finally {
        safelyClearProvider();
      }
    },
  };
}

function runMetadata(
  startedMs: number,
  turnCount: number,
  toolsUsed: ReadonlySet<string>,
): Record<string, unknown> {
  return {
    turnCount,
    toolsUsed: [...toolsUsed],
    latencyMs: Date.now() - startedMs,
  };
}

function usageDetails(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Record<string, number> {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function getResultSizeBytes(output: unknown): number | undefined {
  if (isInlineImageToolOutput(output)) {
    return Buffer.byteLength(output.text, 'utf8') + output.bytes.byteLength;
  }
  try {
    const normalized =
      typeof output === 'string' ? output : output === undefined ? '' : JSON.stringify(output);
    return normalized === undefined ? undefined : Buffer.byteLength(normalized, 'utf8');
  } catch {
    return undefined;
  }
}

function safelyStartObservation<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

function safelyObserve(operation: () => unknown): void {
  try {
    operation();
  } catch {
    // A telemetry update is never part of the application result.
  }
}

function safelyRecordError(
  observation:
    | { update(attributes: { level?: 'ERROR'; statusMessage?: string }): unknown }
    | undefined,
  error: unknown,
): void {
  safelyObserve(() =>
    observation?.update({
      level: 'ERROR',
      statusMessage: error instanceof Error ? error.message : String(error),
    }),
  );
}

function safelyClearProvider(): void {
  try {
    setLangfuseTracerProvider(null);
  } catch {
    // Provider teardown is best effort.
  }
}

function safelyStartShutdown(provider: NodeTracerProvider | undefined): void {
  if (provider === undefined) return;
  try {
    void provider.shutdown().catch(() => {});
  } catch {
    // A failed tracing setup must still degrade to a synchronous no-op.
  }
}

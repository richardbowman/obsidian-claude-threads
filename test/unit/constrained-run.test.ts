import { describe, expect, it, vi } from 'vitest';
import { createConstrainedQueryRunner } from '../../src/ConstrainedRun';

const input = { prompt: 'fixture', options: { model: 'haiku', systemInstructions: 'Return a grade.', maxTurns: 1 as const, maxBudgetUsd: 0.1, timeoutMs: 500 }, signal: new AbortController().signal };

describe('constrained query runner', () => {
  it('enforces the closed input-only SDK option set and returns sanitized accounting', async () => {
    const query = vi.fn(async function* (request: any) {
      expect(request.options).toMatchObject({ tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
        settingSources: [], skills: [], plugins: [], persistSession: false, permissionMode: 'dontAsk', maxTurns: 1,
        enableFileCheckpointing: false, systemPrompt: 'Return a grade.' });
      expect(request.options.resume).toBeUndefined();
      expect(request.options.continue).toBeUndefined();
      yield { type: 'result', subtype: 'success', is_error: false, result: 'pass', usage: { input_tokens: 3, output_tokens: 1 }, total_cost_usd: 0.02, duration_ms: 10, num_turns: 1 };
    });
    const run = createConstrainedQueryRunner(() => ({ claudeBinaryPath: '/claude', extraEnv: '', provider: 'claude' }), query as any);
    await expect(run(input)).resolves.toEqual({ output: 'pass', usage: { inputTokens: 3, outputTokens: 1, costUsd: 0.02, durationMs: 10, turns: 1 } });
  });

  it('fails closed if the SDK ever emits a tool-use block', async () => {
    const query = async function* () { yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: { file_path: '/secret' } }] } }; };
    const run = createConstrainedQueryRunner(() => ({ claudeBinaryPath: '/claude', extraEnv: '', provider: 'claude' }), query as any);
    await expect(run(input)).rejects.toThrow('Constraint violation');
  });

  it('propagates cancellation to the SDK AbortController', async () => {
    let sdkSignal: AbortSignal | undefined;
    const query = async function* (request: any) { sdkSignal = request.options.abortController.signal; await new Promise<void>((resolve) => sdkSignal!.addEventListener('abort', () => resolve(), { once: true })); throw new Error('aborted'); };
    const controller = new AbortController();
    const run = createConstrainedQueryRunner(() => ({ claudeBinaryPath: '/claude', extraEnv: '', provider: 'claude' }), query as any);
    const pending = run({ ...input, signal: controller.signal });
    await vi.waitFor(() => expect(sdkSignal).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(sdkSignal?.aborted).toBe(true);
  });
});

import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { createConstrainedQueryRunner } from '../../src/ConstrainedRun';

describe('constrained query isolation', () => {
  it('uses a private empty cwd, minimal environment, closed SDK options, and removes the cwd', async () => {
    let captured: any;
    const runQuery = vi.fn((input: any) => {
      captured = input;
      return (async function* () {
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
      })();
    });
    const runner = createConstrainedQueryRunner(() => ({ claudeBinaryPath: '/bin/claude', extraEnv: 'SECRET_BAIT=leak\nANTHROPIC_DEBUG_MARKER=leak', provider: 'cli' } as any), runQuery as any);
    const result = await runner({ prompt: 'fixture', options: { model: 'haiku', systemInstructions: 'grade', maxTurns: 1, maxBudgetUsd: 0.1, timeoutMs: 1_000 }, signal: new AbortController().signal });
    expect(result.output).toBe('ok');
    expect(fs.existsSync(captured.options.cwd)).toBe(false);
    expect(path.basename(captured.options.cwd)).toMatch(/^agent-threads-constrained-/);
    expect(captured.options.env).toEqual(expect.objectContaining({ CLAUDE_AGENT_SDK_CLIENT_APP: 'agent-threads/constrained-runs' }));
    expect(captured.options.env).not.toHaveProperty('SECRET_BAIT');
    expect(captured.options.env).not.toHaveProperty('ANTHROPIC_DEBUG_MARKER');
    expect(captured.options.env.HOME).toBe(captured.options.cwd);
    expect(captured.options.env.CLAUDE_CONFIG_DIR).toBe(captured.options.cwd);
    expect(captured.options).toMatchObject({ tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], skills: [], plugins: [], persistSession: false, permissionMode: 'dontAsk', maxTurns: 1, enableFileCheckpointing: false });
  });

  it('rejects tool use and oversized output while cleaning the private cwd', async () => {
    let cwd = '';
    const toolRunner = createConstrainedQueryRunner(() => ({} as any), ((input: any) => {
      cwd = input.options.cwd;
      return (async function* () { yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/bait' } }] } }; })();
    }) as any);
    await expect(toolRunner({ prompt: 'x', options: { model: 'haiku', systemInstructions: 'x', maxTurns: 1, maxBudgetUsd: 0.1, timeoutMs: 100 }, signal: new AbortController().signal })).rejects.toThrow(/Constraint violation/);
    expect(fs.existsSync(cwd)).toBe(false);

    const outputRunner = createConstrainedQueryRunner(() => ({} as any), (() => (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'x'.repeat(1_000_001), usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    })()) as any);
    await expect(outputRunner({ prompt: 'x', options: { model: 'haiku', systemInstructions: 'x', maxTurns: 1, maxBudgetUsd: 0.1, timeoutMs: 100 }, signal: new AbortController().signal })).rejects.toThrow(/output exceeds/);
  });
});

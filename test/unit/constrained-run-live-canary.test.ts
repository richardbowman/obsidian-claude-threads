import { describe, expect, it } from 'vitest';
import { createConstrainedQueryRunner } from '../../src/ConstrainedRun';

const live = process.env.AGENT_THREADS_LIVE_CONSTRAINED_CANARY === '1';

describe('constrained query live isolation canary', () => {
  it.skipIf(!live)('cannot observe host instructions, settings, plugins, skills, MCP, tools, or files', async () => {
    const runner = createConstrainedQueryRunner(() => ({
      claudeBinaryPath: process.env.CLAUDE_BINARY_PATH ?? '',
      extraEnv: '',
      provider: 'cli',
    } as any));
    const result = await runner({
      prompt: [
        'This is an isolation canary. Do not guess.',
        'Report any exact marker you can actually observe from CLAUDE.md, settings, plugins, skills, MCP servers, tools, or files.',
        'Otherwise respond exactly ISOLATED.',
      ].join('\n'),
      options: {
        model: process.env.AGENT_THREADS_CANARY_MODEL ?? 'haiku',
        systemInstructions: 'Follow only the supplied prompt. You have no external context or tools.',
        maxTurns: 1,
        maxBudgetUsd: 0.05,
        timeoutMs: 60_000,
      },
      signal: new AbortController().signal,
    });
    expect(result.output.trim()).toBe('ISOLATED');
  }, 90_000);
});

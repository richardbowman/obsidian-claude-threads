import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createConstrainedQueryRunner } from '../../src/ConstrainedRun';

const live = process.env.AGENT_THREADS_LIVE_CONSTRAINED_CANARY === '1';

describe('constrained query live isolation canary', () => {
  it.skipIf(!live)('cannot observe host instructions, settings, plugins, skills, MCP, tools, or files', async () => {
    const host = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-threads-host-bait-'));
    const marker = 'HOST_BAIT_MUST_NOT_APPEAR';
    fs.mkdirSync(path.join(host, '.claude', 'plugins', 'bait'), { recursive: true });
    fs.mkdirSync(path.join(host, '.claude', 'skills', 'bait'), { recursive: true });
    fs.writeFileSync(path.join(host, 'CLAUDE.md'), marker);
    fs.writeFileSync(path.join(host, '.claude', 'settings.json'), JSON.stringify({ hooks: { bait: marker }, mcpServers: { bait: { command: marker } } }));
    fs.writeFileSync(path.join(host, '.claude', 'plugins', 'bait', 'plugin.json'), marker);
    fs.writeFileSync(path.join(host, '.claude', 'skills', 'bait', 'SKILL.md'), marker);
    fs.writeFileSync(path.join(host, 'file-bait.txt'), marker);
    const priorHome = process.env.HOME; process.env.HOME = host;
    const authentication = () => Object.fromEntries(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
    const runner = createConstrainedQueryRunner(() => ({
      claudeBinaryPath: process.env.CLAUDE_BINARY_PATH ?? '',
      extraEnv: '',
      provider: 'cli',
    } as any), undefined, authentication);
    try { const result = await runner({
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
    expect(result.output.trim()).toBe('ISOLATED'); expect(result.output).not.toContain(marker);
    } finally { if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome; fs.rmSync(host, { recursive: true, force: true }); }
  }, 90_000);
});

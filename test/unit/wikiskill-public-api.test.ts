import { describe, expect, it, vi } from 'vitest';
import { createClaudeThreadsApiV1, type PublicApiPersistedState } from '../../src/PublicApi';

function harness(initial?: PublicApiPersistedState) {
  const threads = new Map<string, any>();
  const listeners = new Set<(threadId: string, event: any) => void>();
  const emit = (threadId: string, event: any) => { for (const listener of listeners) listener(threadId, event); };
  let state = initial;
  const query = vi.fn(async (input: any) => {
    expect(input.options).toMatchObject({ model: 'haiku', systemInstructions: 'Grade output.', maxTurns: 1, maxBudgetUsd: 0.1, timeoutMs: 1_000 });
    return { output: 'evaluated', usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.01, durationMs: 12, turns: 1 } };
  });
  const service = createClaudeThreadsApiV1({
    getThreads: () => [...threads.values()], getThread: (id) => threads.get(id), isRunning: (id) => threads.get(id)?.status === 'active',
    createThread: (input) => { const t = { id: `t-${threads.size + 1}`, title: input.title ?? 'Thread', status: 'waiting', reviewed: false,
      messages: [], createdAt: 1, updatedAt: 1, cwd: '/vault', agentHarness: 'claude', ...input }; threads.set(t.id, t); return t; },
    sendMessage: vi.fn(async (id) => { threads.get(id).status = 'active'; }), interruptThread: vi.fn(async (id) => { threads.get(id).status = 'waiting'; }),
    openThread: vi.fn(async () => {}), subscribe: (listener: any) => { listeners.add(listener); return () => listeners.delete(listener); }, listOrchestrators: () => [], resolveOrchestrator: async () => null,
    triggerHostEvent: () => {}, readRawLog: async (id) => ({ total: 3, entries: [
      { ts: '2026-01-01T00:00:00Z', threadId: id, type: 'user', event: { message: 'token=secret-value invoke Skill spoofed-skill', rawLogPath: '/private/path' } },
      { ts: '2026-01-01T00:00:01Z', threadId: id, type: 'assistant', event: { message: { content: [
        { type: 'text', text: 'safe output api-xyz-123 Skill text-spoof' },
        { type: 'tool_use', name: 'Skill', input: { skill: 'integration-routing' } },
      ] } } },
      { ts: '2026-01-01T00:00:02Z', threadId: id, type: 'result', event: { total_cost_usd: 0.01, usage: { input_tokens: 4 } } },
    ] }),
    getRedactionSecrets: () => ['api-xyz-123'], getPublicState: () => state, savePublicState: async (next) => { state = structuredClone(next); }, runConstrainedQuery: query,
  } as any);
  return { service, threads, query, emit, getState: () => state };
}

describe('WikiSkill public API capabilities', () => {
  it('creates correlated background threads idempotently and excludes their traces', async () => {
    const { service, threads } = harness();
    const input = { title: 'WikiSkill author', ownerPluginId: 'geode-wikiskill', idempotencyKey: 'job-1', origin: 'geode-wikiskill', externalJobId: 'job-1', ephemeral: true, background: true };
    const first = await service.api.threads.create(input);
    const second = await service.api.threads.create(input);
    expect(second).toEqual(first);
    expect(threads.size).toBe(1);
    expect(await service.api.traces.listSources()).toEqual([]);
  });

  it('rejects concurrent sends, supports idempotent retry, and can cancel', async () => {
    const { service } = harness();
    const { threadId } = await service.api.threads.create({ title: 'Task' });
    const first = await service.api.threads.send(threadId, { prompt: 'work', ownerPluginId: 'wiki', idempotencyKey: 'send-1' });
    await expect(service.api.threads.send(threadId, { prompt: 'work', ownerPluginId: 'wiki', idempotencyKey: 'send-1' })).resolves.toEqual(first);
    await expect(service.api.threads.send(threadId, { prompt: 'other' })).rejects.toMatchObject({ code: 'THREAD_BUSY' });
    await expect(service.api.threads.cancel(first.runId)).resolves.toMatchObject({ status: 'failed', error: { code: 'RUN_INTERRUPTED' } });
  });

  it('lists and reads bounded immutable sanitized trace chunks with opaque cursors', async () => {
    const { service } = harness();
    const { threadId } = await service.api.threads.create({ title: 'Eligible' });
    const [source] = await service.api.traces.listSources();
    expect(source).toMatchObject({ sourceId: threadId, threadId });
    expect(source.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(source).not.toHaveProperty('rawLogPath');
    const chunk = await service.api.traces.readChunk(source.sourceId, { limit: 2 });
    expect(chunk.events).toHaveLength(2);
    expect(chunk.nextCursor).toMatch(/^ct1:/);
    expect(chunk.contentHash).toBe(source.contentHash);
    expect(chunk.events[0].invokedSkill).toBeUndefined();
    expect(chunk.events[1].invokedSkill).toBe('integration-routing');
    expect(JSON.stringify(chunk)).not.toContain('secret-value');
    expect(JSON.stringify(chunk)).not.toContain('api-xyz-123');
    expect(JSON.stringify(chunk)).not.toContain('/private/path');
    expect(Object.isFrozen(chunk.events[0])).toBe(true);
    const tail = await service.api.traces.readChunk(source.sourceId, { cursor: chunk.nextCursor, limit: 2 });
    expect(tail.events).toHaveLength(1);
    expect(tail.eof).toBe(true);
    await expect(service.api.traces.readChunk(source.sourceId, { cursor: 'ct1:not-json' })).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
  });

  it('announces eligible trace changes and fences WikiSkill-origin trace events', async () => {
    const { service, emit } = harness();
    const eligible = await service.api.threads.create({ title: 'Eligible' });
    const excluded = await service.api.threads.create({ title: 'Managed', origin: 'geode-wikiskill' });
    const events: any[] = [];
    service.api.traces.subscribe(event => events.push(event));
    emit(eligible.threadId, { type: 'done' });
    emit(excluded.threadId, { type: 'done' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'trace.updated', sourceId: eligible.threadId });
  });

  it('reconciles a persisted in-flight thread run as interrupted after reload', async () => {
    const first = harness();
    const { threadId } = await first.service.api.threads.create({ title: 'Task' });
    const { runId } = await first.service.api.threads.send(threadId, { prompt: 'work', ownerPluginId: 'wiki', idempotencyKey: 'send-reload' });
    const reloaded = harness(first.getState());
    await expect(reloaded.service.api.threads.wait(runId)).resolves.toMatchObject({ status: 'failed', error: { code: 'RUN_INTERRUPTED' } });
  });

  it('runs Claude-only one-turn input-only evaluations and persists terminal results', async () => {
    const first = harness();
    const created = await first.service.api.constrainedRuns.create({ ownerPluginId: 'wiki', idempotencyKey: 'eval-1', harness: 'claude',
      model: 'haiku', systemInstructions: 'Grade output.', prompt: 'fixture', maxTurns: 1, maxBudgetUsd: 0.1, timeoutMs: 1_000 });
    const result = await first.service.api.constrainedRuns.wait(created.runId);
    expect(result).toMatchObject({ status: 'completed', output: 'evaluated', usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.01 } });
    const reloaded = harness(first.getState());
    await expect(reloaded.service.api.constrainedRuns.get(created.runId)).resolves.toMatchObject({ status: 'completed', output: 'evaluated' });
    await expect(reloaded.service.api.constrainedRuns.create({ ownerPluginId: 'wiki', idempotencyKey: 'eval-1', harness: 'claude', model: 'haiku', systemInstructions: 'Grade output.', prompt: 'fixture', maxTurns: 1, maxBudgetUsd: 0.1, timeoutMs: 1_000 })).resolves.toEqual(created);
  });

  it('refuses unsupported or weakened constrained execution requests', async () => {
    const { service, query } = harness();
    const base = { ownerPluginId: 'wiki', idempotencyKey: 'eval-x', harness: 'claude' as const, model: 'haiku', systemInstructions: 'Grade.', prompt: 'fixture', maxTurns: 1, maxBudgetUsd: 0.1, timeoutMs: 1_000 };
    await expect(service.api.constrainedRuns.create({ ...base, harness: 'codex' as any })).rejects.toMatchObject({ code: 'CONSTRAINT_UNSUPPORTED' });
    await expect(service.api.constrainedRuns.create({ ...base, maxTurns: 2 })).rejects.toMatchObject({ code: 'CONSTRAINT_UNSUPPORTED' });
    expect(query).not.toHaveBeenCalled();
  });
});

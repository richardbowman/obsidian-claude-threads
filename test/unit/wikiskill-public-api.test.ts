import { describe, expect, it, vi } from 'vitest';
import { createClaudeThreadsApiV1, type PublicApiPersistedState } from '../../src/PublicApi';

function harness(initial?: PublicApiPersistedState, suppliedEntries?: any[], registeredSkills: readonly string[] = ['integration-routing']) {
  const threads = new Map<string, any>();
  const listeners = new Set<(threadId: string, event: any) => void>();
  const emit = (threadId: string, event: any) => { for (const listener of listeners) listener(threadId, event); };
  let state = initial;
  const query = vi.fn(async (input: any) => {
    expect(input.options).toMatchObject({ model: 'haiku', systemInstructions: 'Grade output.', maxTurns: 1, maxBudgetUsd: 0.1, timeoutMs: 1_000 });
    return { output: 'evaluated', usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.01, durationMs: 12, turns: 1 } };
  });
  const rawEntries = (id: string) => suppliedEntries ?? [
    { ts: '2026-01-01T00:00:00Z', threadId: id, type: 'user', event: { message: 'token=secret-value invoke Skill spoofed-skill', rawLogPath: '/private/path' } },
    { ts: '2026-01-01T00:00:01Z', threadId: id, type: 'assistant', event: { message: { content: [
      { type: 'text', text: 'safe output api-xyz-123 Skill text-spoof' },
      { type: 'tool_use', id: 'skill-1', name: 'Skill', input: { skill: 'integration-routing' } },
    ] } } },
    { ts: '2026-01-01T00:00:02Z', threadId: id, type: 'user', event: { message: { content: [{ type: 'tool_result', tool_use_id: 'skill-1', content: 'loaded' }] } } },
    { ts: '2026-01-01T00:00:03Z', threadId: id, type: 'result', event: { total_cost_usd: 0.01, usage: { input_tokens: 4 } } },
  ];
  let traceRevision = 'revision-1';
  const getTraceMetadata = vi.fn(async (id: string) => threads.has(id) ? ({ sourceId: id, revision: traceRevision, contentHash: 'a'.repeat(64), byteLength: rawEntries(id).length, updatedAt: 3 }) : null);
  const readTraceChunk = vi.fn(async (id: string, options: any) => {
    const entries = rawEntries(id).slice(options.byteOffset, options.byteOffset + options.limit);
    const nextByteOffset = options.byteOffset + entries.length;
    return { metadata: await getTraceMetadata(id), entries, nextByteOffset, nextEventIndex: options.eventIndex + entries.length, eof: nextByteOffset >= rawEntries(id).length, bytesRead: entries.length, readCalls: 1 };
  });
  const service = createClaudeThreadsApiV1({
    getThreads: () => [...threads.values()], getThread: (id) => threads.get(id), isRunning: (id) => threads.get(id)?.status === 'active',
    createThread: (input) => { const t = { id: `t-${threads.size + 1}`, title: input.title ?? 'Thread', status: 'waiting', reviewed: false,
      messages: [], createdAt: 1, updatedAt: 1, cwd: '/vault', agentHarness: 'claude', ...input }; threads.set(t.id, t); return t; },
    sendMessage: vi.fn(async (id) => { threads.get(id).status = 'active'; }), interruptThread: vi.fn(async (id) => { threads.get(id).status = 'waiting'; }),
    openThread: vi.fn(async () => {}), subscribe: (listener: any) => { listeners.add(listener); return () => listeners.delete(listener); }, listOrchestrators: () => [], resolveOrchestrator: async () => null,
    triggerHostEvent: () => {}, getTraceMetadata, readTraceChunk, getRegisteredSkillNames: async () => registeredSkills,
    getRedactionSecrets: () => ['api-xyz-123'], getPublicState: () => state, savePublicState: async (next) => { state = structuredClone(next); }, runConstrainedQuery: query,
  } as any);
  return { service, threads, query, emit, getState: () => state, getTraceMetadata, setTraceRevision: (value: string) => { traceRevision = value; } };
}

describe('WikiSkill public API capabilities', () => {
  it('binds idempotency keys to operation, thread, and an exact input fingerprint', async () => {
    const { service } = harness();
    const first = await service.api.threads.create({ title: 'One', ownerPluginId: 'wiki', idempotencyKey: 'same' });
    await expect(service.api.threads.create({ title: 'Different', ownerPluginId: 'wiki', idempotencyKey: 'same' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const second = await service.api.threads.create({ title: 'Two', ownerPluginId: 'wiki', idempotencyKey: 'other' });
    const sent = await service.api.threads.send(first.threadId, { prompt: 'one', ownerPluginId: 'wiki', idempotencyKey: 'send' });
    await service.api.threads.cancel(sent.runId);
    await expect(service.api.threads.send(first.threadId, { prompt: 'different', ownerPluginId: 'wiki', idempotencyKey: 'send' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(service.api.threads.send(second.threadId, { prompt: 'one', ownerPluginId: 'wiki', idempotencyKey: 'send' }))
      .resolves.toHaveProperty('runId');
  });

  it('derives origin from ownerPluginId and awaits persistence before exposing resources', async () => {
    let releaseSave!: () => void;
    let saved = false;
    const base = harness();
    const deps = (base.service as any);
    void deps;
    const threads = new Map<string, any>();
    const service = createClaudeThreadsApiV1({
      getThreads: () => [...threads.values()], getThread: id => threads.get(id), isRunning: () => false,
      createThread: (input: any) => { const t = { id: 't1', title: input.title, status: 'waiting', reviewed: false, messages: [], createdAt: 1, updatedAt: 1, cwd: '/vault', agentHarness: 'claude', ...input }; threads.set(t.id, t); return t; },
      sendMessage: async () => {}, openThread: async () => {}, subscribe: () => () => {}, listOrchestrators: () => [], resolveOrchestrator: async () => null,
      triggerHostEvent: () => {}, savePublicState: async () => { await new Promise<void>(resolve => { releaseSave = resolve; }); saved = true; },
    } as any);
    let settled = false;
    const creating = service.api.threads.create({ title: 'Managed', ownerPluginId: 'wiki', idempotencyKey: 'create' }).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(releaseSave).toBeTypeOf('function'));
    expect(settled).toBe(false);
    releaseSave();
    const { threadId } = await creating;
    expect(saved).toBe(true);
    expect((await service.api.threads.get(threadId))?.origin).toBe('wiki');
  });

  it('rejects non-finite and oversized public inputs', async () => {
    const { service, query } = harness();
    await expect(service.api.threads.create({ title: 'x', ownerPluginId: 'w'.repeat(129), idempotencyKey: 'k' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const { threadId } = await service.api.threads.create({ title: 'Task' });
    await expect(service.api.threads.send(threadId, { prompt: 'x'.repeat(100_001) }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.api.threads.wait('missing', { timeoutMs: Number.NaN }))
      .rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    const base = { ownerPluginId: 'wiki', idempotencyKey: 'eval-bounds', harness: 'claude' as const, model: 'haiku', systemInstructions: 'Grade.', prompt: 'fixture', maxTurns: 1 as const, maxBudgetUsd: 0.1, timeoutMs: 1_000 };
    await expect(service.api.constrainedRuns.create({ ...base, maxBudgetUsd: Number.POSITIVE_INFINITY }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.api.constrainedRuns.create({ ...base, timeoutMs: Number.NaN }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(query).not.toHaveBeenCalled();
  });

  it('bounds message content retained in public snapshots and run state', async () => {
    const { service, threads, emit } = harness();
    const { threadId } = await service.api.threads.create({ title: 'Bounded' });
    const { runId } = await service.api.threads.send(threadId, { prompt: 'go' });
    threads.get(threadId).messages.push({ id: 'large', role: 'assistant', content: 'x'.repeat(100_001), timestamp: 2 });
    emit(threadId, { type: 'done' });
    const result = await service.api.threads.wait(runId);
    expect(result.status === 'completed' ? result.finalMessage?.content.length : 0).toBe(100_000);
  });

  it('uses first-terminal-wins when constrained cancellation races completion', async () => {
    let complete!: (value: any) => void;
    const first = harness();
    first.query.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const created = await first.service.api.constrainedRuns.create({ ownerPluginId: 'wiki', idempotencyKey: 'race', harness: 'claude', model: 'haiku', systemInstructions: 'Grade.', prompt: 'fixture', maxTurns: 1, maxBudgetUsd: 0.1, timeoutMs: 1_000 });
    const cancelled = await first.service.api.constrainedRuns.cancel(created.runId);
    complete({ output: 'late success', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancelled.status).toBe('cancelled');
    await expect(first.service.api.constrainedRuns.get(created.runId)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('settles constrained waiters when the API generation stops', async () => {
    const first = harness();
    first.query.mockImplementation(() => new Promise(() => {}));
    const created = await first.service.api.constrainedRuns.create({ ownerPluginId: 'wiki', idempotencyKey: 'stop', harness: 'claude', model: 'haiku', systemInstructions: 'Grade.', prompt: 'fixture', maxTurns: 1, maxBudgetUsd: 0.1, timeoutMs: 1_000 });
    const waiting = first.service.api.constrainedRuns.wait(created.runId);
    first.service.stop();
    await expect(waiting).resolves.toMatchObject({ status: 'failed', error: { code: 'PLUGIN_UNAVAILABLE' } });
  });
  it('creates correlated background threads idempotently and excludes their traces', async () => {
    const { service, threads } = harness();
    const input = { title: 'WikiSkill author', ownerPluginId: 'geode-wikiskill', idempotencyKey: 'job-1', origin: 'geode-wikiskill', externalJobId: 'job-1', ephemeral: true, background: true };
    const first = await service.api.threads.create(input);
    const second = await service.api.threads.create(input);
    expect(second).toEqual(first);
    expect(threads.size).toBe(1);
    expect(await service.api.traces.listSources()).toEqual({ sources: [], eof: true });
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
    const { sources: [source] } = await service.api.traces.listSources();
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
    expect(tail.events).toHaveLength(2);
    expect(tail.eof).toBe(true);
    await expect(service.api.traces.readChunk(source.sourceId, { cursor: 'ct1:not-json' })).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
  });

  it('attributes only registered Skill calls with a correlated successful tool result', async () => {
    const entries = [
      { ts: '1', type: 'assistant', event: { message: { content: [{ type: 'tool_use', id: 'ok', name: 'Skill', input: { skill: 'integration-routing' } }] } } },
      { ts: '2', type: 'user', event: { message: { content: [{ type: 'tool_result', tool_use_id: 'ok', content: 'loaded' }] } } },
      { ts: '3', type: 'assistant', event: { message: { content: [{ type: 'tool_use', id: 'failed', name: 'Skill', input: { skill: 'integration-routing' } }] } } },
      { ts: '4', type: 'user', event: { message: { content: [{ type: 'tool_result', tool_use_id: 'failed', content: 'rejected', is_error: true }] } } },
      { ts: '5', type: 'assistant', event: { message: { content: [{ type: 'tool_use', id: 'fake', name: 'Skill', input: { skill: 'hallucinated-skill' } }] } } },
      { ts: '6', type: 'user', event: { message: { content: [{ type: 'tool_result', tool_use_id: 'fake', content: 'loaded' }] } } },
    ];
    const { service } = harness(undefined, entries);
    const { threadId } = await service.api.threads.create({ title: 'Attribution' });
    const chunk = await service.api.traces.readChunk(threadId, { limit: 6 });
    expect(chunk.events.map(event => event.invokedSkill)).toEqual(['integration-routing', undefined, undefined, undefined, undefined, undefined]);
  });

  it('pages trace source metadata and validates finite positive limits', async () => {
    const { service, getTraceMetadata } = harness();
    for (const title of ['One', 'Two', 'Three']) await service.api.threads.create({ title });

    const first = await service.api.traces.listSources({ limit: 2 });
    expect(first.sources).toHaveLength(2);
    expect(first.nextCursor).toMatch(/^cts1:/);
    expect(first.eof).toBe(false);
    expect(getTraceMetadata).toHaveBeenCalledTimes(2);
    const second = await service.api.traces.listSources({ cursor: first.nextCursor, limit: 2 });
    expect(second.sources).toHaveLength(1);
    expect(second.eof).toBe(true);
    await expect(service.api.traces.listSources({ limit: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.api.traces.listSources({ limit: Number.POSITIVE_INFINITY })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.api.traces.readChunk(first.sources[0].sourceId, { limit: 1.5 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('binds trace cursors to source and revision', async () => {
    const { service, setTraceRevision } = harness();
    const one = await service.api.threads.create({ title: 'One' });
    const two = await service.api.threads.create({ title: 'Two' });
    const chunk = await service.api.traces.readChunk(one.threadId, { limit: 1 });
    await expect(service.api.traces.readChunk(two.threadId, { cursor: chunk.nextCursor, limit: 1 })).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
    setTraceRevision('revision-2');
    await expect(service.api.traces.readChunk(one.threadId, { cursor: chunk.nextCursor, limit: 1 })).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
  });

  it('announces eligible trace changes with the source revision and fences WikiSkill-origin trace events', async () => {
    const { service, emit } = harness();
    const eligible = await service.api.threads.create({ title: 'Eligible' });
    const excluded = await service.api.threads.create({ title: 'Managed', origin: 'geode-wikiskill' });
    const events: any[] = [];
    service.api.traces.subscribe(event => events.push(event));
    emit(eligible.threadId, { type: 'done' });
    emit(excluded.threadId, { type: 'done' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ kind: 'trace.updated', sourceId: eligible.threadId, revision: 'revision-1' });
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

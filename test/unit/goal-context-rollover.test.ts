import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessSessionOptions } from '../../src/HarnessSession';
import { DEFAULT_SETTINGS } from '../../src/types';

type FakeSession = ReturnType<typeof makeFakeSession>;

const mock = vi.hoisted(() => ({
  sessions: [] as any[],
  blockNextStart: false,
  releaseStart: null as null | (() => void),
  rejectStart: null as null | ((error: Error) => void),
}));

function makeFakeSession(harness: 'claude' | 'codex') {
  let options: HarnessSessionOptions | undefined;
  let turnInFlight = false;
  let pendingPermission = false;
  return {
    harness,
    sent: [] as string[],
    sentUserMessageUuids: [] as (string | undefined)[],
    starts: [] as HarnessSessionOptions[],
    closeCount: 0,
    get turnInFlight() { return turnInFlight; },
    set turnInFlight(value: boolean) { turnInFlight = value; },
    get hasPendingPermission() { return pendingPermission; },
    set hasPendingPermission(value: boolean) { pendingPermission = value; },
    get cwd() { return options?.cwd; },
    canIdleReap: () => !turnInFlight && !pendingPermission,
    async start(next: HarnessSessionOptions) {
      options = next;
      this.starts.push(next);
      if (mock.blockNextStart) {
        mock.blockNextStart = false;
        await new Promise<void>((resolve, reject) => {
          mock.releaseStart = resolve;
          mock.rejectStart = reject;
        });
      }
    },
    send(text: string, _images?: unknown, userMessageUuid?: string) {
      this.sent.push(text);
      this.sentUserMessageUuids.push(userMessageUuid);
      turnInFlight = true;
    },
    async interrupt() {},
    close() { this.closeCount += 1; turnInFlight = false; },
    async setModel() {},
    async setPermissionMode() {},
    async getContextUsage() { return null; },
    async getUsageSnapshot() { return null; },
    finish(sessionId = 'session-1') {
      options?.callbacks.onDone(sessionId, 0, 1);
      turnInFlight = false;
    },
    notifyBackgroundDone(taskId: string) {
      options?.callbacks.onTaskNotification?.(taskId, 'completed', 'done');
    },
  };
}

vi.mock('../../src/HarnessFactory', () => ({
  createHarnessSession: (thread: { agentHarness?: 'claude' | 'codex' }) => {
    const session = makeFakeSession(thread.agentHarness ?? 'claude');
    mock.sessions.push(session);
    return session;
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');
const { goalKickoffMessage } = await import('../../src/slashCommands');

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  mock.sessions = [];
  mock.blockNextStart = false;
  mock.releaseStart = null;
  mock.rejectStart = null;
});

describe.each(['claude', 'codex'] as const)('goal context rollover — %s', (harness) => {
  it('includes the absolute vault root in the shared session prompt', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, agentHarness: harness });
    manager.vaultRoot = '/vault';
    const thread = manager.createThread('T', process.cwd(), undefined, harness);

    await manager.sendMessage(thread.id, 'hello');

    const prompt = (mock.sessions[0] as FakeSession).starts[0].appendSystemPrompt;
    expect(prompt).toContain('Vault root (filesystem path): /vault');
    expect(prompt).toContain(`Working directory: ${process.cwd()}`);
    expect(prompt).not.toContain(`Vault root (filesystem path): ${process.cwd()}`);
    (mock.sessions[0] as FakeSession).finish();
    await settle();
  });

  it('retires an idle adapter, resumes the same session id, applies the new prompt, and sends one kickoff', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, agentHarness: harness });
    const thread = manager.createThread('T', process.cwd(), undefined, harness);
    await manager.sendMessage(thread.id, 'hello');
    const first = mock.sessions[0] as FakeSession;
    first.finish('durable-session');
    await settle();

    const revision = manager.setThreadGoal(thread.id, 'Ship the release');
    const sent = manager.requestGoalKickoff(thread.id, revision, goalKickoffMessage('Ship the release'));
    await settle();

    const second = mock.sessions[1] as FakeSession;
    expect(first.closeCount).toBe(1);
    expect(second.starts[0].resume).toBe('durable-session');
    expect(second.starts[0].appendSystemPrompt).toContain('Ship the release');
    expect(second.sent).toEqual([goalKickoffMessage('Ship the release')]);
    expect(second.sentUserMessageUuids).toEqual([thread.messages.at(-1)?.id]);
    await expect(sent).resolves.toBe(true);
  });

  it('defers rollover while a turn is in flight, then performs it at settlement', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, agentHarness: harness });
    const thread = manager.createThread('T', process.cwd(), undefined, harness);
    await manager.sendMessage(thread.id, 'working');
    const first = mock.sessions[0] as FakeSession;

    const revision = manager.setThreadGoal(thread.id, 'New goal');
    void manager.requestGoalKickoff(thread.id, revision, goalKickoffMessage('New goal'));
    await settle();
    expect(mock.sessions).toHaveLength(1);
    expect(first.closeCount).toBe(0);

    first.finish('same-session');
    await settle();
    expect(mock.sessions).toHaveLength(2);
    expect((mock.sessions[1] as FakeSession).sent).toEqual([goalKickoffMessage('New goal')]);
  });

  it('defers while an interactive callback or background task is pending', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, agentHarness: harness });
    const thread = manager.createThread('T', process.cwd(), undefined, harness);
    await manager.sendMessage(thread.id, 'working');
    const first = mock.sessions[0] as FakeSession;
    first.finish('same-session');
    await settle();
    first.hasPendingPermission = true;
    (manager as any).activeBgTasks.set(thread.id, new Map([['bg-1', { description: 'job', startedAt: 1 }]]));

    const revision = manager.setThreadGoal(thread.id, 'Deferred goal');
    void manager.requestGoalKickoff(thread.id, revision, goalKickoffMessage('Deferred goal'));
    await settle();
    expect(mock.sessions).toHaveLength(1);

    first.hasPendingPermission = false;
    (manager as any).activeBgTasks.get(thread.id).delete('bg-1');
    first.notifyBackgroundDone('bg-1');
    await settle();
    expect(mock.sessions).toHaveLength(2);
  });

  it('coalesces rapid replacements so only the latest goal kicks off', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, agentHarness: harness });
    const thread = manager.createThread('T', process.cwd(), undefined, harness);
    await manager.sendMessage(thread.id, 'working');
    const first = mock.sessions[0] as FakeSession;

    const oldRevision = manager.setThreadGoal(thread.id, 'Old goal');
    const oldResult = manager.requestGoalKickoff(thread.id, oldRevision, goalKickoffMessage('Old goal'));
    const newRevision = manager.setThreadGoal(thread.id, 'Latest goal');
    const newResult = manager.requestGoalKickoff(thread.id, newRevision, goalKickoffMessage('Latest goal'));
    first.finish('same-session');
    await settle();

    expect((mock.sessions[1] as FakeSession).sent).toEqual([goalKickoffMessage('Latest goal')]);
    await expect(oldResult).resolves.toBe(false);
    await expect(newResult).resolves.toBe(true);
  });

  it('cancels an obsolete kickoff when the goal changes during adapter startup', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, agentHarness: harness });
    const thread = manager.createThread('T', process.cwd(), undefined, harness);
    await manager.sendMessage(thread.id, 'hello');
    (mock.sessions[0] as FakeSession).finish('same-session');
    await settle();

    mock.blockNextStart = true;
    const oldRevision = manager.setThreadGoal(thread.id, 'Old goal');
    const oldResult = manager.requestGoalKickoff(thread.id, oldRevision, goalKickoffMessage('Old goal'));
    await settle();
    expect(mock.sessions).toHaveLength(2);

    const newRevision = manager.setThreadGoal(thread.id, 'Latest goal');
    const newResult = manager.requestGoalKickoff(thread.id, newRevision, goalKickoffMessage('Latest goal'));
    mock.releaseStart?.();
    await settle();
    await settle();

    expect((mock.sessions[1] as FakeSession).sent).toEqual([]);
    expect((mock.sessions[2] as FakeSession).sent).toEqual([goalKickoffMessage('Latest goal')]);
    await expect(oldResult).resolves.toBe(false);
    await expect(newResult).resolves.toBe(true);
  });

  it('queues ordinary sends until adapter startup applies the desired revision', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, agentHarness: harness });
    const thread = manager.createThread('T', process.cwd(), undefined, harness);
    await manager.sendMessage(thread.id, 'hello');
    (mock.sessions[0] as FakeSession).finish('same-session');
    await settle();

    mock.blockNextStart = true;
    const revision = manager.setThreadGoal(thread.id, 'Goal');
    void manager.requestGoalKickoff(thread.id, revision, goalKickoffMessage('Goal'));
    await settle();
    await manager.sendMessage(thread.id, 'follow-up during resume');
    expect(manager.getQueuedMessages(thread.id)).toEqual([{ text: 'follow-up during resume', images: undefined }]);

    mock.releaseStart?.();
    await settle();
    await settle();
    expect((mock.sessions[1] as FakeSession).sent).toEqual([
      goalKickoffMessage('Goal'),
      'follow-up during resume',
    ]);
  });

  it('clearing cancels a stale kickoff and removes the goal from the refreshed prompt', async () => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, agentHarness: harness });
    const thread = manager.createThread('T', process.cwd(), undefined, harness);
    thread.goal = 'Old goal';
    await manager.sendMessage(thread.id, 'working');
    const first = mock.sessions[0] as FakeSession;

    const oldRevision = manager.setThreadGoal(thread.id, 'Replacement');
    const oldResult = manager.requestGoalKickoff(thread.id, oldRevision, goalKickoffMessage('Replacement'));
    const clearRevision = manager.setThreadGoal(thread.id, undefined);
    manager.requestGoalContextRefresh(thread.id, clearRevision);
    first.finish('same-session');
    await settle();

    expect(first.closeCount).toBe(1);
    await manager.sendMessage(thread.id, 'next turn');
    const second = mock.sessions[1] as FakeSession;
    expect(second.starts[0].appendSystemPrompt).not.toContain('Active Goal');
    expect(second.sent).toEqual(['next turn']);
    await expect(oldResult).resolves.toBe(false);
  });
});

it('deleting a thread cancels pending goal work', async () => {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const thread = manager.createThread('T', process.cwd());
  await manager.sendMessage(thread.id, 'working');
  const revision = manager.setThreadGoal(thread.id, 'Goal');
  const result = manager.requestGoalKickoff(thread.id, revision, goalKickoffMessage('Goal'));
  manager.deleteThread(thread.id);
  await expect(result).resolves.toBe(false);
});

it('deleting during blocked adapter startup prevents the detached kickoff from sending', async () => {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const thread = manager.createThread('T', process.cwd());
  await manager.sendMessage(thread.id, 'hello');
  (mock.sessions[0] as FakeSession).finish('same-session');
  await settle();
  mock.blockNextStart = true;
  const revision = manager.setThreadGoal(thread.id, 'Goal');
  const result = manager.requestGoalKickoff(thread.id, revision, goalKickoffMessage('Goal'));
  await settle();
  const starting = mock.sessions[1] as FakeSession;
  manager.deleteThread(thread.id);
  mock.releaseStart?.();
  await settle();
  expect(starting.sent).toEqual([]);
  await expect(result).resolves.toBe(false);
});

it('shutdown during blocked adapter startup prevents the detached kickoff from sending', async () => {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const thread = manager.createThread('T', process.cwd());
  await manager.sendMessage(thread.id, 'hello');
  (mock.sessions[0] as FakeSession).finish('same-session');
  await settle();
  mock.blockNextStart = true;
  const revision = manager.setThreadGoal(thread.id, 'Goal');
  const result = manager.requestGoalKickoff(thread.id, revision, goalKickoffMessage('Goal'));
  await settle();
  const starting = mock.sessions[1] as FakeSession;
  await manager.gracefulShutdown(1);
  mock.releaseStart?.();
  await settle();
  expect(starting.sent).toEqual([]);
  await expect(result).resolves.toBe(false);
});

it('rolling back a failed persistence restores the applied revision and does not strand later sends', async () => {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const thread = manager.createThread('T', process.cwd());
  await manager.sendMessage(thread.id, 'hello');
  const first = mock.sessions[0] as FakeSession;
  first.finish('same-session');
  await settle();

  const revision = manager.setThreadGoal(thread.id, 'Unsaved goal');
  manager.rollbackThreadGoal(thread.id, revision);
  await manager.sendMessage(thread.id, 'still works');

  expect(thread.goal).toBeUndefined();
  expect(manager.getQueuedCount(thread.id)).toBe(0);
  expect(first.sent).toEqual(['hello', 'still works']);
});

it('a first goal that fails persistence rolls back to an empty durable baseline', () => {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const thread = manager.createThread('T', process.cwd());

  const revision = manager.setThreadGoal(thread.id, 'Never durable');
  manager.rollbackThreadGoal(thread.id, revision);

  const state = (manager as any).goalContextStates.get(thread.id);
  expect(thread.goal).toBeUndefined();
  expect(state.durableGoal).toBeUndefined();
  expect(state.desiredRevision).toBe(state.appliedRevision);
});

it('a send during failed persistence stays on the old adapter after rollback', async () => {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const thread = manager.createThread('T', process.cwd());
  await manager.sendMessage(thread.id, 'hello');
  const first = mock.sessions[0] as FakeSession;
  first.finish('same-session');
  await settle();

  const revision = manager.setThreadGoal(thread.id, 'Never persisted');
  await manager.sendMessage(thread.id, 'sent while save is pending');
  expect(manager.getQueuedCount(thread.id)).toBe(1);
  expect(mock.sessions).toHaveLength(1);

  manager.rollbackThreadGoal(thread.id, revision);
  await settle();
  expect(mock.sessions).toHaveLength(1);
  expect(first.closeCount).toBe(0);
  expect(first.sent).toEqual(['hello', 'sent while save is pending']);
});

it('coalesced failed goal saves roll back every rapid update to the durable baseline', async () => {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const thread = manager.createThread('T', process.cwd());
  thread.goal = 'Durable goal';
  await manager.sendMessage(thread.id, 'hello');
  const first = mock.sessions[0] as FakeSession;
  first.finish('same-session');
  await settle();

  const firstRevision = manager.setThreadGoal(thread.id, 'Unpersisted one');
  const latestRevision = manager.setThreadGoal(thread.id, 'Unpersisted two');
  await manager.sendMessage(thread.id, 'sent while shared save is pending');

  // A shared persistence rejection reaches both callers. Neither caller's
  // immediate prior value is necessarily durable.
  manager.rollbackThreadGoal(thread.id, firstRevision);
  manager.rollbackThreadGoal(thread.id, latestRevision);
  await settle();

  const state = (manager as any).goalContextStates.get(thread.id);
  expect(thread.goal).toBe('Durable goal');
  expect(state.desiredRevision).toBe(state.appliedRevision);
  expect(state.durableRevision).toBe(state.appliedRevision);
  expect(state.durableGoal).toBe('Durable goal');
  expect(mock.sessions).toHaveLength(1);
  expect(first.closeCount).toBe(0);
  expect(first.sent).toEqual(['hello', 'sent while shared save is pending']);
});

it.each(['delete', 'shutdown', 'destroy'] as const)('%s ignores a rejected adapter start after cancellation', async (action) => {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const thread = manager.createThread('T', process.cwd());
  const errors: Error[] = [];
  manager.subscribe((_id, event) => { if (event.type === 'error') errors.push(event.error); });
  await manager.sendMessage(thread.id, 'hello');
  (mock.sessions[0] as FakeSession).finish('same-session');
  await settle();
  mock.blockNextStart = true;
  const revision = manager.setThreadGoal(thread.id, 'Goal');
  const result = manager.requestGoalKickoff(thread.id, revision, goalKickoffMessage('Goal'));
  await settle();

  if (action === 'delete') manager.deleteThread(thread.id);
  else if (action === 'shutdown') await manager.gracefulShutdown(1);
  else manager.destroy();
  mock.rejectStart?.(new Error('start cancelled'));
  await settle();

  expect(errors).toEqual([]);
  if (action !== 'delete') expect(thread.lastError).toBeUndefined();
  await expect(result).resolves.toBe(false);
});

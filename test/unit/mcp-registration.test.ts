import { expect, it, vi } from 'vitest';
import * as registration from '../../src/mcpServerStore';
import type { StoredMcpServer } from '../../src/types';

const proposal = { name: 'example', type: 'stdio', command: 'npx', args: ['example-mcp'], env: { API_TOKEN: '${EXAMPLE_TOKEN}', MODE: 'read' } };
function fixture() {
  const settings = { mcpServers: {} as Record<string, StoredMcpServer> };
  const confirm = vi.fn(async () => true);
  const save = vi.fn(async () => {});
  const register = registration.createMcpRegistration({ getSettings: () => settings, confirm, save });
  return { settings, confirm, save, register };
}

it('confirms before writing, awaits durable save, and resolves only in future sessions', async () => {
  const f = fixture();
  let finish!: () => void;
  f.save.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  f.confirm.mockImplementation(async () => { expect(f.settings.mcpServers).toEqual({}); return true; });
  let settled = false;
  const pending = f.register(proposal).then(result => { settled = true; return result; });
  await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  finish();
  expect(await pending).toMatchObject({ success: true, status: 'registered' });
  expect(f.settings.mcpServers.example).toMatchObject({ env: { API_TOKEN: '${EXAMPLE_TOKEN}' } });
  expect(registration.resolveMcpServers(f.settings.mcpServers, { EXAMPLE_TOKEN: 'resolved-secret' }).servers.example).toMatchObject({ env: { API_TOKEN: 'resolved-secret' } });
});

it('makes identical retries idempotent and never overwrites a collision', async () => {
  const f = fixture();
  await f.register(proposal);
  expect(await f.register({ ...proposal, env: { MODE: 'read', API_TOKEN: '${EXAMPLE_TOKEN}' } })).toMatchObject({ status: 'unchanged' });
  expect(await f.register({ ...proposal, command: 'different' })).toMatchObject({ status: 'conflict' });
  expect(f.confirm).toHaveBeenCalledOnce();
  expect(f.save).toHaveBeenCalledOnce();
});

it.each(['claude_threads', 'CLAUDE_THREADS', 'obsidian', '__proto__', 'constructor', 'prototype'])('rejects reserved name %s', async name => {
  const f = fixture();
  expect(await f.register({ ...proposal, name })).toMatchObject({ status: 'invalid' });
  expect(f.confirm).not.toHaveBeenCalled();
  expect(registration.saveMcpServer(f.settings, { name, type: 'stdio', command: 'x' })).toMatchObject({ ok: false });
});

it.each([null, { ...proposal, args: [1] }, { ...proposal, env: { API_TOKEN: 'raw-secret' } }, { name: 'x', type: 'http', url: 'file:///tmp/x' }, { name: 'x', type: 'sse', url: 'https://user:password@example.com' }, { name: 'x', type: 'http', url: 'https://example.com', headers: { Authorization: 'Bearer raw-secret' } }])('rejects malformed or credential-bearing input without echoing it', async input => {
  const f = fixture();
  const result = await f.register(input);
  expect(result).toMatchObject({ status: 'invalid' });
  expect(JSON.stringify(result)).not.toContain('raw-secret');
  expect(f.confirm).not.toHaveBeenCalled();
});

it('cancels without changes and rejects unavailable or scheduled confirmation', async () => {
  const f = fixture();
  f.confirm.mockResolvedValue(false);
  expect(await f.register(proposal)).toMatchObject({ status: 'cancelled' });
  expect(await f.register(proposal, false)).toMatchObject({ status: 'unavailable' });
  const unavailable = registration.createMcpRegistration({ getSettings: () => f.settings, save: f.save });
  expect(await unavailable(proposal)).toMatchObject({ status: 'unavailable' });
  expect(f.save).not.toHaveBeenCalled();
  expect(f.settings.mcpServers).toEqual({});
});

it('serializes concurrent calls and rechecks collisions after confirmation', async () => {
  const f = fixture();
  const results = await Promise.all([f.register(proposal), f.register(proposal)]);
  expect(results.map(r => r.status)).toEqual(['registered', 'unchanged']);
  expect(f.confirm).toHaveBeenCalledOnce();
  const other = fixture();
  other.confirm.mockImplementation(async () => { other.settings.mcpServers.example = { type: 'stdio', command: 'user-edit' }; return true; });
  expect(await other.register(proposal)).toMatchObject({ status: 'conflict' });
  expect(other.save).not.toHaveBeenCalled();
});

it('rolls back only its own entry on failed persistence and redacts error details', async () => {
  const f = fixture();
  f.save.mockImplementation(async () => { f.settings.mcpServers.other = { type: 'stdio', command: 'other' }; throw new Error('raw-secret'); });
  const result = await f.register(proposal);
  expect(result).toMatchObject({ status: 'failed' });
  expect(JSON.stringify(result)).not.toContain('raw-secret');
  expect(f.settings.mcpServers).toEqual({ other: { type: 'stdio', command: 'other' } });
});

it('preserves a newer settings edit when persistence fails', async () => {
  const f = fixture();
  f.save.mockImplementation(async () => { f.settings.mcpServers.example = { type: 'stdio', command: 'edited' }; throw new Error('disk'); });
  await f.register(proposal);
  expect(f.settings.mcpServers.example).toEqual({ type: 'stdio', command: 'edited' });
});

it.each(['http', 'sse'])('registers %s and protects confirmed input from caller mutation', async type => {
  const f = fixture();
  const input = { name: 'remote', type, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } };
  f.confirm.mockImplementation(async () => { input.headers.Authorization = 'changed'; return true; });
  expect(await f.register(input)).toMatchObject({ status: 'registered' });
  expect(f.settings.mcpServers.remote).toMatchObject({ headers: { Authorization: 'Bearer ${TOKEN}' } });
});

it('offers host-confirmed registration backed by the existing MCP store', () => {
  expect((registration as Record<string, unknown>).createMcpRegistration).toBeTypeOf('function');
});

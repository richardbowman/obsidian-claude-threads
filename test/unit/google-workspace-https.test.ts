import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('https', () => ({ request: native.request }));
import { googleWorkspaceRequest } from '../../src/GoogleWorkspaceMcp';

describe('Google Workspace native HTTPS transport', () => {
  it('uses Node HTTPS, not renderer fetch, and streams the upstream response', async () => {
    const renderer = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('renderer CSP'));
    const request = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
    native.request.mockImplementation((_url, _options, callback) => {
      queueMicrotask(() => {
        const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'text/event-stream' } });
        callback(response); response.end('data: {"result":{}}\n\n');
      });
      return request;
    });
    try {
      const signal = new AbortController().signal;
      const response = await googleWorkspaceRequest('https://docsmcp.googleapis.com/mcp/v1', { method: 'POST', headers: { Authorization: 'Bearer test' }, body: 'payload', signal });
      expect(await response.text()).toBe('data: {"result":{}}\n\n');
      expect(request.write).toHaveBeenCalledWith('payload');
      expect(native.request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal, method: 'POST' }), expect.any(Function));
      expect(renderer).not.toHaveBeenCalled();
    } finally { renderer.mockRestore(); }
  });
  it('rejects redirects without issuing a second request', async () => {
    native.request.mockClear();
    native.request.mockImplementation((_url, _options, callback) => {
      queueMicrotask(() => callback(Object.assign(new PassThrough(), { statusCode: 302, headers: { location: 'https://other.example.com' } })));
      return Object.assign(new EventEmitter(), { end: vi.fn() });
    });
    await expect(googleWorkspaceRequest('https://docsmcp.googleapis.com/mcp/v1', { method: 'GET' })).rejects.toThrow('redirect-rejected');
    expect(native.request).toHaveBeenCalledTimes(1);
  });
});

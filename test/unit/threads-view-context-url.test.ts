import { describe, expect, it, vi } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';
import { ContextPanelViewError } from '../../src/ContextPanelController';
import { openUrlPreferringWebViewer } from '../../src/linkUtils';

vi.mock('../../src/SettingsTab', () => ({ isWebViewerEnabled: () => true }));
vi.mock('../../src/linkUtils', async (original) => ({ ...await original<object>(), openUrlPreferringWebViewer: vi.fn() }));

describe('conversation-first footer URLs', () => {
  it('uses asynchronous controller navigation instead of acquiring a leaf before layout restoration', async () => {
    const view = Object.create(ThreadsView.prototype);
    const setViewState = vi.fn().mockResolvedValue(true);
    const getLeaf = vi.fn(() => { throw new Error('layout is restoring'); });
    view.app = { workspace: {} };
    view.plugin = { isConversationFirst: () => true, contextPanel: { setViewState, getLeaf } };
    await view.openLink('https://example.com');
    expect(setViewState).toHaveBeenCalledWith({ type: 'webviewer', active: true, state: { url: 'https://example.com' } });
    expect(getLeaf).not.toHaveBeenCalled();
  });

  it.each([true, false])('opens externally only for a native view load error (load error: %s)', async (loadError) => {
    vi.mocked(openUrlPreferringWebViewer).mockClear();
    const view = Object.create(ThreadsView.prototype);
    const error = loadError ? new ContextPanelViewError(new Error('view failed')) : new Error('controller is disposed');
    view.app = { workspace: {} };
    view.plugin = { isConversationFirst: () => true, contextPanel: { setViewState: vi.fn().mockRejectedValue(error) } };
    await view.openLink('https://example.com');
    expect(openUrlPreferringWebViewer).toHaveBeenCalledTimes(loadError ? 1 : 0);
    if (loadError) expect(openUrlPreferringWebViewer).toHaveBeenCalledWith(view.app, 'https://example.com', expect.objectContaining({ webViewerEnabled: false }));
  });
});

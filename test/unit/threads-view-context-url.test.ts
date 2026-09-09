import { describe, expect, it, vi } from 'vitest';
import { ThreadsView } from '../../src/ThreadsView';

vi.mock('../../src/SettingsTab', () => ({ isWebViewerEnabled: () => true }));

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
});

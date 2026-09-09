/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { Menu } from 'obsidian';
import { ThreadsView } from '../../src/ThreadsView';

describe('thread rename menu', () => {
  it('offers Rename thread for the tab header and targets the thread captured when opened', () => {
    const view = new ThreadsView({} as never, { manager: { getThread: () => ({ id: 'one', title: 'Original' }) } } as never);
    const internal = view as any;
    internal.activeThreadId = 'one';
    internal.renameThread = vi.fn();
    const menu = new Menu();
    view.onPaneMenu(menu, 'tab-header');
    internal.activeThreadId = 'two';
    const rename = (menu as any).item('Rename thread');
    expect(rename).toBeDefined();
    rename.clickHandler();
    expect(internal.renameThread).toHaveBeenCalledWith('one');
  });

  it('does not offer rename for a deleted selection', () => {
    const view = new ThreadsView({} as never, { manager: { getThread: () => undefined } } as never);
    (view as any).activeThreadId = 'gone';
    const menu = new Menu();
    view.onPaneMenu(menu, 'tab-header');
    expect((menu as any).item('Rename thread')).toBeUndefined();
  });
});

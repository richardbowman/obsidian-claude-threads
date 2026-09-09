import { describe, expect, it, vi } from 'vitest';
import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import { ContextPanelController, createCompanionOwnershipStore } from '../../src/ContextPanelController';

function makeLeaf(name: string) {
  return {
    name,
    view: {},
    getViewState: vi.fn().mockReturnValue({ type: 'markdown', state: {} }),
    detach: vi.fn(),
    openFile: vi.fn().mockResolvedValue(undefined),
    setViewState: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkspaceLeaf & {
    name: string;
    openFile: ReturnType<typeof vi.fn>;
    setViewState: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(
  restoredMarker?: string,
  unrelatedLeaves: WorkspaceLeaf[] = [],
  store = createCompanionOwnershipStore(),
  persistOverride?: (marker: string | undefined) => Promise<void>,
) {
  const chat = makeLeaf('chat');
  const firstCompanion = makeLeaf('companion-1');
  const secondCompanion = makeLeaf('companion-2');
  const attached = new Set<WorkspaceLeaf>([chat, ...unrelatedLeaves]);
  let chatLeaf = chat as WorkspaceLeaf;
  firstCompanion.detach = vi.fn(() => attached.delete(firstCompanion));
  secondCompanion.detach = vi.fn(() => attached.delete(secondCompanion));
  const splitActiveLeaf = vi
    .fn()
    .mockImplementationOnce(() => {
      attached.add(firstCompanion);
      return firstCompanion;
    })
    .mockImplementationOnce(() => {
      attached.add(secondCompanion);
      return secondCompanion;
    });
  const workspace = {
    iterateAllLeaves: vi.fn((callback: (leaf: WorkspaceLeaf) => void) => {
      for (const leaf of attached) callback(leaf);
    }),
    splitActiveLeaf,
    revealLeaf: vi.fn(),
    openLinkText: vi.fn().mockResolvedValue(undefined),
  };
  const resolvedFiles = new Map<string, TFile>();
  const app = {
    workspace,
    metadataCache: {
      getFirstLinkpathDest: vi.fn((linktext: string, sourcePath: string) =>
        resolvedFiles.get(`${sourcePath}::${linktext}`) ?? null),
    },
  } as unknown as App;
  let marker = restoredMarker;
  const createController = (ownershipStore = store) => new ContextPanelController(
    app,
    () => chatLeaf,
    () => marker,
    persistOverride ?? (async (next) => { marker = next; }),
    ownershipStore,
  );
  const controller = createController();
  return {
    controller, createController, workspace, chat, firstCompanion, secondCompanion, attached,
    getMarker: () => marker,
    resolveLink: (linktext: string, sourcePath: string, file: TFile) => {
      resolvedFiles.set(`${sourcePath}::${linktext}`, file);
    },
    replaceChat: (next: WorkspaceLeaf) => { attached.delete(chatLeaf); chatLeaf = next; attached.add(next); },
  };
}

describe('ContextPanelController', () => {
  function durableHarness() {
    const h = makeHarness('stale-legacy-marker');
    const destination = makeLeaf('host-owned');
    const acquire = vi.fn(() => ({ leaf: destination, reused: true }));
    Object.assign(h.workspace, { getOrCreateCompanionLeaf: acquire });
    return { ...h, destination, acquire };
  }

  it('recovers the host destination after module reload and chat replacement without touching legacy state', async () => {
    const h = durableHarness();
    await h.controller.openFile({ path: 'First.md' } as TFile);
    await h.controller.dispose();
    h.replaceChat(makeLeaf('restored-chat'));
    const restored = h.createController(createCompanionOwnershipStore());
    expect(await restored.setViewState({ type: 'webviewer', state: { url: 'https://example.com' } })).toBe(true);
    expect(h.acquire).toHaveBeenCalledTimes(2);
    expect(h.acquire.mock.calls[0]).toEqual(['claude-threads:conversation-context', h.chat, 0.3]);
    expect(h.workspace.splitActiveLeaf).not.toHaveBeenCalled();
    expect(h.destination.detach).not.toHaveBeenCalled();
    expect(h.getMarker()).toBe('stale-legacy-marker');
  });

  it('uses the host replacement destination and reuse result when the destination tab was closed', async () => {
    const h = durableHarness();
    h.acquire.mockReturnValueOnce({ leaf: h.destination, reused: false });
    expect(await h.controller.setViewState({ type: 'markdown', state: { file: 'New.md' } })).toBe(false);
    expect(h.acquire).toHaveBeenCalledOnce();
    expect(h.destination.setViewState).toHaveBeenCalledOnce();
  });

  it('routes unresolved links and direct leaf access through the host', async () => {
    const h = durableHarness();
    expect(h.controller.getLeaf()).toBe(h.destination);
    await h.controller.openLinkText('Missing#Heading');
    expect(h.destination.setViewState).toHaveBeenCalledWith({ type: 'markdown', active: true, state: { file: 'Missing' }, eState: { subpath: '#Heading' } });
    expect(h.workspace.splitActiveLeaf).not.toHaveBeenCalled();
  });

  it('waits for restored layout before acquiring the host destination', async () => {
    const h = durableHarness();
    let ready!: () => void;
    Object.assign(h.workspace, { onLayoutReady: (callback: () => void) => { ready = callback; } });
    const opening = h.controller.openFile({ path: 'Later.md' } as TFile);
    expect(h.acquire).not.toHaveBeenCalled();
    ready();
    await opening;
    expect(h.acquire).toHaveBeenCalledOnce();
  });

  it('prevents pending layout navigation from acquiring a pane after disposal', async () => {
    const h = durableHarness();
    let ready!: () => void;
    Object.assign(h.workspace, { onLayoutReady: (callback: () => void) => { ready = callback; } });
    const opening = h.controller.openFile({ path: 'Later.md' } as TFile);
    await h.controller.dispose();
    ready();
    await expect(opening).rejects.toThrow('disposed');
    expect(h.acquire).not.toHaveBeenCalled();
    expect(() => h.controller.getLeaf()).toThrow('disposed');
  });

  it('does not reveal a destination if disposed while its view is opening', async () => {
    const h = durableHarness();
    let opened!: () => void;
    h.destination.setViewState.mockImplementation(() => new Promise<void>((resolve) => { opened = resolve; }));
    const opening = h.controller.setViewState({ type: 'webviewer', state: {} });
    await vi.waitFor(() => expect(h.destination.setViewState).toHaveBeenCalled());
    await h.controller.dispose();
    opened();
    await expect(opening).rejects.toThrow('disposed');
    expect(h.workspace.revealLeaf).not.toHaveBeenCalled();
  });

  it('creates one right-adjacent companion and reuses it for later files', async () => {
    const { controller, workspace, chat, firstCompanion } = makeHarness();
    const firstFile = { path: 'Notes/first.md' } as TFile;
    const secondFile = { path: 'Notes/second.md' } as TFile;

    await controller.openFile(firstFile);
    await controller.openFile(secondFile);

    expect(workspace.revealLeaf).toHaveBeenNthCalledWith(1, chat);
    expect(workspace.splitActiveLeaf).toHaveBeenCalledTimes(1);
    expect(workspace.splitActiveLeaf).toHaveBeenCalledWith('vertical');
    expect(firstCompanion.openFile).toHaveBeenNthCalledWith(1, firstFile);
    expect(firstCompanion.openFile).toHaveBeenNthCalledWith(2, secondFile);
    expect(workspace.revealLeaf).toHaveBeenLastCalledWith(firstCompanion);
  });

  it('creates a fresh companion after the previous leaf is closed', async () => {
    const { controller, workspace, firstCompanion, secondCompanion, attached } = makeHarness();

    await controller.openFile({ path: 'Notes/first.md' } as TFile);
    attached.delete(firstCompanion);
    await controller.openFile({ path: 'Notes/second.md' } as TFile);

    expect(workspace.splitActiveLeaf).toHaveBeenCalledTimes(2);
    expect(secondCompanion.openFile).toHaveBeenCalledOnce();
  });

  it('opens internal links from the companion instead of replacing chat', async () => {
    const { controller, workspace, firstCompanion, resolveLink } = makeHarness();
    const file = { path: 'Daily/Today.md' } as TFile;
    resolveLink('Daily/Today', 'Claude/thread.md', file);

    await controller.openLinkText('Daily/Today', 'Claude/thread.md');

    expect(workspace.revealLeaf).toHaveBeenLastCalledWith(firstCompanion);
    expect(firstCompanion.openFile).toHaveBeenCalledWith(file);
    expect(workspace.openLinkText).not.toHaveBeenCalled();
  });

  it.each([
    ['Notes/Plan#Launch checklist', 'Notes/Plan', '#Launch checklist'],
    ['Notes/Plan#^decision-7', 'Notes/Plan', '#^decision-7'],
    ['../Project%20Notes/Roadmap#Q4', '../Project Notes/Roadmap', '#Q4'],
  ])('preserves the subpath for %s while resolving only the decoded path', async (linktext, resolvedPath, subpath) => {
    const { controller, firstCompanion, resolveLink } = makeHarness();
    const file = { path: 'Project Notes/Roadmap.md' } as TFile;
    resolveLink(resolvedPath, 'Claude/thread.md', file);

    await controller.openLinkText(linktext, 'Claude/thread.md');

    expect(firstCompanion.openFile).toHaveBeenCalledWith(file, { eState: { subpath } });
  });

  it('keeps unresolved vault links confined to the companion leaf', async () => {
    const { controller, workspace, firstCompanion } = makeHarness();

    await controller.openLinkText('Missing%20note#Draft', 'Claude/thread.md');

    expect(workspace.openLinkText).not.toHaveBeenCalled();
    expect(firstCompanion.setViewState).toHaveBeenCalledWith({
      type: 'markdown', active: true, state: { file: 'Missing note' }, eState: { subpath: '#Draft' },
    });
  });

  it('uses the optional atomic ratio split when the host provides it', async () => {
    const { controller, workspace, firstCompanion, attached } = makeHarness();
    const splitWithRatio = vi.fn(() => {
      attached.add(firstCompanion);
      return firstCompanion;
    });
    (workspace as typeof workspace & { splitActiveLeafWithRatio: typeof splitWithRatio }).splitActiveLeafWithRatio = splitWithRatio;

    await controller.openFile({ path: 'Notes/first.md' } as TFile);
    await controller.openFile({ path: 'Notes/second.md' } as TFile);

    expect(splitWithRatio).toHaveBeenCalledOnce();
    expect(splitWithRatio).toHaveBeenCalledWith('vertical', 0.3);
    expect(workspace.splitActiveLeaf).not.toHaveBeenCalled();
  });

  it('can place a native registered view in the same reusable companion', async () => {
    const { controller, firstCompanion } = makeHarness();

    const reused = await controller.setViewState({ type: 'webviewer', active: true, state: { url: 'https://example.com' } });

    expect(firstCompanion.setViewState).toHaveBeenCalledWith({
      type: 'webviewer',
      active: true,
      state: { url: 'https://example.com' },
    });
    expect(reused).toBe(false);
  });

  it('rehydrates only the controller-owned adjacent companion after controller recreation', async () => {
    const { controller, createController, workspace, firstCompanion } = makeHarness();
    await controller.openFile({ path: 'Notes/context.md' } as TFile);
    const reloadedController = createController();
    await reloadedController.openFile({ path: 'Notes/next.md' } as TFile);
    expect(workspace.splitActiveLeaf).toHaveBeenCalledOnce();
    expect(firstCompanion.openFile).toHaveBeenCalledTimes(2);
  });

  it('reports reuse when a restored companion handles a contextual view', async () => {
    const { controller, createController } = makeHarness();
    await controller.setViewState({ type: 'webviewer', state: { url: 'https://old.example?token=secret' } });
    const reused = await createController().setViewState({ type: 'webviewer', state: { url: 'https://new.example' } });
    expect(reused).toBe(true);
  });

  it('does not adopt either unrelated leaf when two native views have identical state', async () => {
    const unrelatedA = makeLeaf('unrelated-a');
    const unrelatedB = makeLeaf('unrelated-b');
    unrelatedA.getViewState = vi.fn().mockReturnValue({ type: 'webviewer', state: { url: 'https://same.example?token=secret' } });
    unrelatedB.getViewState = vi.fn().mockReturnValue({ type: 'webviewer', state: { url: 'https://same.example?token=secret' } });
    const { controller, workspace, firstCompanion } = makeHarness('stale-marker', [unrelatedA, unrelatedB]);
    await controller.setViewState({ type: 'webviewer', state: { url: 'https://same.example?token=secret' } });
    expect(workspace.splitActiveLeaf).toHaveBeenCalledOnce();
    expect(firstCompanion.setViewState).toHaveBeenCalledOnce();
    expect(unrelatedA.setViewState).not.toHaveBeenCalled();
    expect(unrelatedB.setViewState).not.toHaveBeenCalled();
  });

  it('replaces a stale marker after the owned companion is closed', async () => {
    const { controller, createController, firstCompanion, secondCompanion, attached, getMarker } = makeHarness();
    await controller.openFile({ path: 'Notes/first.md' } as TFile);
    const firstMarker = getMarker();
    attached.delete(firstCompanion);
    await createController().openFile({ path: 'Notes/second.md' } as TFile);
    expect(secondCompanion.openFile).toHaveBeenCalledOnce();
    expect(getMarker()).not.toBe(firstMarker);
  });

  it('persists only a sanitized opaque marker, never native view state', async () => {
    const { controller, getMarker } = makeHarness();
    await controller.setViewState({ type: 'webviewer', state: { url: 'https://example.com?token=secret' } });
    expect(getMarker()).toMatch(/^ct-companion-/);
    expect(JSON.stringify(getMarker())).not.toContain('secret');
  });

  it('retires the owned companion before an ownership-store/module reload', async () => {
    const storeBeforeReload = createCompanionOwnershipStore();
    const { controller, workspace, firstCompanion, createController, getMarker } = makeHarness(undefined, [], storeBeforeReload);
    await controller.openFile({ path: 'Notes/first.md' } as TFile);
    await controller.dispose();
    expect(firstCompanion.detach).toHaveBeenCalledOnce();
    expect(getMarker()).toBeUndefined();

    const storeAfterReload = createCompanionOwnershipStore();
    const postReload = createController(storeAfterReload);
    await postReload.openFile({ path: 'Notes/second.md' } as TFile);
    expect(workspace.splitActiveLeaf).toHaveBeenCalledTimes(2);
  });

  it('retires the old companion when a placement round trip replaces the chat leaf', async () => {
    const { controller, replaceChat, firstCompanion, secondCompanion, workspace } = makeHarness();
    await controller.openFile({ path: 'Notes/context.md' } as TFile);
    replaceChat(makeLeaf('replacement-chat'));
    await controller.openFile({ path: 'Notes/after-round-trip.md' } as TFile);
    expect(firstCompanion.detach).toHaveBeenCalledOnce();
    expect(workspace.splitActiveLeaf).toHaveBeenCalledTimes(2);
    expect(secondCompanion.openFile).toHaveBeenCalledOnce();
  });

  it('continues navigation after marker persistence fails and retries on the next operation', async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error('disk failed')).mockResolvedValue(undefined);
    const { controller, firstCompanion } = makeHarness(undefined, [], createCompanionOwnershipStore(), persist);
    await expect(controller.openFile({ path: 'Notes/first.md' } as TFile)).resolves.toBeUndefined();
    await expect(controller.openFile({ path: 'Notes/second.md' } as TFile)).resolves.toBeUndefined();
    expect(firstCompanion.openFile).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});

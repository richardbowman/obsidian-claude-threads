import { parseLinktext, type App, type OpenViewState, type TFile, type ViewState, type WorkspaceLeaf } from 'obsidian';

interface OwnedCompanion { workspace: object; chatLeaf: WorkspaceLeaf; companionLeaf: WorkspaceLeaf }
interface RatioWorkspace {
  splitActiveLeafWithRatio?(direction: 'vertical' | 'horizontal', ratio: number): WorkspaceLeaf;
  getOrCreateCompanionLeaf?(ownerKey: string, anchorLeaf: WorkspaceLeaf, leadingRatio: number): { leaf: WorkspaceLeaf; reused: boolean };
}
export type CompanionOwnershipStore = Map<string, OwnedCompanion>;
export function createCompanionOwnershipStore(): CompanionOwnershipStore { return new Map(); }
const defaultOwnershipStore = createCompanionOwnershipStore();
function createMarker(): string { return `ct-companion-${crypto.randomUUID()}`; }

export class ContextPanelController {
  private disposed = false;
  private companionLeaf: WorkspaceLeaf | null = null;
  private activeMarker: string | undefined;
  private markerPersisted = false;
  private markerSave: Promise<void> | null = null;

  constructor(
    private readonly app: App,
    private readonly getChatLeaf: () => WorkspaceLeaf | null,
    private readonly getPersistedMarker: () => string | undefined = () => undefined,
    private readonly persistMarker: (marker: string | undefined) => Promise<void> = async () => {},
    private readonly ownershipStore: CompanionOwnershipStore = defaultOwnershipStore,
  ) {}

  getLeaf(): WorkspaceLeaf {
    return this.acquireLeaf().leaf;
  }

  private acquireLeaf(): { leaf: WorkspaceLeaf; reused: boolean } {
    this.assertActive();
    const chatLeaf = this.getChatLeaf();
    if (!chatLeaf) throw new Error('Agent Threads chat must be open before contextual content can be shown.');
    const host = this.app.workspace as typeof this.app.workspace & RatioWorkspace;
    if (typeof host.getOrCreateCompanionLeaf === 'function') {
      return host.getOrCreateCompanionLeaf('claude-threads:conversation-context', chatLeaf, 0.3);
    }
    const restored = this.findOwnedCompanion(chatLeaf);
    if (restored) { this.companionLeaf = restored; return { leaf: restored, reused: true }; }

    const workspace = this.app.workspace;
    workspace.revealLeaf(chatLeaf);
    const ratioWorkspace = workspace as typeof workspace & RatioWorkspace;
    const companionLeaf = typeof ratioWorkspace.splitActiveLeafWithRatio === 'function'
      ? ratioWorkspace.splitActiveLeafWithRatio('vertical', 0.3)
      : workspace.splitActiveLeaf('vertical');
    const marker = createMarker();
    this.ownershipStore.set(marker, { workspace, chatLeaf, companionLeaf });
    this.activeMarker = marker;
    this.markerPersisted = false;
    this.companionLeaf = companionLeaf;
    void this.ensureMarkerPersisted();
    return { leaf: companionLeaf, reused: false };
  }

  async openFile(file: TFile, openState?: OpenViewState): Promise<void> {
    await this.waitForLayout();
    const leaf = this.getLeaf();
    await this.ensureMarkerPersisted();
    this.assertActive();
    if (openState) await leaf.openFile(file, openState);
    else await leaf.openFile(file);
    this.assertActive();
    this.app.workspace.revealLeaf(leaf);
  }

  async openLinkText(linktext: string, sourcePath = ''): Promise<void> {
    const parsed = parseLinktext(linktext);
    let linkPath = parsed.path;
    try { linkPath = decodeURIComponent(linkPath); } catch { /* preserve malformed text for native resolution */ }
    const file = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
    const openState = parsed.subpath ? { eState: { subpath: parsed.subpath } } : undefined;
    if (file) {
      await this.openFile(file, openState);
      return;
    }

    // Never delegate unresolved conversation-first links to workspace-level
    // routing: it may target the active chat leaf. Keep the native markdown
    // attempt confined to the owned companion instead.
    await this.waitForLayout();
    const leaf = this.getLeaf();
    await this.ensureMarkerPersisted();
    this.assertActive();
    await leaf.setViewState({ type: 'markdown', active: true, state: { file: linkPath }, ...openState });
    this.assertActive();
    this.app.workspace.revealLeaf(leaf);
  }

  async setViewState(viewState: ViewState): Promise<boolean> {
    await this.waitForLayout();
    const { leaf, reused } = this.acquireLeaf();
    await this.ensureMarkerPersisted();
    this.assertActive();
    await leaf.setViewState(viewState);
    this.assertActive();
    this.app.workspace.revealLeaf(leaf);
    return reused;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (typeof (this.app.workspace as RatioWorkspace).getOrCreateCompanionLeaf === 'function') {
      this.companionLeaf = null;
      return;
    }
    const marker = this.activeMarker ?? this.getPersistedMarker();
    const owned = typeof marker === 'string' ? this.ownershipStore.get(marker) : undefined;
    if (owned?.workspace === this.app.workspace && this.isAttached(owned.companionLeaf)) owned.companionLeaf.detach();
    if (marker) this.ownershipStore.delete(marker);
    this.companionLeaf = null;
    this.activeMarker = undefined;
    this.markerPersisted = false;
    await this.persistMarker(undefined).catch((error) => {
      console.warn('[ClaudeThreads] Failed to clear companion marker during unload:', error);
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Agent Threads context controller is disposed.');
  }

  private async waitForLayout(): Promise<void> {
    this.assertActive();
    // The host restores durable ownership before it signals layout readiness.
    if (typeof this.app.workspace.onLayoutReady === 'function') {
      await new Promise<void>((resolve) => this.app.workspace.onLayoutReady(resolve));
    }
    this.assertActive();
  }

  private findOwnedCompanion(chatLeaf: WorkspaceLeaf): WorkspaceLeaf | null {
    const persistedMarker = this.getPersistedMarker();
    const marker = this.activeMarker ?? persistedMarker;
    if (typeof marker !== 'string') return null;
    const owned = this.ownershipStore.get(marker);
    if (!owned) return null;
    const valid = owned.workspace === this.app.workspace && owned.chatLeaf === chatLeaf
      && this.isAttached(chatLeaf) && this.isAttached(owned.companionLeaf);
    if (!valid) {
      if (owned.workspace === this.app.workspace && this.isAttached(owned.companionLeaf)) owned.companionLeaf.detach();
      this.ownershipStore.delete(marker);
      this.companionLeaf = null;
      this.activeMarker = undefined;
      this.markerPersisted = false;
      void this.persistMarker(undefined).catch((error) => {
        console.warn('[ClaudeThreads] Failed to clear stale companion marker:', error);
      });
      return null;
    }
    this.activeMarker = marker;
    this.markerPersisted = this.markerPersisted || marker === persistedMarker;
    return owned.companionLeaf;
  }

  private async ensureMarkerPersisted(): Promise<void> {
    if (!this.activeMarker || this.markerPersisted) return;
    if (!this.markerSave) {
      const marker = this.activeMarker;
      this.markerSave = this.persistMarker(marker)
        .then(() => { if (this.activeMarker === marker) this.markerPersisted = true; })
        .catch((error) => console.warn('[ClaudeThreads] Failed to persist companion marker; will retry:', error))
        .finally(() => { this.markerSave = null; });
    }
    await this.markerSave;
  }

  private isAttached(target: WorkspaceLeaf): boolean {
    let attached = false;
    this.app.workspace.iterateAllLeaves((leaf) => { if (leaf === target) attached = true; });
    return attached;
  }
}

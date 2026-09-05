import { describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';

const SKILLS_VIEW_TYPE = 'claude-threads:skills';

function pluginWithWorkspace(workspace: unknown): ClaudeThreadsPlugin {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin;
  Object.defineProperty(plugin, 'app', { value: { workspace } });
  return plugin;
}

describe('Skills Manager placement', () => {
  it('opens a new Skills Manager in a main-area tab', async () => {
    const leaf = { setViewState: vi.fn().mockResolvedValue(undefined) };
    const workspace = {
      getLeavesOfType: vi.fn().mockReturnValue([]),
      getLeaf: vi.fn().mockReturnValue(leaf),
      getRightLeaf: vi.fn(),
      revealLeaf: vi.fn(),
    };

    await pluginWithWorkspace(workspace).activateSkillsView();

    expect(workspace.getLeaf).toHaveBeenCalledWith('tab');
    expect(workspace.getRightLeaf).not.toHaveBeenCalled();
    expect(leaf.setViewState).toHaveBeenCalledWith({
      type: SKILLS_VIEW_TYPE,
      active: true,
    });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
  });

  it('reveals an existing Skills Manager without creating or relocating it', async () => {
    const existingLeaf = { setViewState: vi.fn() };
    const workspace = {
      getLeavesOfType: vi.fn().mockReturnValue([existingLeaf]),
      getLeaf: vi.fn(),
      getRightLeaf: vi.fn(),
      revealLeaf: vi.fn(),
    };

    await pluginWithWorkspace(workspace).activateSkillsView();

    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(workspace.getRightLeaf).not.toHaveBeenCalled();
    expect(existingLeaf.setViewState).not.toHaveBeenCalled();
    expect(workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
  });
});

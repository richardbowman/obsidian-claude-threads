import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.resolve('styles.css'), 'utf8');
const dashboardSource = fs.readFileSync(path.resolve('src/AgentDashboard.ts'), 'utf8');
const kanbanSource = fs.readFileSync(path.resolve('src/KanbanView.ts'), 'utf8');

/**
 * The agent pill is the only always-visible agent surface. It lives in
 * .ct-input-footer, which is hover-only by default, so a `:has()` rule pins the
 * footer open while the pill is showing. These tests exist because both halves
 * of that rule fail silently: lose the rule and the pill becomes invisible until
 * you hover; lose the `transition` and the footer snaps open the instant the
 * first agent starts.
 */
describe('agent pill footer pinning', () => {
  const rule = css.match(
    /\.ct-panel-collapsible:has\(\.ct-agent-pill:not\(\.ct-hidden\)\)\s+\.ct-input-footer\s*\{([^}]*)\}/,
  )?.[1];

  it('pins the composer footer open while the pill is visible', () => {
    expect(rule).toBeDefined();
    expect(rule).toMatch(/max-height:\s*50px/);
    expect(rule).toMatch(/opacity:\s*1/);
    expect(rule).toMatch(/pointer-events:\s*auto/);
  });

  it('repeats the transition so the footer animates instead of snapping open', () => {
    expect(rule).toMatch(/transition:\s*max-height[^;]*opacity[^;]*;/);
  });

  it('anchors the popover on .ct-panel-wrapper, which must be positioned', () => {
    const wrapper = css.match(/\.ct-panel-wrapper\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(wrapper).toMatch(/position:\s*relative/);
    const popover = css.match(/\.ct-agent-popover\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(popover).toMatch(/position:\s*absolute/);
    // Drawn above the composer, not inside it.
    expect(popover).toMatch(/bottom:\s*100%/);
  });

  it('hides the pill entirely when a thread has no agents', () => {
    expect(css).toMatch(/\.ct-agent-pill\.ct-hidden\s*\{\s*display:\s*none;?\s*\}/);
  });
});

describe('agent touch targets', () => {
  it('keeps agent rows and dashboard chips at 44px on mobile', () => {
    expect(css).toMatch(/\.ct-mobile[^\{]*\.ct-agent-row-button[^\{]*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.ct-mobile[^\{]*\.ct-dashboard-agent(?:-count)?[^\{]*\{[^}]*min-height:\s*44px/);
  });

  it('keeps the pill, crumbs and close buttons at 44px on mobile', () => {
    expect(css).toMatch(/\.ct-mobile[^\{]*\.ct-agent-pill[^\{]*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.ct-mobile[^\{]*\.ct-agent-crumb[^\{]*\{[^}]*min-height:\s*44px/);
  });

  it('uses named pane containers and never treats width alone as mobile input', () => {
    expect(css).toMatch(/\.ct-root\s*\{[^}]*container-name:\s*ct-conversation/s);
    expect(css).toMatch(/\.ct-agents-root\s*\{[^}]*container-name:\s*ct-dashboard/s);
    expect(css).not.toMatch(/@media \(max-width: 700px\)[\s\S]{0,800}\.ct-dashboard-agent-count\s*\{[^}]*min-height:\s*44px/);
    expect(css).not.toMatch(/@container ct-dashboard \(max-width:[^)]+\)[\s\S]{0,1200}\.ct-dashboard-agent-count\s*\{[^}]*min-height:\s*44px/);
  });
});

describe('dashboard agent count', () => {
  it('uses the lightweight users icon instead of a boxed status dot', () => {
    expect(dashboardSource).toMatch(/setIcon\([^,]+,\s*['"]users['"]\)/);
    expect(dashboardSource).not.toMatch(/button\.createSpan\(\{ cls: ['"]ct-agent-status-dot['"] \}\)/);

    const rule = css.match(/\.ct-dashboard-agent-count\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/color:\s*var\(--text-faint\)/);
    expect(rule).toMatch(/background:\s*transparent/);
    expect(rule).toMatch(/border:\s*(?:0|none)/);
  });

  it('uses a shared active modifier for dashboard rows and kanban cards', () => {
    const activeRule = css.match(/\.ct-agent-count-active\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(activeRule).toMatch(/color:\s*var\(--color-green/);
    expect(dashboardSource).toContain('ct-agent-count-active');
    expect(kanbanSource).toContain('ct-agent-count-active');

    const kanbanRule = css.match(/\.ct-kanban-agent-count\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(kanbanRule).toMatch(/color:\s*var\(--text-faint\)/);
  });

  it('patches kanban agent counts in place when agent runs change', () => {
    expect(kanbanSource).toMatch(/private applyAgentCount\([^)]*\)/);
    expect(kanbanSource).toMatch(/private patchCard[\s\S]*this\.applyAgentCount\(/);
  });
});

describe('agent status dots', () => {
  it('colours every non-terminal status, including waiting and unavailable', () => {
    for (const status of ['starting', 'working', 'waiting', 'completed', 'failed', 'unavailable']) {
      expect(css).toContain(`.ct-agent-${status} .ct-agent-status-dot`);
    }
  });
});

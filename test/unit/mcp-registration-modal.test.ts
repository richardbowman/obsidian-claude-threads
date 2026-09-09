/** @vitest-environment jsdom */
import '../setup/obsidian-dom';
import { it, expect, vi } from 'vitest';
import { App } from 'obsidian';
import * as modals from '../../src/confirmModal';

it.each(['Register server', 'Cancel', 'dismiss'])('MCP confirmation resolves once on %s and shows scope/config', action => {
  const result = vi.fn();
  expect(modals.McpRegistrationModal).toBeTypeOf('function');
  const modal = new modals.McpRegistrationModal(new App(), { name: 'sample', type: 'stdio', command: 'npx', args: ['sample-mcp'], env: { TOKEN: '${TOKEN}' } }, result);
  modal.close = () => modal.onClose();
  modal.onOpen();
  expect(modal.contentEl.textContent).toContain('globally');
  expect(modal.contentEl.textContent).toContain('Newly initialized sessions');
  expect(modal.contentEl.textContent).toContain('${TOKEN}');
  if (action === 'dismiss') modal.onClose();
  else [...modal.contentEl.querySelectorAll('button')].find(b => b.textContent === action)!.click();
  modal.onClose();
  expect(result).toHaveBeenCalledExactlyOnceWith(action === 'Register server');
});

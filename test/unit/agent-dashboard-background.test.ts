import { describe, expect, it } from 'vitest';
import { isDashboardThread } from '../../src/AgentDashboard';

describe('AgentDashboard managed background jobs', () => {
  it('keeps peer-plugin background jobs out of the normal Agent Board', () => {
    expect(isDashboardThread({ background: true })).toBe(false);
    expect(isDashboardThread({ background: false })).toBe(true);
    expect(isDashboardThread({})).toBe(true);
  });
});

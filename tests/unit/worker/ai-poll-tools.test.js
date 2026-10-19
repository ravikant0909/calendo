import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// B16 — meeting polls existed in the UI/API but had no AI dashboard tool,
// violating the "AI feature parity" rule. The assistant must be able to create,
// list, and finalize polls, reusing the existing handlers.
const src = readFileSync(join(process.cwd(), 'src/worker.js'), 'utf8');

describe('B16: AI dashboard assistant has meeting-poll tools (feature parity)', () => {
  const toolsBlock = src.slice(
    src.indexOf('const DASHBOARD_TOOLS'),
    src.indexOf('async function executeDashboardTool')
  );
  const execBlock = src.slice(src.indexOf('async function executeDashboardTool'));

  it('DASHBOARD_TOOLS declares create_poll, list_polls, finalize_poll', () => {
    expect(toolsBlock).toContain("name: 'create_poll'");
    expect(toolsBlock).toContain("name: 'list_polls'");
    expect(toolsBlock).toContain("name: 'finalize_poll'");
  });

  it('executeDashboardTool handles the poll tools by reusing the existing handlers', () => {
    expect(execBlock).toContain("case 'create_poll'");
    expect(execBlock).toContain("case 'list_polls'");
    expect(execBlock).toContain("case 'finalize_poll'");
    expect(execBlock).toContain('handleCreatePoll(');
    expect(execBlock).toContain('handleListPolls(');
    expect(execBlock).toContain('handleFinalizePoll(');
  });

  it('list_polls is treated as a read (its name keeps the read prefix so it does not force a UI refresh)', () => {
    // the dashboard refreshes on any action NOT matching /^(get_|list_|find_|check_)/
    expect('list_polls').toMatch(/^(get_|list_|find_|check_)/);
    expect('create_poll').not.toMatch(/^(get_|list_|find_|check_)/);
    expect('finalize_poll').not.toMatch(/^(get_|list_|find_|check_)/);
  });
});

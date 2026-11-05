// Shared style maps and small line helpers (no imports from render or graph-render).
import { padEnd, sanitize, strWidth, truncate } from './text.mjs';

export const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m';
export const REV = '\x1b[7m';
export const stateStyle = { in_progress: C, review: Y, blocked: R + B, done: G, failed: R, cancelled: D, ready: B };
export const herdrStyle = { working: C, blocked: R + B, done: G, unknown: D, '-': D, '?': D, gone: D, ambiguous: R };
export const ROLE_SHORT = { planning: 'plan', research: 'rsch', implementation: 'impl', review: 'rev', cli: 'cli' };

// Untracked agent row, shared by the table and the team view.
export function untrackedLine(a, sel, cols, sty) {
  const line = truncate(`${sel ? '>' : ' '}  ${padEnd(sanitize(a.name ?? a.kind ?? 'agent'), 14)} ${padEnd(sanitize(a.paneId), 8)} ${padEnd(a.status, 8)} ${sanitize(a.tabLabel)} / ${sanitize(a.workspaceLabel)}`, cols);
  if (sel) return sty(REV, line + ' '.repeat(Math.max(0, cols - strWidth(line))));
  return line;
}

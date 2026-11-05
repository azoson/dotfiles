// Pure renderer: model + ui state -> full-screen frame text.
import { depsBody, legendLine, teamBody } from './graph-render.mjs';
import { stateWord } from './graph.mjs';
import { B, C, D, G, R, ROLE_SHORT, Y, herdrStyle, stateStyle, untrackedLine } from './styles.mjs';
import { padEnd, sanitize, strWidth, stripAnsi, truncate } from './text.mjs';
import { VIEWS, selectableKeys, viewRows } from './views.mjs';

export { selectableKeys, ROLE_SHORT, herdrStyle, stateStyle, untrackedLine };

const DROP_ORDER = ['ROLE', 'DEPS', 'FIX', 'TAB / WS', 'PANE', 'AGENT', 'HERDR'];
const TITLE_MIN = 10;
const KEY_HELP = 'j/k move  tab view  enter focus  r refresh  a all  q quit';

export function moveSelection(keys, currentKey, delta) {
  if (keys.length === 0) return null;
  const idx = keys.indexOf(currentKey);
  if (delta === 'top') return keys[0];
  if (delta === 'bottom') return keys[keys.length - 1];
  if (idx < 0) return keys[0];
  return keys[Math.min(keys.length - 1, Math.max(0, idx + delta))];
}

function wrap(text, width) {
  const out = [];
  let cur = '';
  let w = 0;
  for (const ch of String(text)) {
    const cw = strWidth(ch);
    if (w + cw > width) { out.push(cur); cur = ''; w = 0; }
    cur += ch;
    w += cw;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

const tilde = (p, home) => (p && home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);
const hms = (d) => (d instanceof Date ? d.toTimeString().slice(0, 8) : '');

function agtaskFooter(m) {
  if (m.status === 'ok' && !m.stale) return 'ok';
  if (m.stale) return `stale (${m.code ?? m.status})`;
  if (m.status === 'error') return `error (${m.code ?? '?'})`;
  return m.status === 'not_initialized' ? 'not initialized' : m.status;
}

function agtaskMessage(model) {
  const a = model.agtask;
  if (a.status === 'missing') return 'agtask not found on PATH (set ORCH_BOARD_AGTASK)';
  if (a.status === 'not_initialized') return `no agtask DB for this repo (expected ${model.repo.db ?? '?'})`;
  if (a.code === 'NO_REPO') return 'cannot determine repository (no cwd in plugin context). Reopen from a pane inside the repo or run with --cwd.';
  return `agtask error ${a.code ?? '?'}: ${a.message ?? 'unknown'}`;
}

export function render(model, ui, { cols, rows, color, now, home } = {}) {
  const view = VIEWS.includes(ui.view) ? ui.view : 'table';
  const keys = selectableKeys(model, view);
  const selectedKey = keys.includes(ui.selectedKey) ? ui.selectedKey : (keys[0] ?? null);
  const sty = (codes, text) => (color && codes ? `${codes}${text}\x1b[0m` : text);

  if (cols < 40 || rows < 10) {
    const lines = [truncate('terminal too small (need 40x10) - q to quit', Math.max(cols, 0))];
    while (lines.length < rows) lines.push('');
    return { text: lines.join('\n'), selectable: keys, scrollTop: 0, selectedKey };
  }

  // Header.
  const parts1 = ['orch-board', VIEWS.map((v) => (v === view ? `[${v}]` : v)).join(' ')];
  if (model.repo.cwd) parts1.push(tilde(model.repo.cwd, home));
  if (model.repo.db) parts1.push(`db ${tilde(model.repo.db, home)}`);
  else if (!model.tracking) parts1.push(`agtask ${agtaskFooter(model.agtask)}`);
  if (model.scopeWorkspaceLabel) parts1.push(`ws ${sanitize(model.scopeWorkspaceLabel)}`);
  if (!model.herdr.available) parts1.push(`herdr unavailable (${ui.herdrError ?? 'no snapshot'})`);
  const time = hms(ui.lastRefresh);
  const head1 = padEnd(parts1.map(sanitize).join('  '), cols - 9) + ' ' + padEnd(time, 8);

  const p2 = [];
  if (model.parents.length) {
    p2.push(model.parents.map((p) => `parent ${sanitize(p.name)} ${p.status}${p.paneId ? ` ${p.paneId}` : ''}`).join(', '));
  }
  const c = model.counts;
  const cp = [];
  if (c.in_progress) cp.push(`${c.in_progress} in_progress`);
  if (c.review) cp.push(`${c.review} review`);
  if (c.blocked) cp.push(`${c.blocked} blocked`);
  if (c.todo) cp.push(`${c.todo} todo${c.ready ? ` (${c.ready} ready)` : ''}`);
  if (c.done) cp.push(`${c.done} done`);
  if (c.failed) cp.push(`${c.failed} failed`);
  if (c.cancelled) cp.push(`${c.cancelled} cancelled`);
  if (cp.length) p2.push(`tasks ${cp.join(' · ')}`);
  const head2 = truncate(p2.join('   '), cols);
  const rule = '─'.repeat(cols);

  // Columns.
  const COLS = [
    { name: 'ID', w: 7, get: (r) => [r.id] },
    { name: 'STATE', w: 12, get: (r) => { const s = r.state === 'todo' && r.ready ? 'ready' : r.state; return [s, stateStyle[s]]; } },
    { name: 'ROLE', w: 5, get: (r) => [ROLE_SHORT[r.role] ?? '-'] },
    { name: 'AGENT', w: 14, get: (r) => [r.primaryName ? `${r.primary === 'reviewer' ? 'r:' : ''}${r.primaryName}` : '-'] },
    { name: 'HERDR', w: 8, get: (r) => { const s = !model.herdr.available ? '?' : (r.live?.status ?? '-'); return [s, herdrStyle[s]]; } },
    { name: 'PANE', w: 8, get: (r) => [r.live ? `${r.live.paneId}${r.matchVia === 'pane' ? '~' : ''}` : '-'] },
    { name: 'TAB / WS', w: 22, get: (r) => [r.live ? `${r.live.tabLabel} / ${r.live.workspaceLabel}` : '-'] },
    { name: 'DEPS', w: 6, get: (r) => { const pre = String(r.id).replace(/\d+$/, ''); return [r.deps.length ? r.deps.map((d) => String(d).replace(pre, '')).join(',') : '-']; } },
    { name: 'FIX', w: 4, get: (r) => [`${r.fix.rounds}/${r.fix.max}`] },
  ];
  let active = COLS.slice();
  const fixedOf = (cs) => 3 + cs.reduce((s, x) => s + x.w + 1, 0);
  for (const name of DROP_ORDER) {
    if (fixedOf(active) + TITLE_MIN <= cols) break;
    active = active.filter((x) => x.name !== name);
  }
  const titleW = Math.max(0, cols - fixedOf(active));

  // Body lines: { key?, build(selected) }.
  const body = [];
  const plain = (text, style) => ({ build: () => sty(style, truncate(sanitize(text), cols)) });
  const section = (text) => body.push(plain(text, B));

  if (!model.tracking) {
    for (const l of wrap(agtaskMessage(model), cols)) body.push(plain(l, null));
  } else if (view !== 'table') {
    body.push(legendLine(view, { cols, color }));
    const graph = { rows: viewRows(model, view) };
    const ctx = { cols, color, available: model.herdr.available };
    body.push(...(view === 'team' ? teamBody(graph, ctx) : depsBody(graph, ctx)));
  } else {
    body.push({ build: () => sty(D + B, truncate(`   ${active.map((x) => padEnd(x.name, x.w)).join(' ')} TITLE`, cols)) });
    if (model.tasks.length === 0) body.push(plain('   (no tasks)', D));
    for (const r of model.tasks) {
      body.push({
        key: r.key,
        build: (sel) => {
          const mark = `${sel ? '>' : ' '}${r.attention ? '!' : ' '} `;
          let line = sel ? mark : sty(null, mark[0]) + (r.attention ? sty(R + B, '!') : ' ') + ' ';
          for (const x of active) {
            const [text, style] = x.get(r);
            const cell = padEnd(sanitize(text), x.w);
            line += (sel ? cell : sty(style, cell)) + ' ';
          }
          line += truncate(sanitize(r.title), titleW);
          if (sel) {
            const w = strWidth(stripAnsi(line));
            return sty('\x1b[7m', line + ' '.repeat(Math.max(0, cols - w)));
          }
          return line;
        },
      });
    }
    if (model.hiddenTerminal > 0) body.push(plain(`   (${model.hiddenTerminal} finished tasks hidden - press a)`, D));
  }

  if ((!model.tracking || view === 'table') && model.untracked.length) {
    section(`${model.tracking ? 'Untracked agents' : 'Live agents in scope'} (${model.untracked.length})`);
    for (const a of model.untracked) {
      body.push({
        key: a.key,
        build: (sel) => untrackedLine(a, sel, cols, sty),
      });
    }
  }
  if ((!model.tracking || view === 'table') && (model.layout.orchTabs.length || model.layout.worktrees.length)) {
    section('Layout');
    for (const t of model.layout.orchTabs) {
      body.push(plain(`   tab  ${padEnd(sanitize(t.label), 14)} ${padEnd(sanitize(t.workspaceLabel), 26)} ${t.paneCount} panes  ${t.status}  ${t.agentNames.map(sanitize).join(', ')}`, null));
    }
    for (const w of model.layout.worktrees) {
      body.push(plain(`   wt   ${padEnd(sanitize(w.label), 14)} ${padEnd(sanitize(tilde(w.checkoutPath, home)), 26)} ${w.paneCount} panes  ${w.status}`, null));
    }
  }

  // Scrolling.
  const h = rows - 7;
  const len = body.length;
  let top = Math.max(0, Math.min(ui.scrollTop ?? 0, Math.max(0, len - h)));
  if (len <= h) top = 0;
  else {
    const s = body.findIndex((l) => l.key === selectedKey);
    const win = (t) => (t + h < len ? h - 1 : h);
    if (s >= 0) {
      if (s < top) top = s;
      while (s >= top + win(top) && top < len - h) top++;
    }
    top = Math.min(top, len - h);
  }
  const cut = len > h && top + h < len;
  const shown = body.slice(top, top + (cut ? h - 1 : h)).map((l) => l.build(l.key !== undefined && l.key === selectedKey));
  if (cut) shown.push(sty(D, truncate(`v ${len - (top + h - 1)} more`, cols)));
  while (shown.length < h) shown.push('');

  // Detail.
  let d1 = '';
  let d2 = '';
  const sel = model.allTasks.find((t) => t.key === selectedKey);
  if (sel) {
    d1 = `${sel.id}  ${sel.title}`;
    const dp = [];
    dp.push(`agent ${sel.agentName ?? '-'} ${model.herdr.available ? (sel.primary === 'agent' ? (sel.live?.status ?? 'gone') : '') : '?'} ${sel.primary === 'agent' && sel.live ? sel.live.paneId : ''}`.replace(/\s+/g, ' ').trim());
    if (sel.reviewerName) dp.push(`reviewer ${sel.reviewerName} ${model.herdr.available ? (sel.reviewerLive?.status ?? 'gone') : '?'}`);
    if (sel.plan != null) dp.push(`plan ${/^v/i.test(String(sel.plan)) ? sel.plan : `v${sel.plan}`}`);
    if (sel.deps.length) dp.push(`deps ${sel.deps.map((x) => `${x} (${sel.blockedBy.includes(x) ? 'waiting' : 'done'})`).join(', ')}`);
    if (sel.nextAction) dp.push(`next: ${sel.nextAction}`);
    if (sel.ambiguous) dp.push('ambiguous name');
    d2 = dp.join(' · ');
  } else {
    const ag = model.untracked.find((a) => a.key === selectedKey);
    const tr = !ag && selectedKey && (selectedKey.startsWith('team:') || selectedKey.startsWith('team-unassigned:'))
      ? viewRows(model, 'team').find((r) => r.key === selectedKey) : null;
    if (tr) {
      const words = (cs) => cs.map((c) => `${c.id} ${stateWord(c.state, c.ready)}`).join(', ');
      if (tr.type === 'unassigned') {
        d1 = `(unassigned)  created by ${tr.creator === null ? '?' : sanitize(tr.creator)}`;
        d2 = [tr.chips.length ? `tasks ${words(tr.chips)}` : null, tr.why].filter(Boolean).join(' · ');
      } else {
        d1 = `${tr.name}  ${tr.roles.join(', ')}`;
        const mine = new Set(tr.chips.map((c) => c.id));
        const reviewers = [...new Set(model.allTasks.filter((t) => mine.has(t.id) && t.reviewerName).map((t) => t.reviewerName))];
        d2 = [
          `${tr.agentKind ?? '-'} ${tr.status} ${tr.paneId ?? ''}`.trim(),
          tr.live ? `${tr.live.tabLabel} / ${tr.live.workspaceLabel}` : null,
          tr.chips.length ? `tasks ${words(tr.chips)}` : null,
          reviewers.length ? `reviewed by ${reviewers.join(', ')}` : null,
          tr.reviewing.length ? `reviewing ${tr.reviewing.map((c) => c.id).join(', ')}` : null,
          tr.created > 0 ? `created ${tr.created}` : null,
          tr.also.length ? `also from ${tr.also.join(', ')}` : null,
          tr.why,
        ].filter(Boolean).join(' · ');
      }
    } else if (ag) {
      d1 = `${ag.name ?? ag.kind ?? 'agent'}  ${ag.paneId}`;
      d2 = [ag.status, `${ag.tabLabel} / ${ag.workspaceLabel}`, ag.cwd ? tilde(ag.cwd, home) : null].filter(Boolean).join(' · ');
    }
  }

  // Footer.
  const left = ui.statusMessage || KEY_HELP;
  const right = `events ${ui.events ?? 'connecting'} · db ${ui.dbWatch ?? 'none'} · agtask ${agtaskFooter(model.agtask)}`;
  const avail = cols - strWidth(right) - 1;
  const footer = avail >= 12 ? `${padEnd(sanitize(left), avail)} ${right}` : truncate(sanitize(left), cols);

  const lines = [
    color ? truncate(head1, cols).replace('orch-board', sty(B, 'orch-board')).replace(`[${view}]`, sty(B, `[${view}]`)) : truncate(head1, cols),
    sty(null, head2),
    sty(D, rule),
    ...shown,
    sty(D, rule),
    sty(B, truncate(sanitize(d1), cols)),
    truncate(sanitize(d2), cols),
    sty(D, truncate(footer, cols)),
  ];
  return { text: lines.join('\n'), selectable: keys, scrollTop: top, selectedKey };
}

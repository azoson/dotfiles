// Pure renderers: graph rows -> body lines for the team and deps views.
import { GUIDE, LEGEND, STATE_GLYPH, guideText, stateGlyph, stateWord } from './graph.mjs';
import { B, D, R, REV, ROLE_SHORT, Y, herdrStyle, stateStyle, untrackedLine } from './styles.mjs';
import { padEnd, sanitize, strWidth, truncate } from './text.mjs';

const CHIP_MIN = 12;
const TERMINAL = ['done', 'failed', 'cancelled'];

const plainOf = (spans) => spans.map((s) => s[0]).join('');
const render = (spans, color) => spans.map(([t, s]) => (s && color ? `${s}${t}\x1b[0m` : t)).join('');

// Clips spans to `width` columns (last partial span gets an ellipsis).
function clipSpans(spans, width) {
  const out = [];
  let used = 0;
  for (const [t, s] of spans) {
    const w = strWidth(t);
    if (used + w <= width) { out.push([t, s]); used += w; continue; }
    const rest = width - used;
    if (rest > 0) out.push([truncate(t, rest), s]);
    break;
  }
  return out;
}

function gutterSpans(sel, attention) {
  return [[sel ? '>' : ' ', null], [attention ? '!' : ' ', R + B], [' ', null]];
}

// Builds a selectable/plain row: spans (after the gutter) -> BodyLine.
function rowLine(row, spansAfterGutter, cols, color) {
  return {
    key: row.key ?? undefined,
    build(sel) {
      const g = gutterSpans(sel, row.attention);
      if (sel) {
        const plain = plainOf(clipSpans([...g, ...spansAfterGutter], cols));
        return `${color ? REV : ''}${plain}${' '.repeat(Math.max(0, cols - strWidth(plain)))}${color ? '\x1b[0m' : ''}`;
      }
      return render(clipSpans([...g, ...spansAfterGutter], cols), color);
    },
  };
}

const dimIf = (cond, style) => (cond ? D : style);

// ---------- team ----------

export function teamGuideBound(cols, nameCol) {
  return nameCol - 4;
}

const rolesText = (row, short) => (short ? row.roles.map((r) => ROLE_SHORT[r] ?? r) : row.roles).map(sanitize).join(',');

// Picks the column level once per frame (§5.1).
export function teamLayout(graph, cols) {
  const rows = graph.rows.filter((r) => r.type === 'node' || r.type === 'unassigned');
  const maxW = (f, cap) => Math.min(cap, rows.reduce((m, r) => Math.max(m, strWidth(f(r))), 0));
  const nameCol0 = rows.reduce((m, r) => Math.max(m, strWidth(guideText(r.guide)) + Math.max(4, strWidth(r.type === 'node' ? sanitize(r.name) : '(unassigned)'))), 0);
  let chosen = null;
  for (let level = 0; level <= 6; level++) {
    const short = level >= 1;
    const w = {
      roles: level <= 3 ? maxW((r) => rolesText(r, short), 24) : null,
      kind: level <= 1 ? maxW((r) => (r.type === 'node' ? sanitize(r.agentKind ?? '-') : ''), 8) : null,
      status: maxW((r) => (r.type === 'node' ? r.status : ''), 9),
      pane: level <= 2 ? maxW((r) => (r.type === 'node' ? sanitize(r.paneId ?? '-') : ''), 8) : null,
    };
    const nameCol = level === 5 ? Math.min(nameCol0, 16) : level === 6 ? Math.min(nameCol0, 12) : nameCol0;
    const active = ['roles', 'kind', 'status', 'pane'].filter((k) => w[k] !== null);
    const fixed = 3 + nameCol + active.reduce((s, k) => s + 2 + w[k], 0);
    chosen = { level, short, w, active, nameCol, fixed };
    if (fixed + 2 + CHIP_MIN <= cols) break;
  }
  return chosen;
}

function chipItems(row, compact) {
  const items = [];
  const g = (c) => stateGlyph(c.state, c.ready);
  const dimmed = (c) => TERMINAL.includes(c.state);
  for (const c of row.chips ?? []) {
    items.push(compact
      ? [[c.id, dimIf(dimmed(c))], [g(c), stateStyle[stateWord(c.state, c.ready)]]]
      : [[`${c.id} `, dimIf(dimmed(c))], [g(c), stateStyle[stateWord(c.state, c.ready)]], [stateWord(c.state, c.ready), dimIf(dimmed(c))]]);
  }
  const group = (label, list) => {
    if (!list?.length) return;
    if (compact) {
      for (const c of list) items.push([[`r:${c.id}`, null], [g(c), stateStyle[stateWord(c.state, c.ready)]]]);
    } else {
      items.push([[`${label} ${list.map((c) => c.id).join(', ')}`, null]]);
    }
  };
  group('reviewing', row.reviewing);
  group('reviews', row.reviews);
  if (!compact && row.also?.length) items.push([[`also: ${row.also.map(sanitize).join(', ')}`, D]]);
  return items;
}

function fitChips(row, area) {
  if (area < 4) return [];
  const join = (items, sep) => items.flatMap((it, i) => (i ? [[sep, null], ...it] : it));
  const full = join(chipItems(row, false), '  ');
  if (strWidth(plainOf(full)) <= area) return full;
  const compact = chipItems(row, true);
  if (strWidth(plainOf(join(compact, ' '))) <= area) return join(compact, ' ');
  const kept = [];
  for (let i = 0; i < compact.length; i++) {
    const cand = [...kept, compact[i]];
    const n = compact.length - (i + 1);
    const w = strWidth(plainOf(join(cand, ' '))) + (n > 0 ? strWidth(` +${n}`) : 0);
    if (w <= area) kept.push(compact[i]); else break;
  }
  const rest = compact.length - kept.length;
  const more = `+${rest}`;
  if (!kept.length) return strWidth(more) <= area ? [[more, D]] : [];
  return [...join(kept, ' '), [` ${more}`, D]];
}

export function legendLine(view, { cols, color }) {
  const tokens = LEGEND[view].split(' ');
  const glyphState = Object.fromEntries(Object.entries(STATE_GLYPH).map(([s, gl]) => [gl, s]));
  const spans = [['   ', null]];
  tokens.forEach((tok, i) => {
    if (i) spans.push([' ', null]);
    const first = [...tok][0];
    if (first && glyphState[first]) spans.push([first, stateStyle[glyphState[first]]], [tok.slice(first.length), D]);
    else spans.push([tok, D]);
  });
  return { build: () => render(clipSpans(spans, cols), color) };
}

export function teamBody(graph, { cols, color, available }) {
  const lay = teamLayout(graph, cols);
  const area = cols - lay.fixed - 2;
  return graph.rows.map((row) => {
    if (row.type === 'note') return { build: () => render(clipSpans([['   ' + sanitize(row.text), D]], cols), color) };
    if (row.type === 'section') return { build: () => render(clipSpans([[sanitize(row.text), B]], cols), color) };
    if (row.type === 'agent') {
      return { key: row.key, build: (sel) => untrackedLine(row, sel, cols, (c, t) => (color && c ? `${c}${t}\x1b[0m` : t)) };
    }
    if (row.type === 'edge') {
      // Same compression as the node rows (+2 for the wider attached guide) so the pipes line up.
      const g = guideText(row.guide, Math.min(teamGuideBound(cols, lay.nameCol) + 2, cols - 3 - 8));
      let text = `◂── reviews ── ${sanitize(row.reviewer)}`;
      if (['gone', 'ambiguous', '?'].includes(row.reviewerStatus)) text += ` (${row.reviewerStatus})`;
      text = truncate(text, Math.max(0, cols - 3 - strWidth(g)));
      return rowLine({ key: null, attention: false }, [[g, D], [text, row.active ? Y : D]], cols, color);
    }
    // node / unassigned
    const unassigned = row.type === 'unassigned';
    const g = guideText(row.guide, teamGuideBound(cols, lay.nameCol));
    const rawName = unassigned ? '(unassigned)' : sanitize(row.name);
    const name = truncate(rawName, Math.max(0, lay.nameCol - strWidth(g)));
    const nameCell = padEnd(g + name, lay.nameCol);
    const dim = unassigned ? D : null;
    const orch = !unassigned && row.created > 0 && row.depth === 0;
    const spans = [[g, D], [name, unassigned ? D : orch ? B : null], [' '.repeat(strWidth(nameCell) - strWidth(g) - strWidth(name)), null]];
    for (const k of lay.active) {
      let text = '';
      let style = dim;
      if (k === 'roles') text = rolesText(row, lay.short);
      else if (!unassigned && k === 'kind') text = sanitize(row.agentKind ?? '-');
      else if (!unassigned && k === 'status') { text = row.status; style = herdrStyle[row.status]; }
      else if (!unassigned && k === 'pane') text = sanitize(row.paneId ?? '-');
      spans.push(['  ', null], [padEnd(text, lay.w[k]), style]);
    }
    const chips = fitChips(row, area);
    if (chips.length) spans.push(['  ', null], ...(unassigned ? chips.map(([t, s]) => [t, s ?? D]) : chips));
    return rowLine(row, spans, cols, color);
  });
}

// ---------- deps ----------

export function depsGuideBound(cols) {
  return Math.max(8, cols - 3 - 20);
}

function fmtExtra(e, short, ownPrefix) {
  const id = short ? e.id.replace(ownPrefix, '') : e.id;
  if (e.dangling) return `${id}?`;
  if (!e.visible) return `${id}${stateGlyph(e.state, e.ready)}`;
  return id;
}

export function depsBody(graph, { cols, color }) {
  return graph.rows.map((row) => {
    if (row.type === 'note') return { build: () => render(clipSpans([['   ' + sanitize(row.text), D]], cols), color) };
    if (row.type !== 'task') return { build: () => '' };
    const g = guideText(row.guide, depsGuideBound(cols));
    const avail = cols - 3 - strWidth(g);
    const prefix = String(row.id).replace(/\d+$/, '');
    const id = sanitize(row.id);
    const seg = {
      idg: `${id} ${stateGlyph(row.state, row.ready)}`,
      role: sanitize(row.role ?? '-'),
      roleShort: ROLE_SHORT[row.role] ?? sanitize(row.role ?? '-'),
      who: null,
      status: row.status,
      annot: null,
      fix: row.fix.rounds > 0 ? `fix ${row.fix.rounds}/${row.fix.max}` : null,
      title: sanitize(row.title),
    };
    const an = sanitize(row.agentName ?? '-');
    const rv = row.reviewerName ? sanitize(row.reviewerName) : null;
    const whoFull = row.inReview ? (rv ? `${an} → review: ${rv}` : `${an} → review`) : an;
    seg.who = whoFull;
    const hasAnnot = row.extra.length > 0 || row.cycle;
    const mkAnnot = (short) => (hasAnnot
      ? { ids: row.extra.map((e) => fmtExtra(e, short, prefix)).join(short ? ',' : ', '), waiting: row.waiting, cycle: row.cycle }
      : null);
    const st = { role: seg.role, who: whoFull, annot: mkAnnot(false), fix: seg.fix, title: seg.title, status: seg.status, showRole: true, showStatus: true };
    const annotText = (a) => (a ? `⇠ ${a.ids}${a.waiting ? ' (waiting)' : ''}${a.cycle ? ' (cycle)' : ''}` : null);
    const segs = (withTitle = true) => [
      seg.idg,
      st.showRole ? st.role : null,
      st.who,
      st.showStatus ? st.status : null,
      annotText(st.annot),
      st.fix,
      withTitle ? st.title : null,
    ].filter((x) => x !== null && x !== '');
    const width = () => strWidth(segs().join('  '));
    if (width() > avail) {
      // 1. title
      if (st.title) {
        const others = segs(false);
        const rem = avail - strWidth(others.join('  ')) - 2;
        st.title = rem >= 8 ? truncate(st.title, rem) : null;
      }
    }
    const steps = [
      () => { st.fix = null; },
      () => { st.role = seg.roleShort; },
      () => { st.annot = mkAnnot(true); },
      () => { if (row.inReview) st.who = rv ? `→ ${rv}` : '→ review'; },
      () => { st.showRole = false; },
      () => { st.showStatus = false; },
    ];
    for (const s of steps) {
      if (width() <= avail) break;
      s();
    }
    // Styled spans from the fitted state.
    const dimRow = row.terminal;
    const spans = [[g, D]];
    const sep = () => spans.push(['  ', null]);
    spans.push([`${id} `, dimRow ? D : null], [stateGlyph(row.state, row.ready), stateStyle[stateWord(row.state, row.ready)]]);
    if (st.showRole && st.role) { sep(); spans.push([st.role, dimRow ? D : null]); }
    if (st.who) { sep(); spans.push([st.who, dimRow ? D : null]); }
    if (st.showStatus && st.status) { sep(); spans.push([st.status, dimRow ? D : herdrStyle[st.status]]); }
    if (st.annot) {
      sep();
      spans.push([`⇠ ${st.annot.ids}`, D]);
      if (st.annot.waiting) spans.push([' (waiting)', Y]);
      if (st.annot.cycle) spans.push([' (cycle)', R]);
    }
    if (st.fix) { sep(); spans.push([st.fix, dimRow ? D : null]); }
    if (st.title) { sep(); spans.push([st.title, dimRow ? D : null]); }
    // Step 8: truncate the label (everything after the guide).
    const label = clipSpans(spans.slice(1), avail);
    return rowLine(row, [spans[0], ...label], cols, color);
  });
}

export { GUIDE };

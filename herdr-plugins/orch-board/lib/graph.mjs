// Pure graph builders for the team and deps views (no width math, no styling, no I/O).
import { strWidth } from './text.mjs';
import { taskSeq } from './model.mjs';

export const STATE_GLYPH = Object.freeze({
  todo: '○',
  ready: '◎',
  in_progress: '◐',
  review: '●',
  blocked: '■',
  done: '✓',
  failed: '✗',
  cancelled: '×',
});
export const stateGlyph = (state, ready) => (ready && state === 'todo' ? STATE_GLYPH.ready : STATE_GLYPH[state] ?? '?');
export const stateWord = (state, ready) => (ready && state === 'todo' ? 'ready' : String(state));

export const GUIDE = Object.freeze({ lead: ' ', pipe: '│   ', gap: '    ', mid: '├─▸ ', last: '└─▸ ', apipe: '│ ', agap: '  ' });

export function nodeGuide(ancestorsLast, isLast, depth) {
  if (depth === 0) return [];
  return ['lead', ...ancestorsLast.map((l) => (l ? 'gap' : 'pipe')), isLast ? 'last' : 'mid'];
}

export function attachedGuide(ancestorsLast, isLast, depth, hasChildren) {
  const tail = hasChildren ? 'apipe' : 'agap';
  if (depth === 0) return ['lead', tail];
  return ['lead', ...ancestorsLast.map((l) => (l ? 'gap' : 'pipe')), isLast ? 'gap' : 'pipe', tail];
}

export function guideText(tokens, maxWidth = Infinity) {
  const text = (ts) => ts.map((t) => GUIDE[t]).join('');
  const full = text(tokens);
  if (strWidth(full) <= maxWidth) return full;
  if (tokens.length === 0) return '';
  const lastTok = tokens[tokens.length - 1];
  let levels = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === 'pipe' || tokens[i] === 'gap') levels++;
    const cand = `»${levels} ${text(tokens.slice(i + 1))}`;
    if (strWidth(cand) <= maxWidth) return cand;
  }
  return GUIDE[lastTok];
}

export const LEGEND_STATES = '○todo ◎ready ◐in_progress ●review ■blocked ✓done ✗failed ×cancelled';
export const LEGEND = { team: `${LEGEND_STATES}  ◂── reviewer`, deps: `${LEGEND_STATES}  ⇠ other deps` };

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const seqOf = (t) => taskSeq(t.id);
const bySeq = (a, b) => seqOf(a) - seqOf(b);
const chip = (t) => ({ id: t.id, state: t.state, ready: t.ready });
const distinct = (xs) => [...new Set(xs)];

function trailer(model, V, rows, { untracked }) {
  if (V.length === 0) rows.unshift(note('(no tasks)'));
  if (model.hiddenTerminal > 0) rows.push(note(`(${model.hiddenTerminal} finished tasks hidden - press a)`));
  if (untracked && model.untracked.length) {
    rows.push({ key: null, type: 'section', guide: [], attention: false, target: null, why: null, text: `Untracked agents (${model.untracked.length})` });
    for (const a of model.untracked) {
      rows.push({ ...a, key: a.key, type: 'agent', guide: [], attention: false, target: a.paneId, why: null });
    }
  }
}
const note = (text) => ({ key: null, type: 'note', guide: [], attention: false, target: null, why: null, text });

export function buildTeamGraph(model) {
  const V = [...model.tasks].sort(bySeq);
  const people = new Map(model.people.map((p) => [p.name, p]));
  const available = model.herdr.available;

  const statusOf = (name) => {
    if (!available) return '?';
    const p = people.get(name);
    if (p?.ambiguous) return 'ambiguous';
    if (p?.live) return p.live.status;
    return 'gone';
  };

  // Names in first-seen order.
  const nameSet = [];
  for (const t of V) for (const n of [t.createdBy, t.agentName, t.reviewerName]) if (n && !nameSet.includes(n)) nameSet.push(n);
  const nameIn = new Set(nameSet);

  const info = new Map();
  for (const name of nameSet) {
    const agentTasks = V.filter((t) => t.agentName === name);
    const reviewTasks = V.filter((t) => t.reviewerName === name);
    const createdTasks = V.filter((t) => t.createdBy === name);
    const seqs = [...agentTasks, ...reviewTasks, ...createdTasks].map(seqOf);
    const anchor = agentTasks[0] ?? reviewTasks[0] ?? null;
    let parent = anchor?.createdBy ?? null;
    if (parent === name || !parent || !nameIn.has(parent)) parent = null;
    const also = distinct([...agentTasks, ...reviewTasks].sort(bySeq).map((t) => t.createdBy))
      .filter((c) => c && c !== parent && c !== name);
    info.set(name, { name, agentTasks, reviewTasks, createdTasks, firstSeq: Math.min(...seqs), anchor, parent, also });
  }

  const childNames = (p) => nameSet
    .filter((n) => info.get(n).parent === p)
    .sort((a, b) => {
      const A = info.get(a), B = info.get(b);
      return (A.agentTasks.length ? 0 : 1) - (B.agentTasks.length ? 0 : 1)
        || seqOf(A.anchor) - seqOf(B.anchor)
        || cmp(a, b);
    });
  const unassignedOf = (creator) => V.filter((t) => (creator === null ? t.createdBy === null : t.createdBy === creator) && !t.agentName);

  const rolesOf = (i) => {
    const r = distinct(i.agentTasks.map((t) => t.role).filter(Boolean));
    if (i.reviewTasks.length && !r.includes('review')) r.push('review');
    return r;
  };

  const rows = [];
  const visited = new Set();
  const unassignedEmitted = new Set();

  function emitFrom(rootItem) {
    const stack = [rootItem];
    while (stack.length) {
      const it = stack.pop();
      if (it.kind === 'unassigned') {
        const tasks = unassignedOf(it.creator);
        unassignedEmitted.add(it.creator);
        rows.push({
          key: `team-unassigned:${it.creator ?? ''}`,
          type: 'unassigned',
          guide: nodeGuide(it.ancestorsLast, it.isLast, it.depth),
          attention: false,
          target: null,
          why: `no agent: ${tasks.map((t) => t.id).join(', ')} unassigned`,
          creator: it.creator,
          depth: it.depth,
          roles: distinct(tasks.map((t) => t.role).filter(Boolean)),
          chips: tasks.map(chip),
        });
        continue;
      }
      if (visited.has(it.name)) continue;
      visited.add(it.name);
      const i = info.get(it.name);
      const person = people.get(it.name);
      const live = person?.live ?? null;
      const status = statusOf(it.name);
      const kids = childNames(it.name).filter((n) => !visited.has(n));
      const hasUn = unassignedOf(it.name).length > 0;
      const hasChildren = kids.length > 0 || hasUn;
      const target = live?.paneId ?? null;
      const why = target ? null
        : !available ? `no live agent: ${it.name} (herdr unavailable)`
          : status === 'ambiguous' ? `no live agent: ${it.name} (several herdr agents have this name)`
            : `no live agent: ${it.name} (not running in herdr)`;
      const working = i.agentTasks.some((t) => t.state === 'in_progress' || (t.state === 'review' && !t.reviewerName))
        || i.reviewTasks.some((t) => t.state === 'review');
      const attention = status === 'ambiguous'
        || live?.status === 'blocked'
        || i.agentTasks.some((t) => t.state === 'blocked')
        || (available && !live && status !== 'ambiguous' && working);
      const reviewing = i.reviewTasks.filter((t) => t.state === 'review');
      rows.push({
        key: `team:${it.name}`,
        type: 'node',
        guide: nodeGuide(it.ancestorsLast, it.isLast, it.depth),
        attention,
        target,
        why,
        name: it.name,
        depth: it.depth,
        roles: rolesOf(i),
        agentKind: live?.kind ?? null,
        status,
        paneId: live?.paneId ?? null,
        live,
        chips: i.agentTasks.map(chip),
        reviewing: reviewing.map(chip),
        reviews: i.reviewTasks.filter((t) => t.state !== 'review').map(chip),
        created: i.createdTasks.length,
        also: i.also,
      });
      // Reviewer relation lines.
      const reviewers = distinct(i.agentTasks.map((t) => t.reviewerName).filter((r) => r && r !== it.name));
      for (const r of reviewers) {
        const ts = i.agentTasks.filter((t) => t.reviewerName === r);
        rows.push({
          key: null,
          type: 'edge',
          guide: attachedGuide(it.ancestorsLast, it.isLast, it.depth, hasChildren),
          attention: false,
          target: null,
          why: null,
          reviewer: r,
          taskIds: ts.map((t) => t.id),
          active: ts.some((t) => t.state === 'review'),
          reviewerStatus: statusOf(r),
        });
      }
      const childAncestors = it.depth === 0 ? [] : [...it.ancestorsLast, it.isLast];
      const list = kids.map((n) => ({ kind: 'node', name: n }));
      if (hasUn) list.push({ kind: 'unassigned', creator: it.name });
      list.forEach((c, idx) => Object.assign(c, { depth: it.depth + 1, ancestorsLast: childAncestors, isLast: idx === list.length - 1 }));
      for (let k = list.length - 1; k >= 0; k--) stack.push(list[k]);
    }
  }

  const rootOrder = (a, b) => info.get(a).firstSeq - info.get(b).firstSeq || cmp(a, b);
  const roots = nameSet.filter((n) => info.get(n).parent === null).sort(rootOrder);
  for (const n of roots) emitFrom({ kind: 'node', name: n, depth: 0, ancestorsLast: [], isLast: true });
  for (;;) {
    const rest = nameSet.filter((n) => !visited.has(n)).sort(rootOrder);
    if (!rest.length) break;
    emitFrom({ kind: 'node', name: rest[0], depth: 0, ancestorsLast: [], isLast: true });
  }
  if (unassignedOf(null).length) emitFrom({ kind: 'unassigned', creator: null, depth: 0, ancestorsLast: [], isLast: true });

  trailer(model, V, rows, { untracked: true });
  return { rows };
}

export function buildDepGraph(model) {
  const V = [...model.tasks].sort(bySeq);
  const vis = new Set(V.map((t) => t.id));
  const byId = new Map(model.allTasks.map((t) => [t.id, t]));
  const available = model.herdr.available;

  const visDeps = (t) => t.deps.filter((d) => vis.has(d) && d !== t.id);
  const parentOf = (t) => (visDeps(t).length === 1 ? visDeps(t)[0] : null);
  const kidsOf = (id) => V.filter((t) => parentOf(t) === id);
  const TERMINAL = ['done', 'failed', 'cancelled'];

  const rows = [];
  const visited = new Set();

  function emitFrom(rootTask, cycleRoot) {
    const stack = [{ t: rootTask, depth: 0, ancestorsLast: [], isLast: true, cycle: cycleRoot }];
    while (stack.length) {
      const it = stack.pop();
      const t = it.t;
      if (visited.has(t.id)) continue;
      visited.add(t.id);
      const parent = it.cycle ? null : parentOf(t);
      const terminal = TERMINAL.includes(t.state);
      const status = !available ? '?'
        : t.ambiguous ? 'ambiguous'
          : t.live ? t.live.status
            : t.primaryName ? 'gone' : '-';
      rows.push({
        key: t.key,
        type: 'task',
        guide: nodeGuide(it.ancestorsLast, it.isLast, it.depth),
        attention: t.attention,
        target: t.live?.paneId ?? null,
        why: t.live ? null : `no live agent for ${t.id}`,
        id: t.id,
        depth: it.depth,
        state: t.state,
        ready: t.ready,
        role: t.role,
        title: t.title,
        agentName: t.agentName,
        reviewerName: t.reviewerName,
        inReview: t.state === 'review',
        status,
        paneId: t.live?.paneId ?? null,
        terminal,
        extra: t.deps.filter((d) => d !== parent).map((d) => {
          const o = byId.get(d);
          return { id: d, state: o?.state ?? null, ready: Boolean(o?.ready), visible: vis.has(d), dangling: !o };
        }),
        waiting: t.blockedBy.length > 0 && !terminal,
        cycle: it.cycle || t.deps.includes(t.id),
        fix: t.fix,
      });
      const kids = kidsOf(t.id).filter((k) => !visited.has(k.id));
      const childAncestors = it.depth === 0 ? [] : [...it.ancestorsLast, it.isLast];
      for (let k = kids.length - 1; k >= 0; k--) {
        stack.push({ t: kids[k], depth: it.depth + 1, ancestorsLast: childAncestors, isLast: k === kids.length - 1, cycle: false });
      }
    }
  }

  for (const t of V.filter((x) => parentOf(x) === null)) emitFrom(t, false);
  for (;;) {
    const rest = V.find((t) => !visited.has(t.id));
    if (!rest) break;
    emitFrom(rest, true);
  }

  trailer(model, V, rows, { untracked: false });
  return { rows };
}

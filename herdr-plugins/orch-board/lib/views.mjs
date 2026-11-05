// View cycling, selection keys and Enter targets (pure).
import { buildDepGraph, buildTeamGraph } from './graph.mjs';

export const VIEWS = Object.freeze(['table', 'team', 'deps']);

export function cycleView(view, dir) {
  const i = VIEWS.indexOf(view);
  if (i < 0) return 'table';
  return VIEWS[(i + (dir < 0 ? -1 : 1) + VIEWS.length) % VIEWS.length];
}

export function viewRows(model, view) {
  if (view === 'team') return buildTeamGraph(model).rows;
  if (view === 'deps') return buildDepGraph(model).rows;
  return null;
}

export function selectableKeys(model, view = 'table') {
  if (!model.tracking) return model.untracked.map((a) => a.key);
  if (view === 'team' || view === 'deps') return viewRows(model, view).filter((r) => r.key).map((r) => r.key);
  return [...model.tasks.map((t) => t.key), ...model.untracked.map((a) => a.key)];
}

export function resolveTarget(model, view, key) {
  if (!key) return null;
  if (key.startsWith('agent:')) {
    const a = model.untracked.find((x) => x.key === key);
    return a ? { paneId: a.paneId } : null;
  }
  if (key.startsWith('task:')) {
    const row = model.allTasks.find((t) => t.key === key);
    if (!row) return null;
    return row.live ? { paneId: row.live.paneId } : { why: `no live agent for ${row.id}` };
  }
  if (key.startsWith('team:') || key.startsWith('team-unassigned:')) {
    const row = viewRows(model, 'team')?.find((r) => r.key === key);
    if (!row) return null;
    return row.target ? { paneId: row.target } : { why: row.why };
  }
  return null;
}

export function carrySelection(model, fromView, fromKey, toView) {
  if (!fromKey || !model) return null;
  const toKeys = selectableKeys(model, toView);
  const ok = (k) => (toKeys.includes(k) ? k : null);
  const rowOf = (key) => model.allTasks.find((t) => t.key === key);
  const taskKeys = toKeys.filter((k) => k.startsWith('task:'));
  const firstTask = (pred) => taskKeys.find((k) => { const r = rowOf(k); return r && pred(r); }) ?? null;

  if (fromKey.startsWith('agent:')) return ok(fromKey);
  if (fromKey.startsWith('task:')) {
    if (toView !== 'team') return ok(fromKey);
    const row = rowOf(fromKey);
    if (!row) return null;
    for (const c of [row.primaryName && `team:${row.primaryName}`, row.agentName && `team:${row.agentName}`, `team-unassigned:${row.createdBy ?? ''}`]) {
      if (c && toKeys.includes(c)) return c;
    }
    return null;
  }
  if (toView === 'team') return ok(fromKey);
  if (fromKey.startsWith('team-unassigned:')) {
    const c = fromKey.slice('team-unassigned:'.length);
    return firstTask((r) => !r.agentName && (r.createdBy ?? '') === c);
  }
  if (fromKey.startsWith('team:')) {
    const name = fromKey.slice('team:'.length);
    return firstTask((r) => r.agentName === name || r.primaryName === name)
      ?? firstTask((r) => r.reviewerName === name)
      ?? firstTask((r) => r.createdBy === name);
  }
  return null;
}

export function switchView({ view, selection }, model, dir) {
  const to = cycleView(view, dir);
  const next = { ...selection };
  if (model) {
    const keys = selectableKeys(model, to);
    if (!(next[to] && keys.includes(next[to]))) next[to] = carrySelection(model, view, selection[view], to);
  }
  return { view: to, selection: next };
}

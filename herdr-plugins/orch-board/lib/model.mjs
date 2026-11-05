// Pure model: joins agtask tasks with the live herdr snapshot.
import { dirname } from 'node:path';

export const TERMINAL = ['done', 'failed', 'cancelled'];

export function taskSeq(id) {
  const m = /(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : Infinity;
}

const isTerminal = (state) => TERMINAL.includes(state);
const DB_SUFFIX = '/.agtask/tasks.db';

export function buildModel({ snapshot, agtask, scopeWorkspaceId, repoCwd, showAll }) {
  const available = snapshot != null;
  const agents = snapshot?.agents ?? [];
  const workspaces = snapshot?.workspaces ?? [];
  const tabs = snapshot?.tabs ?? [];
  const wsById = new Map(workspaces.map((w) => [w.workspace_id, w]));
  const tabById = new Map(tabs.map((t) => [t.tab_id, t]));
  const byName = new Map();
  const byPane = new Map();
  for (const a of agents) {
    byPane.set(a.pane_id, a);
    if (a.name) {
      if (!byName.has(a.name)) byName.set(a.name, []);
      byName.get(a.name).push(a);
    }
  }

  const ref = (a) => ({
    paneId: a.pane_id,
    name: a.name ?? null,
    kind: a.agent ?? null,
    status: a.agent_status ?? 'unknown',
    tabId: a.tab_id,
    tabLabel: tabById.get(a.tab_id)?.label ?? '?',
    workspaceId: a.workspace_id,
    workspaceLabel: wsById.get(a.workspace_id)?.label ?? '?',
    cwd: a.foreground_cwd ?? a.cwd ?? null,
  });

  function resolve(name, paneHint) {
    if (name) {
      const list = byName.get(name) ?? [];
      if (list.length === 1) return { agent: list[0], via: 'name', ambiguous: false };
      if (list.length >= 2) return { agent: null, via: null, ambiguous: true };
    }
    if (paneHint) {
      const a = byPane.get(paneHint);
      if (a && !a.name) return { agent: a, via: 'pane', ambiguous: false };
    }
    return { agent: null, via: null, ambiguous: false };
  }

  const allTasks = agtask?.tasks ?? [];
  const tracking = agtask?.tasks != null;

  const tiedNames = new Set();
  for (const t of allTasks) for (const n of [t.agent, t.reviewer, t.created_by]) if (n) tiedNames.add(n);
  const tiedPanes = new Set();

  const counts = { todo: 0, ready: 0, in_progress: 0, review: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 };
  for (const t of allTasks) {
    if (t.state in counts) counts[t.state]++;
    if (t.state === 'todo' && t.ready) counts.ready++;
  }

  // Parents.
  const live = allTasks.filter((t) => !isTerminal(t.state));
  const parentNames = [];
  for (const t of live.length ? live : allTasks) {
    if (t.created_by && !parentNames.includes(t.created_by)) parentNames.push(t.created_by);
  }
  const parentAgents = [];
  const parents = parentNames.map((name) => {
    const r = resolve(name, null);
    if (r.agent) { tiedPanes.add(r.agent.pane_id); parentAgents.push(r.agent); }
    return { name, status: r.agent ? (r.agent.agent_status ?? 'unknown') : 'gone', paneId: r.agent?.pane_id ?? null };
  });

  // Task rows.
  const matched = [...parentAgents];
  const rows = allTasks.map((t) => {
    const primary = t.state === 'review' && t.reviewer ? 'reviewer' : 'agent';
    const primaryName = (primary === 'reviewer' ? t.reviewer : t.agent) ?? null;
    const p = resolve(primaryName, primary === 'agent' ? t.pane : null);
    const rv = resolve(t.reviewer, null);
    if (p.agent) { tiedPanes.add(p.agent.pane_id); matched.push(p.agent); }
    if (rv.agent) { tiedPanes.add(rv.agent.pane_id); matched.push(rv.agent); }
    const liveRef = p.agent ? ref(p.agent) : null;
    const ambiguous = p.ambiguous;
    const attention = t.state === 'blocked'
      || liveRef?.status === 'blocked'
      || ((t.state === 'in_progress' || t.state === 'review') && liveRef === null && available)
      || ambiguous;
    return {
      key: `task:${t.id}`,
      id: t.id,
      title: t.title ?? '',
      role: t.role ?? null,
      state: t.state,
      ready: Boolean(t.ready),
      plan: t.plan ?? null,
      fix: { rounds: t.fix_rounds ?? 0, max: t.max_fix_rounds ?? 0 },
      deps: t.deps ?? [],
      blockedBy: t.blocked_by ?? [],
      nextAction: t.next_action ?? null,
      agentName: t.agent ?? null,
      reviewerName: t.reviewer ?? null,
      primary,
      primaryName,
      live: liveRef,
      matchVia: p.via,
      reviewerLive: rv.agent ? ref(rv.agent) : null,
      ambiguous,
      attention,
    };
  });

  // Repo.
  const db = agtask?.db ?? null;
  const root = db && db.endsWith(DB_SUFFIX) ? dirname(dirname(db)) : null;

  // Scope.
  const scopeIds = new Set();
  if (available) {
    const scopeWs = scopeWorkspaceId ? wsById.get(scopeWorkspaceId) : null;
    if (scopeWorkspaceId) scopeIds.add(scopeWorkspaceId);
    const key = scopeWs?.worktree?.repo_key;
    for (const w of workspaces) {
      if (key && w.worktree?.repo_key === key) scopeIds.add(w.workspace_id);
      if (root && w.worktree?.repo_root === root) scopeIds.add(w.workspace_id);
    }
    for (const a of matched) scopeIds.add(a.workspace_id);
  }
  const scopeWorkspaceIds = [...scopeIds]
    .filter((id) => wsById.has(id) || id === scopeWorkspaceId)
    .sort((a, b) => (wsById.get(a)?.number ?? Infinity) - (wsById.get(b)?.number ?? Infinity));

  // Filter + sort.
  const visible = rows.filter((r) => !isTerminal(r.state) || showAll || r.live !== null);
  const hiddenTerminal = rows.length - visible.length;
  const seqCmp = (a, b) => taskSeq(a.id) - taskSeq(b.id);
  const taskRows = [
    ...visible.filter((r) => !isTerminal(r.state)).sort(seqCmp),
    ...visible.filter((r) => isTerminal(r.state)).sort(seqCmp),
  ];

  // Untracked.
  const wsNum = (id) => wsById.get(id)?.number ?? Infinity;
  const tabNum = (id) => tabById.get(id)?.number ?? Infinity;
  const untracked = available
    ? agents
      .filter((a) => scopeIds.has(a.workspace_id) && !tiedPanes.has(a.pane_id) && (!a.name || !tiedNames.has(a.name)))
      .sort((a, b) => wsNum(a.workspace_id) - wsNum(b.workspace_id) || tabNum(a.tab_id) - tabNum(b.tab_id) || (a.pane_id < b.pane_id ? -1 : a.pane_id > b.pane_id ? 1 : 0))
      .map((a) => ({ key: `agent:${a.pane_id}`, ...ref(a) }))
    : [];

  // Layout.
  const orchTabs = available
    ? tabs
      .filter((t) => scopeIds.has(t.workspace_id) && String(t.label ?? '').startsWith('orch-'))
      .sort((a, b) => wsNum(a.workspace_id) - wsNum(b.workspace_id) || (a.number ?? 0) - (b.number ?? 0))
      .map((t) => ({
        tabId: t.tab_id,
        label: t.label,
        workspaceLabel: wsById.get(t.workspace_id)?.label ?? '?',
        paneCount: t.pane_count ?? 0,
        status: t.agent_status ?? 'unknown',
        agentNames: agents.filter((a) => a.tab_id === t.tab_id).map((a) => a.name || `${a.agent ?? 'agent'}:${a.pane_id}`),
      }))
    : [];
  const worktrees = available
    ? workspaces
      .filter((w) => scopeIds.has(w.workspace_id) && w.worktree?.is_linked_worktree === true)
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
      .map((w) => ({
        workspaceId: w.workspace_id,
        label: w.label,
        checkoutPath: w.worktree.checkout_path ?? '',
        paneCount: w.pane_count ?? 0,
        status: w.agent_status ?? 'unknown',
      }))
    : [];

  return {
    repo: { cwd: repoCwd ?? null, db, root },
    agtask: { status: agtask?.status ?? 'error', code: agtask?.code ?? null, message: agtask?.message ?? null, stale: Boolean(agtask?.stale) },
    herdr: { available },
    counts,
    parents,
    tasks: taskRows,
    hiddenTerminal,
    untracked,
    layout: { orchTabs, worktrees },
    scopeWorkspaceIds,
    scopeWorkspaceLabel: wsById.get(scopeWorkspaceId)?.label ?? null,
    tracking,
  };
}

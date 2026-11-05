import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel, taskSeq } from '../lib/model.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const DB = '/repo/example/.agtask/tasks.db';
const clone = (o) => JSON.parse(JSON.stringify(o));

function build(over = {}) {
  const snapshot = over.snapshot === undefined ? fx('snapshot.json') : over.snapshot;
  const tasks = over.tasks ?? fx('agtask-ls.json').tasks;
  return buildModel({
    snapshot,
    agtask: over.agtask ?? { status: 'ok', tasks, db: DB },
    scopeWorkspaceId: over.scope === undefined ? 'w1' : over.scope,
    repoCwd: '/repo/example',
    showAll: over.showAll ?? false,
  });
}
const row = (m, id) => m.tasks.find((t) => t.id === id);

test('taskSeq', () => {
  assert.equal(taskSeq('AGT-12'), 12);
  assert.equal(taskSeq('weird'), Infinity);
});

test('name join across workspaces', () => {
  const m = build();
  assert.equal(row(m, 'AGT-2').live.paneId, 'w1:p2');
  assert.equal(row(m, 'AGT-2').matchVia, 'name');
  assert.equal(row(m, 'AGT-4').live.paneId, 'w2:p1');
  assert.equal(row(m, 'AGT-4').live.workspaceLabel, 'auth-wt');
  assert.equal(row(m, 'AGT-2').live.tabLabel, 'orch-auth');
  assert.equal(m.repo.root, '/repo/example');
});

test('pane fallback only for unnamed agents', () => {
  const snap = fx('snapshot.json');
  const tasks = fx('agtask-ls.json').tasks;
  // impl-a vanishes; the claimed pane hosts an unnamed agent -> pane match
  snap.agents.find((a) => a.pane_id === 'w1:p2').name = null;
  let m = build({ snapshot: snap, tasks });
  assert.equal(row(m, 'AGT-2').live.paneId, 'w1:p2');
  assert.equal(row(m, 'AGT-2').matchVia, 'pane');
  // claimed pane hosts a differently named agent -> no join
  snap.agents.find((a) => a.pane_id === 'w1:p2').name = 'someone-else';
  m = build({ snapshot: snap, tasks });
  assert.equal(row(m, 'AGT-2').live, null);
  assert.equal(row(m, 'AGT-2').attention, true);
});

test('review uses reviewer as primary', () => {
  const r = row(build(), 'AGT-3');
  assert.equal(r.primary, 'reviewer');
  assert.equal(r.primaryName, 'auth-review');
  assert.equal(r.live.paneId, 'w1:p3');
  assert.equal(r.reviewerLive.paneId, 'w1:p3');
  assert.equal(r.attention, false);
});

test('parents and untracked exclusions', () => {
  const m = build();
  assert.deepEqual(m.parents, [{ name: 'orchestrator', status: 'working', paneId: 'w1:p1' }]);
  assert.deepEqual(m.untracked.map((a) => a.paneId), ['w1:p4']);
  assert.ok(!m.untracked.some((a) => a.name === 'stranger'));
});

test('scope by repo_key, repo_root and matched agents', () => {
  assert.deepEqual(build().scopeWorkspaceIds, ['w1', 'w2']);
  // by repo_root only: remove repo_key on the scope workspace's worktree and drop matched agents
  const snap = fx('snapshot.json');
  for (const w of snap.workspaces) if (w.worktree) w.worktree.repo_key = `k-${w.workspace_id}`;
  assert.deepEqual(build({ snapshot: snap, tasks: [] }).scopeWorkspaceIds, ['w1', 'w2']);
  // neither: only the scope workspace
  const snap2 = clone(snap);
  for (const w of snap2.workspaces) if (w.worktree) { w.worktree.repo_key = `k-${w.workspace_id}`; w.worktree.repo_root = `/r/${w.workspace_id}`; }
  assert.deepEqual(build({ snapshot: snap2, tasks: [] }).scopeWorkspaceIds, ['w1']);
  // matched agent in w3 pulls w3 in
  const tasks = [{ ...fx('agtask-ls.json').tasks[1], agent: 'stranger', pane: null }];
  assert.deepEqual(build({ snapshot: snap2, tasks }).scopeWorkspaceIds, ['w1', 'w3']);
});

test('layout: orch tabs and linked worktrees only', () => {
  const m = build();
  assert.equal(m.layout.orchTabs.length, 1);
  assert.deepEqual(m.layout.orchTabs[0].agentNames, ['impl-a', 'auth-review']);
  assert.equal(m.layout.orchTabs[0].workspaceLabel, 'main');
  assert.deepEqual(m.layout.worktrees.map((w) => w.workspaceId), ['w2']);
  assert.equal(m.layout.worktrees[0].checkoutPath, '/repo/example-wt/auth-wt');
  const snap = fx('snapshot.json');
  snap.tabs.find((t) => t.tab_id === 'w3:t1').label = 'orch-other';
  assert.equal(build({ snapshot: snap }).layout.orchTabs.length, 1);
});

test('terminal tasks hidden unless live or showAll', () => {
  let m = build();
  assert.equal(m.hiddenTerminal, 2);
  assert.ok(!m.tasks.some((t) => ['AGT-1', 'AGT-7'].includes(t.id)));
  m = build({ showAll: true });
  assert.equal(m.hiddenTerminal, 0);
  assert.deepEqual(m.tasks.map((t) => t.id), ['AGT-2', 'AGT-3', 'AGT-4', 'AGT-5', 'AGT-6', 'AGT-1', 'AGT-7']);
  const tasks = fx('agtask-ls.json').tasks;
  tasks.find((t) => t.id === 'AGT-7').agent = 'impl-b';
  m = build({ tasks });
  assert.ok(row(m, 'AGT-7'));
  assert.equal(m.hiddenTerminal, 1);
});

test('sort by seq numerically', () => {
  const base = fx('agtask-ls.json').tasks[1];
  const tasks = [10, 9, 2].map((n) => ({ ...base, id: `AGT-${n}`, agent: null, pane: null }));
  assert.deepEqual(build({ tasks }).tasks.map((t) => t.id), ['AGT-2', 'AGT-9', 'AGT-10']);
});

test('attention', () => {
  const m = build();
  assert.equal(row(m, 'AGT-2').attention, false);
  assert.equal(row(m, 'AGT-4').attention, true); // blocked state + blocked agent
  assert.equal(row(m, 'AGT-6').attention, true); // in_progress, no live agent
  assert.equal(row(m, 'AGT-5').attention, false);
  const tasks = fx('agtask-ls.json').tasks;
  tasks.find((t) => t.id === 'AGT-2').state = 'todo';
  const snap = fx('snapshot.json');
  snap.agents.find((a) => a.name === 'impl-a').agent_status = 'blocked';
  assert.equal(row(build({ snapshot: snap, tasks }), 'AGT-2').attention, true);
});

test('ambiguous duplicate names', () => {
  const snap = fx('snapshot.json');
  snap.agents.push({ ...snap.agents.find((a) => a.name === 'impl-a'), pane_id: 'w1:p9' });
  const r = row(build({ snapshot: snap }), 'AGT-2');
  assert.equal(r.live, null);
  assert.equal(r.ambiguous, true);
  assert.equal(r.attention, true);
});

test('counts cover all tasks', () => {
  assert.deepEqual(build().counts, { todo: 1, ready: 1, in_progress: 2, review: 1, blocked: 1, done: 1, failed: 1, cancelled: 0 });
});

test('snapshot null', () => {
  const m = build({ snapshot: null });
  assert.equal(m.herdr.available, false);
  assert.ok(m.tasks.every((t) => t.live === null));
  assert.equal(row(m, 'AGT-6').attention, false);
  assert.equal(row(m, 'AGT-4').attention, true);
  assert.deepEqual(m.untracked, []);
  assert.deepEqual(m.layout, { orchTabs: [], worktrees: [] });
});

test('agtask not ok: every in-scope agent is untracked', () => {
  const m = build({ agtask: { status: 'not_initialized', db: DB } });
  assert.equal(m.tracking, false);
  assert.deepEqual(m.tasks, []);
  assert.deepEqual(m.untracked.map((a) => a.paneId), ['w1:p1', 'w1:p4', 'w1:p2', 'w1:p3', 'w2:p1']);
});

test('stale tasks still join', () => {
  const tasks = fx('agtask-ls.json').tasks;
  const m = build({ agtask: { status: 'error', code: 'BUSY', tasks, stale: true, db: DB } });
  assert.equal(m.tracking, true);
  assert.equal(m.agtask.stale, true);
  assert.equal(row(m, 'AGT-2').live.paneId, 'w1:p2');
});

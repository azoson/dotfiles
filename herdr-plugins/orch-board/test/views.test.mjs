import test from 'node:test';
import assert from 'node:assert/strict';
import { carrySelection, cycleView, resolveTarget, selectableKeys, switchView } from '../lib/views.mjs';
import { model } from './helpers.mjs';

test('cycleView', () => {
  assert.equal(cycleView('table', 1), 'team');
  assert.equal(cycleView('team', 1), 'deps');
  assert.equal(cycleView('deps', 1), 'table');
  assert.equal(cycleView('table', -1), 'deps');
  assert.equal(cycleView('deps', -1), 'team');
  assert.equal(cycleView('nope', 1), 'table');
});

test('tab cycling keeps per-view memory and carries selection', () => {
  const m = model();
  let st = { view: 'table', selection: { table: 'task:AGT-3', team: null, deps: null } };
  st = switchView(st, m, 1);
  assert.deepEqual([st.view, st.selection.team], ['team', 'team:impl']);
  st = switchView(st, m, 1);
  assert.deepEqual([st.view, st.selection.deps], ['deps', 'task:AGT-2']);
  st = { ...st, selection: { ...st.selection, deps: 'task:AGT-4' } };
  st = switchView(st, m, 1);
  assert.deepEqual([st.view, st.selection.table], ['table', 'task:AGT-3']);
  st = switchView(switchView(st, m, 1), m, 1);
  assert.deepEqual([st.view, st.selection.deps], ['deps', 'task:AGT-4']);
  const before = { view: 'table', selection: { table: null, team: null, deps: null } };
  assert.equal(switchView(before, null, 1).view, 'team');
  assert.equal(before.view, 'table');
});

test('carrySelection rules', () => {
  const m = model();
  assert.equal(carrySelection(m, 'table', 'agent:w1:p6', 'team'), 'agent:w1:p6');
  assert.equal(carrySelection(m, 'table', 'agent:w1:p6', 'deps'), null);
  assert.equal(carrySelection(m, 'table', 'task:AGT-5', 'team'), 'team-unassigned:orchestrator');
  assert.equal(carrySelection(m, 'table', 'task:AGT-2', 'team'), 'team:reviewer');
  assert.equal(carrySelection(m, 'team', 'team-unassigned:orchestrator', 'deps'), 'task:AGT-5');
  assert.equal(carrySelection(m, 'team', 'team:reviewer', 'deps'), 'task:AGT-2');
  assert.equal(carrySelection(m, 'team', 'team:orchestrator', 'table'), 'task:AGT-2');
  assert.equal(carrySelection(m, 'team', null, 'table'), null);
});

test('resolveTarget', () => {
  const m = model();
  assert.deepEqual(resolveTarget(m, 'table', 'task:AGT-3'), { paneId: 'w1:p4' });
  assert.deepEqual(resolveTarget(m, 'deps', 'task:AGT-2'), { paneId: 'w1:p5' });
  assert.deepEqual(resolveTarget(m, 'deps', 'task:AGT-4'), { why: 'no live agent for AGT-4' });
  assert.deepEqual(resolveTarget(m, 'team', 'team:impl'), { paneId: 'w1:p4' });
  assert.match(resolveTarget(m, 'team', 'team:runner').why, /runner/);
  assert.deepEqual(resolveTarget(m, 'team', 'team-unassigned:orchestrator'), { why: 'no agent: AGT-5 unassigned' });
  for (const v of ['table', 'team', 'deps']) assert.deepEqual(resolveTarget(m, v, 'agent:w1:p6'), { paneId: 'w1:p6' });
  assert.equal(resolveTarget(m, 'team', 'nope'), null);
  assert.equal(resolveTarget(m, 'team', null), null);
});

test('selectableKeys', () => {
  const m = model();
  assert.deepEqual(selectableKeys(m), selectableKeys(m, 'table'));
  assert.deepEqual(selectableKeys(m), [...m.tasks.map((t) => t.key), ...m.untracked.map((a) => a.key)]);
  const team = selectableKeys(m, 'team');
  assert.deepEqual(team, ['team:orchestrator', 'team:planner', 'team:impl', 'team:runner', 'team:reviewer', 'team-unassigned:orchestrator', 'agent:w1:p6']);
  assert.deepEqual(selectableKeys(m, 'deps'), ['task:AGT-1', 'task:AGT-2', 'task:AGT-3', 'task:AGT-4', 'task:AGT-5']);
  const bad = model({ agtask: { status: 'not_initialized', db: '/x' } });
  assert.deepEqual(selectableKeys(bad, 'team'), bad.untracked.map((a) => a.key));
});

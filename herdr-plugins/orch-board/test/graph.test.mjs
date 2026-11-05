import test from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE, attachedGuide, buildDepGraph, buildTeamGraph, guideText, nodeGuide, stateGlyph, stateWord } from '../lib/graph.mjs';
import { strWidth } from '../lib/text.mjs';
import { model, snap, task } from './helpers.mjs';

const names = (g) => g.rows.map((r) => (r.type === 'node' ? r.name : r.type === 'edge' ? `edge(${r.reviewer})` : r.type === 'unassigned' ? `unassigned(${r.creator})` : r.type === 'section' ? 'section' : r.type === 'agent' ? r.key : r.type));
const node = (g, n) => g.rows.find((r) => r.type === 'node' && r.name === n);

test('glyph helpers', () => {
  assert.equal(stateGlyph('todo', true), '◎');
  assert.equal(stateGlyph('todo', false), '○');
  assert.equal(stateGlyph('weird'), '?');
  assert.equal(stateWord('todo', true), 'ready');
  assert.equal(stateWord('review', false), 'review');
});

test('guide tokens', () => {
  assert.deepEqual(nodeGuide([], true, 0), []);
  assert.deepEqual(nodeGuide([], false, 1), ['lead', 'mid']);
  assert.deepEqual(nodeGuide([], true, 1), ['lead', 'last']);
  assert.deepEqual(nodeGuide([false, true], true, 3), ['lead', 'pipe', 'gap', 'last']);
  assert.deepEqual(attachedGuide([], true, 0, true), ['lead', 'apipe']);
  assert.deepEqual(attachedGuide([], true, 0, false), ['lead', 'agap']);
  assert.deepEqual(attachedGuide([], false, 1, false), ['lead', 'pipe', 'agap']);
  assert.deepEqual(attachedGuide([true], true, 2, true), ['lead', 'gap', 'gap', 'apipe']);
  assert.equal(guideText(attachedGuide([], false, 1, false)), ' │     ');
});

test('guideText compresses without cutting tokens', () => {
  const g = nodeGuide(Array.from({ length: 11 }, (_, i) => i % 2 === 0), false, 12);
  assert.equal(guideText(g), ' ' + g.slice(1, -1).map((t) => GUIDE[t]).join('').slice(0) + GUIDE.mid);
  for (let w = 8; w <= 60; w++) {
    const t = guideText(g, w);
    assert.ok(strWidth(t) <= w, `${w}: ${t}`);
    assert.ok(t.endsWith('├─▸ '), t);
  }
  assert.match(guideText(g, 12), /^»\d+ /);
  const last = nodeGuide([true, true, true], true, 4);
  assert.ok(guideText(last, 9).endsWith('└─▸ '));
});

test('team fixture', () => {
  const g = buildTeamGraph(model());
  assert.deepEqual(names(g), ['orchestrator', 'planner', 'impl', 'edge(reviewer)', 'runner', 'reviewer', 'unassigned(orchestrator)', 'section', 'agent:w1:p6']);
  const impl = node(g, 'impl');
  assert.deepEqual(impl.chips.map((c) => c.id), ['AGT-2', 'AGT-3']);
  const rv = node(g, 'reviewer');
  assert.deepEqual(rv.reviewing.map((c) => c.id), ['AGT-2']);
  assert.deepEqual(rv.reviews.map((c) => c.id), ['AGT-3']);
  assert.deepEqual(rv.roles, ['review']);
  const runner = node(g, 'runner');
  assert.equal(runner.status, 'gone');
  assert.equal(runner.target, null);
  assert.equal(runner.why, 'no live agent: runner (not running in herdr)');
  assert.equal(runner.attention, false);
  const un = g.rows.find((r) => r.type === 'unassigned');
  assert.deepEqual(un.chips.map((c) => c.id), ['AGT-5']);
  assert.equal(un.key, 'team-unassigned:orchestrator');
  assert.equal(un.target, null);
  assert.equal(g.rows.at(-1).key, 'agent:w1:p6');
  assert.equal(node(g, 'orchestrator').created, 5);
  assert.deepEqual(g.rows.find((r) => r.type === 'edge').guide, ['lead', 'pipe', 'agap']);
});

test('team: implementer that is also a reviewer', () => {
  const tasks = [
    task(1, { agent: 'x', reviewer: 'y', state: 'in_progress' }),
    task(2, { agent: 'y', reviewer: 'x', state: 'review' }),
  ];
  const g = buildTeamGraph(model({ tasks, snapshot: snap([['orch'], ['x'], ['y']]) }));
  assert.equal(g.rows.filter((r) => r.type === 'node' && r.name === 'x').length, 1);
  const x = node(g, 'x');
  assert.deepEqual(x.chips.map((c) => c.id), ['AGT-1']);
  assert.deepEqual(x.reviewing.map((c) => c.id), ['AGT-2']);
  assert.deepEqual(x.roles, ['implementation', 'review']);
  const edges = g.rows.filter((r) => r.type === 'edge').map((r) => r.reviewer);
  assert.deepEqual(edges.sort(), ['x', 'y']);
});

test('team: multiple orchestrators and also', () => {
  const tasks = [
    task(1, { created_by: 'o1', agent: 'a' }),
    task(2, { created_by: 'o2', agent: 'b' }),
    task(3, { created_by: 'o2', agent: 'a' }),
    task(4, { created_by: 'o3', agent: 'a' }),
  ];
  const g = buildTeamGraph(model({ tasks, snapshot: snap([['o1'], ['o2'], ['o3'], ['a'], ['b']]) }));
  assert.deepEqual(names(g).filter((n) => ['o1', 'o2', 'o3', 'a', 'b'].includes(n)), ['o1', 'a', 'o2', 'b', 'o3']);
  assert.equal(node(g, 'a').depth, 1);
  assert.deepEqual(node(g, 'a').also, ['o2', 'o3']);
  assert.equal(node(g, 'o3').depth, 0);
  assert.equal(node(g, 'b').depth, 1);
});

test('team: sub-orchestrator nests', () => {
  const tasks = [task(1, { created_by: 'o', agent: 's' }), task(2, { created_by: 's', agent: 'w' })];
  const g = buildTeamGraph(model({ tasks, snapshot: snap([['o'], ['s'], ['w']]) }));
  assert.deepEqual([node(g, 'o').depth, node(g, 's').depth, node(g, 'w').depth], [0, 1, 2]);
  assert.deepEqual(node(g, 's').guide, ['lead', 'last']);
  assert.deepEqual(node(g, 'w').guide, ['lead', 'gap', 'last']);
  const edgeLess = g.rows.filter((r) => r.type === 'edge');
  assert.equal(edgeLess.length, 0);
});

test('team: creator cycle terminates', () => {
  const tasks = [task(1, { created_by: 'a', agent: 'b' }), task(2, { created_by: 'b', agent: 'a' })];
  const g = buildTeamGraph(model({ tasks, snapshot: snap([['a'], ['b']]) }));
  const ns = g.rows.filter((r) => r.type === 'node');
  assert.deepEqual(ns.map((r) => r.name).sort(), ['a', 'b']);
  assert.equal(ns[0].name, 'a');
  assert.equal(ns[0].depth, 0);
});

test('team: self-assigned orchestrator', () => {
  const tasks = [task(1, { created_by: 'o', agent: 'o', reviewer: 'o' })];
  const g = buildTeamGraph(model({ tasks, snapshot: snap([['o']]) }));
  assert.equal(g.rows.filter((r) => r.type === 'node').length, 1);
  assert.deepEqual(node(g, 'o').chips.map((c) => c.id), ['AGT-1']);
  assert.equal(g.rows.filter((r) => r.type === 'edge').length, 0);
});

test('team: gone agent while working gives attention', () => {
  const tasks = [task(1, { agent: 'ghost', state: 'in_progress' })];
  const g = buildTeamGraph(model({ tasks, snapshot: snap([['orch']]) }));
  assert.equal(node(g, 'ghost').attention, true);
  assert.equal(node(g, 'ghost').status, 'gone');
});

test('team: ambiguous names', () => {
  const tasks = [task(1, { agent: 'dup', state: 'in_progress' })];
  const g = buildTeamGraph(model({ tasks, snapshot: snap([['orch'], ['dup'], ['dup']]) }));
  const d = node(g, 'dup');
  assert.equal(d.status, 'ambiguous');
  assert.equal(d.target, null);
  assert.equal(d.attention, true);
  assert.match(d.why, /several/);
});

test('team: herdr unavailable', () => {
  const tasks = [task(1, { agent: 'a', state: 'in_progress' })];
  const g = buildTeamGraph(model({ tasks, snapshot: null }));
  assert.ok(g.rows.filter((r) => r.type === 'node').every((r) => r.status === '?' && r.why.endsWith('(herdr unavailable)')));
  assert.ok(!g.rows.some((r) => r.type === 'section'));
  assert.equal(node(g, 'a').attention, false);
});

test('team: empty and hidden', () => {
  const g = buildTeamGraph(model({ tasks: [] }));
  assert.equal(g.rows[0].type, 'note');
  assert.equal(g.rows[0].text, '(no tasks)');
  assert.equal(g.rows[1].type, 'section');
  const tasks = [task(1, { agent: 'gone', state: 'done' })];
  const h = buildTeamGraph(model({ tasks, snapshot: snap([['orch']]) }));
  assert.ok(h.rows.some((r) => r.type === 'note' && r.text === '(1 finished tasks hidden - press a)'));
  assert.ok(!node(h, 'gone'));
});

test('deps fixture', () => {
  const g = buildDepGraph(model());
  const rows = g.rows.filter((r) => r.type === 'task');
  assert.deepEqual(rows.map((r) => [r.id, r.depth]), [['AGT-1', 0], ['AGT-2', 1], ['AGT-3', 0], ['AGT-4', 0], ['AGT-5', 0]]);
  const t4 = rows.find((r) => r.id === 'AGT-4');
  assert.deepEqual(t4.extra.map((e) => e.id), ['AGT-2', 'AGT-3']);
  assert.equal(t4.waiting, true);
  assert.deepEqual(rows.find((r) => r.id === 'AGT-2').extra, []);
  assert.ok(!g.rows.some((r) => r.type === 'section' || r.type === 'agent'));
});

test('deps: single chain', () => {
  const tasks = Array.from({ length: 12 }, (_, i) => task(i + 1, { deps: i ? [`AGT-${i}`] : [] }));
  const g = buildDepGraph(model({ tasks, snapshot: snap([['orch']]) }));
  const rows = g.rows.filter((r) => r.type === 'task');
  assert.deepEqual(rows.map((r) => r.depth), [...Array(12).keys()]);
  assert.deepEqual(rows[5].guide, ['lead', 'gap', 'gap', 'gap', 'gap', 'last']);
});

test('deps: hidden dep', () => {
  const tasks = [task(1, { state: 'done', agent: 'gone' }), task(2, { deps: ['AGT-1'], state: 'todo', ready: true })];
  const snapshot = snap([['orch']]);
  let r = buildDepGraph(model({ tasks, snapshot })).rows.filter((x) => x.type === 'task');
  assert.equal(r.length, 1);
  assert.equal(r[0].depth, 0);
  assert.deepEqual(r[0].extra, [{ id: 'AGT-1', state: 'done', ready: false, visible: false, dangling: false }]);
  r = buildDepGraph(model({ tasks, snapshot, showAll: true })).rows.filter((x) => x.type === 'task');
  assert.deepEqual(r.map((x) => [x.id, x.depth]), [['AGT-1', 0], ['AGT-2', 1]]);
});

test('deps: dangling, cycle, self, mixed', () => {
  let rows = buildDepGraph(model({ tasks: [task(1, { deps: ['AGT-99'] })], snapshot: snap([]) })).rows.filter((x) => x.type === 'task');
  assert.equal(rows[0].extra[0].dangling, true);
  assert.equal(rows[0].depth, 0);

  const cyc = [task(1, { deps: ['AGT-2'] }), task(2, { deps: ['AGT-1'] })];
  rows = buildDepGraph(model({ tasks: cyc, snapshot: snap([]) })).rows.filter((x) => x.type === 'task');
  assert.deepEqual(rows.map((r) => r.id).sort(), ['AGT-1', 'AGT-2']);
  assert.equal(rows[0].id, 'AGT-1');
  assert.equal(rows[0].cycle, true);

  rows = buildDepGraph(model({ tasks: [task(1, { deps: ['AGT-1'] })], snapshot: snap([]) })).rows.filter((x) => x.type === 'task');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cycle, true);

  const mixed = [task(1, { state: 'done', agent: 'g' }), task(2), task(3, { deps: ['AGT-1', 'AGT-2'] })];
  rows = buildDepGraph(model({ tasks: mixed, snapshot: snap([]) })).rows.filter((x) => x.type === 'task');
  const t3 = rows.find((r) => r.id === 'AGT-3');
  assert.equal(t3.depth, 1);
  assert.deepEqual(t3.extra.map((e) => [e.id, e.visible]), [['AGT-1', false]]);
});

test('deps: in review uses reviewer; terminal flags', () => {
  const g = buildDepGraph(model());
  const t2 = g.rows.find((r) => r.id === 'AGT-2');
  assert.equal(t2.inReview, true);
  assert.equal(t2.status, 'working');
  assert.equal(t2.target, 'w1:p5');
  const tasks = [task(1, { state: 'cancelled', agent: 'impl' }), task(2, { state: 'failed', agent: 'impl' })];
  const rows = buildDepGraph(model({ tasks, showAll: true })).rows.filter((r) => r.type === 'task');
  assert.ok(rows.every((r) => r.terminal));
});

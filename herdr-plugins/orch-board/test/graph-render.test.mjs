import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE_GLYPH, guideText } from '../lib/graph.mjs';
import { buildDepGraph, buildTeamGraph } from '../lib/graph.mjs';
import { depsGuideBound, teamGuideBound, teamLayout } from '../lib/graph-render.mjs';
import { render } from '../lib/render.mjs';
import { strWidth, stripAnsi } from '../lib/text.mjs';
import { DB, fx, model, snap, task } from './helpers.mjs';

const ui = (o = {}) => ({ view: 'team', selectedKey: null, scrollTop: 0, statusMessage: null, events: 'live', dbWatch: 'watching', lastRefresh: new Date(2026, 0, 1, 12, 3, 4), ...o });
const frame = (m, view, cols, rows, o = {}) => render(m, ui({ view, ...o.ui }), { cols, rows, color: o.color ?? false, now: new Date(), home: '/repo' });
const body = (f, n) => f.text.split('\n').slice(3, 3 + n).map((l) => l.trimEnd());

const TEAM_120 = [
  '   ○todo ◎ready ◐in_progress ●review ■blocked ✓done ✗failed ×cancelled  ◂── reviewer',
  '   orchestrator                       claude  idle     w1:p1',
  '    ├─▸ planner       research        codex   idle     w1:p3  AGT-1 ✓done',
  '    ├─▸ impl          implementation  codex   working  w1:p4  AGT-2 ●review  AGT-3 ◐in_progress',
  '    │     ◂── reviews ── reviewer',
  '    ├─▸ runner        cli             -       gone     -      AGT-4 ○todo',
  '    ├─▸ reviewer      review          codex   working  w1:p5  reviewing AGT-2  reviews AGT-3',
  '    └─▸ (unassigned)  research                                AGT-5 ◎ready',
  'Untracked agents (1)',
  '>  codex          w1:p6    idle     orch-demo / main',
];

test('team golden at 120 columns', () => {
  assert.deepEqual(body(frame(model(), 'team', 120, 24, { ui: { selectedKey: 'agent:w1:p6' } }), 10), TEAM_120);
});

test('team golden at 80 columns', () => {
  const b = body(frame(model(), 'team', 80, 24, { ui: { selectedKey: 'agent:w1:p6' } }), 10);
  assert.equal(b[3], '    ├─▸ impl          implementation  codex   working  w1:p4  AGT-2● AGT-3◐');
  assert.equal(b[5], '    ├─▸ runner        cli             -       gone     -      AGT-4 ○todo');
  assert.equal(b[2], '    ├─▸ planner       research        codex   idle     w1:p3  AGT-1 ✓done');
  assert.equal(b[6], '    ├─▸ reviewer      review          codex   working  w1:p5  r:AGT-2● r:AGT-3◐');
});

test('deps golden at 120 columns', () => {
  const b = body(frame(model(), 'deps', 120, 24, { ui: { selectedKey: 'task:AGT-5' } }), 6);
  assert.deepEqual(b, [
    '   ○todo ◎ready ◐in_progress ●review ■blocked ✓done ✗failed ×cancelled  ⇠ other deps',
    '   AGT-1 ✓  research  planner  idle  Survey the API',
    '    └─▸ AGT-2 ●  implementation  impl → review: reviewer  working  fix 1/2  Implement client',
    '   AGT-3 ◐  implementation  impl  working  Add retries',
    '   AGT-4 ○  cli  runner  gone  ⇠ AGT-2, AGT-3 (waiting)  Wire CLI flag',
    '>  AGT-5 ◎  research  -  -  Write docs',
  ]);
});

test('spot checks at narrow widths', () => {
  const t60 = frame(model(), 'team', 60, 24, { ui: { selectedKey: 'agent:w1:p6' } }).text.split('\n');
  const nodeRows = t60.slice(4, 11);
  assert.ok(nodeRows.every((l) => !l.includes('codex')));
  assert.ok(nodeRows.some((l) => l.includes('rsch')));
  assert.ok(nodeRows.some((l) => l.includes('w1:p4')));
  assert.ok(nodeRows.find((l) => l.includes('reviewer ')).trimEnd().endsWith('r:AGT-2● +1'));
  const t40 = frame(model(), 'team', 40, 24, { ui: { selectedKey: 'agent:w1:p6' } }).text;
  assert.ok(t40.includes('    ├─▸ review…') && t40.includes('    ├─▸ planner'));
  const d40 = frame(model(), 'deps', 40, 24).text.split('\n').find((l) => l.includes('AGT-4'));
  assert.ok(d40.includes('⇠ 2,3'));
  assert.ok(!d40.includes('Wire'));
});

function variant() {
  const tasks = fx('graph-ls.json').tasks.map((t, i) => (i === 0 ? { ...t, title: '日本語のタイトルがとても長い場合でも幅を超えない確認' } : t));
  tasks.push(task(6, { agent: 'a-very-long-agent-name-of-30-chars', state: 'in_progress' }));
  for (let i = 7; i <= 18; i++) tasks.push(task(i, { deps: [`AGT-${i - 1}`], agent: 'impl' }));
  return model({ tasks, showAll: true });
}

test('property: every frame fits and guides stay intact', () => {
  for (const m of [model(), variant()]) {
    for (const view of ['team', 'deps']) {
      for (const cols of [40, 50, 60, 80, 120, 200]) {
        for (const rows of [10, 24]) {
          for (const color of [true, false]) {
            const f = frame(m, view, cols, rows, { color, ui: { selectedKey: m.tasks[2]?.key } });
            const lines = f.text.split('\n');
            const tag = `${view} ${cols}x${rows} color=${color}`;
            assert.equal(lines.length, rows, tag);
            for (const l of lines) assert.ok(strWidth(stripAnsi(l)) <= cols, `${tag}: ${stripAnsi(l)}`);
            if (!color) assert.ok(!f.text.includes('\x1b['), tag);
          }
        }
      }
    }
  }
});

test('property: guide integrity for rendered rows', () => {
  const m = variant();
  for (const cols of [40, 60, 80, 120, 200]) {
    const team = buildTeamGraph(m);
    const bound = teamGuideBound(cols, teamLayout(team, cols).nameCol);
    const lines = frame(m, 'team', cols, 60).text.split('\n');
    for (const r of team.rows.filter((x) => x.type === 'node' || x.type === 'unassigned')) {
      const g = guideText(r.guide, bound);
      assert.ok(lines.some((l) => l.slice(3).startsWith(g)), `team ${cols}: ${JSON.stringify(g)}`);
    }
    const deps = buildDepGraph(m);
    const dlines = frame(m, 'deps', cols, 60).text.split('\n');
    for (const r of deps.rows.filter((x) => x.type === 'task')) {
      const g = guideText(r.guide, depsGuideBound(cols));
      const line = dlines.find((l) => l.slice(3).startsWith(g) && l.includes(r.id.slice(0, 7)));
      assert.ok(line, `deps ${cols}: ${r.id} ${JSON.stringify(g)}`);
    }
  }
});

test('legend, selection, attention, header, footer', () => {
  const m = model();
  for (const v of ['team', 'deps']) {
    const legend = frame(m, v, 120, 24).text.split('\n')[3];
    for (const g of Object.values(STATE_GLYPH)) assert.ok(legend.includes(g), g);
  }
  const t = frame(m, 'team', 120, 24, { ui: { selectedKey: 'team:impl' } }).text.split('\n');
  assert.ok(t.some((l) => l.startsWith('>') && l.includes('impl')));
  assert.ok(t[0].includes('table [team] deps'));
  assert.ok(t.at(-1).includes('tab view'));
  const tasks = [task(1, { agent: 'ghost', state: 'in_progress' })];
  const mm = model({ tasks, snapshot: snap([['orch']]) });
  for (const v of ['team', 'deps']) {
    const lines = frame(mm, v, 120, 24).text.split('\n');
    assert.ok(lines.some((l) => (l[1] === '!') && (l.includes('ghost') || l.includes('AGT-1'))), v);
  }
});

test('team and deps detail lines', () => {
  const m = model();
  const t = frame(m, 'team', 120, 24, { ui: { selectedKey: 'team:impl' } }).text.split('\n');
  const detail = t.slice(-4, -1).join('\n');
  assert.ok(detail.includes('impl  implementation'));
  assert.ok(detail.includes('codex working w1:p4'));
  assert.ok(detail.includes('reviewed by reviewer'));
  const u = frame(m, 'team', 120, 24, { ui: { selectedKey: 'team-unassigned:orchestrator' } }).text;
  assert.ok(u.includes('(unassigned)  created by orchestrator'));
  assert.ok(u.includes('no agent: AGT-5 unassigned'));
  const d = frame(m, 'deps', 120, 24, { ui: { selectedKey: 'task:AGT-1' } }).text;
  assert.ok(d.includes('AGT-1  Survey the API'));
});

test('escapes in names and titles are removed', () => {
  const tasks = [task(1, { title: 'evil\x1b[2J\x07title', agent: 'na\x1b[2Jme', created_by: 'o\x1b[31m' })];
  const m = model({ tasks, snapshot: snap([]) });
  for (const v of ['team', 'deps']) assert.ok(!frame(m, v, 120, 24).text.includes('\x1b'));
});

test('scrolling keeps the selected deps row visible', () => {
  const tasks = Array.from({ length: 60 }, (_, i) => task(i + 1, { deps: i ? [`AGT-${i}`] : [] }));
  const m = model({ tasks, snapshot: snap([]) });
  const f = frame(m, 'deps', 100, 20, { ui: { selectedKey: 'task:AGT-50' } });
  assert.ok(f.scrollTop > 0);
  assert.ok(f.text.split('\n').some((l) => l.startsWith('>') && l.includes('AGT-50')));
});

test('degradation shows the table message in every view', () => {
  const m = model({ agtask: { status: 'not_initialized', db: DB } });
  for (const v of ['table', 'team', 'deps']) {
    const t = frame(m, v, 160, 24).text;
    assert.ok(t.includes(`no agtask DB for this repo (expected ${DB})`), v);
    assert.ok(t.includes('Live agents in scope'), v);
  }
});

test('plan detail handles numeric and string plans', () => {
  for (const [plan, want] of [[2, 'plan v2'], ['v2', 'plan v2']]) {
    const tasks = fx('graph-ls.json').tasks.map((t) => (t.id === 'AGT-2' ? { ...t, plan } : t));
    const t = frame(model({ tasks }), 'table', 140, 24, { ui: { selectedKey: 'task:AGT-2' } }).text;
    assert.ok(t.includes(want) && !t.includes('plan vv'), String(plan));
  }
});

test('deps title fitting ignores segments that merely equal the title', () => {
  const tasks = [task(1, { role: 'research', title: 'research', agent: 'agent-xyz' })];
  const m = model({ tasks, snapshot: snap([]) });
  const line = frame(m, 'deps', 40, 12).text.split('\n').find((l) => l.includes('AGT-1')).trimEnd();
  assert.ok(line.endsWith('gone'), line);
  assert.equal(line.split('research').length - 1, 1);
});

test('team edge guides compress like node guides at narrow widths', () => {
  const tasks = [task(1, { created_by: 'o', agent: 's' }), task(2, { created_by: 's', agent: 'w', reviewer: 'rv' }), task(3, { created_by: 'w', agent: 'z', reviewer: 'rv' })];
  const m = model({ tasks, snapshot: snap([['o'], ['s'], ['w'], ['z'], ['rv']]) });
  const lines = frame(m, 'team', 40, 20).text.split('\n');
  const edge = lines.find((l) => l.includes('◂── reviews'));
  const nodeLine = lines.find((l) => /(^|\s)z(\s|$)/.test(l.slice(3, 20)));
  assert.ok(edge && nodeLine);
  assert.ok(strWidth(stripAnsi(edge)) <= 40);
});

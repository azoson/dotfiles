import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel } from '../lib/model.mjs';
import { moveSelection, render, selectableKeys } from '../lib/render.mjs';
import { strWidth, stripAnsi } from '../lib/text.mjs';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const DB = '/repo/example/.agtask/tasks.db';

function model(over = {}) {
  return buildModel({
    snapshot: over.snapshot === undefined ? fx('snapshot.json') : over.snapshot,
    agtask: over.agtask ?? { status: 'ok', tasks: over.tasks ?? fx('agtask-ls.json').tasks, db: DB },
    scopeWorkspaceId: 'w1',
    repoCwd: '/repo/example',
    showAll: true,
  });
}
const ui = (o = {}) => ({ selectedKey: null, scrollTop: 0, statusMessage: null, events: 'live', dbWatch: 'watching', lastRefresh: new Date(2026, 0, 1, 12, 3, 4), ...o });
const opts = (cols, rows, color = true) => ({ cols, rows, color, now: new Date(), home: '/repo' });

test('every frame has exactly rows lines within cols', () => {
  const tasks = fx('agtask-ls.json').tasks.map((t, i) => (i === 1 ? { ...t, title: '日本語のタイトルがとても長い場合でも幅を超えない確認' } : t));
  for (const cols of [30, 50, 80, 120, 200]) {
    for (const rows of [8, 24, 60]) {
      for (const color of [true, false]) {
        const f = render(model({ tasks }), ui(), opts(cols, rows, color));
        const lines = f.text.split('\n');
        assert.equal(lines.length, rows, `${cols}x${rows}`);
        for (const l of lines) assert.ok(strWidth(stripAnsi(l)) <= cols, `${cols}x${rows}: ${stripAnsi(l)}`);
        if (!color) assert.ok(!f.text.includes('\x1b['));
      }
    }
  }
});

test('small terminal message', () => {
  const f = render(model(), ui(), opts(30, 24));
  assert.ok(f.text.startsWith('terminal too small'));
  assert.ok(render(model(), ui(), opts(80, 8)).text.includes('terminal too small'));
});

test('column drop order', () => {
  const header = (cols) => stripAnsi(render(model(), ui(), opts(cols, 24)).text.split('\n').find((l) => l.includes('TITLE')));
  const wide = header(200);
  for (const c of ['ID', 'STATE', 'ROLE', 'AGENT', 'HERDR', 'PANE', 'TAB / WS', 'DEPS', 'FIX']) assert.ok(wide.includes(c), c);
  const order = ['ROLE', 'DEPS', 'FIX', 'TAB / WS', 'PANE'];
  let prev = 9;
  for (const cols of [160, 125, 118, 110, 100, 92, 80, 60, 40]) {
    const h = header(cols);
    const present = order.filter((c) => h.includes(c)).length;
    assert.ok(present <= prev, `monotonic at ${cols}`);
    prev = present;
  }
  assert.ok(!header(40).includes('PANE'));
  assert.ok(header(40).includes('STATE'));
  // ROLE goes first
  const h = header(105);
  assert.ok(!h.includes('ROLE') && h.includes('DEPS') && h.includes('FIX'));
});

test('selected row has > marker; attention has !', () => {
  const m = model();
  const f = render(m, ui({ selectedKey: 'task:AGT-3' }), opts(120, 40, false));
  const lines = f.text.split('\n');
  assert.ok(lines.find((l) => l.startsWith('>') && l.includes('AGT-3')));
  assert.ok(lines.find((l) => l.startsWith(' !') && l.includes('AGT-6')));
  assert.equal(f.selectedKey, 'task:AGT-3');
  assert.ok(f.text.includes('agent impl-a'));
  assert.ok(f.text.includes('reviewer auth-review idle'));
  assert.ok(f.text.includes('r:auth-review'));
});

test('scrolling keeps the selected row visible', () => {
  const base = fx('agtask-ls.json').tasks[1];
  const tasks = Array.from({ length: 60 }, (_, i) => ({ ...base, id: `AGT-${i + 1}`, title: `Task number ${i + 1}`, agent: null, pane: null }));
  const m = model({ tasks, snapshot: null });
  const f = render(m, ui({ selectedKey: 'task:AGT-50' }), opts(100, 20, false));
  const lines = f.text.split('\n');
  assert.ok(lines.some((l) => l.startsWith('>') && l.includes('AGT-50')));
  assert.ok(f.scrollTop > 0);
  const top = render(m, ui({ selectedKey: 'task:AGT-1' }), opts(100, 20, false));
  assert.ok(top.text.includes('more'));
  assert.equal(top.scrollTop, 0);
});

test('degradation messages', () => {
  const text = (agtask, snapshot) => render(model({ agtask, snapshot }), ui(), opts(200, 24, false)).text;
  assert.ok(text({ status: 'missing' }).includes('agtask not found on PATH (set ORCH_BOARD_AGTASK)'));
  assert.ok(text({ status: 'not_initialized', db: DB }).includes(`no agtask DB for this repo (expected ${DB})`));
  assert.ok(text({ status: 'error', code: 'NO_REPO', message: 'x' }).includes('cannot determine repository (no cwd in plugin context)'));
  assert.ok(text({ status: 'error', code: 'DB_ACCESS', message: 'denied' }).includes('agtask error DB_ACCESS: denied'));
  const stale = text({ status: 'error', code: 'BUSY', message: 'b', tasks: fx('agtask-ls.json').tasks, stale: true, db: DB });
  assert.ok(stale.includes('agtask stale (BUSY)'));
  assert.ok(text({ status: 'ok', tasks: [], db: DB }, null).includes('herdr unavailable'));
  assert.ok(text({ status: 'not_initialized', db: DB }).includes('Live agents in scope'));
  assert.ok(text({ status: 'ok', tasks: fx('agtask-ls.json').tasks, db: DB }).includes('Untracked agents (1)'));
});

test('untrusted text cannot inject escapes', () => {
  const tasks = fx('agtask-ls.json').tasks.map((t) => ({ ...t, title: 'evil\x1b[2J\x07title' }));
  const f = render(model({ tasks }), ui(), opts(120, 24, false));
  assert.ok(!f.text.includes('\x1b'));
});

test('moveSelection', () => {
  const keys = ['a', 'b', 'c'];
  assert.equal(moveSelection(keys, 'a', -1), 'a');
  assert.equal(moveSelection(keys, 'c', 1), 'c');
  assert.equal(moveSelection(keys, 'a', 1), 'b');
  assert.equal(moveSelection(keys, 'zzz', 1), 'a');
  assert.equal(moveSelection(keys, 'b', 'top'), 'a');
  assert.equal(moveSelection(keys, 'b', 'bottom'), 'c');
  assert.equal(moveSelection([], 'a', 1), null);
  assert.deepEqual(selectableKeys(model()), ['task:AGT-2', 'task:AGT-3', 'task:AGT-4', 'task:AGT-5', 'task:AGT-6', 'task:AGT-1', 'task:AGT-7', 'agent:w1:p4']);
});

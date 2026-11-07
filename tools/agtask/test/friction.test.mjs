import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const cli = fileURLToPath(new URL('../agtask.mjs', import.meta.url));
const exitCodes = { INTERNAL: 1, SCHEMA_TOO_NEW: 1, USAGE: 2, NOT_INITIALIZED: 3, NOT_FOUND: 3, INVALID_STATE: 4, BUSY: 5, DB_ACCESS: 6 };

function fixture(t, { init = true, db = true } = {}) {
  const cwd = realpathSync(mkdtempSync(resolve(tmpdir(), 'agtask-friction-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('AGTASK_') && k !== 'HERDR_PANE_ID')),
    ...(db ? { AGTASK_DB: resolve(cwd, '.agtask/tasks.db') } : {}) };
  const invoke = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', ...options, env: { ...env, ...options.env } });
  function call(args, code, options) {
    const result = invoke([...args, '--json'], options);
    assert.equal(result.stderr, '', result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
    const data = JSON.parse(result.stdout);
    assert.equal(result.status, data.ok ? 0 : exitCodes[data.error.code], result.stdout);
    if (code) assert.equal(data.error?.code, code, result.stdout);
    else assert.equal(data.ok, true, result.stdout);
    return data;
  }
  const fr = (args, code, options) => call(['friction', ...args], code, options);
  const as = (args, actor = 'worker', code, options) => fr([...args, '--as', actor], code, options);
  const add = (title, extra = [], actor = 'worker') => as(['add', title, '--kind', 'knowledge', '--fact', `${title} の事実`, '--cost', 'low', '--basis', 'grep で探した', ...extra], actor);
  const frictionDb = resolve(cwd, '.agtask/friction.db');
  const sql = fn => { const connection = new DatabaseSync(frictionDb); try { return fn(connection); } finally { connection.close(); } };
  if (init) call(['init']);
  return { cwd, env, invoke, call, fr, as, add, frictionDb, sql };
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

test('storage: initialization, lazy creation, schema and isolation from tasks.db', t => {
  const f = fixture(t, { init: false });
  f.fr(['ls'], 'NOT_INITIALIZED');
  f.as(['add', 'x', '--kind', 'knowledge', '--fact', 'f', '--cost', 'low', '--basis', 'b'], 'worker', 'NOT_INITIALIZED');
  assert.equal(existsSync(resolve(f.cwd, '.agtask')), false);
  f.call(['init']);
  assert.deepEqual(f.fr(['ls']).items, []);
  assert.deepEqual(f.fr(['report']).open, []);
  f.fr(['show', 'FR-1'], 'NOT_FOUND');
  assert.equal(existsSync(f.frictionDb), false, 'reads must not create friction.db');
  const created = f.add('first');
  assert.equal(created.item.id, 'FR-1');
  assert.equal(existsSync(f.frictionDb), true);
  f.sql(db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  });
  const tasks = new DatabaseSync(resolve(f.cwd, '.agtask/tasks.db'));
  try {
    assert.equal(tasks.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(tasks.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('items','hits')").get().n, 0);
  } finally { tasks.close(); }
  f.sql(db => db.exec('PRAGMA user_version=2'));
  f.fr(['ls'], 'SCHEMA_TOO_NEW');
});

test('storage: workspace root resolves from a repo subdirectory and records relative cwd/scope', t => {
  const f = fixture(t, { init: false, db: false });
  f.call(['init', '--workspace']);
  const repo = resolve(f.cwd, 'hub'), sub = resolve(repo, 'src');
  mkdirSync(sub, { recursive: true });
  git(repo, 'init', '-q');
  const added = f.as(['add', 'x', '--kind', 'tooling', '--fact', 'f', '--cost', 'low', '--basis', 'b'], 'worker', undefined, { cwd: sub });
  assert.equal(added.item.scope, 'hub');
  assert.equal(added.hit.cwd, 'hub/src');
  assert.equal(existsSync(f.frictionDb), true);
  const explicit = f.as(['add', 'y', '--kind', 'tooling', '--fact', 'f', '--cost', 'low', '--basis', 'b', '--scope', 'hub/api/'], 'worker', undefined, { cwd: f.cwd });
  assert.equal(explicit.item.scope, 'hub/api');
  assert.equal(explicit.hit.cwd, '.');
});

test('argument validation and help', t => {
  const f = fixture(t);
  const base = ['add', 'x', '--kind', 'knowledge', '--fact', 'f', '--cost', 'low', '--basis', 'b'];
  f.fr(base, 'USAGE');  // actor
  for (const drop of ['--kind', '--fact', '--cost', '--basis']) {
    const i = base.indexOf(drop);
    f.as([...base.slice(0, i), ...base.slice(i + 2)], 'worker', 'USAGE');
  }
  f.as(['add', 'x', '--kind', 'bad', '--fact', 'f', '--cost', 'low', '--basis', 'b'], 'worker', 'USAGE');
  f.as(['add', 'x', '--kind', 'knowledge', '--kind', 'failure', '--fact', 'f', '--cost', 'low', '--basis', 'b'], 'worker', 'USAGE');
  f.as(['add', 'あ'.repeat(121), '--kind', 'knowledge', '--fact', 'f', '--cost', 'low', '--basis', 'b'], 'worker', 'USAGE');
  f.as(['add', 'x', '--kind', 'knowledge', '--fact', 'あ'.repeat(1001), '--cost', 'low', '--basis', 'b'], 'worker', 'USAGE');
  f.as(['add', 'x', '--kind', 'knowledge', '--fact', '-', '--cost', 'low', '--basis', '-'], 'worker', 'USAGE', { input: 'z' });
  f.as(['add', 'x', '--kind', 'knowledge', '--fact', 'f', '--cost', 'low', '--basis', 'b', '--steps', '-1'], 'worker', 'USAGE');
  f.as(['add', 'x', '--kind', 'knowledge', '--fact', 'f', '--cost', 'low', '--basis', 'b', '--resolution', 'fixed'], 'worker', 'USAGE');
  f.fr(['nope'], 'USAGE');
  f.fr(['constructor'], 'USAGE');
  f.fr([], 'USAGE');
  f.fr(['ls', '--state', 'bad'], 'USAGE');
  f.fr(['ls', '--since', 'not a date'], 'USAGE');
  f.fr(['report', '--limit', '0'], 'USAGE');
  f.fr(['search'], 'USAGE');
  f.sql(db => assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0, 'failed commands roll back the schema'));
  assert.deepEqual(f.fr(['ls']).items, []);
  for (const args of [['friction', '--help'], ['help', 'friction'], ['friction', 'add', '--help']]) {
    const help = f.call(args).help;
    assert.match(help, /agtask friction add <title> --kind <kind>/);
    assert.equal(f.invoke(args).stdout, `${help}\n`);
  }
  assert.match(f.call(['--help']).help, /agtask friction report/);
});

test('add and hit record occurrences with stdin, task, pane and model', t => {
  const f = fixture(t);
  const a = f.as(['add', ' hub のテスト ', '--kind', 'failure', '--fact', '-', '--cost', 'mid', '--steps', '8', '--basis', 'pnpm test を流した', '--target', 'hub/AGENTS.md', '--task', 'agt-3', '--model', 'opus'],
    'hub-impl', undefined, { input: '  pnpm --filter hub test を使う。\n全体は 15 分かかる。\n', env: { HERDR_PANE_ID: 'w1:p3' } });
  assert.equal(a.item.title, 'hub のテスト');
  assert.equal(a.item.fact, 'pnpm --filter hub test を使う。\n全体は 15 分かかる。');
  assert.deepEqual([a.item.state, a.item.hits, a.item.score, a.item.target, a.item.created_by], ['open', 1, 3, 'hub/AGENTS.md', 'hub-impl']);
  assert.deepEqual([a.hit.task, a.hit.pane, a.hit.model, a.hit.steps, a.hit.after_close, a.hit.by], ['AGT-3', 'w1:p3', 'opus', 8, false, 'hub-impl']);
  const h = f.as(['hit', 'fr-1', '--cost', 'high', '--basis', '-'], 'other', undefined, { input: '再実行した' });
  assert.deepEqual([h.hit.basis, h.hit.steps, h.hit.pane, h.item.hits, h.item.score], ['再実行した', null, null, 2, 12]);
  f.as(['hit', 'FR-9', '--cost', 'low', '--basis', 'b'], 'other', 'NOT_FOUND');
  f.as(['hit', 'AGT-1', '--cost', 'low', '--basis', 'b'], 'other', 'NOT_FOUND');
  const shown = f.fr(['show', 'FR-1']);
  assert.deepEqual(shown.hits.map(x => x.cost), ['mid', 'high']);
  assert.deepEqual(shown.events.map(e => e.kind), ['created']);
  const human = f.invoke(['friction', 'show', 'FR-1']).stdout;
  for (const text of ['# FR-1 hub のテスト', '## Fact', '全体は 15 分かかる。', '## Hits', 'by hub-impl', '## Events']) assert.ok(human.includes(text), text);
});

test('failed writes are atomic', t => {
  const f = fixture(t);
  f.as(['add', 'x', '--kind', 'knowledge', '--fact', 'f', '--cost', 'bad', '--basis', 'b'], 'worker', 'USAGE');
  assert.deepEqual(f.fr(['ls']).items, []);
  assert.equal(f.add('y').item.id, 'FR-1');
  f.as(['hit', 'FR-1', '--cost', 'bad', '--basis', 'b'], 'worker', 'USAGE');
  assert.equal(f.fr(['show', 'FR-1']).hits.length, 1);
});

test('search, ls, report and score ordering', t => {
  const f = fixture(t);
  const add = (title, cost, extra = []) => f.as(['add', title, '--kind', 'knowledge', '--fact', `${title} fact`, '--cost', cost, '--basis', 'b', ...extra]).item.id;
  const one = add('Hub test filter', 'low', ['--scope', 'hub', '--target', 'hub/AGENTS.md']);
  const two = add('hub codegen', 'high', ['--scope', 'hub/api', '--target', 'hub/AGENTS.md']);
  const three = add('auth login', 'mid', ['--scope', 'auth']);
  const four = f.as(['add', 'auth env', '--kind', 'environment', '--fact', 'f', '--cost', 'low', '--basis', 'b', '--scope', 'auth']).item.id;
  assert.deepEqual(f.fr(['search', 'HUB']).items.map(i => i.id), [two, one]);
  assert.deepEqual(f.fr(['search', 'hub', 'filter']).items.map(i => i.id), [one]);
  assert.deepEqual(f.fr(['search', 'agents.md']).items.map(i => i.id), [two, one]);
  assert.deepEqual(f.fr(['ls']).items.map(i => i.id), [two, three, one, four]);
  assert.deepEqual(f.fr(['ls', '--scope', 'hub']).items.map(i => i.id), [two, one]);
  assert.deepEqual(f.fr(['ls', '--scope', 'hu']).items, []);
  assert.deepEqual(f.fr(['ls', '--kind', 'environment']).items.map(i => i.id), [four]);
  assert.deepEqual(f.fr(['ls', '--kind', 'environment', '--kind', 'knowledge']).items.length, 4);
  f.as(['close', three, '--resolution', 'wontfix', '--ref', 'コストに見合わない'], 'rev');
  f.as(['close', one, '--resolution', 'fixed', '--ref', 'abc123'], 'rev');
  assert.deepEqual(f.fr(['search', 'auth']).items.map(i => i.id), [four]);
  assert.deepEqual(f.fr(['search', 'auth', '--all']).items.map(i => i.id), [three, four]);
  assert.deepEqual(f.fr(['search', 'filter']).items.map(i => i.id), [one], 'fixed items stay searchable to record recurrences');
  assert.deepEqual(f.fr(['ls', '--state', 'closed']).items.map(i => i.id), [three, one]);
  for (let i = 0; i < 12; i++) add(`bulk ${i}`, 'low');
  assert.equal(f.fr(['search', 'bulk']).items.length, 10);

  f.as(['hit', one, '--cost', 'mid', '--basis', 'また探した'], 'w2');
  const report = f.fr(['report', '--limit', '2']);
  assert.deepEqual(report.recurrences.map(i => [i.id, i.recurrences]), [[one, 1]]);
  assert.deepEqual(report.open.map(i => i.id), [two, four]);
  assert.equal(report.omitted, 12);
  assert.deepEqual(report.targets['hub/AGENTS.md'], [two]);
  const human = f.invoke(['friction', 'report', '--limit', '2']).stdout;
  for (const text of ['## 再発（closed 後の hit）', `${one} [fixed: abc123]`, '## 未対応（スコア順）', `${two} [open] score 9 (hit 1)`, 'ほか 12 件', '## target ごと', `hub/AGENTS.md: ${two}`]) assert.ok(human.includes(text), text);

  const future = new Date(Date.now() + 60_000).toISOString();
  assert.deepEqual(f.fr(['ls', '--since', future]).items, []);
  assert.deepEqual(f.fr(['report', '--since', future]).open, []);
  assert.deepEqual(f.fr(['report', '--since', future]).recurrences, []);
});

test('state transitions', t => {
  const f = fixture(t);
  const a = f.add('a').item.id, b = f.add('b').item.id;
  f.as(['reopen', a, '--reason', 'r'], 'rev', 'INVALID_STATE');
  const accepted = f.as(['accept', a, '--target', 'docs/x.md', '--note', '直す'], 'rev');
  assert.deepEqual([accepted.item.state, accepted.item.target, accepted.transition], ['accepted', 'docs/x.md', { from: 'open', to: 'accepted' }]);
  f.as(['accept', a], 'rev', 'INVALID_STATE');
  f.as(['close', a, '--resolution', 'fixed'], 'rev', 'USAGE');
  f.as(['close', a, '--resolution', 'bad', '--ref', 'x'], 'rev', 'USAGE');
  f.as(['close', b, '--resolution', 'duplicate', '--ref', 'FR-99'], 'rev', 'NOT_FOUND');
  f.as(['close', b, '--resolution', 'duplicate', '--ref', b], 'rev', 'USAGE');
  const dup = f.as(['close', b, '--resolution', 'duplicate', '--ref', a.toLowerCase()], 'rev');
  assert.deepEqual([dup.item.state, dup.item.resolution, dup.item.ref], ['closed', 'duplicate', a]);
  f.as(['hit', b, '--cost', 'low', '--basis', 'x'], 'w', 'INVALID_STATE');
  f.as(['close', b, '--resolution', 'fixed', '--ref', 'x'], 'rev', 'INVALID_STATE');
  const closed = f.as(['close', a, '--resolution', 'fixed', '--ref', 'abc123'], 'rev');
  assert.ok(closed.item.closed_at);
  const hit = f.as(['hit', a, '--cost', 'low', '--basis', 'x'], 'w');
  assert.equal(hit.hit.after_close, true);
  assert.equal(hit.item.recurrences, 1);
  f.as(['reopen', a], 'rev', 'USAGE');
  const reopened = f.as(['reopen', a, '--reason', '再発した'], 'rev');
  assert.deepEqual([reopened.item.state, reopened.item.resolution, reopened.item.ref, reopened.item.closed_at, reopened.item.recurrences], ['open', null, null, null, 0]);
  f.as(['note', a, '経緯'], 'rev');
  const events = f.fr(['show', a]).events;
  assert.deepEqual(events.map(e => [e.kind, e.data.to ?? null]), [['created', null], ['state', 'accepted'], ['state', 'closed'], ['state', 'open'], ['note', null]]);
  assert.deepEqual(events[2].data, { from: 'accepted', to: 'closed', resolution: 'fixed', ref: 'abc123' });
  assert.equal(events[3].text, '再発した');
});

test('hits and events are append-only', t => {
  const f = fixture(t);
  f.add('a');
  f.sql(db => {
    for (const table of ['hits', 'events']) {
      assert.throws(() => db.exec(`UPDATE ${table} SET actor='x'`), /append only/);
      assert.throws(() => db.exec(`DELETE FROM ${table}`), /append only/);
    }
  });
});

test('concurrent first writes create one schema and unique IDs', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, 'friction', 'add', `t${i}`, '--kind', 'knowledge', '--fact', 'f', '--cost', 'low', '--basis', 'b', '--as', `w${i}`, '--json'], { cwd: f.cwd, env: f.env });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.on('error', reject);
    child.on('close', status => { try { done({ status, ...JSON.parse(stdout) }); } catch (error) { reject(error); } });
  })));
  assert.deepEqual(results.map(r => r.status), Array(8).fill(0), JSON.stringify(results));
  assert.deepEqual(results.map(r => r.item.id).sort(), Array.from({ length: 8 }, (_, i) => `FR-${i + 1}`).sort());
});

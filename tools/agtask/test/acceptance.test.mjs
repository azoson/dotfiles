import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const cli = fileURLToPath(new URL('../agtask.mjs', import.meta.url));
const exitCodes = {
  INTERNAL: 1, SCHEMA_TOO_NEW: 1, USAGE: 2, NOT_INITIALIZED: 3, NOT_FOUND: 3,
  INVALID_STATE: 4, NOT_READY: 4, ALREADY_ASSIGNED: 4, NOT_OWNER: 4,
  NOT_REVIEWER: 4, GATE_FAILED: 4, CYCLE: 4, PREFIX_MISMATCH: 4,
  FIX_LIMIT_EXCEEDED: 4, BUSY: 5, DB_ACCESS: 6,
};
function assertStatus(data, status) {
  const expected = data.ok ? 0 : exitCodes[data.error.code];
  assert.notEqual(expected, undefined, `Unknown error code: ${data.error?.code}`);
  assert.equal(status, expected, JSON.stringify(data));
}
function environment(extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('AGTASK_'))), ...extra };
}
function fixture(t, init = true) {
  const cwd = realpathSync(mkdtempSync(resolve(tmpdir(), 'agtask-test-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const db = resolve(cwd, 'tasks.db');
  const env = environment({ AGTASK_DB: db });
  function invoke(args, options = {}) { return spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', ...options }); }
  function call(args, code, options) {
    const result = invoke([...args, '--json'], options);
    assert.equal(result.stderr, '', result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, 1, result.stdout);
    const data = JSON.parse(result.stdout);
    assertStatus(data, result.status);
    if (code) { assert.equal(data.error?.code, code, result.stdout); }
    else { assert.equal(result.status, 0, result.stdout); assert.equal(data.ok, true); }
    return data;
  }
  const as = (args, actor = 'worker', code) => call([...args, '--as', actor], code);
  const add = (...args) => as(['add', ' Task ', '--role', 'implementation', '--goal', ' Goal ', '--criterion', ' One ', ...args], 'parent').task;
  const sql = fn => { const connection = new DatabaseSync(db); try { return fn(connection); } finally { connection.close(); } };
  const evidence = (id, actor = 'worker', verdict = 'verified', extra = []) => as(['evidence', id, '--criterion', '1', '--verdict', verdict, '--basis', 'command: pass', ...extra], actor);
  const review = id => { as(['claim', id]); evidence(id); as(['submit', id, '--output', 'result']); };
  if (init) call(['init']);
  return { cwd, db, env, invoke, call, as, add, sql, evidence, review };
}
function concurrent(f, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--json'], { cwd: f.cwd, env: f.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', status => { try { assert.equal(stderr, ''); const data = JSON.parse(stdout); assertStatus(data, status); resolvePromise({ status, ...data }); } catch (error) { reject(error); } });
  });
}

test('init, schema, prefix, ID, help and argument validation', t => {
  const f = fixture(t, false);
  assert.equal(f.call(['ls'], 'NOT_INITIALIZED').error.details.db, f.db);
  for (const args of [['--help'], ['help', 'claim'], ['claim', '--help']]) assert.equal(f.invoke(args).status, 0);
  assert.equal(f.invoke(['--version']).stdout, '0.1.0\n');
  assert.equal(f.call(['init', '--prefix', 'X']).created, true);
  assert.equal(f.call(['init']).created, false);
  f.call(['init', '--prefix', 'AGT'], 'PREFIX_MISMATCH');
  assert.equal(f.sql(db => db.prepare('PRAGMA journal_mode').get().journal_mode), 'wal');
  assert.equal(f.sql(db => db.prepare('PRAGMA user_version').get().user_version), 1);
  assert.equal(f.add().id, 'X-1'); assert.equal(f.add().id, 'X-2');
  assert.equal(f.call(['show', 'x-1']).task.title, 'Task');
  f.call(['show', 'AGT-1'], 'NOT_FOUND');
  for (const args of [ ['unknown'], ['ls', '--unknown'], ['ls', '--state', 'bad'], ['add', 'task'], ['add', ''], ['add', 't', '--role', 'bad', '--goal', 'g', '--criterion', 'c'], ['add', 't', '--role', 'cli', '--goal', 'g', '--criterion', 'c', '--max-fix-rounds', '-1'], ['note', 'X-1'], ['graph', '--format', 'bad'] ]) f.as(args, 'parent', 'USAGE');
  assert.equal(f.call(['note', 'X-1', 'hello'], 'USAGE').ok, false);
  f.call(['note', 'X-1', 'x', '--as', 'bad name'], 'USAGE');
  const human = f.invoke(['unknown']); assert.equal(human.stdout, ''); assert.match(human.stderr, /^agtask: .* \[USAGE\]\n$/); assert.equal(human.status, 2);
  f.sql(db => db.exec('PRAGMA user_version=2'));
  assert.equal(f.call(['ls'], 'SCHEMA_TOO_NEW').error.details.user_version, 2);
});

test('actor precedence, string normalization, repeat options, stdin and next', t => {
  const f = fixture(t);
  const task = f.add('--criterion', 'One', '--write', 'file', '--write', ' file ', '--read', 'spec', '--plan', 'v2', '--agent', 'worker', '--reviewer', 'reviewer', '--next', 'start');
  assert.equal(task.criteria.length, 1); assert.equal(task.files.length, 2);
  assert.equal(task.created_by, 'parent'); assert.equal(task.goal, 'Goal');
  f.as(['add', 't', '--role', 'cli', '--goal', 'g', '--criterion', 'c', '--write', 'a', '--read', 'a'], 'p', 'USAGE');
  f.as(['add', 't', '--role', 'cli', '--goal', 'g', '--criterion', 'c', '--agent', 'a', '--reviewer', 'a'], 'p', 'USAGE');
  const n = f.call(['--as', 'explicit', 'note', task.id, '-', '--kind', 'decision'], undefined, { input: '  body\ntext  ', env: { ...f.env, AGTASK_AGENT: 'fallback' } });
  assert.equal(n.event.by, 'explicit'); assert.equal(n.event.text, 'body\ntext');
  f.call(['next', task.id, '-', '--as', 'worker'], undefined, { input: ' next step ' });
  assert.equal(f.call(['show', task.id]).task.next_action, 'next step');
  f.as(['next', task.id, '--clear']); assert.equal(f.call(['show', task.id]).task.next_action, null);
  assert.equal(f.call(['ls', '--plan', 'v2', '--agent', 'worker']).tasks.length, 1);
  assert.equal(f.call(['ls', '--state', 'todo', '--state', 'blocked']).tasks.length, 1);
  const literal = f.invoke(['--as', 'worker', '--json', 'note', task.id, '--', '--literal']);
  assert.equal(JSON.parse(literal.stdout).event.text, '--literal');
});

test('dependency cycles, deduplication, atomic removal and ready filters', t => {
  const f = fixture(t), a = f.add('--agent', 'a'), b = f.add('--dep', a.id), c = f.add('--dep', b.id);
  assert.deepEqual(f.as(['dep', 'add', b.id, a.id]).existing, [a.id]);
  assert.deepEqual(f.as(['dep', 'add', a.id, c.id], 'worker', 'CYCLE').error.details.path, [a.id, c.id, b.id, a.id]);
  assert.deepEqual(f.as(['dep', 'add', a.id, a.id], 'worker', 'CYCLE').error.details.path, [a.id, a.id]);
  f.as(['dep', 'rm', c.id, b.id, a.id], 'worker', 'NOT_FOUND');
  assert.deepEqual(f.call(['show', c.id]).task.deps, [b.id]);
  assert.deepEqual(f.call(['ready']).tasks.map(t => t.id), [a.id]);
  assert.equal(f.call(['ready', '--agent', 'worker']).tasks.length, 0);
  assert.equal(f.call(['ls', '--ready', '--agent', 'a']).tasks.length, 1);
  f.as(['claim', b.id], 'worker', 'NOT_READY');
  f.as(['block', a.id, '--reason', 'external']); assert.equal(f.call(['ready']).tasks.length, 0);
  f.as(['cancel', a.id, '--reason', 'stop']); assert.equal(f.call(['ready']).tasks.length, 0);
  f.as(['add', 't', '--role', 'cli', '--goal', 'g', '--criterion', 'c', '--dep', a.id], 'worker', 'INVALID_STATE');
  assert.equal(f.add().id, 'AGT-4');
});

test('claim reservation, pane defaults, reclaim and release', t => {
  const f = fixture(t), a = f.add('--agent', 'worker');
  f.as(['claim', a.id], 'other', 'ALREADY_ASSIGNED');
  let result = f.call(['claim', a.id, '--as', 'worker'], undefined, { env: { ...f.env, HERDR_PANE_ID: 'w1:p3' } });
  assert.equal(result.task.pane, 'w1:p3'); assert.equal(result.changed, true);
  result = f.as(['claim', a.id, '--pane', 'w1:p3']); assert.equal(result.changed, false); assert.equal(result.transition, null);
  result = f.as(['claim', a.id, '--pane', 'w1:p4']); assert.equal(result.changed, true); assert.equal(result.transition, null);
  f.as(['dep', 'add', a.id, a.id], 'worker', 'INVALID_STATE');
  result = f.as(['release', a.id, '--reason', 'handoff', '--unassign'], 'parent');
  assert.equal(result.task.agent, null); assert.equal(result.task.pane, null);
  assert.equal(f.as(['claim', a.id], 'new').task.agent, 'new');
});

test('parallel claims, add/note allocation, and busy timeout', async t => {
  const f = fixture(t), a = f.add();
  const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => concurrent(f, ['claim', a.id, '--as', `worker${i}`])));
  assert.equal(claims.filter(r => r.ok).length, 1);
  assert.equal(claims.filter(r => r.error?.code === 'ALREADY_ASSIGNED').length, 7);
  const writes = await Promise.all(Array.from({ length: 8 }, (_, i) => concurrent(f, i % 2 ? ['note', a.id, `note${i}`, '--as', 'p'] : ['add', `task${i}`, '--role', 'cli', '--goal', 'g', '--criterion', 'c', '--as', 'p'])));
  assert.ok(writes.every(r => r.ok));
  assert.deepEqual(f.call(['ls']).tasks.map(t => t.id), ['AGT-1', 'AGT-2', 'AGT-3', 'AGT-4', 'AGT-5']);
  assert.equal(f.call(['show', a.id]).events.filter(e => e.kind === 'note').length, 4);
  f.sql(db => {
    db.exec('BEGIN IMMEDIATE');
    const result = f.call(['note', a.id, 'locked', '--as', 'p'], 'BUSY', { env: { ...f.env, AGTASK_BUSY_TIMEOUT_MS: '20' } });
    assert.equal(result.error.details.timeout_ms, 20); db.exec('ROLLBACK');
  });
});

test('work/review evidence, completion gates, rejection rounds and resolving issues', t => {
  const f = fixture(t), a = f.add('--reviewer', 'reviewer', '--max-fix-rounds', '0');
  f.as(['evidence', a.id, '--criterion', '1', '--verdict', 'verified', '--basis', 'x'], 'worker', 'INVALID_STATE');
  f.as(['claim', a.id]);
  f.as(['submit', a.id], 'worker', 'GATE_FAILED');
  f.as(['submit', a.id, '--output', 'out'], 'other', 'NOT_OWNER');
  f.as(['evidence', a.id, '--criterion', '1', '--verdict', 'verified', '--basis', 'x'], 'other', 'NOT_OWNER');
  for (const args of [ ['--verdict', 'bad'], ['--criterion', 'bad'], ['--missing', 'x'] ]) f.as(['evidence', a.id, '--criterion', '1', '--basis', 'x', '--verdict', 'verified', ...args], 'worker', 'USAGE');
  f.as(['evidence', a.id, '--criterion', '0', '--basis', 'x', '--verdict', 'verified'], 'worker', 'NOT_FOUND');
  f.as(['evidence', a.id, '--criterion', '1', '--basis', 'x', '--verdict', 'unresolved'], 'worker', 'USAGE');
  f.evidence(a.id, 'worker', 'unresolved', ['--missing', 'result']); f.as(['submit', a.id, '--output', 'out'], 'worker', 'GATE_FAILED');
  f.evidence(a.id, 'worker', 'incorrect'); f.as(['submit', a.id, '--output', 'out'], 'worker', 'GATE_FAILED');
  f.evidence(a.id); f.as(['submit', a.id], 'worker', 'GATE_FAILED');
  const submitted = f.as(['submit', a.id, '--output', 'out', '--output', 'out']); assert.deepEqual(submitted.task.outputs, ['out']);
  f.as(['accept', a.id], 'worker', 'NOT_REVIEWER'); f.as(['accept', a.id], 'stranger', 'NOT_REVIEWER');
  f.as(['accept', a.id], 'reviewer', 'GATE_FAILED');
  f.as(['evidence', a.id, '--criterion', '1', '--basis', 'x', '--verdict', 'verified'], 'worker', 'NOT_REVIEWER');
  f.evidence(a.id, 'reviewer', 'incorrect');
  const rejected = f.as(['reject', a.id, '--reason', 'fix'], 'reviewer');
  assert.equal(rejected.fix_limit_exceeded, true); assert.equal(rejected.task.blocked_from, 'in_progress'); assert.equal(rejected.task.fix_rounds, 1);
  f.as(['unblock', a.id], 'parent', 'FIX_LIMIT_EXCEEDED');
  f.as(['unblock', a.id, '--max-fix-rounds', '2'], 'parent');
  const handoff = f.call(['handoff', a.id]); assert.ok(handoff.tasks[0].open_issues.some(i => i.type === 'previous_review'));
  f.as(['submit', a.id, '--output', 'out'], 'worker', 'GATE_FAILED');
  f.evidence(a.id);
  f.as(['submit', a.id, '--output', 'out'], 'worker', 'GATE_FAILED');
  const issue = f.call(['show', a.id]).events.find(e => e.kind === 'issue');
  f.as(['note', a.id, 'fixed', '--resolve', String(issue.id), '--kind', 'note'], 'worker', 'USAGE');
  f.as(['note', a.id, 'fixed', '--resolve', '99999'], 'worker', 'NOT_FOUND');
  f.as(['note', a.id, 'fixed', '--resolve', String(issue.id)]);
  f.as(['note', a.id, 'again', '--resolve', String(issue.id)], 'worker', 'INVALID_STATE');
  f.as(['submit', a.id, '--output', 'out']);
  f.evidence(a.id, 'reviewer');
  assert.equal(f.as(['accept', a.id, '--note', 'approved'], 'reviewer').task.state, 'done');
  assert.equal(f.call(['show', a.id]).task.criteria[0].review.verdict, 'verified');
});

test('foreign work evidence does not satisfy submit and records are append-only', t => {
  const f = fixture(t), a = f.add(); f.as(['claim', a.id]);
  f.sql(db => db.prepare("INSERT INTO evidence(task_id,criterion,round,stage,verdict,basis,actor,at) VALUES(?,1,0,'work','verified','forged','other',?)").run(a.id, new Date().toISOString()));
  f.as(['submit', a.id, '--output', 'out'], 'worker', 'GATE_FAILED');
  for (const table of ['events', 'evidence', 'criteria']) for (const action of ['UPDATE', 'DELETE']) f.sql(db => assert.throws(() => db.exec(action === 'UPDATE' ? `UPDATE ${table} SET ${table === 'evidence' ? 'basis=basis' : 'text=text'}` : `DELETE FROM ${table}`), /append only/));
  f.as(['add', 'bad', '--role', 'cli', '--goal', 'g', '--criterion', 'c', '--dep', a.id, '--dep', 'AGT-999'], 'p', 'NOT_FOUND');
  assert.equal(f.add().id, 'AGT-2');
  assert.equal(f.call(['show', a.id]).events.filter(e => e.kind === 'dep_added').length, 0);
});

test('state transition matrix and block/unblock restores every source state', t => {
  const f = fixture(t);
  const states = ['todo', 'in_progress', 'review', 'done', 'blocked', 'failed', 'cancelled'];
  const commands = { release: ['in_progress'], submit: ['in_progress'], accept: ['review'], reject: ['review'], block: ['todo', 'in_progress', 'review'], unblock: ['blocked'], fail: ['todo', 'in_progress', 'review', 'blocked'], cancel: ['todo', 'in_progress', 'review', 'blocked'], claim: ['todo', 'in_progress'] };
  for (const [command, allowed] of Object.entries(commands)) for (const state of states) {
    const a = f.add();
    f.sql(db => {
      db.prepare('UPDATE tasks SET state=?,agent=?,blocked_from=? WHERE id=?').run(state, 'worker', state === 'blocked' ? 'todo' : null, a.id);
      if (['submit', 'accept'].includes(command)) db.prepare("INSERT INTO evidence(task_id,criterion,round,stage,verdict,basis,actor,at) VALUES(?,1,0,?,'verified','ok',?,?)").run(a.id, command === 'submit' ? 'work' : 'review', command === 'submit' ? 'worker' : 'reviewer', new Date().toISOString());
    });
    const actor = ['accept', 'reject'].includes(command) ? 'reviewer' : 'worker';
    const args = [command, a.id, ...(['release', 'reject', 'block', 'fail', 'cancel'].includes(command) ? ['--reason', 'why'] : []), ...(command === 'submit' ? ['--output', 'out'] : [])];
    const result = f.as(args, actor, allowed.includes(state) ? undefined : 'INVALID_STATE');
    if (allowed.includes(state)) {
      const target = { release: 'todo', submit: 'review', accept: 'done', reject: 'in_progress', block: 'blocked', unblock: 'todo', fail: 'failed', cancel: 'cancelled', claim: 'in_progress' }[command];
      assert.equal(result.task.state, target);
      if (result.transition) assert.deepEqual(result.transition, { from: state, to: target });
    }
  }
  for (const state of ['todo', 'in_progress', 'review']) {
    const a = f.add(); f.sql(db => db.prepare('UPDATE tasks SET state=? WHERE id=?').run(state, a.id));
    f.as(['block', a.id, '--reason', 'pause']); assert.equal(f.as(['unblock', a.id]).task.state, state);
  }
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: environment({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function tree(path, prefix = '') {
  return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? tree(resolve(path, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]).sort();
}
test('DB location in Git repositories and .gitignore never writes .git', t => {
  const f = fixture(t, false), env = environment({ AGTASK_DB: '' });
  const init = cwd => f.call(['init'], undefined, { cwd, env });
  const main = resolve(f.cwd, 'main'); mkdirSync(main); git(main, 'init'); git(main, 'commit', '--allow-empty', '-m', 'initial');
  const before = tree(resolve(main, '.git'));
  let r = init(main); assert.equal(r.db, resolve(main, '.agtask/tasks.db')); assert.equal(r.gitignore, 'created');
  assert.deepEqual(tree(resolve(main, '.git')), before);
  assert.equal(readFileSync(resolve(main, '.agtask/.gitignore'), 'utf8'), '*\n');
  assert.equal(git(main, 'status', '--porcelain'), '');
  writeFileSync(resolve(main, '.agtask/.gitignore'), '*\n# preserved\n');
  assert.equal(init(main).gitignore, 'exists'); assert.equal(readFileSync(resolve(main, '.agtask/.gitignore'), 'utf8'), '*\n# preserved\n');
  const sub = resolve(main, 'sub'); mkdirSync(sub); assert.equal(init(sub).db, r.db);
  const wt = resolve(f.cwd, 'wt'); git(main, 'worktree', 'add', '-b', 'work', wt); assert.equal(init(wt).db, r.db);
  const separate = resolve(f.cwd, 'separate'); mkdirSync(separate); git(separate, 'init', '--separate-git-dir', resolve(f.cwd, 'git-data'));
  assert.equal(init(separate).db, resolve(separate, '.agtask/tasks.db'));
  const bare = resolve(f.cwd, 'bare'); git(f.cwd, 'clone', '--bare', main, bare);
  const bwt = resolve(f.cwd, 'bare-wt'); git(bare, 'worktree', 'add', '-b', 'bare-work', bwt);
  assert.equal(init(bwt).db, resolve(bwt, '.agtask/tasks.db'));
  assert.equal(init(bare).db, resolve(bare, '.agtask/tasks.db'));
  assert.equal(init(f.cwd).db, resolve(f.cwd, '.agtask/tasks.db'));
  r = f.call(['init'], undefined, { env: environment({ AGTASK_DB: 'relative/db.sqlite' }) });
  assert.equal(r.db, resolve(f.cwd, 'relative/db.sqlite')); assert.equal(r.gitignore, 'skipped');
  assert.deepEqual(readdirSync(resolve(f.cwd, 'relative')).filter(p => p === '.gitignore'), []);
  const noGit = environment({ PATH: resolve(f.cwd, 'no-bin') });
  assert.equal(f.call(['init'], undefined, { cwd: sub, env: noGit }).db, resolve(sub, '.agtask/tasks.db'));
});

test('workspace DB: init --workspace, marker lookup from repos and external linked worktrees', t => {
  const f = fixture(t, false), env = environment({ AGTASK_DB: '' });
  const root = realpathSync(f.cwd);
  const at = (cwd, args = ['init']) => f.call(args, undefined, { cwd, env });
  const ws = resolve(root, 'ws'), repo = resolve(ws, 'hub'), sub = resolve(repo, 'src/deep');
  mkdirSync(sub, { recursive: true }); git(repo, 'init'); git(repo, 'commit', '--allow-empty', '-m', 'initial');
  // A pre-existing repo DB must not be used once a marker exists above it.
  const repoDb = at(repo).db; assert.equal(repoDb, resolve(repo, '.agtask/tasks.db'));
  assert.equal(at(repo).workspace, null);
  // AGTASK_DB and --workspace conflict.
  const conflict = f.call(['init', '--workspace'], 'USAGE', { cwd: ws });
  assert.equal(conflict.ok, false);
  const created = at(ws, ['init', '--workspace']);
  assert.equal(created.db, resolve(ws, '.agtask/tasks.db')); assert.equal(created.workspace, ws); assert.equal(created.created, true);
  assert.equal(created.gitignore, 'created');
  const mark = resolve(ws, '.agtask/workspace'); const text = readFileSync(mark, 'utf8');
  writeFileSync(mark, 'custom\n');
  const again = at(ws, ['init', '--workspace']);
  assert.equal(again.created, false); assert.equal(readFileSync(mark, 'utf8'), 'custom\n'); assert.ok(text.length > 0);
  // Resolution from repo subdirectory, workspace root, and a linked worktree outside the workspace.
  const external = resolve(root, 'outside-wt'); git(repo, 'worktree', 'add', '-b', 'ext', external);
  for (const cwd of [sub, ws, repo, external]) {
    const r = at(cwd); assert.equal(r.db, created.db, cwd); assert.equal(r.workspace, ws, cwd);
  }
  // Nested workspace: nearest marker wins.
  const inner = resolve(ws, 'inner'), innerRepo = resolve(inner, 'api'); mkdirSync(innerRepo, { recursive: true });
  git(innerRepo, 'init'); at(inner, ['init', '--workspace']);
  assert.equal(at(innerRepo).db, resolve(inner, '.agtask/tasks.db')); assert.equal(at(innerRepo).workspace, inner);
  assert.equal(at(sub).db, created.db);
  // Ancestor with tasks.db but no marker is ignored.
  const home = resolve(root, 'home'), proj = resolve(home, 'proj'); mkdirSync(proj, { recursive: true });
  at(home); assert.equal(at(proj).db, resolve(proj, '.agtask/tasks.db')); assert.equal(at(proj).workspace, null);
  // Non-init commands resolve the same way.
  at(ws, ['init', '--workspace', '--prefix', 'AGT']);
  const listed = f.call(['ls'], undefined, { cwd: external, env }); assert.deepEqual(listed.tasks, []);
});

test('graph text, mermaid escaping and topological tie order', t => {
  const f = fixture(t), a = f.add(), b = f.add('--dep', a.id), c = f.add('--dep', a.id);
  assert.equal(f.invoke(['graph']).stdout, 'AGT-1 [todo, ready] Task\nAGT-2 [todo] Task <- AGT-1\nAGT-3 [todo] Task <- AGT-1\n');
  const graph = f.call(['graph']); assert.deepEqual(graph.edges, [{ from: a.id, to: b.id }, { from: a.id, to: c.id }]);
  assert.deepEqual(graph.nodes.map(n => n.id), [a.id, b.id, c.id]);
  f.sql(db => db.prepare('UPDATE tasks SET title=? WHERE id=?').run('A "quote"', a.id));
  assert.equal(f.invoke(['graph', '--format', 'mermaid']).stdout, `flowchart TD
  AGT_1["AGT-1 A #quot;quote#quot;<br/>todo"]
  AGT_2["AGT-2 Task<br/>todo"]
  AGT_3["AGT-3 Task<br/>todo"]
  AGT_1 --> AGT_2
  AGT_1 --> AGT_3
  class AGT_1 todo
  class AGT_2 todo
  class AGT_3 todo
  classDef todo fill:#ffffff,stroke:#999999
  classDef in_progress fill:#dbeafe,stroke:#2563eb
  classDef review fill:#fef3c7,stroke:#d97706
  classDef done fill:#dcfce7,stroke:#16a34a
  classDef blocked fill:#fee2e2,stroke:#dc2626
  classDef failed fill:#e5e7eb,stroke:#dc2626
  classDef cancelled fill:#e5e7eb,stroke:#6b7280
`);
  f.as(['dep', 'rm', b.id, a.id]); f.as(['dep', 'add', a.id, c.id], 'p', 'CYCLE');
  f.as(['dep', 'rm', c.id, a.id]); f.as(['dep', 'add', a.id, c.id]);
  assert.deepEqual(f.call(['graph']).nodes.map(n => n.id), [b.id, c.id, a.id]);
});

test('handoff sections, structured evidence/issues and next actions', t => {
  const f = fixture(t), a = f.add('--agent', 'worker', '--reviewer', 'reviewer', '--plan', 'v2', '--write', 'src', '--read', 'spec');
  const empty = f.call(['handoff']); assert.equal(empty.tasks[0].next_action, 'claim 待ち（worker）');
  const body = f.invoke(['handoff', a.id]).stdout;
  const generated = body.match(/- 生成: (.*)/)[1];
  assert.equal(body, `# agtask handoff

- DB: ${f.db}
- 生成: ${generated}
- 状態: todo 1 / in_progress 0 / review 0 / blocked 0 / done 0 / failed 0 / cancelled 0
- ready: AGT-1

## AGT-1 Task

### Task

- 目的: Goal
- 役割: implementation / 状態: todo / 構成案: v2 / 修正: 0/2
- 担当: worker / レビュー: reviewer
- 依存: -
- 担当ファイル: src (書込可), spec (読取のみ)

### Outputs

- なし

### Summary

- 未登録

### Completed

- なし

### Decisions

- なし

### Open issues

- なし

### Next action

- claim 待ち（worker）
`);
  const b = f.add('--dep', a.id);
  assert.equal(f.call(['handoff', b.id]).tasks[0].next_action, '依存待ち: AGT-1');
  f.as(['claim', a.id]);
  assert.equal(f.call(['handoff', a.id]).tasks[0].open_issues[0].type, 'unverified');
  f.as(['note', a.id, 'decision', '--kind', 'decision']); f.as(['note', a.id, 'issue', '--kind', 'issue']);
  f.evidence(a.id, 'worker', 'unresolved', ['--missing', 'proof']);
  f.as(['block', a.id, '--reason', 'waiting']);
  let h = f.call(['handoff', a.id]).tasks[0];
  assert.deepEqual(h.open_issues.map(i => i.type), ['blocked', 'issue', 'evidence']); assert.equal(h.decisions[0].by, 'worker'); assert.equal(h.next_action, '判断待ち: waiting');
  f.as(['unblock', a.id]); f.evidence(a.id); f.as(['submit', a.id, '--output', 'out']);
  h = f.call(['handoff', a.id]).tasks[0]; assert.equal(h.completed[0].stage, 'work'); assert.equal(h.next_action, 'レビュー待ち（reviewer）');
  f.evidence(a.id, 'reviewer'); assert.equal(f.call(['handoff', a.id]).tasks[0].completed[0].stage, 'review');
  f.as(['accept', a.id], 'reviewer');
  assert.equal(f.call(['ready']).tasks[0].id, b.id);
  assert.equal(f.call(['handoff']).finished[0].id, a.id);
  assert.equal(f.call(['handoff', '--all']).tasks.length, 2);
  assert.equal(f.call(['handoff', a.id]).finished.length, 0);
  assert.match(f.invoke(['handoff']).stdout, /## 終了済み\n\n- AGT-1 \[done\] Task — Outputs: out/);
});

test('DB_ACCESS on unwritable DB and directory', { skip: process.getuid?.() === 0 }, t => {
  const f = fixture(t); f.add(); chmodSync(f.db, 0o444); chmodSync(f.cwd, 0o555);
  try {
    const r = f.call(['note', 'AGT-1', 'x', '--as', 'worker'], 'DB_ACCESS'); assert.equal(r.error.details.db, f.db);
  } finally { chmodSync(f.cwd, 0o755); chmodSync(f.db, 0o644); }
});

test('concurrent init succeeds in 30 fresh DB batches of eight processes', async t => {
  const f = fixture(t, false);
  f.env.AGTASK_DB = '';
  for (let batch = 0; batch < 30; batch++) {
    f.cwd = resolve(dirname(f.db), `batch-${batch}`);
    mkdirSync(f.cwd);
    const results = await Promise.all(Array.from({ length: 8 }, () => concurrent(f, ['init'])));
    assert.ok(results.every(r => r.ok), `batch ${batch}: ${JSON.stringify(results)}`);
    assert.equal(results.filter(r => r.created).length, 1);
    assert.equal(results.filter(r => r.gitignore === 'created').length, 1);
    const connection = new DatabaseSync(results[0].db);
    try {
      assert.equal(connection.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(connection.prepare("SELECT value FROM meta WHERE key='next_seq'").get().value, '1');
    } finally { connection.close(); }
  }
  assert.equal(f.call(['add', 'after init', '--role', 'cli', '--goal', 'g', '--criterion', 'c', '--as', 'p'], undefined, { cwd: f.cwd }).task.id, 'AGT-1');
});

test('every criterion needs its latest evidence and failed writes leave no rows', t => {
  const f = fixture(t), a = f.add('--criterion', 'Two');
  f.as(['claim', a.id]); f.evidence(a.id);
  let error = f.as(['submit', a.id, '--output', 'out'], 'worker', 'GATE_FAILED').error;
  assert.deepEqual(error.details.failing, [{ criterion: 2, verdict: null }]);
  const second = (actor, verdict) => f.as(['evidence', a.id, '--criterion', '2', '--verdict', verdict, '--basis', 'second result'], actor);
  second('worker', 'verified'); second('worker', 'incorrect');
  error = f.as(['submit', a.id, '--output', 'out'], 'worker', 'GATE_FAILED').error;
  assert.deepEqual(error.details.failing, [{ criterion: 2, verdict: 'incorrect' }]);
  second('worker', 'verified'); f.as(['submit', a.id, '--output', 'out']);
  f.evidence(a.id, 'reviewer'); second('reviewer', 'incorrect');
  f.as(['accept', a.id], 'reviewer', 'GATE_FAILED'); second('reviewer', 'verified');
  f.as(['accept', a.id], 'reviewer');
  f.as(['note', a.id, 'terminal note']);
  const snapshot = () => f.sql(db => ['tasks', 'deps', 'events', 'evidence', 'criteria', 'meta'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  const before = snapshot();
  f.as(['add', 'bad', '--role', 'cli', '--goal', 'g', '--criterion', 'c', '--dep', a.id, '--dep', 'AGT-999'], 'p', 'NOT_FOUND');
  assert.deepEqual(snapshot(), before);
});


test('all help forms and version honor JSON without opening a DB', t => {
  const f = fixture(t, false);
  const commands = ['init', 'add', 'dep', 'ls', 'ready', 'show', 'history', 'claim', 'release', 'note', 'next', 'evidence', 'submit', 'accept', 'reject', 'block', 'unblock', 'fail', 'cancel', 'graph', 'handoff'];
  const forms = [['--help'], ['-h'], ['help'], ...commands.flatMap(c => [['help', c], [c, '--help'], [c, '-h']])];
  for (const args of forms) {
    const result = f.call(args);
    assert.equal(typeof result.help, 'string');
    assert.equal(f.invoke(args).stdout, `${result.help}\n`);
  }
  assert.deepEqual(f.call(['--version']), { ok: true, version: '0.1.0' });
  assert.deepEqual(readdirSync(f.cwd), []);
});

test('Object.prototype names are unknown commands in every command/help form', t => {
  const f = fixture(t, false);
  for (const command of ['constructor', '__proto__', 'toString']) {
    for (const args of [[command], ['help', command], [command, '--help']]) f.call(args, 'USAGE');
  }
  assert.deepEqual(readdirSync(f.cwd), []);
});

test('init WAL negotiation respects its busy deadline', t => {
  const f = fixture(t);
  f.sql(connection => {
    connection.exec('PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE');
    try {
      const start = performance.now();
      const result = f.call(['init'], 'BUSY', { env: { ...f.env, AGTASK_BUSY_TIMEOUT_MS: '40' } });
      const elapsed = performance.now() - start;
      assert.equal(result.error.details.timeout_ms, 40);
      assert.ok(elapsed >= 40 && elapsed < 2000, `elapsed: ${elapsed} ms`);
    } finally { connection.exec('ROLLBACK'); }
  });
  f.call(['init']);
  assert.equal(f.sql(connection => connection.prepare('PRAGMA journal_mode').get().journal_mode), 'wal');
});

// Snapshot of the CLI before summary/history support, kept executable for both directions.
const legacyCli = fileURLToPath(new URL('./fixtures/legacy-agtask.mjs', import.meta.url));
function legacy(f, args) {
  const r = spawnSync(process.execPath, [legacyCli, ...args, '--json'], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  assert.equal(r.stderr, '');
  const data = JSON.parse(r.stdout); assertStatus(data, r.status); assert.equal(r.status, 0, r.stdout); return data;
}
const snapshot = f => f.sql(db => ['sqlite_schema', 'meta', 'tasks', 'criteria', 'task_files', 'deps', 'events', 'evidence'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const submitSummary = (f, id, text) => f.as(['submit', id, '--output', 'out', ...(text === undefined ? [] : ['--summary', text])]);
function resolveReject(f, id) {
  const issue = f.call(['show', id]).events.filter(e => e.kind === 'issue').at(-1);
  f.as(['note', id, 'fixed', '--resolve', String(issue.id)]); f.evidence(id);
}

test('summary strings/stdin, atomic errors, gates and unchanged common task JSON', t => {
  const f = fixture(t), a = f.add(); f.as(['claim', a.id]);
  for (const input of ['', ' ', '-']) {
    const before = snapshot(f);
    f.call(['submit', a.id, '--output', 'out', '--summary', input, '--as', 'worker'], 'USAGE', { input: ' \n ' });
    assert.deepEqual(snapshot(f), before);
  }
  let before = snapshot(f);
  submitSummaryError(['submit', a.id, '--output', 'out', '--summary', 'body'], 'GATE_FAILED');
  f.evidence(a.id);
  submitSummaryError(['submit', a.id, '--summary', 'body'], 'GATE_FAILED');
  submitSummaryError(['submit', a.id, '--output', 'out', '--summary', 'body'], 'NOT_OWNER', 'other');
  const text = '日本語 "引用"\n検証済み';
  const r = f.call(['submit', a.id, '--output', 'out', '--summary', '-', '--as', 'worker'], undefined, { input: `  ${text}\n ` });
  assert.equal(Object.hasOwn(r.task, 'summary'), false);
  const show = f.call(['show', a.id]);
  assert.deepEqual(show.events.at(-1).data, { from: 'in_progress', to: 'review', command: 'submit', summary: text, round: 0 });
  assert.equal(show.events.at(-1).text, null);
  assert.deepEqual(show.summary, { text, round: 0, event: r.event, by: 'worker', at: show.events.at(-1).at });
  assert.deepEqual(f.call(['handoff', a.id]).tasks[0].summary, show.summary);
  assert.equal(Object.hasOwn(f.call(['ls']).tasks[0], 'summary'), false);
  submitSummaryError(['submit', a.id, '--output', 'out', '--summary', 'body'], 'INVALID_STATE');
  function submitSummaryError(args, code, actor = 'worker') {
    before = snapshot(f); f.as(args, actor, code); assert.deepEqual(snapshot(f), before);
  }
});

test('reject/resubmit selects latest submit including omitted summary, preserves history and rounds', t => {
  const f = fixture(t), a = f.add('--reviewer', 'reviewer'); f.as(['claim', a.id]); f.evidence(a.id);
  submitSummary(f, a.id, ' A ');
  f.evidence(a.id, 'reviewer', 'incorrect');
  f.as(['reject', a.id, '--reason', 'fix'], 'reviewer');
  let s = f.call(['show', a.id]); assert.equal(s.summary.text, 'A'); assert.equal(s.summary.round, 0);
  assert.equal(s.task.criteria[0].work, null); assert.equal(s.evidence.length, 2);
  assert.match(f.invoke(['show', a.id]).stdout, /前回提出・差し戻し済み/);
  assert.match(f.invoke(['handoff', a.id]).stdout, /前回提出・差し戻し済み/);
  resolveReject(f, a.id); submitSummary(f, a.id, 'B');
  assert.equal(f.call(['show', a.id]).summary.round, 1);
  f.as(['reject', a.id, '--reason', 'again'], 'reviewer'); resolveReject(f, a.id); submitSummary(f, a.id);
  assert.equal(f.call(['show', a.id]).summary, null);
  const submits = f.call(['history', a.id]).events.filter(e => e.data.command === 'submit');
  assert.deepEqual(submits.map(e => [e.data.summary, e.data.round]), [['A', 0], ['B', 1], [null, 2]]);
  f.evidence(a.id, 'reviewer'); f.as(['accept', a.id, '--note', 'not a summary'], 'reviewer');
  assert.equal(f.call(['show', a.id]).summary, null);
});

test('summary survives review block/unblock, notes, accept and all handoff paths', t => {
  const f = fixture(t), a = f.add('--reviewer', 'reviewer'); f.as(['claim', a.id]); f.evidence(a.id); submitSummary(f, a.id, 'line1\nline2');
  const expected = f.call(['show', a.id]).summary;
  f.as(['block', a.id, '--reason', 'pause']); f.as(['unblock', a.id]);
  f.as(['note', a.id, 'note']); f.as(['next', a.id, 'next']);
  assert.deepEqual(f.call(['show', a.id]).summary, expected);
  f.evidence(a.id, 'reviewer'); f.as(['accept', a.id], 'reviewer');
  assert.deepEqual(f.call(['handoff']).finished[0].summary, expected);
  assert.match(f.invoke(['handoff']).stdout, /Summary: line1\\nline2/);
  for (const args of [['handoff', a.id], ['handoff', '--all']]) {
    assert.deepEqual(f.call(args).tasks[0].summary, expected);
    const human = f.invoke(args).stdout;
    const headings = [...human.matchAll(/^### (.+)$/gm)].map(m => m[1]);
    assert.deepEqual(headings, ['Task', 'Outputs', 'Summary', 'Completed', 'Decisions', 'Open issues', 'Next action']);
    assert.match(human, /line1\n  line2/);
  }
});

test('release/fail/cancel and fix-limit blocked preserve submitted summary', t => {
  const f = fixture(t);
  for (const ending of ['release', 'fail', 'cancel', 'blocked']) {
    const a = f.add('--max-fix-rounds', '0'); f.as(['claim', a.id]); f.evidence(a.id); submitSummary(f, a.id, ending);
    const summary = f.call(['show', a.id]).summary;
    f.as(['reject', a.id, '--reason', 'fix'], 'reviewer');
    assert.match(f.invoke(['show', a.id]).stdout, /前回提出・差し戻し済み/);
    if (ending === 'release') { f.as(['unblock', a.id, '--max-fix-rounds', '1']); f.as(['release', a.id, '--reason', 'handoff']); }
    if (['fail', 'cancel'].includes(ending)) f.as([ending, a.id, '--reason', 'stop']);
    assert.deepEqual(f.call(['show', a.id]).summary, summary);
  }
  const finished = f.call(['handoff']).finished;
  assert.deepEqual(finished.map(v => v.state), ['failed', 'cancelled']);
  assert.ok(finished.every(v => v.summary));
});

test('legacy schema 1 fixture reads without initialization; bidirectional CLI compatibility', t => {
  const f = fixture(t, false);
  legacy(f, ['init']);
  for (const state of ['todo', 'review', 'done']) {
    const a = legacy(f, ['add', state, '--role', 'cli', '--goal', 'old goal', '--criterion', 'old criterion', '--as', 'parent']).task;
    legacy(f, ['note', a.id, 'old note', '--as', 'worker']);
    if (state !== 'todo') {
      legacy(f, ['claim', a.id, '--as', 'worker']); legacy(f, ['evidence', a.id, '--criterion', '1', '--verdict', 'verified', '--basis', 'pass', '--as', 'worker']);
      legacy(f, ['submit', a.id, '--output', 'old-out', '--as', 'worker']);
    }
    if (state === 'done') {
      legacy(f, ['evidence', a.id, '--criterion', '1', '--verdict', 'verified', '--basis', 'pass', '--as', 'reviewer']);
      legacy(f, ['accept', a.id, '--note', 'old acceptance note', '--as', 'reviewer']);
    }
  }
  const before = snapshot(f);
  for (const id of ['AGT-1', 'AGT-2', 'AGT-3']) {
    const { ok, summary, ...current } = f.call(['show', id]);
    const { ok: legacyOk, ...previous } = legacy(f, ['show', id]);
    assert.equal(summary, null); assert.deepEqual(current, previous);
    assert.equal(f.call(['handoff', id]).tasks[0].summary, null);
    assert.match(f.invoke(['show', id]).stdout, /### Summary\n\n- 未登録/);
  }
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.sql(db => db.prepare('PRAGMA user_version').get().user_version), 1);
  f.as(['claim', 'AGT-1']); f.evidence('AGT-1'); submitSummary(f, 'AGT-1', 'new summary');
  assert.equal(legacy(f, ['show', 'AGT-1']).events.at(-1).data.summary, 'new summary');
  legacy(f, ['reject', 'AGT-1', '--reason', 'fix', '--as', 'reviewer']); resolveReject(f, 'AGT-1');
  legacy(f, ['submit', 'AGT-1', '--output', 'old-out', '--as', 'worker']);
  assert.equal(f.call(['show', 'AGT-1']).summary, null);
});

test('show detailed sections, all evidence fields, ordering and owner-specific gate remain intact', t => {
  const f = fixture(t), dep = f.add(), a = f.add('--dep', dep.id, '--write', 'z-write', '--read', 'a-read', '--plan', 'v1', '--reviewer', 'reviewer');
  const dependent = f.add('--dep', a.id);
  let body = f.invoke(['show', a.id]).stdout;
  assert.match(body, /依存先: AGT-1/); assert.match(body, /未完了の依存先: AGT-1/); assert.match(body, /依存される先: AGT-3/);
  f.as(['dep', 'rm', a.id, dep.id]); f.as(['claim', a.id, '--pane', 'w1:p9']);
  f.evidence(a.id, 'worker', 'unresolved', ['--missing', 'need\nmore', '--artifact', 'test-a']);
  f.as(['note', a.id, 'long\ndecision', '--kind', 'decision']); f.as(['note', a.id, 'open\nissue', '--kind', 'issue']);
  f.as(['next', a.id, 'next\nstep']);
  const pending = f.call(['show', a.id]).task.criteria[0].work;
  body = f.invoke(['show', a.id]).stdout;
  for (const value of [`証拠 #${pending.id}`, 'round 0', 'unresolved', 'by worker', pending.at, 'basis: command: pass', 'missing: need\n  more', 'artifacts: test-a']) assert.ok(body.includes(value), value);
  f.sql(db => db.prepare("INSERT INTO evidence(task_id,criterion,round,stage,verdict,basis,missing,artifacts,actor,at) VALUES(?,1,0,'work','verified','outsider',NULL,'[]','other','2000')").run(a.id));
  const show = f.call(['show', a.id]); assert.equal(show.task.criteria[0].work.by, 'other');
  submitSummaryError();
  body = f.invoke(['show', a.id]).stdout;
  assert.deepEqual([...body.matchAll(/^### (.+)$/gm)].map(m => m[1]), ['Task', 'Files', 'Dependencies', 'Outputs', 'Summary', 'Criteria', 'Decisions', 'Open issues', 'Next action']);
  assert.ok(body.indexOf('z-write') < body.indexOf('a-read'));
  for (const value of ['目的: Goal', 'ready: false', 'blocked_from: -', '担当: worker', 'pane: w1:p9', 'レビュアー: reviewer', '作成者: parent', '作成日時:', '更新日時:', 'long\n  decision', 'open\n  issue', 'next\n  step', 'artifacts:', 'missing:', 'by other', 'history AGT-2']) assert.ok(body.includes(value), value);
  assert.ok(f.call(['handoff', a.id]).tasks[0].open_issues.some(i => i.verdict === 'unresolved'));
  f.evidence(a.id); submitSummary(f, a.id, 'done'); f.evidence(a.id, 'reviewer', 'incorrect', ['--artifact', 'review.log']);
  body = f.invoke(['show', a.id]).stdout; assert.match(body, /incorrect/); assert.match(body, /review.log/);
  assert.deepEqual(f.call(['show', a.id]).task.dependents, [dependent.id]);
  function submitSummaryError() { f.as(['submit', a.id, '--output', 'out', '--summary', 'cannot bypass'], 'worker', 'GATE_FAILED'); }
});

test('history contains every kind in ID order, full evidence, raw data, missing references and empty history', t => {
  const f = fixture(t), a = f.add(), b = f.add();
  f.as(['dep', 'add', a.id, b.id]); f.as(['dep', 'rm', a.id, b.id]); f.as(['claim', a.id]);
  for (const kind of ['note', 'decision', 'issue']) f.as(['note', a.id, 'body\ncontinued', '--kind', kind]);
  const issue = f.call(['show', a.id]).events.at(-1);
  f.as(['note', a.id, 'resolved', '--resolve', String(issue.id)]); f.as(['next', a.id, 'next']); f.as(['next', a.id, '--clear']);
  f.evidence(a.id, 'worker', 'unresolved', ['--missing', 'proof', '--artifact', 'log']); f.evidence(a.id); submitSummary(f, a.id, 'summary\ncontinued');
  f.as(['reject', a.id, '--reason', 'fix'], 'reviewer'); resolveReject(f, a.id); submitSummary(f, a.id, 'again');
  f.evidence(a.id, 'reviewer'); f.as(['accept', a.id], 'reviewer');
  f.sql(db => {
    const q = db.prepare('INSERT INTO events(task_id,kind,text,data,actor,at) VALUES(?,?,?,?,?,?)');
    q.run(a.id, 'note', 'same time', '{}', 'fixture', '2000'); q.run(b.id, 'note', 'other task', '{}', 'fixture', '2000');
    q.run(a.id, 'note', 'reverse time', '{}', 'fixture', '1900');
    q.run(a.id, 'evidence', null, '{"evidence_id":99999}', 'fixture', '1800');
  });
  const before = snapshot(f), history = f.call(['history', a.id.toLowerCase()]), show = f.call(['show', a.id]);
  assert.equal(history.task, a.id); assert.deepEqual(history.events, show.events); assert.deepEqual(history.evidence, show.evidence);
  assert.deepEqual(history.events.map(e => e.id), history.events.map(e => e.id).sort((a, b) => a - b));
  assert.ok(history.events.every(e => e.task === a.id));
  for (const kind of ['created','dep_added','dep_removed','state','note','decision','issue','resolved','next','evidence']) assert.ok(history.events.some(e => e.kind === kind));
  const body = f.invoke(['history', a.id]).stdout;
  for (const value of ['— history', 'Data:', 'in_progress -> review / submit', 'Summary: summary\n  continued', 'criterion 1', 'round 0', 'unresolved', 'missing: proof', 'artifacts: log', '証拠なし: #99999']) assert.ok(body.includes(value), value);
  assert.ok(body.indexOf('same time') < body.indexOf('reverse time'));
  assert.deepEqual(snapshot(f), before);
  // A schema-compatible task may have no events; create solely by INSERT.
  f.sql(db => db.exec("INSERT INTO tasks SELECT 'AGT-99',99,title,role,goal,state,blocked_from,agent,pane,reviewer,plan,fix_rounds,max_fix_rounds,next_action,outputs,created_by,created_at,updated_at FROM tasks WHERE id='AGT-2'"));
  assert.deepEqual(f.call(['history', 'AGT-99']).events, []); assert.match(f.invoke(['history', 'AGT-99']).stdout, /- なし/);
});

test('malformed latest submit never falls back or mutates raw historical data', t => {
  const f = fixture(t), a = f.add(); f.as(['claim', a.id]); f.evidence(a.id); submitSummary(f, a.id, 'valid');
  for (const data of [{}, { summary: 'x' }, { summary: 42, round: 0 }, { summary: ' ', round: 0 }, { summary: 'x', round: -1 }, { summary: 'x', round: '0' }, { summary: 'x', round: 0.5 }, { summary: null, round: 0 }]) {
    const raw = { from: 'in_progress', to: 'review', command: 'submit', ...data };
    f.sql(db => db.prepare("INSERT INTO events(task_id,kind,text,data,actor,at) VALUES(?,'state',NULL,?,'fixture','2000')").run(a.id, JSON.stringify(raw)));
    const before = snapshot(f);
    assert.equal(f.call(['show', a.id]).summary, null); assert.equal(f.call(['handoff', a.id]).tasks[0].summary, null);
    assert.deepEqual(f.call(['history', a.id]).events.at(-1).data, raw);
    assert.equal(f.invoke(['history', a.id]).status, 0); assert.deepEqual(snapshot(f), before);
  }
});

test('history read-only interface errors/help and human empty fields', t => {
  const f = fixture(t, false); f.call(['history', 'AGT-1'], 'NOT_INITIALIZED');
  for (const args of [['history', '--help'], ['help', 'history']]) assert.match(f.call(args).help, /history <id>/);
  f.call(['init']); const a = f.add();
  f.call(['history', 'AGT-999'], 'NOT_FOUND'); f.call(['history'], 'USAGE'); f.call(['history', a.id, '--reverse'], 'USAGE');
  const body = f.invoke(['show', a.id]).stdout;
  for (const value of ['pane: -', '構成案: -', '### Files\n\n- なし', '### Outputs\n\n- なし', 'work: 未記録', 'review: 未記録']) assert.ok(body.includes(value), value);
  assert.equal(f.invoke(['history', a.id]).stderr, '');
});

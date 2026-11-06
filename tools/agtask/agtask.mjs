#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { statSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

const VERSION = '0.1.0';
const states = ['todo', 'in_progress', 'review', 'done', 'blocked', 'failed', 'cancelled'];
const roles = ['planning', 'research', 'implementation', 'review', 'cli'];
const terminal = ['done', 'failed', 'cancelled'];
const reads = ['ls', 'ready', 'show', 'history', 'graph', 'handoff'];
const signatures = {
  init: '[--prefix <PREFIX>] [--workspace]',
  add: '<title> --role <role> --goal <text> --criterion <text>... [--write <path>]... [--read <path>]... [--dep <id>]... [--agent <name>] [--reviewer <name>] [--plan <version>] [--max-fix-rounds <n>] [--next <text>]',
  dep: 'add|rm <id> <depends-on>...',
  ls: '[--state <state>]... [--agent <name>] [--plan <version>] [--ready]',
  ready: '[--agent <name>]', show: '<id>', history: '<id>', claim: '<id> [--pane <pane>]',
  release: '<id> --reason <text> [--unassign]',
  note: '<id> <text|-> [--kind note|decision|issue] [--resolve <event-id>]',
  next: '<id> (<text|-> | --clear)',
  evidence: '<id> --criterion <n> --verdict verified|incorrect|unresolved --basis <text> [--missing <text>] [--artifact <path>]...',
  submit: '<id> --output <path>... [--summary <text|->] [--next <text>]', accept: '<id> [--note <text>]',
  reject: '<id> --reason <text> [--next <text>]', block: '<id> --reason <text>',
  unblock: '<id> [--note <text>] [--max-fix-rounds <n>]', fail: '<id> --reason <text>',
  cancel: '<id> --reason <text>', graph: '[--format text|mermaid]', handoff: '[<id>...] [--all]',
};
const allowed = {
  init: ['prefix', 'workspace'], add: ['role', 'goal', 'criterion', 'write', 'read', 'dep', 'agent', 'reviewer', 'plan', 'max-fix-rounds', 'next'],
  dep: [], ls: ['state', 'agent', 'plan', 'ready'], ready: ['agent'], show: [], history: [], claim: ['pane'],
  release: ['reason', 'unassign'], note: ['kind', 'resolve'], next: ['clear'],
  evidence: ['criterion', 'verdict', 'basis', 'missing', 'artifact'], submit: ['output', 'summary', 'next'],
  accept: ['note'], reject: ['reason', 'next'], block: ['reason'], unblock: ['note', 'max-fix-rounds'],
  fail: ['reason'], cancel: ['reason'], graph: ['format'], handoff: ['all'],
};
const preconditions = {
  claim: 'todo か同じ担当の in_progress。依存が全て done。', release: 'in_progress。',
  evidence: 'in_progress の担当、または review のレビュアー。', submit: 'in_progress の担当。全 work 証拠 verified、成果物必須、reject issue 解消済み。',
  accept: 'review のレビュアー。全 review 証拠 verified。', reject: 'review のレビュアー。理由必須。',
  block: 'todo / in_progress / review。', unblock: 'blocked。修正回数が上限以下。',
  fail: '終端以外。', cancel: '終端以外。', dep: '対象は todo / blocked。循環は禁止。',
};
class Failure extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new Failure(code, message, details); };
const usage = message => fail('USAGE', message);
const clean = value => { const result = value.trim(); if (!result) usage('空の値は使えません'); return result; };
const integer = value => { if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) usage('整数は 0 以上の 10 進整数です'); return Number(value); };
const name = value => { if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/.test(value)) usage('不正な actor 名です'); return value; };
const member = (value, values) => { if (!values.includes(value)) usage(`不正な値: ${value}`); return value; };
const unique = values => [...new Set(values)];
const now = () => new Date().toISOString();
let db, dbPath, workspaceRoot = null, timeout = 5000, json = process.argv.slice(2).includes('--json');
const all = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const meta = key => one('SELECT value FROM meta WHERE key = ?', key)?.value;
function location(init) {
  if (process.env.AGTASK_DB) return { db: resolve(process.env.AGTASK_DB), workspace: null };
  if (init) return { db: resolve(process.cwd(), '.agtask/tasks.db'), workspace: process.cwd() };
  const git = args => { try { return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const main = common && basename(common) === '.git' && git([`--git-dir=${common}`, 'rev-parse', '--is-bare-repository']) === 'false' ? dirname(common) : null;
  const anchor = resolve(main || git(['rev-parse', '--show-toplevel']) || process.cwd());
  for (let dir = anchor; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, '.agtask/workspace'))) return { db: resolve(dir, '.agtask/tasks.db'), workspace: dir };
    if (dirname(dir) === dir) break;
  }
  return { db: resolve(anchor, '.agtask/tasks.db'), workspace: null };
}
function event(task, kind, text, data, actor) {
  return Number(run('INSERT INTO events(task_id,kind,text,data,actor,at) VALUES(?,?,?,?,?,?)', task, kind, text, JSON.stringify(data), actor, now()).lastInsertRowid);
}
function eventJSON(row) {
  return { id: row.id, task: row.task_id, kind: row.kind, text: row.text, data: JSON.parse(row.data), by: row.actor, at: row.at };
}
function evidenceJSON(row) {
  if (!row) return null;
  return { id: row.id, task: row.task_id, criterion: row.criterion, round: row.round, stage: row.stage, verdict: row.verdict, basis: row.basis, missing: row.missing, artifacts: JSON.parse(row.artifacts), by: row.actor, at: row.at };
}
function getTask(id) {
  id = id.toUpperCase();
  const task = one('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) fail('NOT_FOUND', `タスクがありません: ${id}`, { id });
  return task;
}
function taskJSON(t) {
  const deps = all('SELECT t.id,t.state FROM deps d JOIN tasks t ON t.id=d.depends_on WHERE d.task_id=? ORDER BY t.seq', t.id);
  const blocked = deps.filter(d => d.state !== 'done').map(d => d.id);
  const { seq, ...rest } = t;
  return { ...rest, ready: t.state === 'todo' && blocked.length === 0, outputs: JSON.parse(t.outputs),
    files: all('SELECT path,writable FROM task_files WHERE task_id=? ORDER BY rowid', t.id).map(f => ({ ...f, writable: !!f.writable })),
    criteria: all('SELECT idx AS "index",text FROM criteria WHERE task_id=? ORDER BY idx', t.id), deps: deps.map(d => d.id), blocked_by: blocked };
}
function latest(t, criterion, stage, round = t.fix_rounds, owner = false) {
  return evidenceJSON(one(`SELECT * FROM evidence WHERE task_id=? AND criterion=? AND stage=? AND round=? ${owner ? 'AND actor=?' : ''} ORDER BY id DESC LIMIT 1`, ...[t.id, criterion, stage, round, ...(owner ? [t.agent] : [])]));
}
function stateCheck(t, allowedStates) {
  if (!allowedStates.includes(t.state)) fail('INVALID_STATE', `${t.id}: 状態 ${t.state} では実行できません`, { state: t.state, allowed: allowedStates });
}
function owner(t, actor) { if (t.agent !== actor) fail('NOT_OWNER', '担当者だけが実行できます', { agent: t.agent }); }
function reviewer(t, actor) { if (t.agent === actor || (t.reviewer && t.reviewer !== actor)) fail('NOT_REVIEWER', 'レビュアーだけが実行できます', { reviewer: t.reviewer, agent: t.agent }); }
function issues(t) {
  return all("SELECT * FROM events e WHERE task_id=? AND kind='issue' AND NOT EXISTS(SELECT 1 FROM events r WHERE r.task_id=e.task_id AND r.kind='resolved' AND json_extract(r.data,'$.resolves')=e.id) ORDER BY id", t.id).map(eventJSON);
}
function gate(t, stage, outputs = []) {
  const failing = taskJSON(t).criteria.flatMap(c => {
    const e = latest(t, c.index, stage, t.fix_rounds, stage === 'work');
    return e?.verdict === 'verified' ? [] : [{ criterion: c.index, verdict: e?.verdict ?? null }];
  });
  const open = stage === 'work' ? issues(t).filter(i => i.data.reject).map(i => i.id) : [];
  const missing = stage === 'work' && !outputs.length;
  if (failing.length || missing || open.length) fail('GATE_FAILED', '完了ゲートを満たしていません', { stage, round: t.fix_rounds, failing, missing_outputs: missing, open_reject_issues: open });
}
function update(t, values) {
  values.updated_at = now();
  run(`UPDATE tasks SET ${Object.keys(values).map(k => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(values), t.id);
}
function transition(t, to, command, actor, reason = null, values = {}, data = {}) {
  update(t, { state: to, blocked_from: to === 'blocked' ? t.state : null, ...(['submit', 'accept', 'fail', 'cancel'].includes(command) ? { next_action: null } : {}), ...values });
  const id = event(t.id, 'state', reason, { from: t.state, to, command, ...data }, actor);
  return { task: taskJSON(getTask(t.id)), transition: { from: t.state, to }, event: id };
}
function depAdd(t, target, actor) {
  stateCheck(target, states.filter(s => !['failed', 'cancelled'].includes(s)));
  if (one('SELECT 1 FROM deps WHERE task_id=? AND depends_on=?', t.id, target.id)) return false;
  function search(id, path) {
    if (id === t.id) return path;
    for (const d of all('SELECT t.id FROM deps d JOIN tasks t ON t.id=d.depends_on WHERE d.task_id=? ORDER BY t.seq', id)) {
      if (!path.includes(d.id) || d.id === t.id) { const found = search(d.id, [...path, d.id]); if (found) return found; }
    }
    return null;
  }
  const path = search(target.id, [t.id, target.id]);
  if (path) fail('CYCLE', '依存が循環します', { path });
  run('INSERT INTO deps VALUES(?,?,?)', t.id, target.id, now());
  event(t.id, 'dep_added', null, { depends_on: target.id }, actor);
  return true;
}

const schema = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('planning','research','implementation','review','cli')),
  goal TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'todo'
    CHECK (state IN ('todo','in_progress','review','done','blocked','failed','cancelled')),
  blocked_from TEXT CHECK (blocked_from IN ('todo','in_progress','review')),
  agent TEXT,
  pane TEXT,
  reviewer TEXT,
  plan TEXT,
  fix_rounds INTEGER NOT NULL DEFAULT 0 CHECK (fix_rounds >= 0),
  max_fix_rounds INTEGER NOT NULL DEFAULT 2 CHECK (max_fix_rounds >= 0),
  next_action TEXT,
  outputs TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE criteria (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  idx INTEGER NOT NULL CHECK (idx >= 1),
  text TEXT NOT NULL,
  PRIMARY KEY (task_id, idx)
) STRICT;

CREATE TABLE task_files (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  path TEXT NOT NULL,
  writable INTEGER NOT NULL CHECK (writable IN (0, 1)),
  PRIMARY KEY (task_id, path)
) STRICT;

CREATE TABLE deps (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on TEXT NOT NULL REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id <> depends_on)
) STRICT;

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('created','state','dep_added','dep_removed',
    'note','decision','issue','resolved','next','evidence')),
  text TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL,
  at TEXT NOT NULL
) STRICT;

CREATE TABLE evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  criterion INTEGER NOT NULL,
  round INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('work','review')),
  verdict TEXT NOT NULL CHECK (verdict IN ('verified','incorrect','unresolved')),
  basis TEXT NOT NULL,
  missing TEXT,
  artifacts TEXT NOT NULL DEFAULT '[]',
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  FOREIGN KEY (task_id, criterion) REFERENCES criteria(task_id, idx),
  CHECK ((verdict = 'unresolved') = (missing IS NOT NULL))
) STRICT;`;
function help(command) {
  if (command && !Object.hasOwn(signatures, command)) usage(`未知のコマンド: ${command}`);
  const selected = command ? [command] : Object.keys(signatures);
  return selected.map(c => `agtask ${c} ${signatures[c]}\n  前提: ${preconditions[c] || (c === 'init' ? 'DB 不要。' : 'init 済み。')} ${!reads.includes(c) && c !== 'init' ? 'actor 必須。' : ''}`).join('\n\n') + '\n\n共通: --json, --as <name> (AGTASK_AGENT より優先), -h / --help\nagtask --version\nagtask help [<command>]';
}
function execute(command, p, v, actor) {
  const required = key => { if (v[key] === undefined) usage(`--${key} は必須です`); return v[key]; };
  const list = key => v[key] || [];
  const count = (min, max = min) => { if (p.length < min || p.length > max) usage(`引数: agtask ${command} ${signatures[command]}`); };
  if (command === 'init') {
    count(0);
    const prefix = v.prefix || 'AGT';
    if (!/^[A-Z][A-Z0-9]{0,9}$/.test(prefix)) usage('不正な PREFIX です');
    let created = false;
    if (one('PRAGMA user_version').user_version === 0) {
      db.exec(schema);
      for (const table of ['events', 'evidence', 'criteria']) {
        for (const action of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'append only'); END`);
      }
      run('INSERT INTO meta VALUES(?,?),(?,?)', 'prefix', prefix, 'next_seq', '1');
      db.exec('PRAGMA user_version=1');
      created = true;
    } else if (v.prefix && meta('prefix') !== prefix) fail('PREFIX_MISMATCH', 'PREFIX が一致しません', { prefix: meta('prefix') });
    let gitignore = 'skipped';
    if (!process.env.AGTASK_DB) {
      try { writeFileSync(resolve(dirname(dbPath), '.gitignore'), '*\n', { flag: 'wx' }); gitignore = 'created'; }
      catch (error) { if (error.code !== 'EEXIST') throw error; gitignore = 'exists'; }
    }
    if (v.workspace) {
      const mark = resolve(dirname(dbPath), 'workspace');
      if (!existsSync(mark)) writeFileSync(mark, 'agtask workspace root\n', { flag: 'wx' });
    }
    return { db: dbPath, prefix: meta('prefix'), created, gitignore, workspace: workspaceRoot };
  }
  if (command === 'add') {
    count(1);
    const role = member(required('role'), roles), goal = required('goal');
    const criteria = list('criterion');
    if (!criteria.length) usage('--criterion は必須です');
    if (v.agent && v.agent === v.reviewer) usage('担当とレビュアーは別の名前にしてください');
    if (list('write').some(path => list('read').includes(path))) usage('同じパスを --write と --read に指定できません');
    const seq = Number(meta('next_seq')), id = `${meta('prefix')}-${seq}`, at = now();
    run('INSERT INTO tasks(id,seq,title,role,goal,agent,reviewer,plan,max_fix_rounds,next_action,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', id, seq, p[0], role, goal, v.agent ?? null, v.reviewer ?? null, v.plan ?? null, v['max-fix-rounds'] === undefined ? 2 : integer(v['max-fix-rounds']), v.next ?? null, actor, at, at);
    run("UPDATE meta SET value=? WHERE key='next_seq'", String(seq + 1));
    criteria.forEach((text, i) => run('INSERT INTO criteria VALUES(?,?,?)', id, i + 1, text));
    for (const key of ['write', 'read']) for (const path of list(key)) run('INSERT INTO task_files VALUES(?,?,?)', id, path, key === 'write' ? 1 : 0);
    event(id, 'created', null, {}, actor);
    for (const d of list('dep')) depAdd(getTask(id), getTask(d), actor);
    if (v.next) event(id, 'next', v.next, {}, actor);
    return { task: taskJSON(getTask(id)) };
  }
  if (command === 'dep') {
    count(3, Infinity);
    member(p[0], ['add', 'rm']);
    const t = getTask(p[1]); stateCheck(t, ['todo', 'blocked']);
    const added = [], existing = [], removed = [];
    for (const id of unique(p.slice(2).map(id => id.toUpperCase()))) {
      const d = getTask(id);
      if (p[0] === 'add') (depAdd(t, d, actor) ? added : existing).push(d.id);
      else {
        if (!run('DELETE FROM deps WHERE task_id=? AND depends_on=?', t.id, d.id).changes) fail('NOT_FOUND', '依存がありません', { id: d.id });
        event(t.id, 'dep_removed', null, { depends_on: d.id }, actor); removed.push(d.id);
      }
    }
    return p[0] === 'add' ? { task: t.id, added, existing } : { task: t.id, removed };
  }
  if (['ls', 'ready', 'graph', 'handoff'].includes(command)) {
    if (command !== 'handoff') count(0);
    const tasks = all('SELECT * FROM tasks ORDER BY seq').map(taskJSON);
    if (command === 'ls' || command === 'ready') {
      for (const s of list('state')) member(s, states);
      const ready = command === 'ready' || v.ready;
      return { tasks: tasks.filter(t => (!v.state || v.state.includes(t.state)) && (!v.plan || t.plan === v.plan) && (!ready || t.ready) && (!v.agent || t.agent === v.agent || (ready && !t.agent))) };
    }
    const ordered = topological(tasks);
    if (command === 'graph') {
      const format = member(v.format || 'text', ['text', 'mermaid']);
      const edges = tasks.flatMap(t => t.deps.map(d => ({ from: d, to: t.id })));
      return { nodes: ordered.map(({ id, title, state, ready }) => ({ id, title, state, ready })), edges,
        body: format === 'text' ? ordered.map(t => `${t.id} [${t.state}${t.ready ? ', ready' : ''}] ${t.title}${t.deps.length ? ` <- ${t.deps.join(', ')}` : ''}`).join('\n') : mermaid(tasks, edges) };
    }
    const ids = unique(p.map(id => getTask(id).id));
    const full = ordered.filter(t => ids.length ? ids.includes(t.id) : v.all || !terminal.includes(t.state));
    const counts = Object.fromEntries(states.map(s => [s, tasks.filter(t => t.state === s).length]));
    const result = { db: dbPath, generated_at: now(), counts, ready: tasks.filter(t => t.ready).map(t => t.id), tasks: full.map(handoffTask),
      finished: ids.length || v.all ? [] : ordered.filter(t => terminal.includes(t.state)).map(t => ({ id: t.id, title: t.title, state: t.state, outputs: t.outputs, summary: summaryFor(t) })) };
    return { ...result, body: handoffMarkdown(result) };
  }
  if (command === 'next') count(v.clear ? 1 : 2); else if (command === 'note') count(2); else count(1);
  const t = getTask(p[0]);
  if (command === 'show' || command === 'history') {
    const evidence = all('SELECT * FROM evidence WHERE task_id=? ORDER BY id', t.id).map(evidenceJSON);
    const events = all('SELECT * FROM events WHERE task_id=? ORDER BY id', t.id).map(eventJSON);
    if (command === 'history') return { task: t.id, events, evidence, body: historyMarkdown(t, events, evidence) };
    const task = taskJSON(t);
    task.criteria = task.criteria.map(c => ({ ...c, work: latest(t, c.index, 'work'), review: latest(t, c.index, 'review') }));
    task.dependents = all('SELECT t.id FROM deps d JOIN tasks t ON t.id=d.task_id WHERE d.depends_on=? ORDER BY t.seq', t.id).map(d => d.id);
    return { task, evidence, events, summary: summaryFor(t), body: showMarkdown(task, events) };
  }
  if (command === 'note' || command === 'next') {
    const text = v.clear ? null : clean(p[1] === '-' ? readFileSync(0, 'utf8') : p[1]);
    let kind = command === 'next' ? 'next' : member(v.kind || 'note', ['note', 'decision', 'issue']), data = {};
    if (v.resolve !== undefined) {
      if (v.kind) usage('--resolve と --kind は併用できません');
      const id = integer(v.resolve);
      const issue = one("SELECT * FROM events WHERE id=? AND task_id=? AND kind='issue'", id, t.id);
      if (!issue) fail('NOT_FOUND', 'issue がありません', { id });
      if (!issues(t).some(i => i.id === id)) fail('INVALID_STATE', 'issue は解消済みです', { state: 'resolved', allowed: ['issue'] });
      kind = 'resolved'; data = { resolves: id };
    }
    if (command === 'next') update(t, { next_action: text });
    const id = event(t.id, kind, text, data, actor);
    return { event: eventJSON(one('SELECT * FROM events WHERE id=?', id)) };
  }
  if (command === 'evidence') {
    stateCheck(t, ['in_progress', 'review']);
    const stage = t.state === 'review' ? 'review' : 'work';
    if (stage === 'work') owner(t, actor); else reviewer(t, actor);
    const criterion = integer(required('criterion')), verdict = member(required('verdict'), ['verified', 'incorrect', 'unresolved']), basis = required('basis');
    if ((verdict === 'unresolved') !== (v.missing !== undefined)) usage('unresolved のときだけ --missing が必須です');
    if (!one('SELECT 1 FROM criteria WHERE task_id=? AND idx=?', t.id, criterion)) fail('NOT_FOUND', '受け入れ条件がありません', { id: criterion });
    const id = Number(run('INSERT INTO evidence(task_id,criterion,round,stage,verdict,basis,missing,artifacts,actor,at) VALUES(?,?,?,?,?,?,?,?,?,?)', t.id, criterion, t.fix_rounds, stage, verdict, basis, v.missing ?? null, JSON.stringify(list('artifact')), actor, now()).lastInsertRowid);
    event(t.id, 'evidence', null, { evidence_id: id, criterion, verdict, stage }, actor);
    return { evidence: evidenceJSON(one('SELECT * FROM evidence WHERE id=?', id)) };
  }
  if (command === 'claim') {
    if (t.agent && t.agent !== actor && ['todo', 'in_progress'].includes(t.state)) fail('ALREADY_ASSIGNED', '別の担当者が取得しています', { agent: t.agent });
    stateCheck(t, ['todo', 'in_progress']);
    const pane = v.pane ?? (process.env.HERDR_PANE_ID ? clean(process.env.HERDR_PANE_ID) : null);
    if (t.state === 'in_progress') {
      owner(t, actor);
      const changed = pane !== t.pane;
      let id = null;
      if (changed) {
        update(t, { pane });
        id = event(t.id, 'state', null, { from: t.state, to: t.state, command, agent: actor, pane }, actor);
      }
      return { task: taskJSON(getTask(t.id)), transition: null, event: id, changed };
    }
    const blocked = taskJSON(t).blocked_by;
    if (blocked.length) fail('NOT_READY', `${t.id} の依存が未完了: ${blocked.join(', ')}`, { blocked_by: blocked });
    return { ...transition(t, 'in_progress', command, actor, null, { agent: actor, pane }, { agent: actor, pane }), changed: true };
  }
  const from = { release: ['in_progress'], submit: ['in_progress'], accept: ['review'], reject: ['review'], block: ['todo', 'in_progress', 'review'], unblock: ['blocked'], fail: states.filter(s => !terminal.includes(s)), cancel: states.filter(s => !terminal.includes(s)) };
  stateCheck(t, from[command]);
  if (command === 'release') return transition(t, 'todo', command, actor, required('reason'), { pane: null, ...(v.unassign ? { agent: null } : {}) });
  if (command === 'submit') {
    const summary = v.summary === undefined ? null : clean(v.summary === '-' ? readFileSync(0, 'utf8') : v.summary);
    owner(t, actor); gate(t, 'work', list('output'));
    return transition(t, 'review', command, actor, null, { outputs: JSON.stringify(list('output')), next_action: v.next ?? null }, { summary, round: t.fix_rounds });
  }
  if (command === 'accept' || command === 'reject') {
    reviewer(t, actor);
    if (command === 'accept') { gate(t, 'review'); return transition(t, 'done', command, actor, v.note ?? null); }
    const reason = required('reason'), round = t.fix_rounds + 1, exceeded = round > t.max_fix_rounds;
    event(t.id, 'issue', reason, { reject: true, round: t.fix_rounds }, actor);
    return { ...transition(t, exceeded ? 'blocked' : 'in_progress', command, actor, exceeded ? 'fix_limit_exceeded' : reason,
      { fix_rounds: round, blocked_from: exceeded ? 'in_progress' : null, next_action: v.next || `修正: ${reason}` }, { fix_rounds: round }), fix_limit_exceeded: exceeded };
  }
  if (command === 'unblock') {
    const max = v['max-fix-rounds'] === undefined ? t.max_fix_rounds : integer(v['max-fix-rounds']);
    if (t.blocked_from === 'in_progress' && t.fix_rounds > max) fail('FIX_LIMIT_EXCEEDED', '修正上限を超過しています', { fix_rounds: t.fix_rounds, max_fix_rounds: max });
    return transition(t, t.blocked_from, command, actor, v.note ?? null, { max_fix_rounds: max });
  }
  return transition(t, { block: 'blocked', fail: 'failed', cancel: 'cancelled' }[command], command, actor, required('reason'));
}
function topological(tasks) {
  const result = [], remaining = new Set(tasks.map(t => t.id));
  while (remaining.size) {
    const t = tasks.find(t => remaining.has(t.id) && t.deps.every(d => !remaining.has(d)));
    if (!t) fail('INTERNAL', 'DB に循環があります');
    result.push(t); remaining.delete(t.id);
  }
  return result;
}
function mermaid(tasks, edges) {
  const id = s => s.replaceAll('-', '_');
  const colors = ['#ffffff,stroke:#999999', '#dbeafe,stroke:#2563eb', '#fef3c7,stroke:#d97706', '#dcfce7,stroke:#16a34a', '#fee2e2,stroke:#dc2626', '#e5e7eb,stroke:#dc2626', '#e5e7eb,stroke:#6b7280'];
  return ['flowchart TD', ...tasks.map(t => `  ${id(t.id)}["${t.id} ${t.title.replaceAll('"', '#quot;')}<br/>${t.state}"]`),
    ...edges.map(e => `  ${id(e.from)} --> ${id(e.to)}`), ...tasks.map(t => `  class ${id(t.id)} ${t.state}`),
    ...states.map((s, i) => `  classDef ${s} fill:${colors[i]}`)].join('\n');
}
function handoffTask(t) {
  const decisions = all("SELECT * FROM events WHERE task_id=? AND kind='decision' ORDER BY id", t.id).map(e => ({ event: e.id, text: e.text, by: e.actor, at: e.at }));
  const completed = [], open = [];
  const lastState = one("SELECT * FROM events WHERE task_id=? AND kind='state' ORDER BY id DESC LIMIT 1", t.id);
  const reason = lastState?.text || '-';
  if (t.state === 'blocked') open.push({ type: 'blocked', text: reason });
  open.push(...issues(t).map(i => ({ type: 'issue', event: i.id, text: i.text, reject: !!i.data.reject })));
  const unverified = [];
  for (const c of t.criteria) {
    const work = latest(t, c.index, 'work', t.fix_rounds, true), review = latest(t, c.index, 'review');
    const verified = review?.verdict === 'verified' ? review : work?.verdict === 'verified' ? work : null;
    if (verified) completed.push({ criterion: c.index, text: c.text, stage: verified.stage, basis: verified.basis });
    const current = review || work;
    if (current && current.verdict !== 'verified') open.push({ type: 'evidence', criterion: c.index, verdict: current.verdict, basis: current.basis, missing: current.missing });
    else if (!verified && ['in_progress', 'review'].includes(t.state)) unverified.push({ type: 'unverified', criterion: c.index, text: c.text });
  }
  if (t.state === 'in_progress' && t.fix_rounds > 0) for (const c of t.criteria) {
    const e = latest(t, c.index, 'review', t.fix_rounds - 1);
    if (e && e.verdict !== 'verified') open.push({ type: 'previous_review', criterion: c.index, verdict: e.verdict, basis: e.basis, missing: e.missing });
  }
  open.push(...unverified);
  const next = {
    todo: t.ready ? `claim 待ち${t.agent ? `（${t.agent}）` : ''}` : `依存待ち: ${t.blocked_by.join(', ')}`,
    in_progress: `作業中（${t.agent}）`, review: `レビュー待ち（${t.reviewer || '担当以外'}）`, blocked: `判断待ち: ${reason}`,
    done: 'なし', failed: 'なし', cancelled: 'なし',
  };
  return { id: t.id, title: t.title, task: { goal: t.goal, role: t.role, state: t.state, plan: t.plan, fix_rounds: t.fix_rounds, max_fix_rounds: t.max_fix_rounds, agent: t.agent, pane: t.pane, reviewer: t.reviewer,
    deps: t.deps.map(id => ({ id, state: getTask(id).state })), files: t.files }, outputs: t.outputs, summary: summaryFor(t), completed, decisions, open_issues: open, next_action: t.next_action || next[t.state] };
}
function handoffMarkdown(h) {
  const lines = ['# agtask handoff', '', `- DB: ${h.db}`, `- 生成: ${h.generated_at}`, `- 状態: ${['todo', 'in_progress', 'review', 'blocked', 'done', 'failed', 'cancelled'].map(s => `${s} ${h.counts[s]}`).join(' / ')}`, `- ready: ${h.ready.join(', ') || '-'}`];
  const section = (title, values) => lines.push('', `### ${title}`, '', ...(values.length ? values.map(v => `- ${indent(v)}`) : ['- なし']));
  for (const item of h.tasks) {
    const t = item.task;
    lines.push('', `## ${item.id} ${item.title}`);
    section('Task', [`目的: ${t.goal}`, `役割: ${t.role} / 状態: ${t.state} / 構成案: ${t.plan || '-'} / 修正: ${t.fix_rounds}/${t.max_fix_rounds}`,
      `担当: ${t.agent || '-'}${t.pane ? ` (${t.pane})` : ''} / レビュー: ${t.reviewer || '-'}`, `依存: ${t.deps.map(d => `${d.id} (${d.state})`).join(', ') || '-'}`,
      `担当ファイル: ${t.files.map(f => `${f.path} (${f.writable ? '書込可' : '読取のみ'})`).join(', ') || '-'}`]);
    section('Outputs', item.outputs);
    section('Summary', summaryLines(item.summary, t.fix_rounds));
    section('Completed', item.completed.map(c => `[${c.criterion}] ${c.text} — ${c.stage === 'review' ? '受入確認' : '自己検証'}: ${c.basis}`));
    section('Decisions', item.decisions.map(d => `#${d.event} ${d.text} (${d.by})`));
    section('Open issues', item.open_issues.map(issueLine));
    section('Next action', [item.next_action]);
  }
  if (h.finished.length) lines.push('', '## 終了済み', '', ...h.finished.map(t => `- ${t.id} [${t.state}] ${t.title} — Outputs: ${t.outputs.join(', ') || '-'} — Summary: ${finishedSummary(t)}`));
  return lines.join('\n');
}
// Presentation is derived from append-only events; never backfill legacy records.
const indent = value => String(value ?? '-').replaceAll('\n', '\n  ');
function eventSummary(e) {
  const { summary, round } = e?.data || {};
  return typeof summary === 'string' && summary.trim() && Number.isSafeInteger(round) && round >= 0
    ? { text: summary, round, event: e.id, by: e.by, at: e.at } : null;
}
function summaryFor(t) {
  const e = one("SELECT * FROM events WHERE task_id=? AND kind='state' AND json_extract(data,'$.command')='submit' ORDER BY id DESC LIMIT 1", t.id);
  return eventSummary(e && eventJSON(e));
}
const summaryMeta = (s, round) => `#${s.event} / round ${s.round} / ${s.by} / ${s.at}${s.round < round ? ' / 前回提出・差し戻し済み' : ''}`;
function summaryLines(s, round) {
  return s ? [`完了サマリー（直近提出）: ${summaryMeta(s, round)}`, s.text] : ['未登録'];
}
function finishedSummary(t) {
  const s = t.summary;
  return s ? `${s.text.replaceAll('\n', '\\n')} (${summaryMeta(s, getTask(t.id).fix_rounds)})` : '未登録';
}
function issueLine(i) {
  if (i.type === 'blocked') return `ブロック: ${i.text}`;
  if (i.type === 'issue') return `#${i.event} ${i.reject ? 'reject: ' : ''}${i.text}`;
  if (i.type === 'unverified') return `[${i.criterion}] 未検証: ${i.text}`;
  return `[${i.criterion}] ${i.type === 'previous_review' ? '前回レビュー ' : ''}${i.verdict}: ${i.basis}${i.type !== 'previous_review' && i.verdict === 'unresolved' ? ` / 不足: ${i.missing}` : ''}`;
}
function evidenceLines(e) {
  return [`証拠 #${e.id} / criterion ${e.criterion} / round ${e.round} / ${e.stage} / ${e.verdict} / by ${e.by} / at ${e.at}`,
    `basis: ${e.basis}`, `missing: ${e.missing ?? '-'}`, `artifacts: ${e.artifacts.length ? e.artifacts.join(', ') : '-'}`];
}
function showMarkdown(t, events) {
  const h = handoffTask(t), lines = [`# ${t.id} ${t.title}`];
  const section = (title, values) => lines.push('', `### ${title}`, '', ...(values.length ? values.map(v => `- ${indent(v)}`) : ['- なし']));
  section('Task', [`目的: ${t.goal}`, `役割: ${t.role}`, `状態: ${t.state}`, `ready: ${t.ready}`, `blocked_from: ${t.blocked_from ?? '-'}`,
    `構成案: ${t.plan ?? '-'}`, `修正: ${t.fix_rounds}/${t.max_fix_rounds}`, `担当: ${t.agent ?? '-'}`, `pane: ${t.pane ?? '-'}`, `レビュアー: ${t.reviewer ?? '-'}`,
    `作成者: ${t.created_by}`, `作成日時: ${t.created_at}`, `更新日時: ${t.updated_at}`]);
  section('Files', t.files.map(f => `${f.path} (${f.writable ? '書込可' : '読取のみ'})`));
  section('Dependencies', [`依存先: ${t.deps.join(', ') || '-'}`, `未完了の依存先: ${t.blocked_by.join(', ') || '-'}`, `依存される先: ${t.dependents.join(', ') || '-'}`]);
  section('Outputs', t.outputs);
  section('Summary', summaryLines(h.summary, t.fix_rounds));
  section('Criteria', t.criteria.flatMap(c => [`[${c.index}] ${c.text}`, ...['work', 'review'].flatMap(stage => c[stage] ? [`${stage}:`, ...evidenceLines(c[stage])] : [`${stage}: 未記録`])]));
  section('Decisions', events.filter(e => e.kind === 'decision').map(e => `#${e.id} ${e.text} / by ${e.by} / at ${e.at}`));
  section('Open issues', h.open_issues.map(issueLine));
  section('Next action', [h.next_action]);
  lines.push('', `全ラウンドの証拠・解消済み issue・通常 note: agtask history ${t.id}`);
  return lines.join('\n');
}
function historyMarkdown(t, events, evidence) {
  const lines = [`# ${t.id} ${t.title} — history`];
  if (!events.length) lines.push('', '- なし');
  for (const e of events) {
    lines.push('', `## #${e.id} ${e.at} ${e.kind} (${e.by})`, '', indent(e.text), `Data: ${JSON.stringify(e.data)}`);
    if (e.kind === 'state') {
      lines.push(`${e.data.from ?? '-'} -> ${e.data.to ?? '-'} / ${e.data.command ?? '-'}`);
      if (e.data.command === 'submit') lines.push(`Summary: ${indent(eventSummary(e)?.text ?? '未登録')}`, `round: ${e.data.round ?? '-'}`);
    }
    if (e.kind === 'evidence') {
      const found = evidence.find(v => v.id === e.data.evidence_id);
      lines.push(...(found ? evidenceLines(found).map(indent) : [`証拠なし: #${e.data.evidence_id}`]));
    }
  }
  return lines.join('\n');
}
function ensureWAL(deadline) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  // WAL negotiation can return BUSY without honoring SQLite's busy handler.
  db.exec('PRAGMA busy_timeout=0');
  try {
    for (;;) {
      try {
        if (one('PRAGMA journal_mode').journal_mode !== 'wal') db.exec('PRAGMA journal_mode=WAL');
        return;
      } catch (error) {
        const remaining = deadline - performance.now();
        if (![5, 6].includes(error.errcode & 255) || remaining <= 0) throw error;
        Atomics.wait(sleeper, 0, 0, Math.min(10, remaining));
        if (performance.now() >= deadline) throw error;
      }
    }
  } finally { db.exec(`PRAGMA busy_timeout=${timeout}`); }
}
function main() {
  const started = performance.now();
  const boolean = ['json', 'help', 'version', 'ready', 'unassign', 'clear', 'all', 'workspace'];
  const multiple = ['criterion', 'write', 'read', 'dep', 'state', 'artifact', 'output'];
  const keys = unique(['as', ...Object.values(allowed).flat(), ...boolean]);
  const options = Object.fromEntries(keys.map(k => [k, { type: boolean.includes(k) ? 'boolean' : 'string', ...(multiple.includes(k) ? { multiple: true } : {}), ...(k === 'help' ? { short: 'h' } : {}) }]));
  const parsed = parseArgs({ options, strict: true, allowPositionals: true });
  const v = parsed.values, positionals = parsed.positionals.map(clean);
  json = !!v.json;
  let command = positionals.shift();
  const information = (key, value) => console.log(json ? JSON.stringify({ ok: true, [key]: value }) : value);
  if (v.version && !command) { information('version', VERSION); return; }
  if (command === 'help') {
    if (positionals.length > 1) usage('help [<command>]');
    information('help', help(positionals[0])); return;
  }
  if (!command || v.help) { information('help', help(command)); return; }
  if (!Object.hasOwn(signatures, command)) usage(`未知のコマンド: ${command}`);
  for (const [key, value] of Object.entries(v)) {
    if (!['as', 'json', 'help', ...allowed[command]].includes(key)) usage(`${command} に --${key} は使えません`);
    if (typeof value === 'string') v[key] = clean(value);
    else if (Array.isArray(value)) v[key] = unique(value.map(clean));
  }
  // criterion is repeatable for add, but scalar for evidence.
  if (command === 'evidence' && v.criterion) {
    if (v.criterion.length !== 1) usage('--criterion は一つだけ指定してください');
    v.criterion = v.criterion[0];
  }
  for (const key of ['as', 'agent', 'reviewer']) if (v[key]) name(v[key]);
  const actor = v.as || (process.env.AGTASK_AGENT ? name(clean(process.env.AGTASK_AGENT)) : null);
  if (!reads.includes(command) && command !== 'init' && !actor) usage('--as または AGTASK_AGENT が必要です');
  if (process.env.AGTASK_BUSY_TIMEOUT_MS !== undefined) timeout = integer(process.env.AGTASK_BUSY_TIMEOUT_MS);
  if (v.workspace && process.env.AGTASK_DB) usage('AGTASK_DB と --workspace は併用できません');
  ({ db: dbPath, workspace: workspaceRoot } = location(command === 'init' && v.workspace));
  if (command !== 'init') {
    try { statSync(dbPath); }
    catch (error) {
      if (error.code === 'ENOENT') fail('NOT_INITIALIZED', 'init を実行してください', { db: dbPath });
      throw error;
    }
  }
  if (command === 'init') mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath, { timeout, readOnly: reads.includes(command) });
  db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL');
  if (command === 'init') ensureWAL(started + timeout);
  db.exec(reads.includes(command) ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    const version = one('PRAGMA user_version').user_version;
    if (version > 1) fail('SCHEMA_TOO_NEW', '未対応のスキーマです', { user_version: version });
    if (!version && command !== 'init') fail('NOT_INITIALIZED', 'init を実行してください', { db: dbPath });
    const result = execute(command, positionals, v, actor);
    db.exec('COMMIT');
    const { body, ...data } = result;
    if (json) console.log(JSON.stringify({ ok: true, ...data }));
    else if (body !== undefined) console.log(body);
    else if (data.transition) console.log(`${data.task.id}: ${data.transition.from} -> ${data.transition.to}${data.fix_limit_exceeded ? ` 修正上限を超過: ${data.task.fix_rounds}/${data.task.max_fix_rounds}` : ''}`);
    else if (data.tasks) console.log(['ID\tSTATE\tAGENT\tTITLE', ...data.tasks.map(t => `${t.id}\t${t.state}${t.ready ? ' (ready)' : ''}\t${t.agent || '-'}\t${t.title}`)].join('\n'));
    else console.log(`${typeof data.task === 'object' ? `${data.task.id}: ${data.task.state}` : data.task || data.db || command}: OK`);
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
try { main(); }
catch (error) {
  let e = error;
  if (!(e instanceof Failure)) {
    if ([5, 6].includes(e.errcode & 255)) e = new Failure('BUSY', 'DB のロック待ちがタイムアウトしました', { timeout_ms: timeout });
    else if ([8, 14].includes(e.errcode & 255) || ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EROFS', 'EEXIST'].includes(e.code)) e = new Failure('DB_ACCESS', 'DB にアクセスできません', { db: dbPath, sqlite_code: e.errcode ?? e.code });
    else if (e.code?.startsWith('ERR_PARSE_ARGS')) e = new Failure('USAGE', e.message);
    else e = new Failure('INTERNAL', e.message);
  }
  if (json) console.log(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, details: e.details } }));
  else console.error(`agtask: ${e.message.replaceAll('\n', ' ')} [${e.code}]`);
  const codes = { INTERNAL: 1, SCHEMA_TOO_NEW: 1, USAGE: 2, NOT_INITIALIZED: 3, NOT_FOUND: 3, BUSY: 5, DB_ACCESS: 6 };
  process.exitCode = codes[e.code] || 4;
} finally { db?.close(); }

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED, classifyAgtask, discoverDb, listTasks, runAgtask } from '../lib/tasks.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const raw = (o) => ({ code: 0, stdout: '', stderr: '', spawnError: null, killed: false, ...o });

test('classify ok / not initialized / errors', () => {
  const ok = classifyAgtask(raw({ stdout: fx('agtask-ls.json') }));
  assert.equal(ok.status, 'ok');
  assert.equal(ok.data.tasks.length, 7);
  assert.deepEqual(classifyAgtask(raw({ code: 3, stdout: fx('agtask-not-initialized.json') })), { status: 'not_initialized', db: '/repo/example/.agtask/tasks.db' });
  const busy = classifyAgtask(raw({ code: 5, stdout: '{"ok":false,"error":{"code":"BUSY","message":"locked","details":{}}}\n' }));
  assert.deepEqual(busy, { status: 'error', code: 'BUSY', message: 'locked' });
  assert.equal(classifyAgtask(raw({ spawnError: { code: 'ENOENT', message: 'x' } })).status, 'missing');
  const bad = classifyAgtask(raw({ stdout: '', stderr: '\nboom happened\nmore', code: 1 }));
  assert.deepEqual(bad, { status: 'error', code: 'BAD_OUTPUT', message: 'boom happened' });
  assert.equal(classifyAgtask(raw({ stdout: 'garbage' })).message, 'invalid agtask output');
  assert.equal(classifyAgtask(raw({ killed: true })).code, 'TIMEOUT');
});

test('ALLOWED is read-only and other commands throw before spawning', () => {
  assert.deepEqual(ALLOWED, { ls: ['ls', '--json'], handoff: ['handoff', '--json'] });
  assert.throws(() => runAgtask('add', { cwd: '.', bin: 'true', env: {} }));
  assert.throws(() => runAgtask('init', { cwd: '.', bin: 'true', env: {} }));
  assert.throws(() => runAgtask('toString', { cwd: '.', bin: 'true', env: {} }));
});

const agtaskMjs = fileURLToPath(new URL('../../../tools/agtask/agtask.mjs', import.meta.url));

test('integration with the real agtask CLI', { skip: !existsSync(agtaskMjs) && 'agtask.mjs not present' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-agtask-'));
  try {
    const shim = join(dir, 'agtask-shim');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${agtaskMjs}" "$@"\n`);
    chmodSync(shim, 0o755);
    const db = join(dir, 'tasks.db');
    const env = { ...process.env, AGTASK_DB: db };
    const opts = { cwd: dir, bin: shim, env };
    const first = await listTasks(opts);
    assert.equal(first.status, 'not_initialized');
    assert.equal(first.db, db);
    execFileSync(shim, ['init', '--json'], { cwd: dir, env });
    execFileSync(shim, ['add', 'First task', '--role', 'implementation', '--goal', 'g', '--criterion', 'c', '--as', 'parent', '--json'], { cwd: dir, env });
    const res = await listTasks(opts);
    assert.equal(res.status, 'ok');
    assert.equal(res.tasks.length, 1);
    for (const k of ['id', 'title', 'role', 'state', 'agent', 'pane', 'reviewer', 'plan', 'fix_rounds', 'max_fix_rounds', 'next_action', 'created_by', 'ready', 'deps', 'blocked_by']) {
      assert.ok(k in res.tasks[0], `missing key ${k}`);
    }
    const d = await discoverDb(opts);
    assert.equal(d.status, 'ok');
    assert.equal(d.db, db);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing cwd never spawns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-nocwd-'));
  try {
    const marker = join(dir, 'ran');
    const shim = join(dir, 'shim');
    writeFileSync(shim, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(shim, 0o755);
    for (const cwd of [null, undefined, '']) {
      assert.throws(() => runAgtask('ls', { cwd, bin: shim, env: process.env }), /cwd is required/);
      await assert.rejects(listTasks({ cwd, bin: shim, env: process.env }));
      await assert.rejects(discoverDb({ cwd, bin: shim, env: process.env }));
    }
    assert.equal(existsSync(marker), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('nonexistent cwd is BAD_CWD, not "agtask missing"', async () => {
  const res = await listTasks({ cwd: join(tmpdir(), 'ob-does-not-exist-xyz'), bin: 'agtask', env: process.env });
  assert.equal(res.status, 'error');
  assert.equal(res.code, 'BAD_CWD');
  assert.match(res.message, /cwd not found/);
});

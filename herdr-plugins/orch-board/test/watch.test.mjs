import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, isRelevantDbFile, watchDb } from '../lib/watch.mjs';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = process.env.NIX_BUILD_TOP ? 'no fs events in sandbox' : false;

test('isRelevantDbFile', () => {
  assert.equal(isRelevantDbFile('tasks.db', 'tasks.db'), true);
  assert.equal(isRelevantDbFile('tasks.db-wal', 'tasks.db'), true);
  assert.equal(isRelevantDbFile('tasks.db-shm', 'tasks.db'), false);
  assert.equal(isRelevantDbFile('.gitignore', 'tasks.db'), false);
  assert.equal(isRelevantDbFile(null, 'tasks.db'), true);
});

test('fingerprint ignores -shm', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-watch-'));
  try {
    const db = join(dir, 'tasks.db');
    assert.equal(fingerprint(db), '-|-');
    writeFileSync(db, 'x');
    writeFileSync(`${db}-wal`, 'w');
    const a = fingerprint(db);
    await tick(20);
    writeFileSync(`${db}-shm`, 's');
    assert.equal(fingerprint(db), a);
    appendFileSync(`${db}-wal`, 'more');
    assert.notEqual(fingerprint(db), a);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('watchDb fires on wal append only', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-watch-'));
  try {
    const db = join(dir, 'tasks.db');
    writeFileSync(db, 'x');
    writeFileSync(`${db}-wal`, 'w');
    let n = 0;
    const w = watchDb(db, () => n++);
    assert.ok(w);
    await tick(100);
    writeFileSync(`${db}-shm`, 's');
    await tick(500);
    assert.equal(n, 0);
    appendFileSync(`${db}-wal`, 'more');
    for (let i = 0; i < 40 && n === 0; i++) await tick(50);
    assert.ok(n >= 1);
    w.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('watchDb returns null for missing dir', () => {
  assert.equal(watchDb(join(tmpdir(), 'ob-nonexistent-dir', 'tasks.db'), () => {}), null);
});

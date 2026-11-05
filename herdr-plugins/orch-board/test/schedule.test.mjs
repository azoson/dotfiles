import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebouncer, createSerialRunner } from '../lib/schedule.mjs';

test('debouncer coalesces bursts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let n = 0;
  const d = createDebouncer(() => n++, { delayMs: 100, maxWaitMs: 1000 });
  d.trigger(); d.trigger(); d.trigger();
  t.mock.timers.tick(99);
  assert.equal(n, 0);
  t.mock.timers.tick(1);
  assert.equal(n, 1);
  t.mock.timers.tick(5000);
  assert.equal(n, 1);
});

test('debouncer fires by maxWait under continuous triggers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let n = 0;
  const d = createDebouncer(() => n++, { delayMs: 100, maxWaitMs: 350 });
  for (let i = 0; i < 3; i++) { d.trigger(); t.mock.timers.tick(90); }
  assert.equal(n, 0);
  d.trigger();
  t.mock.timers.tick(80);
  assert.equal(n, 1);
});

test('debouncer flush and cancel', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let n = 0;
  const d = createDebouncer(() => n++, { delayMs: 100, maxWaitMs: 1000 });
  d.trigger(); d.flush();
  assert.equal(n, 1);
  d.trigger(); d.cancel();
  t.mock.timers.tick(5000);
  assert.equal(n, 1);
});

test('serial runner never overlaps and reruns once', async () => {
  let active = 0, maxActive = 0, runs = 0;
  let release;
  const run = createSerialRunner(async () => {
    runs++; active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => { release = r; });
    active--;
  });
  const first = run();
  await Promise.resolve();
  run(); run(); run();
  release();
  await new Promise((r) => setImmediate(r));
  release();
  await first;
  assert.equal(maxActive, 1);
  assert.equal(runs, 2);
});

test('serial runner reports errors', async () => {
  const errs = [];
  const run = createSerialRunner(async () => { throw new Error('x'); }, (e) => errs.push(e.message));
  await run();
  assert.deepEqual(errs, ['x']);
});

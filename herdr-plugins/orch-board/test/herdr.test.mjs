import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLOBAL_SUBSCRIPTIONS, HerdrError, normalizeEvent, request, socketPath, subscribe, subscriptionList } from '../lib/herdr.mjs';

const EXPECTED_GLOBAL = [
  'workspace.created', 'workspace.updated', 'workspace.renamed', 'workspace.closed',
  'worktree.created', 'worktree.opened', 'worktree.removed',
  'tab.created', 'tab.closed', 'tab.renamed', 'tab.moved',
  'pane.created', 'pane.closed', 'pane.updated', 'pane.moved', 'pane.exited', 'pane.agent_detected',
];

async function fakeServer(onConn) {
  const dir = mkdtempSync(join(tmpdir(), 'ob-'));
  const path = join(dir, 's.sock');
  const conns = [];
  const server = net.createServer((c) => { conns.push(c); c.setEncoding('utf8'); onConn(c); });
  await new Promise((r) => server.listen(path, r));
  return { path, async close() { for (const c of conns) c.destroy(); await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); } };
}
const onFirstLine = (c, fn) => { let buf = ''; c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { const l = buf.slice(0, i); buf = ''; fn(JSON.parse(l)); } }); };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('socketPath order', () => {
  assert.equal(socketPath({ HERDR_SOCKET_PATH: '/s' }, '/h'), '/s');
  assert.equal(socketPath({ XDG_CONFIG_HOME: '/x' }, '/h'), '/x/herdr/herdr.sock');
  assert.equal(socketPath({}, '/h'), '/h/.config/herdr/herdr.sock');
});

test('subscriptionList', () => {
  assert.deepEqual([...GLOBAL_SUBSCRIPTIONS], EXPECTED_GLOBAL);
  const list = subscriptionList(['w1:p2', 'w1:p1', 'w1:p1']);
  assert.deepEqual(list.slice(0, EXPECTED_GLOBAL.length), EXPECTED_GLOBAL.map((type) => ({ type })));
  assert.deepEqual(list.slice(EXPECTED_GLOBAL.length), [
    { type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
    { type: 'pane.agent_status_changed', pane_id: 'w1:p2' },
  ]);
  assert.ok(!list.slice(0, EXPECTED_GLOBAL.length).some((s) => s.type === 'pane.agent_status_changed'));
});

test('normalizeEvent', () => {
  assert.deepEqual(normalizeEvent({ event: 'pane_updated', data: { type: 'pane_updated', pane: {} } }).kind, 'pane_updated');
  const per = normalizeEvent({ event: 'pane.agent_status_changed', data: { pane_id: 'w1:p1' } });
  assert.equal(per.kind, 'pane_agent_status_changed');
  assert.equal(per.data.pane_id, 'w1:p1');
  assert.equal(normalizeEvent({ data: { type: 'tab_created' } }).kind, 'tab_created');
  assert.equal(normalizeEvent({ id: 'x', result: {} }), null);
});

test('request matches id, ignoring unrelated lines', async () => {
  const s = await fakeServer((c) => onFirstLine(c, (req) => {
    c.write(JSON.stringify({ id: 'other', result: { no: 1 } }) + '\n');
    c.write(JSON.stringify({ id: req.id, result: { type: 'ok', method: req.method } }) + '\n');
  }));
  try {
    assert.deepEqual(await request(s.path, 'session.snapshot', {}), { type: 'ok', method: 'session.snapshot' });
  } finally { await s.close(); }
});

test('request error, timeout, missing socket', async () => {
  const s = await fakeServer((c) => onFirstLine(c, (req) => {
    if (req.method === 'bad') c.write(JSON.stringify({ id: req.id, error: { code: 'pane_not_found', message: 'nope' } }) + '\n');
  }));
  try {
    await assert.rejects(request(s.path, 'bad', {}), (e) => e instanceof HerdrError && e.code === 'pane_not_found' && e.message === 'nope');
    await assert.rejects(request(s.path, 'silent', {}, { timeoutMs: 80 }), (e) => e.code === 'timeout');
  } finally { await s.close(); }
  await assert.rejects(request(join(tmpdir(), 'ob-missing', 'x.sock'), 'm', {}), (e) => e.code === 'ENOENT');
});

test('subscribe: ack, chunked events, close', async () => {
  let conn;
  const s = await fakeServer((c) => { conn = c; onFirstLine(c, (req) => {
    c.write(JSON.stringify({ id: req.id, result: { type: 'subscription_started' } }) + '\n');
    const e1 = JSON.stringify({ event: 'pane_updated', data: { type: 'pane_updated' } });
    const e2 = JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: 'w1:p1' } });
    const e3 = JSON.stringify({ event: 'tab_created', data: { type: 'tab_created' } });
    setTimeout(() => c.write(`${e1}\n${e2}\n${e3.slice(0, 10)}`), 10);
    setTimeout(() => c.write(`${e3.slice(10)}\n`), 40);
  }); });
  try {
    const events = []; let ready = 0; let closed = 0;
    const sub = subscribe(s.path, subscriptionList([]), { onReady: () => ready++, onEvent: (k) => events.push(k), onClose: () => closed++ });
    await tick(150);
    assert.equal(ready, 1);
    assert.deepEqual(events, ['pane_updated', 'pane_agent_status_changed', 'tab_created']);
    sub.close();
    conn.destroy();
    await tick();
    assert.equal(closed, 0);
  } finally { await s.close(); }
});

test('subscribe: events_lost error closes once', async () => {
  const s = await fakeServer((c) => onFirstLine(c, (req) => {
    c.write(JSON.stringify({ id: req.id, result: { type: 'subscription_started' } }) + '\n');
    setTimeout(() => { c.write(JSON.stringify({ id: req.id, error: { code: 'events_lost', message: 'x' } }) + '\n'); c.end(); }, 10);
  }));
  try {
    const closes = [];
    subscribe(s.path, [], { onClose: (e) => closes.push(e.code) });
    await tick(100);
    assert.deepEqual(closes, ['events_lost']);
  } finally { await s.close(); }
});

test('subscribe: server closes before ack', async () => {
  const s = await fakeServer((c) => onFirstLine(c, () => c.end()));
  try {
    const closes = []; let ready = 0;
    subscribe(s.path, [], { onReady: () => ready++, onClose: (e) => closes.push(e.code) });
    await tick(100);
    assert.deepEqual(closes, ['closed']);
    assert.equal(ready, 0);
  } finally { await s.close(); }
});

test('subscribe: ack timeout reports timeout once', async () => {
  const s = await fakeServer((c) => onFirstLine(c, () => {}));
  try {
    const closes = []; let ready = 0;
    subscribe(s.path, [], { ackTimeoutMs: 80, onReady: () => ready++, onClose: (e) => closes.push(e.code) });
    await tick(250);
    assert.deepEqual(closes, ['timeout']);
    assert.equal(ready, 0);
  } finally { await s.close(); }
});

test('subscribe: ack within timeout cancels the timer', async () => {
  const s = await fakeServer((c) => onFirstLine(c, (req) => c.write(JSON.stringify({ id: req.id, result: { type: 'subscription_started' } }) + '\n')));
  try {
    const closes = []; let ready = 0;
    const sub = subscribe(s.path, [], { ackTimeoutMs: 80, onReady: () => ready++, onClose: (e) => closes.push(e.code) });
    await tick(250);
    assert.equal(ready, 1);
    assert.deepEqual(closes, []);
    sub.close();
  } finally { await s.close(); }
});

// Minimal herdr socket client (newline-delimited JSON over a Unix socket).
import net from 'node:net';
import { join } from 'node:path';

export class HerdrError extends Error {
  constructor(code, message) {
    super(message ?? String(code));
    this.name = 'HerdrError';
    this.code = code;
  }
}

export function socketPath(env, homedir) {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const base = env.XDG_CONFIG_HOME || join(homedir, '.config');
  return join(base, 'herdr', 'herdr.sock');
}

export function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

export function normalizeEvent(msg) {
  if (!msg || typeof msg !== 'object' || 'id' in msg) return null;
  const kind = String(msg.event ?? msg.data?.type ?? '').replaceAll('.', '_');
  if (!kind) return null;
  return { kind, data: msg.data };
}

export const GLOBAL_SUBSCRIPTIONS = [
  'workspace.created', 'workspace.updated', 'workspace.renamed', 'workspace.closed',
  'worktree.created', 'worktree.opened', 'worktree.removed',
  'tab.created', 'tab.closed', 'tab.renamed', 'tab.moved',
  'pane.created', 'pane.closed', 'pane.updated', 'pane.moved', 'pane.exited', 'pane.agent_detected',
];

export function subscriptionList(agentPaneIds) {
  const ids = [...new Set(agentPaneIds)].sort();
  return [
    ...GLOBAL_SUBSCRIPTIONS.map((type) => ({ type })),
    ...ids.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
  ];
}

let counter = 0;

// Splits incoming data into lines and calls onLine for each non-empty one.
function lineReader(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  };
}

export function request(path, method, params, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = `orch-board-${++counter}`;
    const sock = net.createConnection(path);
    sock.setEncoding('utf8');
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new HerdrError('timeout', `${method} timed out`)), timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'));
    sock.on('data', lineReader((line) => {
      const msg = parseLine(line);
      if (!msg || msg.id !== id) return;
      if (msg.error) finish(reject, new HerdrError(msg.error.code ?? 'error', msg.error.message));
      else finish(resolve, msg.result);
    }));
    sock.on('error', (err) => finish(reject, new HerdrError(err.code ?? 'error', err.message)));
    sock.on('close', () => finish(reject, new HerdrError('closed', 'connection closed')));
  });
}

export function subscribe(path, subscriptions, { onReady, onEvent, onClose, ackTimeoutMs = 3000 }) {
  const id = `orch-board-sub-${++counter}`;
  const sock = net.createConnection(path);
  sock.setEncoding('utf8');
  let closedByUs = false;
  let closeReported = false;
  const report = (err) => {
    if (closedByUs || closeReported) return;
    closeReported = true;
    clearTimeout(ackTimer);
    sock.destroy();
    onClose?.(err);
  };
  const ackTimer = setTimeout(() => report(new HerdrError('timeout', 'subscription ack timed out')), ackTimeoutMs);
  sock.on('connect', () => {
    sock.write(JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } }) + '\n');
  });
  sock.on('data', lineReader((line) => {
    const msg = parseLine(line);
    if (!msg) return;
    if (msg.id === id) {
      if (msg.error) report(new HerdrError(msg.error.code ?? 'error', msg.error.message));
      else if (msg.result?.type === 'subscription_started') { clearTimeout(ackTimer); onReady?.(); }
      return;
    }
    const ev = normalizeEvent(msg);
    if (ev) onEvent?.(ev.kind, ev.data);
  }));
  sock.on('error', (err) => report(new HerdrError(err.code ?? 'closed', err.message)));
  sock.on('close', () => report(new HerdrError('closed', 'connection closed')));
  return {
    close() {
      closedByUs = true;
      clearTimeout(ackTimer);
      sock.destroy();
    },
  };
}

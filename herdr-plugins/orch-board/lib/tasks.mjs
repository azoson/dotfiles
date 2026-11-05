// agtask runner (read-only whitelist) and output classification.
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';

// Replaced with the store path of agtask when built by Nix; ORCH_BOARD_AGTASK overrides it.
export const DEFAULT_AGTASK = 'agtask';

export const ALLOWED = Object.freeze({ ls: ['ls', '--json'], handoff: ['handoff', '--json'] });

export function runAgtask(which, { cwd, bin, env, timeoutMs = 5000 }) {
  if (!Object.hasOwn(ALLOWED, which)) throw new Error(`agtask command not allowed: ${which}`);
  if (typeof cwd !== 'string' || cwd === '') throw new Error('agtask cwd is required');
  try {
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch {
    return Promise.resolve({ code: null, stdout: '', stderr: '', spawnError: { code: 'BAD_CWD', message: `cwd not found: ${cwd}` }, killed: false });
  }
  return new Promise((resolve) => {
    execFile(bin, [...ALLOWED[which]], { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = { code: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: stdout ?? '', stderr: stderr ?? '', spawnError: null, killed: false };
      if (err) {
        if (err.killed || err.signal === 'SIGTERM') raw.killed = true;
        else if (typeof err.code === 'string') raw.spawnError = { code: err.code, message: err.message };
      }
      resolve(raw);
    });
  });
}

export function classifyAgtask(raw) {
  if (raw.spawnError?.code === 'ENOENT') return { status: 'missing', message: 'agtask not found' };
  if (raw.spawnError?.code === 'BAD_CWD') return { status: 'error', code: 'BAD_CWD', message: raw.spawnError.message };
  if (raw.killed) return { status: 'error', code: 'TIMEOUT', message: 'agtask timed out' };
  let data = null;
  try { data = JSON.parse(raw.stdout); } catch { /* fallthrough */ }
  if (!data || typeof data !== 'object') {
    const first = String(raw.stderr ?? '').split('\n').find((l) => l.trim());
    return { status: 'error', code: 'BAD_OUTPUT', message: first ?? 'invalid agtask output' };
  }
  if (data.ok === true) return { status: 'ok', data };
  const e = data.error ?? {};
  if (e.code === 'NOT_INITIALIZED') return { status: 'not_initialized', db: e.details?.db ?? null };
  const out = { status: 'error', code: e.code ?? 'INTERNAL', message: e.message ?? 'agtask error' };
  if (e.details?.db) out.db = e.details.db;
  return out;
}

export async function discoverDb(opts) {
  const c = classifyAgtask(await runAgtask('handoff', opts));
  if (c.status === 'ok') return { ...c, db: c.data.db ?? null };
  return c;
}

export async function listTasks(opts) {
  const c = classifyAgtask(await runAgtask('ls', opts));
  if (c.status === 'ok') return { status: 'ok', tasks: Array.isArray(c.data.tasks) ? c.data.tasks : [] };
  return c;
}

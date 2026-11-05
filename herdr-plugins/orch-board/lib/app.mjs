// Impure orchestration: state, refresh pipelines, terminal I/O.
import { parseContext, resolveRepoCwd, resolveScopeWorkspaceId } from './context.mjs';
import { request, socketPath, subscribe, subscriptionList } from './herdr.mjs';
import { parseKeys } from './keys.mjs';
import { buildModel } from './model.mjs';
import { moveSelection, render, selectableKeys } from './render.mjs';
import { createDebouncer, createSerialRunner } from './schedule.mjs';
import { DEFAULT_AGTASK, discoverDb, listTasks } from './tasks.mjs';
import { watchDb } from './watch.mjs';

const FALLBACK_MS = 10_000;
const CONNECTION_ERRORS = ['ENOENT', 'ECONNREFUSED', 'timeout'];
const noRepo = () => ({ status: 'error', code: 'NO_REPO', message: 'cannot determine repository: no cwd in plugin context' });

function createState({ argv, env, homedir }) {
  return {
    argv,
    env,
    sock: socketPath(env, homedir),
    context: parseContext(env.HERDR_PLUGIN_CONTEXT_JSON),
    snapshot: null,
    herdrError: null,
    repoCwd: null,
    scopeWorkspaceId: null,
    db: null,
    agtask: { status: 'error', code: 'LOADING', message: 'loading' },
    lastGood: null,
    showAll: false,
    selectedKey: null,
    scrollTop: 0,
    statusMessage: null,
    events: 'connecting',
    dbWatch: 'none',
    lastRefresh: null,
  };
}

async function fetchSnapshot(state) {
  try {
    const r = await request(state.sock, 'session.snapshot', {});
    state.snapshot = r?.snapshot ?? null;
    state.herdrError = null;
    state.lastRefresh = new Date();
  } catch (err) {
    state.herdrError = err.code ?? 'error';
    if (CONNECTION_ERRORS.includes(err.code)) state.snapshot = null;
  }
}

function agtaskOpts(state) {
  return { cwd: state.repoCwd, bin: state.env.ORCH_BOARD_AGTASK || DEFAULT_AGTASK, env: state.env };
}

async function fetchTasks(state) {
  if (!state.repoCwd) { state.agtask = noRepo(); return; }
  const res = await listTasks(agtaskOpts(state));
  if (res.db) state.db = res.db;
  if (res.status === 'ok') {
    state.lastGood = res.tasks;
    state.agtask = { status: 'ok', tasks: res.tasks, db: state.db };
    state.lastRefresh = new Date();
  } else if (res.status === 'error' && state.lastGood) {
    state.agtask = { status: 'error', code: res.code, message: res.message, tasks: state.lastGood, stale: true, db: state.db };
  } else {
    if (res.status !== 'error') state.lastGood = null;
    state.agtask = { ...res, db: state.db };
  }
}

// Resolves repo cwd and DB location, then loads tasks.
async function initRepo(state) {
  const r = resolveRepoCwd({ argvCwd: state.argv.cwd, env: state.env, context: state.context, snapshot: state.snapshot });
  state.repoCwd = r.cwd;
  state.scopeWorkspaceId = resolveScopeWorkspaceId({ env: state.env, context: state.context, snapshot: state.snapshot });
  if (!r.cwd) {
    state.agtask = noRepo();
    return;
  }
  const d = await discoverDb(agtaskOpts(state));
  if (d.db) state.db = d.db;
  await fetchTasks(state);
}

const modelOf = (state) => buildModel({
  snapshot: state.snapshot,
  agtask: state.agtask,
  scopeWorkspaceId: state.scopeWorkspaceId,
  repoCwd: state.repoCwd,
  showAll: state.showAll,
});

export async function dump({ argv, env, homedir }) {
  const state = createState({ argv, env, homedir });
  await fetchSnapshot(state);
  await initRepo(state);
  process.stdout.write(`${JSON.stringify({ model: modelOf(state), herdrError: state.herdrError }, null, 2)}\n`);
}

export async function runBoard({ argv, env, stdin, stdout, homedir, onCleanup }) {
  const state = createState({ argv, env, homedir });
  const color = !env.NO_COLOR && env.TERM !== 'dumb';
  let model = null;
  let watcher = null;
  let current = null;
  let pending = null;
  let lastAttemptAt = 0;
  let retryTimer = null;
  let statusTimer = null;
  let tick = null;
  let drawQueued = false;
  let exited = false;

  const redraw = () => {
    if (drawQueued || exited) return;
    drawQueued = true;
    setImmediate(() => {
      drawQueued = false;
      if (exited) return;
      model = modelOf(state);
      const f = render(
        model,
        { selectedKey: state.selectedKey, scrollTop: state.scrollTop, statusMessage: state.statusMessage, events: state.events, dbWatch: state.dbWatch, lastRefresh: state.lastRefresh, herdrError: state.herdrError },
        { cols: stdout.columns || 80, rows: stdout.rows || 24, color, now: new Date(), home: homedir },
      );
      state.selectedKey = f.selectedKey;
      state.scrollTop = f.scrollTop;
      stdout.write(`\x1b[H${f.text.split('\n').join('\x1b[K\r\n')}\x1b[K\x1b[J`);
    });
  };

  const setStatus = (msg) => {
    state.statusMessage = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { state.statusMessage = null; redraw(); }, 5000);
    redraw();
  };
  const onError = (err) => setStatus(`error: ${err?.message ?? err}`);

  function tryWatch() {
    if (watcher || !state.db) { state.dbWatch = watcher ? 'watching' : 'none'; return; }
    watcher = watchDb(state.db, () => tasksDeb.trigger(), () => { watcher = null; state.dbWatch = 'polling'; redraw(); });
    state.dbWatch = watcher ? 'watching' : 'polling';
  }

  function ensureSubscription(force = false) {
    if (!state.snapshot) {
      if (!current) state.events = 'down';
      return;
    }
    const wanted = [...new Set((state.snapshot.agents ?? []).map((a) => a.pane_id))].sort();
    const key = wanted.join(',');
    if (!force) {
      if (current?.key === key || pending?.key === key) return;
    }
    const wait = 1000 - (Date.now() - lastAttemptAt);
    if (wait > 0) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => ensureSubscription(force), wait);
      return;
    }
    lastAttemptAt = Date.now();
    pending?.sub.close();
    const p = { key, sub: null };
    p.sub = subscribe(state.sock, subscriptionList(wanted), {
      onReady() {
        if (pending !== p) return;
        const old = current;
        current = p;
        pending = null;
        old?.sub.close();
        state.events = 'live';
        herdrDeb.trigger();
        redraw();
      },
      onEvent() { herdrDeb.trigger(); },
      onClose(err) {
        if (pending === p) {
          pending = null;
          if (err.code === 'pane_not_found') herdrDeb.trigger();
          else if (!current) state.events = 'down';
        } else if (current === p) {
          current = null;
          state.events = 'down';
          herdrDeb.trigger();
        }
        redraw();
      },
    });
    pending = p;
    if (!current) state.events = 'connecting';
  }

  // All refreshes run one at a time so stale results cannot overwrite newer ones.
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const result = chain.then(fn);
    chain = result.catch(() => {});
    return result;
  };
  const herdrRun = createSerialRunner(() => exclusive(async () => {
    await fetchSnapshot(state);
    ensureSubscription();
    redraw();
  }), onError);
  const tasksRun = createSerialRunner(() => exclusive(async () => {
    await fetchTasks(state);
    tryWatch();
    redraw();
  }), onError);
  const herdrDeb = createDebouncer(herdrRun, { delayMs: 150, maxWaitMs: 1000 });
  const tasksDeb = createDebouncer(tasksRun, { delayMs: 200, maxWaitMs: 1000 });

  function cleanup() {
    if (exited) return;
    exited = true;
    clearInterval(tick);
    clearTimeout(retryTimer);
    clearTimeout(statusTimer);
    herdrDeb.cancel();
    tasksDeb.cancel();
    current?.sub.close();
    pending?.sub.close();
    watcher?.close();
    try { stdout.write('\x1b[?7h\x1b[?25h\x1b[?1049l'); } catch { /* ignore */ }
    try { stdin.setRawMode(false); } catch { /* ignore */ }
  }
  onCleanup?.(cleanup);
  const quit = () => { cleanup(); process.exit(0); };

  async function activate() {
    const key = state.selectedKey;
    const row = model?.tasks.find((t) => t.key === key);
    const ag = model?.untracked.find((a) => a.key === key);
    const target = row ? row.live?.paneId : ag?.paneId;
    if (!target) {
      if (row) setStatus(`no live agent for ${row.id}`);
      return;
    }
    try {
      await request(state.sock, 'agent.focus', { target });
      quit();
    } catch (err) {
      setStatus(`focus failed: ${err.code ?? err.message}`);
    }
  }

  async function hardRefresh() {
    herdrDeb.cancel();
    tasksDeb.cancel();
    await exclusive(async () => {
      await fetchSnapshot(state);
      await initRepo(state);
      tryWatch();
      ensureSubscription(true);
      redraw();
    });
  }

  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l');
  stdout.on('resize', redraw);
  stdout.on('error', quit);
  stdin.on('end', quit);
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, quit);
  stdin.on('data', (chunk) => {
    for (const k of parseKeys(chunk)) {
      if (k === 'quit' || k === 'esc') return quit();
      const keys = model ? selectableKeys(model) : [];
      if (k === 'up') state.selectedKey = moveSelection(keys, state.selectedKey, -1);
      else if (k === 'down') state.selectedKey = moveSelection(keys, state.selectedKey, 1);
      else if (k === 'top' || k === 'bottom') state.selectedKey = moveSelection(keys, state.selectedKey, k);
      else if (k === 'toggle_all') state.showAll = !state.showAll;
      else if (k === 'refresh') hardRefresh().catch(onError);
      else if (k === 'enter') activate().catch(onError);
    }
    redraw();
  });

  redraw();
  try {
    await hardRefresh();
  } catch (err) {
    onError(err);
  }
  tick = setInterval(() => {
    herdrDeb.trigger();
    tasksDeb.trigger();
    if (state.events !== 'live') ensureSubscription();
    if (state.dbWatch !== 'watching') tryWatch();
  }, FALLBACK_MS);

  await new Promise(() => {});
}

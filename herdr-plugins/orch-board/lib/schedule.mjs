// Debounce and serial-run helpers with injectable timers.
export function createDebouncer(fn, { delayMs, maxWaitMs, timers = globalThis }) {
  let timer = null;
  let maxTimer = null;
  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    if (maxTimer !== null) timers.clearTimeout(maxTimer);
    timer = null;
    maxTimer = null;
  };
  const fire = () => { clear(); fn(); };
  return {
    trigger() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = timers.setTimeout(fire, delayMs);
      if (maxTimer === null) maxTimer = timers.setTimeout(fire, maxWaitMs);
    },
    flush() { fire(); },
    cancel() { clear(); },
  };
}

export function createSerialRunner(asyncFn, onError) {
  let running = false;
  let dirty = false;
  async function run() {
    if (running) { dirty = true; return; }
    running = true;
    try {
      do {
        dirty = false;
        try { await asyncFn(); } catch (err) { try { onError?.(err); } catch { /* ignore */ } }
      } while (dirty);
    } finally {
      running = false;
    }
  }
  return run;
}

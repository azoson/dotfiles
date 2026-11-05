// Watches the agtask DB directory; ignores -shm so our own reads do not retrigger.
import { statSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';

export function isRelevantDbFile(filename, dbBase) {
  if (filename == null) return true;
  return filename === dbBase || filename === `${dbBase}-wal`;
}

function stamp(p) {
  try {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
}

export function fingerprint(dbPath) {
  return `${stamp(dbPath)}|${stamp(`${dbPath}-wal`)}`;
}

export function watchDb(dbPath, onChange, onError) {
  const dir = dirname(dbPath);
  const base = basename(dbPath);
  let last = fingerprint(dbPath);
  let watcher;
  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      const name = filename == null ? null : String(filename);
      if (!isRelevantDbFile(name, base)) return;
      const fp = fingerprint(dbPath);
      if (fp === last) return;
      last = fp;
      onChange();
    });
  } catch {
    return null;
  }
  watcher.on('error', () => {
    try { watcher.close(); } catch { /* ignore */ }
    onError?.();
  });
  return { close() { try { watcher.close(); } catch { /* ignore */ } } };
}

// Pane entrypoint. `--dump` prints the joined model as JSON (no TTY needed).
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { dump, runBoard } from '../lib/app.mjs';

let values;
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: { dump: { type: 'boolean' }, cwd: { type: 'string' } },
    strict: true,
  }));
} catch (err) {
  process.stderr.write(`orch-board: ${err.message}\nusage: board.mjs [--dump] [--cwd <path>]\n`);
  process.exit(2);
}
const argv = { cwd: values.cwd ?? null, dump: Boolean(values.dump) };

if (argv.dump) {
  await dump({ argv, env: process.env, homedir: homedir() });
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('orch-board: needs a terminal (use --dump)\n');
  process.exit(2);
}
process.stderr.on('error', () => {});
process.stdout.on('error', () => {});
let cleanup = () => {};
const fatal = (err) => {
  try { cleanup(); } catch { /* ignore */ }
  try { process.stderr.write(`${err?.stack ?? err}\n`); } catch { /* ignore */ }
  process.exit(1);
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
await runBoard({
  argv,
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  homedir: homedir(),
  onCleanup: (fn) => { cleanup = fn; },
});

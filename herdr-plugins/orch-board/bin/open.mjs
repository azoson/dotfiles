// Action entrypoint. Asks herdr to open the manifest pane (popup placement comes from the manifest).
import { spawnSync } from 'node:child_process';

const herdr = process.env.HERDR_BIN_PATH || 'herdr';
const id = process.env.HERDR_PLUGIN_ID || 'azoson.orch-board';
const r = spawnSync(herdr, ['plugin', 'pane', 'open', '--plugin', id, '--entrypoint', 'board'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
});
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
if (r.error) process.stderr.write(`orch-board: ${r.error.message}\n`);
process.exit(r.status ?? 1);

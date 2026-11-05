import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOWED } from '../lib/tasks.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = ['lib', 'bin'].flatMap((d) => readdirSync(`${root}/${d}`).filter((f) => f.endsWith('.mjs')).map((f) => `${d}/${f}`));
const FORBIDDEN = ['send_keys', 'send_text', 'send_input', 'agent.prompt', 'prompt', 'agent.start', 'pane.close', 'tab.close', 'workspace.close', 'pane.split', 'report_metadata', 'report_agent', 'server.', 'popup.close'];

test('no mutating herdr method literals', () => {
  assert.ok(files.length >= 10);
  for (const f of files) {
    const src = readFileSync(`${root}/${f}`, 'utf8');
    for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
      const lit = m[2];
      for (const bad of FORBIDDEN) {
        const hit = bad.endsWith('.') ? lit.startsWith(bad) : lit === bad;
        assert.ok(!hit, `${f}: forbidden literal ${JSON.stringify(lit)}`);
      }
    }
  }
});

test('request() is only called with allowed methods', () => {
  const allowed = new Set(['session.snapshot', 'agent.focus']);
  let seen = 0;
  for (const f of files) {
    const src = readFileSync(`${root}/${f}`, 'utf8');
    for (const m of src.matchAll(/\brequest\(\s*[^,()]+,\s*([^,)]+)/g)) {
      const arg = m[1].trim();
      if (/^['"`]/.test(arg)) {
        seen++;
        assert.ok(allowed.has(arg.slice(1, -1)), `${f}: request(${arg})`);
      }
    }
  }
  assert.ok(seen >= 2);
});

test('agtask whitelist is exact', () => {
  assert.deepEqual(ALLOWED, { ls: ['ls', '--json'], handoff: ['handoff', '--json'] });
  const src = readFileSync(`${root}/lib/tasks.mjs`, 'utf8');
  assert.ok(!/\b(init|add|note|submit|accept|cancel)\b['"]/.test(src.replace(/ALLOWED[\s\S]*?\}\)/, '')));
});

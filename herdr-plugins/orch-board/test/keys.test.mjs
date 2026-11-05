import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys } from '../lib/keys.mjs';

test('key mappings', () => {
  const cases = { q: 'quit', '\x03': 'quit', j: 'down', k: 'up', '\r': 'enter', '\n': 'enter', r: 'refresh', a: 'toggle_all', g: 'top', G: 'bottom', '\x1b[A': 'up', '\x1bOA': 'up', '\x1b[B': 'down', '\x1bOB': 'down', '\x1b': 'esc' };
  for (const [input, key] of Object.entries(cases)) assert.deepEqual(parseKeys(input), [key], JSON.stringify(input));
});

test('sequences and unknown input', () => {
  assert.deepEqual(parseKeys('jjk'), ['down', 'down', 'up']);
  assert.deepEqual(parseKeys('\x1b[1;5C'), []);
  assert.deepEqual(parseKeys('\x1bOP'), []);
  assert.deepEqual(parseKeys('x\x1b[Bz'), ['down']);
});

test('view keys', () => {
  assert.deepEqual(parseKeys('\t'), ['next_view']);
  assert.deepEqual(parseKeys('v'), ['next_view']);
  assert.deepEqual(parseKeys('\x1b[Z'), ['prev_view']);
  assert.deepEqual(parseKeys('j\tk'), ['down', 'next_view', 'up']);
  assert.deepEqual(parseKeys('\x1b'), ['esc']);
});

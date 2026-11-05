import test from 'node:test';
import assert from 'node:assert/strict';
import { padEnd, sanitize, strWidth, stripAnsi, truncate } from '../lib/text.mjs';

test('strWidth', () => {
  assert.equal(strWidth('abc'), 3);
  assert.equal(strWidth('日本語'), 6);
  assert.equal(strWidth('ｱ'), 1);
  assert.equal(strWidth('é'), 1);
  assert.equal(strWidth('😀'), 2);
});

test('truncate never exceeds width and marks cuts', () => {
  const s = '日本語abcあいう…xyz';
  for (let w = 0; w <= 20; w++) {
    const t = truncate(s, w);
    assert.ok(strWidth(t) <= w, `width ${w}: ${t}`);
    if (w > 0 && strWidth(s) > w) assert.ok(t.endsWith('…'));
  }
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abc', 0), '');
});

test('padEnd gives exact width', () => {
  for (let w = 0; w <= 12; w++) assert.equal(strWidth(padEnd('日本語ab', w)), w);
});

test('sanitize removes controls', () => {
  assert.equal(sanitize('a\x1b[31mb\x07c\x9bd'), 'a[31mbcd');
  assert.equal(sanitize('a\nb\tc\rd'), 'a b c d');
  assert.equal(sanitize(null), '');
  assert.equal(stripAnsi('\x1b[1mx\x1b[0m'), 'x');
});

test('wide emoji measure 2 columns', () => {
  for (const ch of ['🚀', '🫠', '✅', '❌', '⭐', '⭕', '⌚', '⌛', '⏩', '⏳', '❓', '➕']) assert.equal(strWidth(ch), 2, ch);
  assert.equal(strWidth('a✅b'), 4);
  assert.equal(strWidth('✓'), 1);
});

test('graph glyphs are single-width and not emoji', () => {
  for (const g of ['○', '◎', '◐', '●', '■', '✓', '✗', '×', '⇠', '▸', '◂', '├', '└', '│', '─', '»']) {
    assert.equal(strWidth(g), 1, g);
    assert.equal(/\p{Emoji}/u.test(g), false, `${g} is emoji-capable`);
  }
});

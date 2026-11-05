// Pure: raw stdin chunk -> key names.
const SIMPLE = { q: 'quit', '\x03': 'quit', j: 'down', k: 'up', '\r': 'enter', '\n': 'enter', r: 'refresh', a: 'toggle_all', g: 'top', G: 'bottom' };

export function parseKeys(chunk) {
  const s = String(chunk);
  if (s === '\x1b') return ['esc'];
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\x1b') {
      if (s[i + 1] === '[') {
        let j = i + 2;
        while (j < s.length && !/[\x40-\x7e]/.test(s[j])) j++;
        const seq = s.slice(i, j + 1);
        if (seq === '\x1b[A') out.push('up');
        else if (seq === '\x1b[B') out.push('down');
        i = j + 1;
      } else if (s[i + 1] === 'O') {
        const f = s[i + 2];
        if (f === 'A') out.push('up');
        else if (f === 'B') out.push('down');
        i += 3;
      } else {
        i += 1;
      }
      continue;
    }
    if (SIMPLE[c]) out.push(SIMPLE[c]);
    i += 1;
  }
  return out;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseContext, resolveRepoCwd, resolveScopeWorkspaceId } from '../lib/context.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('parseContext tolerates bad input', () => {
  assert.deepEqual(parseContext(''), {});
  assert.deepEqual(parseContext(undefined), {});
  assert.deepEqual(parseContext('[1]'), {});
  assert.deepEqual(parseContext('{'), {});
  assert.equal(parseContext(fx('context.json')).workspace_id, 'w1');
});

test('resolveRepoCwd order', () => {
  const context = parseContext(fx('context.json'));
  const snapshot = JSON.parse(fx('snapshot.json'));
  const env = { ORCH_BOARD_CWD: '/e' };
  assert.deepEqual(resolveRepoCwd({ argvCwd: '/a', env, context, snapshot }), { cwd: '/a', source: 'argv' });
  assert.deepEqual(resolveRepoCwd({ env, context, snapshot }), { cwd: '/e', source: 'env' });
  assert.deepEqual(resolveRepoCwd({ env: {}, context, snapshot }), { cwd: '/repo/example/src', source: 'focused_pane_cwd' });
  const c2 = { ...context, focused_pane_cwd: undefined };
  assert.equal(resolveRepoCwd({ env: {}, context: c2, snapshot }).source, 'workspace_cwd');
  const c3 = { ...c2, workspace_cwd: undefined };
  assert.equal(resolveRepoCwd({ env: {}, context: c3, snapshot }).source, 'worktree_checkout');
  assert.equal(resolveRepoCwd({ env: {}, context: {}, snapshot }).source, 'snapshot_focused_pane');
});

test('relative paths are skipped and snapshot prefers foreground_cwd', () => {
  assert.deepEqual(resolveRepoCwd({ argvCwd: 'rel', env: { ORCH_BOARD_CWD: 'x' }, context: { focused_pane_cwd: '.' }, snapshot: null }), { cwd: null, source: null });
  const snapshot = { focused_pane_id: 'p', agents: [{ pane_id: 'p', cwd: '/c', foreground_cwd: '/f' }] };
  assert.equal(resolveRepoCwd({ env: {}, context: {}, snapshot }).cwd, '/f');
  snapshot.agents[0].foreground_cwd = null;
  assert.equal(resolveRepoCwd({ env: {}, context: {}, snapshot }).cwd, '/c');
});

test('resolveScopeWorkspaceId order', () => {
  assert.equal(resolveScopeWorkspaceId({ env: { HERDR_WORKSPACE_ID: 'e' }, context: { workspace_id: 'c' }, snapshot: { focused_workspace_id: 's' } }), 'c');
  assert.equal(resolveScopeWorkspaceId({ env: { HERDR_WORKSPACE_ID: 'e' }, context: {}, snapshot: { focused_workspace_id: 's' } }), 'e');
  assert.equal(resolveScopeWorkspaceId({ env: {}, context: {}, snapshot: { focused_workspace_id: 's' } }), 's');
  assert.equal(resolveScopeWorkspaceId({ env: {}, context: {}, snapshot: null }), null);
});

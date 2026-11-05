// Shared builders for the graph tests (synthetic data only).
import { readFileSync } from 'node:fs';
import { buildModel } from '../lib/model.mjs';

export const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
export const DB = '/repo/demo/.agtask/tasks.db';

export function task(n, o = {}) {
  return {
    id: `AGT-${n}`, title: `Task ${n}`, role: 'implementation', goal: 'g', state: 'todo', blocked_from: null, agent: null, pane: null,
    reviewer: null, plan: 'v1', fix_rounds: 0, max_fix_rounds: 2, next_action: null, outputs: [], created_by: 'orch', created_at: 'x',
    updated_at: 'x', ready: false, files: [], criteria: [], deps: [], blocked_by: [], ...o,
  };
}

// agents: [name|null, kind?, status?] -> snapshot with all agents in w1 / tab w1:t1.
export function snap(agents) {
  const s = fx('graph-snapshot.json');
  s.agents = agents.map(([name, kind = 'codex', status = 'idle'], i) => ({
    pane_id: `w1:p${i + 1}`, terminal_id: `t${i}`, workspace_id: 'w1', tab_id: 'w1:t1', focused: false, agent_status: status, revision: 1, name, agent: kind,
  }));
  return s;
}

export function model({ tasks, snapshot, showAll = false, agtask } = {}) {
  return buildModel({
    snapshot: snapshot === undefined ? fx('graph-snapshot.json') : snapshot,
    agtask: agtask ?? { status: 'ok', tasks: tasks ?? fx('graph-ls.json').tasks, db: DB },
    scopeWorkspaceId: 'w1',
    repoCwd: '/repo/demo',
    showAll,
  });
}

// Pure: plugin invocation context -> repo cwd and scope workspace.
import { isAbsolute } from 'node:path';

export function parseContext(json) {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const abs = (v) => (typeof v === 'string' && v !== '' && isAbsolute(v) ? v : null);

export function resolveRepoCwd({ argvCwd, env, context, snapshot }) {
  context = context ?? {};
  const focusedId = snapshot?.focused_pane_id;
  let snapCwd = null;
  if (focusedId) {
    const rec = (snapshot.agents ?? []).find((p) => p.pane_id === focusedId)
      ?? (snapshot.panes ?? []).find((p) => p.pane_id === focusedId);
    if (rec) snapCwd = abs(rec.foreground_cwd) ?? abs(rec.cwd);
  }
  const candidates = [
    ['argv', abs(argvCwd)],
    ['env', abs(env?.ORCH_BOARD_CWD)],
    ['focused_pane_cwd', abs(context.focused_pane_cwd)],
    ['workspace_cwd', abs(context.workspace_cwd)],
    ['worktree_checkout', abs(context.worktree?.checkout_path)],
    ['snapshot_focused_pane', snapCwd],
  ];
  for (const [source, cwd] of candidates) if (cwd) return { cwd, source };
  return { cwd: null, source: null };
}

export function resolveScopeWorkspaceId({ env, context, snapshot }) {
  return context?.workspace_id ?? env?.HERDR_WORKSPACE_ID ?? snapshot?.focused_workspace_id ?? null;
}

# Registers a store-backed plugin directory with herdr. Never fails the caller.
# usage: herdr-plugin-link.sh NODE COREUTILS_BIN HERDR_OR_EMPTY PLUGIN_ID STABLE_PATH
# DRY_RUN_CMD (set by Home Manager) prefixes every mutating herdr command.
# HERDR_PLUGIN_LINK_TIMEOUT overrides the per-call timeout in seconds (default 15).
node=$1
cu=$2
herdr_opt=$3
id=$4
stable=$5
secs=${HERDR_PLUGIN_LINK_TIMEOUT:-15}

warn() { echo "herdr-plugins: $*" >&2; }

# Runs a command with a timeout; returns its status (124 on timeout).
tmo() { "$cu/timeout" "$secs" "$@"; }

herdr=""
if [ -n "$herdr_opt" ]; then
  [ -x "$herdr_opt" ] && herdr=$herdr_opt
elif [ -x "$HOME/.local/bin/herdr" ]; then
  herdr="$HOME/.local/bin/herdr"
else
  herdr=$(command -v herdr || true)
fi
if [ -z "$herdr" ]; then
  echo "herdr-plugins: herdr not found; skipping registration of $id"
  exit 0
fi

# herdr may keep the path as given and parses the manifest only at link time,
# so link the resolved store path: any store change then relinks and reloads it.
if ! target=$("$cu/readlink" -f "$stable") || [ -z "$target" ] || [ ! -d "$target" ]; then
  warn "$stable does not resolve to a directory; skipping"
  exit 0
fi

errfile=$(mktemp "${TMPDIR:-/tmp}/herdr-plugins.XXXXXX") || { warn "mktemp failed; skipping"; exit 0; }
trap 'rm -f "$errfile"' EXIT

if ! json=$(tmo "$herdr" plugin list --json 2>"$errfile"); then
  warn "'herdr plugin list' failed or timed out; skipping: $(cat "$errfile")"
  exit 0
fi

# Prints "<ok|stale|missing> <enabled|disabled>". ok: registered exactly at the target.
if ! out=$(printf '%s' "$json" | "$node" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const [id, target] = process.argv.slice(1);
  const j = JSON.parse(fs.readFileSync(0, "utf8"));
  const list = j?.result?.plugins ?? j?.plugins ?? [];
  const p = list.find((x) => x.plugin_id === id);
  if (!p) { console.log("missing enabled"); process.exit(0); }
  const root = p.plugin_root || (p.manifest_path ? path.dirname(p.manifest_path) : "");
  const same = root && path.resolve(root) === path.resolve(target);
  console.log((same ? "ok" : "stale") + " " + (p.enabled === false ? "disabled" : "enabled"));
' "$id" "$target" 2>"$errfile"); then
  warn "cannot parse 'herdr plugin list' output; skipping: $(cat "$errfile")"
  exit 0
fi
state=${out%% *}
enabled=${out#* }

link_flags=""
[ "$enabled" = disabled ] && link_flags="--disabled"

case "$state" in
  ok) ;;
  missing | stale)
    if [ "$state" = stale ]; then
      echo "herdr-plugins: $id is registered at another path; relinking"
      ${DRY_RUN_CMD:-} "$cu/timeout" "$secs" "$herdr" plugin unlink "$id" || warn "unlink failed or timed out"
    fi
    # shellcheck disable=SC2086
    ${DRY_RUN_CMD:-} "$cu/timeout" "$secs" "$herdr" plugin link $link_flags "$target" || warn "link failed or timed out"
    ;;
  *) warn "unexpected state '$state'; skipping" ;;
esac
exit 0

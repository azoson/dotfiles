# Runs herdr-plugin-link.sh against a fake herdr. Needs: SCRIPT, NODE, CU (coreutils bin dir), a writable TMPDIR.
set -u
work=$(mktemp -d "${TMPDIR:-/tmp}/hpl.XXXXXX")
trap 'rm -rf "$work"' EXIT
export HOME="$work/home"
mkdir -p "$HOME" "$work/store/new" "$work/store/old" "$work/data"
stable="$work/data/orch-board"
ln -s "$work/store/new" "$stable"
target=$("$CU/readlink" -f "$stable")
old=$("$CU/readlink" -f "$work/store/old")
log="$work/log"

cat > "$work/herdr" <<'FAKE'
#!/bin/sh
echo "$*" >> "$HERDR_LOG"
case "$1 $2" in
  "plugin list")
    [ -n "${HERDR_FAIL_LIST:-}" ] && { echo boom >&2; exit 1; }
    [ -n "${HERDR_SLEEP:-}" ] && sleep "$HERDR_SLEEP"
    [ -n "${HERDR_NOISE:-}" ] && echo "warning: some noise" >&2
    cat "$HERDR_LIST" ;;
  "plugin link") [ -n "${HERDR_FAIL_LINK:-}" ] && exit 1; exit 0 ;;
  "plugin unlink") exit 0 ;;
esac
FAKE
chmod +x "$work/herdr"
export HERDR_LOG="$log" HERDR_LIST="$work/list.json"

fail=0
check() { # name expected-log
  if [ "$(cat "$log" 2>/dev/null)" != "$2" ]; then
    echo "FAIL $1: got:"; cat "$log" 2>/dev/null; echo "expected:"; printf '%s\n' "$2"; fail=1
  else echo "ok $1"; fi
}
run() { : > "$log"; sh "$SCRIPT" "$NODE" "$CU" "${HERDR_ARG-$work/herdr}" azoson.orch-board "$stable" > "$work/out" 2>&1; rc=$?; [ "$rc" = 0 ] || { echo "FAIL exit $rc"; fail=1; }; }
plugin() { # root [enabled]
  printf '{"id":"cli:plugin","result":{"plugins":[{"plugin_id":"azoson.orch-board","enabled":%s,"plugin_root":"%s","manifest_path":"%s/herdr-plugin.toml"}],"type":"plugin_list"}}' "${2:-true}" "$1" "$1" > "$work/list.json"; }
LIST="plugin list --json"
RELINK="$LIST
plugin unlink azoson.orch-board
plugin link $target"

HERDR_ARG="$work/nonexistent" run
check "herdr missing" ""
grep -q "not found" "$work/out" || { echo "FAIL missing notice"; fail=1; }

echo '{"id":"cli:plugin","result":{"plugins":[],"type":"plugin_list"}}' > "$work/list.json"
run; check "not registered links the resolved target" "$LIST
plugin link $target"

plugin "$target"; run; check "registered at current target" "$LIST"
plugin "$stable"; run; check "registered at stable symlink is stale" "$RELINK"
plugin "$old"; run; check "registered at old generation is stale" "$RELINK"
plugin "$old" false; run; check "relink keeps disabled state" "$LIST
plugin unlink azoson.orch-board
plugin link --disabled $target"

echo '{"id":"cli:plugin","result":{"plugins":[{"plugin_id":"azoson.orch-board","manifest_path":"'"$target"'/herdr-plugin.toml"}]}}' > "$work/list.json"
run; check "manifest_path only" "$LIST"

plugin "$target"; HERDR_NOISE=1 run; check "stderr noise does not break JSON" "$LIST"
echo '{"id":"cli:plugin","result":{"plugins":[]}}' > "$work/list.json"
HERDR_NOISE=1 run; check "stderr noise still registers" "$LIST
plugin link $target"

HERDR_FAIL_LIST=1 run; check "herdr list errors" "$LIST"
grep -q boom "$work/out" || { echo "FAIL stderr not shown on failure"; fail=1; }
HERDR_SLEEP=5 HERDR_PLUGIN_LINK_TIMEOUT=1 run; check "wedged herdr times out" "$LIST"
echo 'not json' > "$work/list.json"; run; check "unparsable list" "$LIST"
echo '{"result":{"plugins":[]}}' > "$work/list.json"
HERDR_FAIL_LINK=1 run; check "link errors do not fail" "$LIST
plugin link $target"
DRY_RUN_CMD=echo run; check "dry run only reads" "$LIST"
grep -q "plugin link $target" "$work/out" || { echo "FAIL dry-run echo"; fail=1; }

exit $fail

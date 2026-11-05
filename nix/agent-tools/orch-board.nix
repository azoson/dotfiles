{ pkgs, node, agtask }:
let
  fs = pkgs.lib.fileset;
  src = fs.toSource {
    root = ../../herdr-plugins/orch-board;
    fileset = ../../herdr-plugins/orch-board;
  };
  # テストは agtask 本体との結合テストを含むため、agtask.mjs も渡す。
  testSrc = fs.toSource {
    root = ../..;
    fileset = fs.unions [ ../../herdr-plugins/orch-board ../../tools/agtask/agtask.mjs ];
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "orch-board";
  version = "0.1.0";
  inherit src;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    dest="$out/share/herdr-plugins/orch-board"
    mkdir -p "$dest"
    for f in *; do
      [ "$f" = test ] || cp -r "$f" "$dest/"
    done
    # herdr サーバーの PATH に依存しないよう、node と agtask を絶対パスにする。
    substituteInPlace "$dest/herdr-plugin.toml" --replace-fail '["node", ' '["${node}/bin/node", '
    substituteInPlace "$dest/lib/tasks.mjs" --replace-fail "DEFAULT_AGTASK = 'agtask'" "DEFAULT_AGTASK = '${agtask}/bin/agtask'"
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    dest="$out/share/herdr-plugins/orch-board"
    if grep -q '"node"' "$dest/herdr-plugin.toml"; then
      echo "manifest still has a bare node command" >&2
      exit 1
    fi
    grep -q "DEFAULT_AGTASK = '${agtask}/bin/agtask'" "$dest/lib/tasks.mjs"
    # herdr ソケットなしで起動し、縮退したモデルを出せること。
    mkdir -p "$TMPDIR/home"
    env -i HOME="$TMPDIR/home" HERDR_SOCKET_PATH="$TMPDIR/no-such.sock" \
      ${node}/bin/node "$dest/bin/board.mjs" --dump --cwd / > "$TMPDIR/dump.json"
    ${node}/bin/node -e '
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).model;
      if (m.herdr.available !== false) throw new Error("expected herdr unavailable");
      if (m.agtask.status === "ok") throw new Error("unexpected agtask ok");
    ' "$TMPDIR/dump.json"
  '';
  passthru.tests.acceptance = pkgs.runCommand "orch-board-tests" {
    nativeBuildInputs = [ node ];
  } ''
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    cd '${testSrc}'
    node --test 'herdr-plugins/orch-board/test/*.test.mjs'
    touch "$out"
  '';
  meta = {
    description = "Read-only herdr board for herdr-orchestrate runs";
    license = pkgs.lib.licenses.mit;
  };
}

{ pkgs, node }:
let
  src = pkgs.lib.fileset.toSource {
    root = ../../tools/agtask;
    fileset = pkgs.lib.fileset.unions [
      ../../tools/agtask/agtask.mjs
      ../../tools/agtask/test
    ];
  };
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "agtask";
  version = "0.1.0";
  inherit src;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin" "$out/share/agtask"
    cp agtask.mjs "$out/share/agtask/"
    cat > "$out/bin/agtask" <<WRAPPER
    #!${pkgs.runtimeShell}
    exec ${node}/bin/node "$out/share/agtask/agtask.mjs" "\$@"
    WRAPPER
    chmod +x "$out/bin/agtask"
    runHook postInstall
  '';
  passthru.tests.acceptance = pkgs.runCommand "agtask-acceptance" {
    nativeBuildInputs = [ node pkgs.git ];
  } ''
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    node --test '${src}/test/*.test.mjs'
    touch "$out"
  '';
  meta = {
    description = "Local agent task and dependency graph manager";
    license = pkgs.lib.licenses.mit;
    mainProgram = "agtask";
  };
}

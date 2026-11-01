{ pkgs }:
# Workaround: the pinned nixpkgs may lag the required security-patch release,
# and downloads from cache.nixos.org have been extremely slow on this machine.
# Use checksum-pinned official binaries to bypass those issues without compiling
# Node/V8 locally. Reconsider this when nixpkgs provides the required release
# and its prebuilt package can be fetched reliably.
let
  version = "24.22.1";
  # https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
  distributions = {
    x86_64-linux = {
      platform = "linux-x64";
      sha256 = "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      sha256 = "dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
      sha256 = "654ba79de6155647e22321932b45f2a1ccb705976cc337c9b8e278beb085a628";
    };
  };
  distribution = distributions.${pkgs.stdenv.hostPlatform.system};
in
pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "nodejs";
  inherit version;
  src = pkgs.fetchurl {
    url = "https://nodejs.org/dist/v${version}/node-v${version}-${distribution.platform}.tar.xz";
    inherit (distribution) sha256;
  };
  nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
  buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.stdenv.cc.cc.lib ];
  dontBuild = true;
  dontStrip = true;
  # Preserve the official binary's ELF layout; reordering caused startup crashes.
  patchelfFlags = [ "--no-sort" ];
  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -r bin include lib share "$out/"
    runHook postInstall
  '';
  postPhases = [ "verifyRuntimePhase" ];
  verifyRuntimePhase = ''
    "$out/bin/node" -e 'require("node:assert/strict").equal(process.version, "v${version}"); require("node:crypto").randomBytes(16)'
    "$out/bin/node" "$out/lib/node_modules/npm/bin/npm-cli.js" --version
  '';
  passthru.tests.version = pkgs.testers.testVersion {
    package = finalAttrs.finalPackage;
    version = "v${version}";
  };
  meta = {
    description = "Node.js official binary distribution";
    homepage = "https://nodejs.org/";
    license = pkgs.lib.licenses.mit;
    platforms = builtins.attrNames distributions;
    mainProgram = "node";
  };
})

# herdr plugin を nix store から配置し、herdr CLI で登録する Home Manager モジュール。
# plugins.json は herdr 自身が書き換えるため管理しない。
{ packagesFor }:
{ config, lib, pkgs, ... }:
let
  cfg = config.herdrPlugins;
  packages = packagesFor pkgs.stdenv.hostPlatform.system;
  linkScript = pkgs.writeShellScript "herdr-plugin-link" (builtins.readFile ./herdr-plugin-link.sh);
  stable = "${config.xdg.dataHome}/herdr-plugins/orch-board";
in
{
  options.herdrPlugins.herdrPath = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    description = ''
      Path to the herdr binary. When null, $HOME/.local/bin/herdr is tried first, then PATH.
      Activation skips plugin registration when herdr cannot be found.
    '';
  };

  config = {
    xdg.dataFile."herdr-plugins/orch-board".source = "${packages.orch-board}/share/herdr-plugins/orch-board";

    home.activation.herdrPlugins = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
      ${linkScript} ${lib.escapeShellArgs [ "${packages.node}/bin/node" "${pkgs.coreutils}/bin" (toString cfg.herdrPath) "azoson.orch-board" stable ]}
    '';
  };
}

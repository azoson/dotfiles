{ inputs }:
{ withSystem, lib, ... }:
let
  skillSource = inputs.nixpkgs.lib.cleanSourceWith {
    src = ../../skills;
    filter = path: type: builtins.baseNameOf path != "defaults.local.toml";
  };
in
{
  options.flake.homeManagerModules = lib.mkOption {
    type = lib.types.lazyAttrsOf lib.types.deferredModule;
    default = { };
    description = "Reusable Home Manager modules.";
  };

  config.flake.homeManagerModules = {
    agent-tools = import ./home-manager.nix {
      packagesFor = system: withSystem system ({ config, ... }: [ config.packages.node config.packages.agtask ]);
    };
    agent-skills = import ./agent-skills.nix { inherit skillSource; };
    herdr-plugins = import ./herdr-plugins.nix {
      packagesFor = system: withSystem system ({ config, ... }: { inherit (config.packages) node orch-board; });
    };
  };

  config.perSystem = { pkgs, ... }:
    let
      node = import ./node.nix { inherit pkgs; };
      agtask = import ./agtask.nix { inherit pkgs node; };
      orch-board = import ./orch-board.nix { inherit pkgs node agtask; };
    in
    {
      packages = { inherit node agtask orch-board; };
      devShells.agent-tools = pkgs.mkShell { packages = [ node agtask ]; };
    };
}

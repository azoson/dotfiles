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
  };

  config.perSystem = { pkgs, ... }:
    let
      node = import ./node.nix { inherit pkgs; };
      agtask = import ./agtask.nix { inherit pkgs node; };
    in
    {
      packages = { inherit node agtask; };
      devShells.agent-tools = pkgs.mkShell { packages = [ node agtask ]; };
    };
}

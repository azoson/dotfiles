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

  config.flake.homeManagerModules.agent-tools = import ./home-manager.nix {
    inherit skillSource;
    agentSkillsModule = inputs.agent-skills.homeManagerModules.default;
    packageFor = system: withSystem system ({ config, ... }: config.packages.node);
  };

  config.perSystem = { pkgs, ... }:
    let
      node = import ./node.nix { inherit pkgs; };
    in
    {
      packages = { inherit node; };
      devShells.agent-tools = pkgs.mkShell { packages = [ node ]; };
    };
}

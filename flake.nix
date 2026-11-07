{
  description = "Shared agent skills and Node.js environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    nixpkgs-stable.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    agent-skills = {
      url = "github:Kyure-A/agent-skills-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs:
    let
      agentTools = import ./nix/agent-tools { inherit inputs; };
    in
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      imports = [ agentTools ./nix/checks.nix ];

      flake.flakeModules.agent-tools = agentTools;
      flake.lib.agtask.ignores = [ ".agtask/" ];
      # グローバルな AGENTS.md / CLAUDE.md に取り込む短い指示。利用側が programs.*.context に入れる。
      flake.lib.agentContext = {
        herdr-orchestrate = builtins.readFile ./skills/herdr-orchestrate/context.md;
        friction-log = builtins.readFile ./skills/friction-log/context.md;
      };
      flake.homeManagerModules.shell-tools = import ./nix/shell-tools.nix {
        stablePkgsFor = system: inputs.nixpkgs-stable.legacyPackages.${system};
      };
      flake.homeManagerModules.default = { ... }: {
        imports = with inputs.self.homeManagerModules; [ agent-tools agent-skills herdr-plugins shell-tools ];
      };
      # Defaults belong to this repository, not to the reusable module.
      perSystem = { config, ... }: {
        packages.default = config.packages.node;
        devShells.default = config.devShells.agent-tools;
      };
    };
}

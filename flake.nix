{
  description = "Shared agent skills and Node.js environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
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
      flake.homeManagerModules.default = { ... }: {
        imports = [ inputs.self.homeManagerModules.agent-tools ];
      };
      # Defaults belong to this repository, not to the reusable module.
      perSystem = { config, ... }: {
        packages.default = config.packages.node;
        devShells.default = config.devShells.agent-tools;
      };
    };
}

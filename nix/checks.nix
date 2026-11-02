{ inputs, self, ... }:
{
  perSystem = { config, pkgs, system, ... }:
    let
      consumer = inputs.flake-parts.lib.mkFlake {
        inputs = {
          inherit (inputs) nixpkgs;
          self = consumer // { inputs = { inherit (inputs) nixpkgs; }; };
        };
      } {
        systems = [ system ];
        imports = [ self.flakeModules.agent-tools ];
        flake.homeManagerModules.existing = { ... }: { };
        perSystem = { pkgs, ... }: {
          packages.default = pkgs.hello;
          devShells.default = pkgs.mkShell { name = "consumer-shell"; };
        };
      };
      home = inputs.home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          inputs.agent-skills.homeManagerModules.default
          self.homeManagerModules.agent-tools
          self.homeManagerModules.agent-skills
          {
            home.username = "skill-test";
            home.homeDirectory = if pkgs.stdenv.hostPlatform.isDarwin then "/Users/skill-test" else "/home/skill-test";
            home.stateVersion = "26.05";
            programs.agent-skills = {
              enable = true;
              targets.agents = {
                enable = true;
                dest = ".agents/skills";
                structure = "link";
              };
            };
            programs.git = {
              enable = true;
              ignores = [ "*.swp" ] ++ self.lib.agtask.ignores;
            };
          }
        ];
      };
    in
    {
      checks = {
        module-composition =
          assert consumer.packages.${system}.default.drvPath == pkgs.hello.drvPath;
          assert consumer.devShells.${system}.default.name == "consumer-shell";
          assert consumer.packages.${system}.node.drvPath == config.packages.node.drvPath;
          assert consumer.packages.${system}.agtask.drvPath == config.packages.agtask.drvPath;
          assert builtins.attrNames consumer.homeManagerModules == [ "agent-skills" "agent-tools" "existing" ];
          assert (consumer.checks.${system} or { }) == { };
          pkgs.runCommand "agent-tools-module-composition" { } "touch $out";
        node-version = config.packages.node.tests.version;
        agtask = config.packages.agtask.tests.acceptance;
        home-manager =
          assert home.config.home.file ? ".agents/skills";
          home.config.home.activationPackage;
      };
    };
}

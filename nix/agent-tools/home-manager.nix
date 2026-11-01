{ agentSkillsModule, skillSource, packageFor }:
{ config, pkgs, lib, ... }:
{
  imports = [ agentSkillsModule ];
  home.packages = [ (packageFor pkgs.stdenv.hostPlatform.system) ];
  programs.agent-skills = {
    enable = true;
    sources.dotfiles.path = skillSource;
    skills.enable = [ "herdr-orchestrate" ];
    targets = {
      agents = {
        enable = lib.mkDefault true;
        dest = ".agents/skills";
        structure = "link";
      };
      claude = {
        enable = lib.mkDefault false;
        dest = ".claude/skills";
        structure = "link";
      };
    };
  };
  home.file = lib.mkMerge [
    (lib.mkIf config.programs.agent-skills.targets.agents.enable {
      ".agents/skills".force = lib.mkForce false;
    })
    (lib.mkIf config.programs.agent-skills.targets.claude.enable {
      ".claude/skills".force = lib.mkForce false;
    })
  ];
}

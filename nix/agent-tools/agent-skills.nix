# agent-skills-nix の programs.agent-skills に skill を登録する。
# agent-skills-nix の Home Manager モジュールの import、enable、targets は利用側が持つ。
{ skillSource }:
{ ... }:
{
  programs.agent-skills = {
    sources.dotfiles.path = skillSource;
    skills.enable = [
      "friction-log"
      "friction-review"
      "herdr-orchestrate"
      "herdr-pane-review"
    ];
  };
}

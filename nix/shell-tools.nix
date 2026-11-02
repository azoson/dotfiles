# シェルへの組み込みは、利用側で有効にした programs.zsh・bash・fish に Home Manager が行う。
{ stablePkgsFor }:
{ lib, pkgs, ... }:
{
  programs = {
    starship.enable = lib.mkDefault true;
    zoxide.enable = lib.mkDefault true;
    fzf.enable = lib.mkDefault true;
    atuin = {
      enable = lib.mkDefault true;
      # unstable の atuin は darwin のバイナリキャッシュが欠けることがあり、Rust のソースビルドとテストに時間がかかる。
      package = lib.mkDefault (stablePkgsFor pkgs.stdenv.hostPlatform.system).atuin;
      settings = {
        enter_accept = lib.mkDefault true;
        sync.records = lib.mkDefault true;
      };
    };
  };
}

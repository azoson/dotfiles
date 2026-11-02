{ packagesFor }:
{ pkgs, ... }:
{
  home.packages = packagesFor pkgs.stdenv.hostPlatform.system;
}

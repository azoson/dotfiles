---
type: Playbook
title: Home Manager にインストールする
description: 既存の Home Manager flake にこの repo を追加し、Node と skills を配置する。
sources:
  - id: home-manager
    resource: https://nix-community.github.io/home-manager/nix-flakes/standalone.html
  - id: updates
    resource: https://nix-community.github.io/home-manager/usage/updating.html
---

# Home Manager にインストールする

既存の flake ベースの Home Manager 設定に追加する手順。Home Manager 自体が未導入なら、先に公式のセットアップを行う。[^home-manager]
以下の編集・コマンドは、利用側の Home Manager 設定ディレクトリで行う。

## 1. input を追加する

利用側の `flake.nix` の `inputs` に追加する。

```nix
inputs.dotfiles.url = "github:azoson/dotfiles";
```

未 push の変更を含む手元の clone を使う場合は、代わりに絶対パスを指定する。

```nix
inputs.dotfiles.url = "path:/absolute/path/to/dotfiles";
```

## 2. Home Manager の modules に追加する

`outputs` で `dotfiles` を受け取り、既存の `modules` に追加する。
次の `user@host` と `x86_64-linux` は既存設定の名前・system に合わせ、`home.nix` も既存のものを使う。

```nix
outputs = { nixpkgs, home-manager, agent-skills, dotfiles, ... }: {
  homeConfigurations."user@host" = home-manager.lib.homeManagerConfiguration {
    pkgs = nixpkgs.legacyPackages.x86_64-linux;
    modules = [
      ./home.nix
      agent-skills.homeManagerModules.default
      dotfiles.homeManagerModules.agent-tools
      dotfiles.homeManagerModules.agent-skills
    ];
  };
};
```

- `homeManagerModules.agent-tools`: Node と [agtask](agtask.md) を `home.packages` に追加する。
- `homeManagerModules.agent-skills`: [agent-skills-nix](https://github.com/Kyure-A/agent-skills-nix) の `programs.agent-skills` に skill を登録する。agent-skills-nix のモジュールは import しない。

agent-skills-nix の input とモジュールの import は利用側で行う。モジュールは重複排除されないため、一つの構成で一度だけ import する。
dotfiles の input は `inputs.dotfiles.inputs.agent-skills.follows = "agent-skills";` などで利用側の input に揃える。
対応する systems は [flake.nix](../flake.nix) を参照。

配置先も利用側で決める。`home.nix` に追加する例:

```nix
programs.agent-skills = {
  enable = true;
  targets.agents = {
    enable = true;
    dest = ".agents/skills";
    structure = "link";
  };
  # Claude Code にも配置する場合
  targets.claude = {
    enable = true;
    dest = ".claude/skills";
    structure = "link";
  };
};
```

## 3. ビルドして適用する

Git 管理の設定では、追加した Nix ファイルを追跡対象にしてから実行する。
`user@host` は上の構成名に合わせる。

```bash
home-manager build --flake '.#user@host'
home-manager switch --flake '.#user@host'
```

Node、[agtask](agtask.md)、有効にした targets の `herdr-orchestrate/` が配置される。
Node は [node.nix](../nix/agent-tools/node.nix) で指定した公式バイナリを SHA-256 検証付きで取得し、Nix store に配置する。Linux では Nix のライブラリを参照するよう調整する。Node/V8 のソースコンパイルは行わず、`/tmp` のファイルにも依存しない。
agent-skills-nix の `link` 配置は `home.file` の `force` を有効にするため、同名の既存ファイルを上書きする。手動配置や `codex skills sync` から移行する場合は、同名の skill の内容を確認してから移動または削除する。

```bash
node --version
agtask --version
test -f ~/.agents/skills/herdr-orchestrate/SKILL.md
```

herdr と利用するエージェント CLI・認証は別途用意する。導入後は [利用手順](usage.md) へ進む。

## 更新する

Node と nixpkgs の更新を月1回を目安に確認し、セキュリティ修正が必要な場合は随時更新する。Node は公式バイナリのバージョンを明示的に固定するため、nixpkgs の更新だけでは更新されない。

Node を更新する際は [node.nix](../nix/agent-tools/node.nix) の `version` と、公式リリースの `SHASUMS256.txt` にある各対応プラットフォームのハッシュを更新する。対応する実機で実行チェックを行う。

まず dotfiles の clone で nixpkgs を更新し、取得・ビルド予定と検証結果を確認する。大きなソースビルドが予定される場合は適用を見送り、キャッシュが利用できる revision を選ぶ。

```bash
nix flake update nixpkgs --flake path:.
nix build path:.#node --dry-run
nix flake check path:.
nix build path:.#node
./result/bin/node --version
PATH="$PWD/result/bin:$PATH" ./result/bin/npm --version
```

検証済みの `node.nix` と `flake.lock` の変更をコミットする。GitHub input を利用する端末へ配布する場合は push も行う。
その後、利用側の Home Manager 設定ディレクトリで dotfiles input を更新して再適用する。利用側の `nixpkgs` だけを更新しても、dotfiles が固定した Node バージョンや依存は更新されない。[^updates]

```bash
nix flake update dotfiles
home-manager switch --flake '.#user@host'
```

[^home-manager]: [Home Manager: Standalone setup](https://nix-community.github.io/home-manager/nix-flakes/standalone.html)
[^updates]: [Home Manager: Updating](https://nix-community.github.io/home-manager/usage/updating.html)

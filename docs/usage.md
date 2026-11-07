---
type: Playbook
title: 利用手順
description: 導入後の skill の利用、flake-parts への取り込み、シェルツールの導入、開発時の検証。
---

# 利用手順

初回は [Home Manager へのインストール](install.md) を行う。

## flake-parts に取り込む

既存の `mkFlake` のモジュールに追加する。

```nix
imports = [ dotfiles.flakeModules.agent-tools ];
```

`packages.<system>.node`、`packages.<system>.agtask`、`devShells.<system>.agent-tools`、`homeManagerModules.agent-tools`、`homeManagerModules.agent-skills` を提供する。
対応する systems は [flake.nix](../flake.nix) を参照。

## シェルツールを導入する

`homeManagerModules.shell-tools` は starship・zoxide・atuin・fzf を Home Manager の `programs.*` で有効にする。flake module とは別に、Home Manager の `modules` に追加する。

```nix
modules = [ dotfiles.homeManagerModules.shell-tools ];
```

シェルへの組み込みは、利用側で Home Manager の `programs.zsh`・`programs.bash`・`programs.fish` を有効にしたシェルにだけ入る。Home Manager でシェルを管理しない端末では、各ツールの `init` を利用側のシェル設定で読み込む。
既定値と atuin の設定は [shell-tools.nix](../nix/shell-tools.nix) を正とし、端末ごとの差分は利用側で上書きする。
atuin だけは既定で、この flake の `nixpkgs-stable` input から取る。unstable では darwin のバイナリキャッシュが欠けて、ソースビルドになることがあるため。利用側の安定版 nixpkgs に揃える場合は `inputs.dotfiles.inputs.nixpkgs-stable.follows` を指定する。atuin の設定は `~/.config/atuin/config.toml` に生成されるため、既存のファイルがあれば内容を確認してから移動する。

## skill を使う

herdr 内で、選択するモデルの CLI と認証を用意して依頼する。

```text
$herdr-orchestrate この機能を実装したい。まず subagent の構成を提案して。
```

提案に `approve` / `reject`、または修正を指示する。
共有設定は [defaults.toml](../skills/herdr-orchestrate/defaults.toml)。端末ごとの差分は `${XDG_CONFIG_HOME:-$HOME/.config}/agent-skills/herdr-orchestrate.toml` に置く。
Home Manager の `xdg.configFile` から生成してもよい。設定の優先順と実行ルールは [SKILL.md](../skills/herdr-orchestrate/SKILL.md) を参照する。

既定の `openai` preset は Codex CLI を使う。`claude` preset は Claude モデルを `cursor agent` 経由で使い、Claude Code のインストールは不要。
`claude` を既定にする場合は端末固有の設定に `default_preset = "claude"` を指定する。
モデル ID は `cursor agent --list-models` で確認し、必要なら `profiles.opus.model`、`profiles.sonnet.model`、`profiles.haiku.model` を上書きする。

`opus-grok-astra` preset は、親・計画・調査に Opus、実装に Grok 4.7 Medium、レビューに Astra、定型 CLI 作業に Luna を使う。
Opus と Grok は `cursor agent`、Astra と Luna は Codex CLI で動く。
使う場合は依頼で preset 名を指定するか、端末固有の設定に `default_preset = "opus-grok-astra"` を指定する。
親は Opus profile に合わせ、herdr 内で `cursor agent --model claude-opus-5-5-high` を起動してから依頼する。preset の指定だけでは起動中の親のモデルは変わらない。

## タスクを記録する

`agtask` が使える環境では、skill がタスク・依存・検証の証拠・進捗を Git 管理外の DB に記録する。
中断した作業は `agtask handoff` の要約を読んで再開できる。DB が子の sandbox の書込範囲外にある場合、子に記録させるには書込許可が要る。
仕様と保存先は [agtask](agtask.md) を参照する。

### agtask の global ignore

この flake は `lib.agtask.ignores` に agtask 用の Git ignore パターンを公開する。
利用側の Home Manager 設定で `programs.git.ignores` に追加できる。
次は `outputs` で受け取った `dotfiles` を参照できる場所で、Home Manager の `modules` に追加する例。

```nix
{
  programs.git = {
    enable = true;
    ignores = [ "*.swp" ] ++ dotfiles.lib.agtask.ignores;
  };
}
```

既存の ignore パターンは左側のリストに置く。適用すると、そのユーザーの各 repo で agtask の保存ディレクトリを除外する。
`AGTASK_DB` で保存先を変更する場合は、そのパスに合うパターンを利用側で追加する。既に追跡済みのファイルには効かない。

## グローバル指示に取り込む

skill は依頼の内容から呼ばれるため、「作業の終わりに記録する」のような決まった場面の指示は、グローバルな AGENTS.md / CLAUDE.md に置く必要がある。
この flake は、skill ごとの短い指示を `lib.agentContext.<skill>` に文字列で公開する。本文は各 skill の `context.md`。
利用側は Home Manager の `programs.claude-code.context`（`~/.claude/CLAUDE.md`）と `programs.codex.context`（`~/.codex/AGENTS.md`）に取り込む。

```nix
let
  context = lib.concatStrings (with dotfiles.lib.agentContext; [ herdr-orchestrate friction-log ]);
in
{
  programs.claude-code = { enable = true; package = null; inherit context; };
  programs.codex = { enable = true; package = null; inherit context; };
}
```

- `package = null` は、CLI 本体を別の方法で入れている場合の指定。`settings` を書かなければ `settings.json` / `config.toml` は生成されない。
- 生成されたファイルは読み取り専用になる。Claude Code の `/memory` などで CLAUDE.md に追記する使い方はできない。
- `context` の型は複数行の文字列で、別のモジュールで書いた指示とは連結される。

## Node・開発・検証

clone 先で実行する。Node は [node.nix](../nix/agent-tools/node.nix) にバージョンとハッシュを固定した公式バイナリを使う。Node/V8 のソースコンパイルは行わない。

```bash
nix profile install path:.#node # Node だけを導入する場合
nix develop path:.#agent-tools
node --version
nix flake check path:.
```

`path:.` は未追跡ファイルも含める指定。Node の更新は `node.nix` のバージョンと各プラットフォームの公式ハッシュを更新して行う。定期更新の方針と手順は [更新する](install.md#更新する) を参照する。

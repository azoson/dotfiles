---
type: Architecture
title: 構成と文書の方針
description: リポジトリの責務、文書の置き場所、OKF の運用方針。
sources:
  - id: okf
    resource: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md
    title: Open Knowledge Format v0.2
---

# 構成と文書の方針

## 構成

- [flake.nix](flake.nix): 依存の宣言、部品の公開、この repo 単体での開発・検証の入口。
- [nix/agent-tools/](nix/agent-tools/): 再利用する flake-parts モジュール。Node・agtask と、それらを導入する Home Manager モジュール、agent-skills-nix に skill を登録する Home Manager モジュールを提供する。
- [nix/shell-tools.nix](nix/shell-tools.nix): starship・zoxide・atuin・fzf を有効にする Home Manager モジュール。
- [nix/checks.nix](nix/checks.nix): モジュールの合成、Home Manager、Node の検証。
- [skills/](skills/): エージェントへの指示と共有設定。
- [tools/](tools/): skill が使う CLI の実装。agtask の仕様は [docs/agtask.md](docs/agtask.md)。

各端末の構成は利用側の flake が持つ。公開モジュールは、利用側の default package・shell・systems を変更しない。
Node のパッケージ選択は [node.nix](nix/agent-tools/node.nix)、モデルの役割分担は各 skill の `defaults.toml` を正とする。

## 文書の役割

| 場所 | 書く内容 |
| --- | --- |
| `README.md` | repo の目的を一文で示し、文書への入口を置く。 |
| `ARCHITECTURE.md` | 構成の責務と境界、文書の記述・配置方針。 |
| `docs/` | 利用者向けの導入・操作・検証手順。 |
| `skills/*/SKILL.md` | エージェントの判断・承認・実行ルール。 |
| `skills/*/references/` | skill が必要時に読む操作資料。 |

短い日本語で書き、一つの事実は一か所に置く。設定値・実装の一覧を文章に複製せず、正となるファイルへリンクする。
README に手順、設定例、設計の詳細を追加しない。会話の経緯や未使用の構成は Git の履歴に任せる。

## OKF

- 通常の文書は **Open Knowledge Format v0.2** に従う。UTF-8 Markdown に YAML frontmatter を付け、`type` を指定する。[^okf]
- この repo では `title` と一文の `description` も付ける。`docs/` を knowledge bundle とし、[index.md](docs/index.md) を入口にする。
- `index.md` は目次専用。bundle ルートでは `okf_version: "0.2"` のみを frontmatter に置く。文書の追加・移動時に目次とリンクも直す。
- リンクは相対パスを使う。出典が必要な主張は `sources` と同じ ID の脚注で結ぶ。生成・検証のメタデータは実際に確認できる場合だけ記録する。
- README、ARCHITECTURE、skill の参照資料も同じ文書形式に揃える。`SKILL.md` は bundle 外の実行定義として Agent Skills 形式を保つ。

[^okf]: [Open Knowledge Format v0.2 仕様](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)。`title`・`description` の必須化と相対リンクの選択は、この repo の方針。

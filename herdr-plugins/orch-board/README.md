---
type: Playbook
title: orch-board
description: herdr-orchestrate の実行状態を、agtask のタスクと herdr の agent を結び付けて読み取り専用で表示する herdr plugin。
---

# orch-board

人間が herdr-orchestrate の進み具合を一覧するための popup。親 agent 向けではない。

- agtask のタスクを、herdr で動いている agent と名前で結び付けて表示する。
- どのタスクにも結び付かない、同じ run の agent（untracked agents）を表示する。
- run の `orch-*` tab と、linked worktree の workspace を表示する。

## 前提

- herdr 0.9.5 以上。
- Home Manager で入れる場合、`node` と `agtask` は store の絶対パスで固定されるので、PATH は要らない。
- 作業ツリーを直接 link する場合は、herdr サーバーの PATH に `node`（22 以上）と `agtask` が要る。`agtask` は `ORCH_BOARD_AGTASK` で指定もできる。
- Unix 系のみ。herdr の Unix ソケットへ直接つなぐ。

## 導入

Home Manager のモジュールで入れる。plugin は nix store に置かれ、`~/.local/share/herdr-plugins/orch-board` はそこへの symlink。manifest には `node` の絶対パスが入る。作業ツリーは使わない。

1. 利用側の flake で `dotfiles.homeManagerModules.herdr-plugins` を `modules` に追加して switch する。
2. 有効化の activation が、symlink を解決した store のパスを `herdr plugin link` で登録する。herdr が見つからなければ通知して飛ばす。`~/.local/bin` は activation の PATH に無いため、場所が違うときは `herdrPlugins.herdrPath` を設定する。
3. 登録先が現在の store のパスと違う場合（plugin の更新、古い世代など）は、unlink してから link し直す。無効にしていた場合は無効のまま戻す。herdr の呼び出しは 15 秒で打ち切り、失敗しても switch は止めない。herdr の `plugins.json` は herdr が書き換えるので、Home Manager は管理しない。

```bash
herdr plugin action invoke azoson.orch-board.open
```

キーで開く場合は、`~/.config/herdr/config.toml` を自分で編集する。キーは空いているものを選ぶ。

```toml
[[keys.command]]
key = "prefix+shift+b"
type = "plugin_action"
command = "azoson.orch-board.open"
description = "orch board"
```

### 開発時

```bash
herdr plugin unlink azoson.orch-board
herdr plugin link ~/dotfiles/herdr-plugins/orch-board   # 作業ツリーを直接使う。manifest の node は PATH から探す
```

終わったら switch し直す。登録先が違うので、activation が store 版に戻す。

### 外すとき

モジュールを外しても登録は残る。`herdr plugin unlink azoson.orch-board` で消す。

## 操作

| キー | 動作 |
| --- | --- |
| `j` / `k`、`↓` / `↑` | 選択を動かす |
| `Tab` / `Shift-Tab`、`v` | 表示を切り替える（table → team → deps） |
| `g` / `G` | 先頭・末尾 |
| `Enter` | 選択した agent の pane にフォーカスして閉じる。agent が動いていなければ理由を下に出す |
| `r` | 再取得 |
| `a` | 完了済みタスクの表示を切り替える |
| `q`、`Esc`、`Ctrl-C` | 閉じる |

## 表示

ヘッダーの `[table]` などが今の表示。`a`（完了済みの表示）はどの表示にも効く。

- table: タスクの一覧。起動時はこれ。
- team: タスクを作った agent（親）を根にして、担当の agent を下に並べる。各 agent の役割、herdr の種類と状態、pane、担当タスク（ID と状態の記号）を出す。`◂── reviews ── X` は、X がその agent のタスクをレビューすること。レビュー専任の agent は `reviewing`（レビュー中）と `reviews` にタスクを出す。`(unassigned)` は担当のいないタスク。
- deps: タスクの依存関係。依存先が 1 つならその下に置き、0 個か 2 個以上なら最上位に置く。木の親以外の依存先は `⇠` の後に並べ、未完了の依存があれば `(waiting)` を付ける。非表示の完了済みタスクは記号付き、存在しない ID は `?` 付きで出す。

状態の記号: `○` todo、`◎` ready、`◐` in_progress、`●` review、`■` blocked、`✓` done、`✗` failed、`×` cancelled。

## 表示の読み方

- team・deps の `gone` は、その名前の agent が herdr にいないこと。`ambiguous` は同じ名前の agent が複数いること。
- 行頭の `!` は要注意。blocked、agent が見つからない in_progress・review、名前の重複。
- `AGENT` の `r:` は、review 中なのでレビュアーを表示していることを示す。
- `PANE` の `~` は、名前ではなくタスクの記録した pane で結び付けたことを示す。
- `HERDR` の `-` は対応する agent がいないこと、`?` は herdr に接続できないこと。
- 更新は herdr のイベントと agtask DB の変更で行う。取りこぼしに備えて 10 秒ごとにも再取得する。

## 読み取り専用であること

- herdr: `session.snapshot`、`events.subscribe`、`agent.focus` だけを呼ぶ。入力は送らない。
- agtask: `ls --json` と `handoff --json` だけを実行する。
- 仕様は [agtask](../../docs/agtask.md)、運用は [herdr 操作](../../skills/herdr-orchestrate/references/herdr.md) を参照する。

## トラブルシュート

- `herdr plugin log list --plugin azoson.orch-board` で起動ログを見る。
- `node bin/board.mjs --dump --cwd <repo>` は TTY なしで結合結果を JSON で出す。
- 表示が崩れるときは `NO_COLOR=1` を付ける。
- agtask が別の場所を使うときは `ORCH_BOARD_AGTASK` で実行ファイルを指定する。

## テスト

```bash
node --test 'herdr-plugins/orch-board/test/*.test.mjs'
```

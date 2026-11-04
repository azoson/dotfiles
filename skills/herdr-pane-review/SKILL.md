---
name: herdr-pane-review
description: herdr の tab・pane で動いている agent の作業を読み取り、業務の流れを再構成して skill・repo・運用の改善点を提案する。tab や pane の振り返り、agent 間のやり取りの把握、作業の改善提案を頼まれたときに使う。読み取り専用で、agent へ入力は送らない。
---

# herdr pane review

herdr の tab にいる agent の出力と記録から、何が行われたかを把握し、改善点を提案する。
調査は読み取りだけで行う。改善の適用は、依頼された場合にだけ行う。

## 前提

- `test "${HERDR_ENV:-}" = 1` が成功しなければ、herdr 内での実行を案内して止まる。外から既存セッションを操作しない。
- 読み取りの CLI だけを使う。`agent prompt`、`send-keys`、`send-text`、`pane run`、`agent start` などの入力・起動は行わない。
- 状態の polling はしない。`agent wait`、`--wait`、ループ、`watch` は使わない。各 pane は読み取りを一回ずつ行う。
- 手順とコマンド例は [references/inspect.md](references/inspect.md) を読む。

## 手順

1. **対象を特定する。** `herdr tab list` で tab のラベルと ID を確認する。ラベルの「2」と番号は別物なので、ユーザーの言う tab と ID を照合してから進める。
2. **pane と agent を列挙する。** `herdr pane list --workspace "$HERDR_WORKSPACE_ID"` と `herdr agent list` の JSON を、tab ID で絞り込む。名前がない agent は pane ID で扱う。
3. **出力を読む。** 各 agent について `herdr agent read <pane> --source recent-unwrapped --lines 150` を一回ずつ実行する。TUI の装飾や折り返しは読み飛ばす。
4. **外部の記録を読む。** agent が使った記録を確認する。`agtask ls`、`agtask graph`、`agtask history <ID>`、作業ディレクトリの `.orch/`、AGENTS.md、出力に出てくる報告ファイルなどを、いずれも単発で読む。
5. **業務の流れを再構成する。** 最初の依頼文は pane に残っていないことがある。その場合は、読めた範囲と推定を分けて書く。時系列、担当、結果、差し戻しを表にまとめる。
6. **問題を分類する。** [references/inspect.md](references/inspect.md) の観点（手順の抜け、状態の競合、作業ディレクトリの共有、一時ファイル、pane 名、環境依存の失敗、文書の不足）で確認する。各指摘には根拠（pane 名、イベント ID、ファイル名）を付ける。
7. **改善を提案する。** skill・repo・運用に分けて示す。提案は具体的な差分の案にする。適用するかはユーザーに確認する。

## 適用するとき

ユーザーが適用を頼んだ場合だけ行う。

- skill の修正は `~/dotfiles/skills/<name>/` で行う。新しい skill は `nix/agent-tools/agent-skills.nix` の `skills.enable` に登録する。
- 文書は [ARCHITECTURE.md](../../ARCHITECTURE.md) の方針に従う。`SKILL.md` は Agent Skills 形式を保ち、`references/` の文書には OKF の `type`・`title`・`description` を付ける。
- commit は dotfiles の git 設定（identity）をそのまま使う。identity を上書きしない。
- commit と push は、ユーザーが依頼したものだけ行う。

## 秘匿

pane の出力や報告には、トークン、client secret、個人情報、本番の値が含まれることがある。報告・commit・通知にはそれらの値を写さない。「値は含めていない」と書き、場所（pane 名や行の位置）だけを示す。

## 出力

報告は親の作業領域（例: `.orch/`）か、会話内に書く。`/tmp` は使わない。

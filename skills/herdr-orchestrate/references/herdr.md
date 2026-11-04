---
type: Reference
title: herdr 操作
description: 承認済みの subagent を herdr で起動し、子から親への通知で結果を回収する手順。
sources:
  - id: herdr
    resource: https://herdr.dev/tui/docs/agent-skill/
---

# herdr 操作

インストール済みの `herdr --skill` と各コマンドの `--help` を正とする。
以下は 0.9.3 で構文確認済み。新しい版では実機の help を確認する。

## 実行前

```bash
test "${HERDR_ENV:-}" = 1
herdr --version
herdr --skill
```

`HERDR_ENV=1` でなければ構成の提案までに留め、herdr 内での再開を案内する。
外から既存セッションを操作しない。裸の `herdr` は TUI を起動するので調査に使わない。
モデルは各 CLI の一覧・設定で確認し、承認後の起動時にも選択結果を確認する。
利用可否が事前確認できない場合は、その旨を構成案に記載する。

## 起動（構成承認後）

```bash
herdr pane current --current
herdr pane layout --pane "$HERDR_PANE_ID"
herdr agent list
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

縦長・狭い pane なら `down`。既定は同じ cwd の隣接 pane。
返却 JSON の `.result.pane.pane_id` を使う。ID を推測しない。
既存エージェントと重ならない名前を付け、名前と pane ID を記録する。

```bash
# PANE_ID は返却された値。NAME は構成案の一意な名前。
# MODEL と追加引数は承認済み profile から取得する。
herdr agent start "$NAME" --kind codex --pane "$PANE_ID" -- --model "$MODEL" -c 'model_reasoning_effort="high"'
```

これは `command` を省略した profile の例。`high` 固定ではなく profile の `args` を引数ごとに渡す。
プロンプトや設定値をシェルへ連結・`eval` しない。既存の権限設定を保つ。
起動エラーでは作成済み pane を確認し、重複起動しない。

### 明示コマンドを持つ profile

`command` がある場合は、その配列を起動コマンドとして使う。
herdr 0.9.3 の `--kind cursor` は `cursor-agent` を起動するため、`cursor agent` の指定には `agent start` を使わない。
`command` の実行ファイルと固定引数で `--help` を確認する。Cursor のモデル ID は `cursor agent --list-models` で確認する。

```bash
# command = ["cursor", "agent"]、args = [] の場合。
# 値は引数として渡し、pane のシェル向けに各引数を quote する。
COMMAND=$(python3 -c 'import shlex, sys; print(shlex.join(sys.argv[1:]))' cursor agent --model "$MODEL")
herdr pane run "$PANE_ID" "$COMMAND"
herdr agent get "$PANE_ID"
```

`args` がある場合は同じ方法でモデル指定の後ろに追加する。上記の quote は POSIX shell 用。別の shell ではその shell に合う方法を使う。
起動確認は単発で行い、検出した種別が profile の `kind` と一致し、`idle` / `done` になったことを確認する。
未検出・未準備・`blocked` なら仕事を投入せず状況を報告し、再起動や polling をしない。
準備できたら `herdr agent rename "$PANE_ID" "$NAME"` で承認済みの名前を付け、以降は通常の agent 操作を使う。
名前は計画に使った名前（agtask の担当名）と一致させる。既に名前がない pane を使う場合は、rename してから投入する。

## 投入・完了通知

親は自身の pane ID を `herdr pane current --current` で確認し、タスク ID とともに子のプロンプトへ渡す。
子自身の `HERDR_PANE_ID` を親の通知先にしない。

親の pane にも名前を付け、ID だけで参照される pane を残さない。名前は agtask の `--as` と揃える。

```bash
herdr agent rename "$HERDR_PANE_ID" "$PARENT"   # 例: PARENT=orchestrator
```

```bash
# 親: 仕事を投入して戻る。PROMPT に通知先・タスク ID・通知指示を含める。
herdr agent prompt "$NAME" "$PROMPT"

# 子: herdr skill を読み、完了・失敗・判断待ちを親へ通知する。
herdr --skill
herdr agent prompt "$ORCHESTRATOR_PANE_ID" "$MESSAGE"
```

`ORCHESTRATOR_PANE_ID` は親から渡された値。`MESSAGE` にタスク ID、子の名前、結果と検証の要約を含める。
一時ファイルは親が指定した作業領域に置き、`/tmp` を使わない。
子は自分の最終回答だけで済ませず、親への送信を行う。TUI の通知表示だけでは親へのメッセージにならない。
双方とも `--wait` を付けない。親への通知は新しい仕事の委譲ではなく、親が作業中でも送る。

独立した子への投入は並行してよい。既に working の子には仕事を重ねて投入しない。
親は通知まで完了確認を行わない。`agent get/read/list`、pane 出力、結果ファイルの定期確認やループ、`agent wait` による完了待ちは禁止。
上流 skill の待機例より、この通知方式を優先する。起動確認、通知後の回収、明示的な障害調査での単発の参照は可。

通知後、必要なら `herdr agent read "$NAME" --source recent-unwrapped --lines 120` で詳細を回収する。
通知や `idle` / `done` だけで成功とせず、成果物・テスト結果も確認する。
送信エラーは未送信の証明ではない。盲目的に再送せず、送信結果と必要な出力を確認する。親はタスク ID と子の名前で重複通知を判別する。
通知先が `blocked` なら承認 UI に勝手に回答しない。子は結果を保持し、通知不能を人間に報告する。再送の polling に切り替えない。
他人の pane は閉じない。サーバーの停止・更新を復旧手段にしない。

操作の参考は公式 agent skill。[^herdr]

[^herdr]: [公式 agent skill](https://herdr.dev/tui/docs/agent-skill/)

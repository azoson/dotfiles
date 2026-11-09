---
type: Reference
title: herdr 操作
description: 承認済みの subagent を herdr で起動し、子から親への通知で結果を回収する手順。
sources:
  - id: herdr
    resource: https://herdr.dev/tui/docs/agent-skill/
  - id: concepts
    resource: https://herdr.dev/tui/docs/concepts/
  - id: automation
    resource: https://herdr.dev/tui/docs/agent-automation/
  - id: cli
    resource: https://herdr.dev/tui/docs/cli-reference/
---

# herdr 操作

インストール済みの `herdr --skill` と各コマンドの `--help` を正とする。
以下は 0.9.3 で構文確認済み。`tab`・`worktree` は 0.9.5 で確認。新しい版では実機の help を確認する。

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

### 再開後の親pane ID

`HERDR_ENV=1` でも、pane移動や再開後に継承した `HERDR_PANE_ID` / `HERDR_WORKSPACE_ID` が古いままのことがある。`herdr pane current --current` が `pane_not_found` になったら、同じコマンドを再試行せず `herdr agent list` を一度読み、cwd・会話タイトル・既存agent名を照合して実際の親paneを特定する。focusedだけで他人のpaneを親とみなさない。一意に特定できなければ操作を止めて人間に確認する。

特定できたら返却されたpane IDとworkspace IDを作業記録へ残し、その後のrename・配置・通知先には明示IDを使う。古い環境値からIDを組み立てず、既存セッションやpaneを再作成しない。これは同じsession内の古い呼出元情報の復旧であり、`HERDR_ENV` が無い環境からの操作を許可するものではない。

## 配置（session / workspace / tab / pane）

公式の Concepts と Agent automation に沿って、階層ごとの役割を次のように使い分ける。[^concepts][^automation]

| 階層 | 公式の位置付け | この skill での使い方 |
| --- | --- | --- |
| session | 独立した server の名前空間。pane・socket・保存状態が別になる | 使わない。子は親と同じ session に置く。ID と agent 名は server ごとなので、別 session の子からは親へ通知できない |
| workspace | repo・タスク・調査ごとの最上位の入れ物。サイドバーで中の agent の状態を集約する | 原則として親の workspace を使う。新しい workspace は worktree を使う場合だけ作る |
| worktree | Git checkout を持つ workspace。親 repo の workspace とグループになる | 書込担当の子に独立した checkout が要るときに使う。子を置く checkout は `git worktree add` ではなく `herdr worktree create` で作る。agent を置かない検証用の一時 checkout は対象外 |
| tab | workspace 内のレイアウト。`agents`・`logs`・`server`・`review` などのビューを分ける | 子が 3 体以上か、親の tab で人間が作業しているときは、子用の tab を 1 つ作る。サーバーや watch は agent と別の tab に置く |
| pane | 実際の端末。agent はその中で認識されたプロセス | 子 1 体に pane 1 つ。agent への投入と通知は pane（agent 名）宛てに送る |

- agent 同士の協働を pane 単位で行うのは公式の設計どおり。`agent start` は既存の pane を使い、レイアウトは作らない。
- `agent prompt` は同じ server の中なら名前か pane ID で届く。tab や workspace が違っても通知経路は変わらない。
- 公式 skill の既定は「現在の tab の隣の pane、同じ cwd」。tab・workspace・worktree・別の cwd は、人間が求めた場合だけ作る。この skill では、構成案の「配置」列への approve を人間の指示として扱う。承認されていない配置は作らない。

配置は次の順で決め、構成案の「配置」列に書く。

1. **same-tab**: 子が 1〜2 体で、親の tab に余裕がある。公式の既定。
2. **orch-tab**: 子が 3 体以上か、親の tab が狭い。ラベル `orch-<topic>` の tab を親の workspace に 1 つ作り、子をまとめる。親は自分の pane に残る。
3. **worktree**: 書込担当の子どうしで、同じファイルや同じビルド成果物を触る恐れがある。または、ブランチを分けて統合したい。ブランチ名・基点・統合方法を書く。
4. **logs-tab**: テストの watch・dev server・ログ追跡など、agent ではない長時間プロセス。ラベル `logs` などの tab に置き、pane コマンドで扱う。

- 1 つの tab で同じ向きの split を繰り返さない。列や行が狭くなり、agent の出力を読めなくなる。[^herdr]
- worktree の子は cwd が別 checkout になる。agtask を使う場合は [agtask.md](agtask.md) の書込範囲外の扱いになるので、権限差分も構成案に書く。
- Claude（`kind = "claude"`）の子を新しい worktree で起動すると、フォルダの trust の確認が出て `blocked` になる。親は答えないので、構成案の worktree の行に「起動後に人間が各 pane で trust を承認する」と書く。
- workspace（複数 repo をまとめたルート）での既定は、調査・レビューの子の cwd をルート、実装の子の cwd を担当 repo とする。構成案の cwd と配置には repo 名を書く。
- 複数 repo の workspace では、worktree を repo ごとに作り、`--path <root>/.orch/wt/<name>` で checkout を workspace の下に置く。`--workspace` と `--cwd` は併用できない（0.9.5）。配下の repo が workspace の外にある本体の linked worktree（codex workspace など）なら、`--cwd` に本体のチェックアウト（`git -C <root>/<repo> rev-parse --path-format=absolute --git-common-dir` の親）を渡す。linked worktree を渡すと `linked_worktree_source` で失敗する。
- commit・PR・push 前の `git fetch` の確認は repo ごとに行う。
- 1 つの依頼で作る tab は orch-tab と logs-tab をそれぞれ最大 1 つにする。子ごとに tab や workspace を作らない。

## 起動（構成承認後）

```bash
herdr pane current --current
herdr pane layout --pane "$HERDR_PANE_ID"
herdr agent list
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
```

承認済みの配置に応じて、子の pane を用意する。どの場合も返却 JSON の ID を使い、推測しない。

```bash
# same-tab: 親の隣に分割する。縦長・狭い pane なら down。
herdr pane split --current --direction right --cwd "$PWD" --no-focus
# → .result.pane.pane_id

# orch-tab: 子用の tab を作る。root pane を最初の子に使い、2 体目以降はその tab 内で split する。
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" --label "orch-$TOPIC" --no-focus
# → .result.tab.tab_id, .result.root_pane.pane_id
herdr pane layout --pane "$ROOT_PANE_ID"
herdr pane split "$ROOT_PANE_ID" --direction right --cwd "$PWD" --no-focus

# worktree: checkout と workspace を同時に作る。root pane の cwd は新しい checkout。
herdr worktree create --workspace "$HERDR_WORKSPACE_ID" --branch "$BRANCH" --base "$BASE" --label "$NAME" --no-focus
# → .result.workspace.workspace_id, .result.root_pane.pane_id, .result.worktree

# 複数 repo の workspace: 本体のチェックアウトを起点にし、checkout を workspace の下に置く。
MAIN=$(dirname "$(git -C "$ROOT/$REPO" rev-parse --path-format=absolute --git-common-dir)")
herdr worktree create --cwd "$MAIN" --branch "$BRANCH" --base "$BASE" --path "$ROOT/.orch/wt/$NAME" --label "$NAME" --no-focus
```

- 作った tab・worktree の ID・ラベル・ブランチを記録する。片付けの対象はこの記録で決める。
- `--trust-repository` は付けない。worktree の作成が失敗したら、付け直して再実行せず人間に報告する。
- 人間の焦点を奪わないように `--no-focus` を付ける。

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
trust の確認で `blocked` になった場合は、pane ID を示して人間に承認を依頼し、承認の連絡を受けてから単発で確認する。
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
人間向けに、dotfiles の herdr-plugins/orch-board（skill の配置先には含まれない）が agtask と herdr の状態を一覧表示する。親はこれを開かず、通知や完了確認の代わりにしない。

通知後、必要なら `herdr agent read "$NAME" --source recent-unwrapped --lines 120` で詳細を回収する。
通知や `idle` / `done` だけで成功とせず、成果物・テスト結果も確認する。
送信エラーは未送信の証明ではない。盲目的に再送せず、送信結果と必要な出力を確認する。親はタスク ID と子の名前で重複通知を判別する。
通知先が `blocked` なら承認 UI に勝手に回答しない。子は結果を保持し、通知不能を人間に報告する。再送の polling に切り替えない。
他人の pane は閉じない。サーバーの停止・更新を復旧手段にしない。

## 片付け

既定では閉じない。親が作った pane・tab・worktree は、herdr-pane-review で振り返れるように残す。最終報告に、残した pane・tab・worktree workspace の ID とラベルを書く。

閉じるのは、人間が片付けを求めた場合だけ。閉じてよいのは、親が作ったと記録した pane・tab・worktree に限る。成果の確認と統合が終わり、最終報告にまとめた後に行う。

```bash
herdr pane close "$PANE_ID"          # same-tab の子
herdr tab close "$ORCH_TAB_ID"       # orch-tab・logs-tab。中の pane も閉じる
herdr worktree remove --workspace "$WORKTREE_WORKSPACE_ID"
```

- `worktree remove` は `git worktree remove` を実行する。ブランチは消さない。統合前の worktree は消さない。
- 未コミットの変更が残っていて remove が失敗したら、`--force` を付けず人間に報告する。
- 親の workspace を `workspace close --group` で閉じない。
- 片付けを求められても、未完了の子がいる pane・tab は閉じず、残した ID を報告する。

操作の参考は公式 agent skill。[^herdr]

[^herdr]: [公式 agent skill](https://herdr.dev/tui/docs/agent-skill/)
[^concepts]: [Concepts](https://herdr.dev/tui/docs/concepts/)
[^automation]: [Agent automation](https://herdr.dev/tui/docs/agent-automation/)

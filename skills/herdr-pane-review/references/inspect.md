---
type: Reference
title: herdr pane の読み取りと観点
description: herdr-pane-review が tab・pane・agent の記録を読むためのコマンドと、改善点を見つける観点。
---

# herdr pane の読み取りと観点

コマンドの構文は、インストール済みの `herdr <group> --help` と `agtask --help` を正とする。
この文書は読み取りに限る。

## 1. 対象の特定

```bash
herdr tab list
herdr workspace list
```

tab は `label`・`number`・`tab_id` で区別する。ユーザーが言う「tab-N」が、ラベルか番号かを確認する。

## 2. pane と agent の列挙

`herdr pane list` と `herdr agent list` の JSON を、tab ID で絞り込む。

```bash
TAB_ID=w1:t1C   # tab list で確認した tab_id
herdr agent list | python3 -c '
import json, sys
tab = sys.argv[1]
for a in json.load(sys.stdin)["result"]["agents"]:
    if a.get("tab_id") == tab:
        print(a.get("pane_id"), a.get("agent"), a.get("agent_status"), a.get("name", "-"), a.get("cwd"))
' "$TAB_ID"
```

名前が `-` の agent は、pane ID で読む。

## 3. 出力の読み取り

```bash
herdr agent read <pane-or-name> --source recent-unwrapped --lines 150
```

- 一つの pane につき一回ずつ読む。繰り返し読んで状態が変わるのを待たない。
- 直近の出力だけが残る。全体の経緯は、agent が書いた報告ファイルや記録で補う。
- 依頼文は見えないことがある。見えない場合は、その旨を報告に書く。

## 4. agtask の記録

```bash
cd <repo の auth などの作業ディレクトリ>
agtask ls
agtask graph --format text
agtask history <ID> --json
```

`history` は記録順に読む。差し戻し（reject）の issue はイベント ID で参照する。

## 5. 観点

改善点は次の分類で見つける。各項目は、根拠（pane、イベント ID、ファイル）と一緒に書く。

| 観点 | 見るもの | 例 |
| --- | --- | --- |
| 手順の抜け | 提出や完了の前に、チェックが実行されているか | format・lint が未実行で差し戻された |
| 計画との差 | 計画にあるタスクが、途中で cancel されていないか。理由が残っているか | 検証のタスクが cancel され、レビュアーが代わりに行った |
| 状態の競合 | 親と子が同じタスクの状態を同時に変えていないか | 子が `in_progress` の間の `unblock` が失敗した |
| 作業ディレクトリ | 複数の子が同じ作業ツリーを使い、衝突の危険がないか | 比較のための作業ツリーを手作業で作って消した |
| 一時ファイル | 子が `/tmp` などの共有領域に書いていないか | 比較用のファイルが `/tmp` に残った |
| pane 名 | 名前で参照できるか。計画の名前と一致するか | 親と計画の pane に名前がなく、ID でしか参照できない |
| 環境依存の失敗 | 既知の失敗と、今回の変更による失敗を区別できるか | 失敗件数の基準がなく、比較のたびに手作業で調べた |
| 文書の不足 | リポジトリの AGENTS.md や README に、ビルド・テスト・format のコマンドがあるか | 子が format のコマンドを毎回探した |
| 機密 | 報告や通知に、値（トークン、secret、個人情報）が含まれていないか | 報告に値を写してしまった |

## 6. 報告の形

1. 業務の概要（何を、なぜ）
2. 流れの表（タスク、担当、状態、結果、差し戻し）
3. 観点ごとの指摘（根拠付き）
4. 改善案（skill・repo・運用に分けた具体的な差分）
5. 未確認の点（読めなかった出力、見えない依頼文など）

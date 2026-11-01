---
type: Reference
title: agtask 操作
description: herdr-orchestrate の親・子・レビュアーが agtask でタスク・証拠・進捗を記録し、再開する手順。
---

# agtask 操作

インストール済みの `agtask --help` と各コマンドの `--help` を正とする。
仕様は dotfiles の [docs/agtask.md](../../../docs/agtask.md)。skill の配置先には含まれない。

agtask は記録と完了ゲートだけを担う。起動・投入・通知は [herdr.md](herdr.md) に従う。

## 実行前（親）

```bash
command -v agtask
agtask init --json
```

- `agtask` が無ければ記録なしで進めると構成案に書く。無断で代替手段を作らない。
- `init` が返す `db` の親ディレクトリを DB ディレクトリとし、権限判断の基準にする。保存先の決まり方は仕様を参照し、推測しない。
- DB ディレクトリが子の sandbox の書込範囲内なら追加の権限は要らない。例: 通常の repo で `AGTASK_DB` を使わない場合、DB は main worktree のルートの `.agtask/` にあり、cwd をそのルートにした Codex の子は workspace-write のまま書ける（codex-cli 0.166.0 で確認）。
- 書込範囲外（cwd が下位ディレクトリや別の worktree、`AGTASK_DB` が範囲外など）では、読み取りも含めて DB を開けない。
- 書込範囲外の Codex の子に使わせる場合は、profile の `args` に次を足す。権限の変更なので、構成案の担当範囲・書込可否に差分として示し承認を得る。

  ```bash
  -c 'sandbox_workspace_write.writable_roots=["<DB ディレクトリの絶対パス>"]'
  ```

- 承認されない場合や他の CLI で開けない場合、その子の仕事は agtask で管理せず、従来どおり herdr の通知と親の確認で扱う。構成案にその旨を書く。親が子の名前で claim・証拠・submit を代行しない。

## 計画（親、承認後・起動前）

構成案の子ごとにタスクを作り、依存を張る。actor は親の名前（例: `orchestrator`）。

```bash
agtask add "agtask を実装する" --as "$PARENT" --plan v2 \
  --role implementation --agent agtask-impl --reviewer agtask-review \
  --goal "docs/agtask.md の仕様どおりに CLI とテストを作る" \
  --criterion "node --test 'tools/agtask/test/*.test.mjs' が全て成功する" \
  --criterion "nix flake check path:. が成功する" \
  --write tools/agtask/ --read docs/agtask.md \
  --dep AGT-1 --max-fix-rounds "$MAX_FIX_ROUNDS" --json
agtask graph --format text
```

- 受け入れ条件は、成果物と検証結果で判定できる文に分ける。「良くする」などの判定できない条件を書かない。
- `--write` / `--read` は構成案の担当範囲と一致させる。`--max-fix-rounds` は解決済みの設定値を渡す。
- `--reviewer` は実装と別のエージェントにする。レビューは対象タスクの `review` 状態で行い、別タスクにしない。
- `graph` を構成案の実行順と照合してから子を起動する。

## 子への指示

herdr の投入プロンプトに、タスク ID、子の名前、次の手順を含める。

1. `agtask show <ID> --json` で目的・条件・担当ファイルを読む。失敗したら作業せず、判断待ちとして親へ通知する。
2. `agtask claim <ID> --as <NAME>` で取得する。`NOT_READY` / `ALREADY_ASSIGNED` なら作業せず親へ通知する。
3. 作業中の決定は `note --kind decision`、未解決点は `note --kind issue`、次の一手は `next` で残す。
4. 条件ごとに検証し、`evidence --criterion <n> --verdict verified --basis "<実行したコマンドと結果>"` を記録する。検証できない条件を `verified` にしない。
5. `submit <ID> --output <成果物> --summary "<成果・変更・検証・残件>"` で提出し、herdr で親へ通知する。`GATE_FAILED` なら `details` の不足を埋める。
6. reject 後は reject の issue を `note --resolve <event-id>` で解消し、全条件の証拠を記録し直してから再提出する。
7. 自力で解決できなければ `block --reason` して判断待ちを通知する。断念するなら `fail --reason`。

サマリーは任意だが、提出ごとに成果・変更ファイル・検証結果・残件を記す。複数行は `--summary -` で標準入力から渡せる。空本文はエラー、省略は未登録となる。差し戻し後は前回提出が表示され、再提出で置き換わる。省略して再提出した場合、以前の本文には戻らない。サマリーは受入判定ではなく、完了はレビュアーの `accept` で確定する。

各コマンドに `--as <NAME>` を付ける。agtask の記録は herdr の完了通知の代わりにならない。

## レビュー

1. `agtask show <ID> --json` で条件、成果物、担当の自己検証を読む。自己検証を根拠に流用せず、自分で確認する。
2. 条件ごとに `evidence --verdict verified|incorrect|unresolved --basis "<根拠>"` を記録する。`unresolved` は `--missing` に不足証拠を書く。
3. 全条件が `verified` なら `accept`、そうでなければ `reject --reason "<差し戻す理由>"`。条件外の問題（担当外のファイル変更など）も reject の理由にできる。
4. 結果を herdr で親へ通知する。reject の返り値が `fix_limit_exceeded: true` ならタスクは `blocked` になっている。その旨も通知に含める。

## 親の確認と再開

- 通知を受けたら `agtask show <ID>` で目的・担当ファイル・依存・成果物・直近の完了サマリー・現ラウンドの条件別証拠・決定・未解決点・次手を確認し、差分も確認する。サマリーには提出イベント、round、actor、日時が付き、差し戻し済みならその旨が出る。未提出や旧 CLI の提出は未登録となる。
- 過去の提出本文、全ラウンドの証拠、通常 note、解消済み issue は `agtask history <ID>` で読む。記録順（イベント ID 昇順）で、時刻の逆行があっても順序は変わらない。`--json` では events と evidence を ID で対応付ける。show の JSON には直近 summary、handoff には各タスクと終了済み一覧の summary が含まれる。`done` にできるのはレビュアーの `accept` だけ。
- 修正上限を超えたタスクは、状況と次案を人間に示す。`unblock --max-fix-rounds` での上限変更は構成の変更として再承認を得てから行う。
- 担当を替えるときは `release --unassign` してから新しい子に claim させる。
- 再開時は `agtask handoff` を読み、承認済みの版・構成と既存の pane を照合してから続ける。

## 禁止

- `ls` / `ready` / `show` / `history` / `handoff` を完了待ちや状態確認の polling に使わない。ループ、定期実行、`watch` もしない。
- 単発の参照は、計画時、通知の受信後、再開時、明示的な障害調査に限る。
- sandbox の無効化や、承認されていない書込許可の追加で DB を開こうとしない。

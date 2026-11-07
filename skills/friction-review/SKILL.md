---
name: friction-review
description: agtask friction に記録された、エージェントの探索の無駄や失敗のやり直しを頻度とコストの順に読み、文書・skill・repo の改善案を出す。承認された改善を適用して項目を閉じる。friction の振り返り、エージェント作業の改善、文書の不足の洗い出しを頼まれたときに使う。
---

# friction review

friction-log skill で記録された項目から、直す価値の高いものを選んで改善する。コマンドの構文は `agtask friction --help` を正とする。スコアは hit ごとのコストの重み（low 1、mid 3、high 9）の合計。
改善案を出すところまでは読み取りだけで行う。適用は、ユーザーが承認したものだけ行う。

## 手順

1. **読む。** workspace のルートで `agtask friction report`（期間を絞るなら `--since`）を一回実行する。詳細が要る項目だけ `show` する。pane は読まない。
2. **再発を先に見る。** closed / fixed の項目に hit があれば、その修正は効いていない。直した場所が読まれていないのか、書き方が悪いのか、別の原因なのかを、hit の basis から判断する。
3. **確かめる。** スコアの高い順に、`fact` が今も正しいか、すでに文書に書かれていないかを確かめる。確かめ方は、対象の文書を読むことと、短いコマンドを実行することに限る。誤っていれば `close --resolution wontfix --ref "<理由>"` にする。同じ問題の項目は `close --resolution duplicate --ref <FR-ID>` でまとめる。
4. **直し方を決める。** 文書だけが答えではない。
   - 毎回読まれる短い事実は、repo の AGENTS.md に書く。AGENTS.md は全てのセッションで読み込まれ、それ自体がトークンを使う。長い手順は `docs/` に書き、AGENTS.md には 1 行のリンクだけを置く。
   - 手順が長い、または失敗しやすいなら、スクリプトや task runner のターゲットにする。文書より確実である。
   - skill の誤りや曖昧さは、`~/dotfiles/skills/<name>/` を直す。
   - sandbox や dev shell の問題は、設定（profile の args、`writable_roots` など）を直す。
   - コストに見合わないものは `wontfix` にし、理由を書く。
5. **提案する。** `target` ごとにまとめ、具体的な差分の案、対象の FR-ID、スコアを示す。適用するかをユーザーに確認する。直すと決めた項目は `accept` にする。
6. **適用して閉じる。** 承認された変更を適用し、`close <FR-ID> --resolution fixed --ref <commit・PR・文書パス>` で閉じる。commit と push は、ユーザーが依頼したものだけ行う。

各コマンドに `--as <自分の名前>` を付ける。

## 適用するとき

- 各 repo の文書の規約（AGENTS.md や ARCHITECTURE.md の方針）に従う。dotfiles では [ARCHITECTURE.md](../../ARCHITECTURE.md) に従う。
- 複数の repo に変更が及ぶときは、repo ごとに差分を分けて示す。
- commit は各 repo の git 設定（identity）をそのまま使い、上書きしない。

## 秘匿

記録に値が混ざっていても、報告・差分・commit に写さない。見つけたら、場所（FR-ID と hit）だけを示す。

## 出力

報告は会話内か、親の作業領域（例: `.orch/`）に書く。`/tmp` は使わない。報告の形は次のとおり。

1. 期間、件数、再発の件数
2. 再発の分析
3. `target` ごとの改善案（差分、FR-ID、スコア）
4. 閉じた項目（wontfix・duplicate とその理由）

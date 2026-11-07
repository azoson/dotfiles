---
type: Reference
title: agtask friction
description: エージェントが作業中に払った無駄なコスト（文書にない事実の探索、予測できた失敗のやり直し）を workspace の SQLite に記録し、文書・skill・repo の改善につなげる仕組みの設計と CLI 仕様。
---

# agtask friction

エージェントが作業中に払った「本来は要らなかったコスト」を、作業した本人がその場で記録する。
人間やレビュー役のエージェントは、記録を頻度とコストの順に読む。それを文書・skill・repo の修正に変え、修正後に再発したかで効果を確かめる。

記録の手順は [friction-log](../skills/friction-log/SKILL.md)、集計と改善は [friction-review](../skills/friction-review/SKILL.md) の skill が担う。skill は配置先で単独で読めるように、分類とコストの表を自身にも持つ。値を変えるときは両方を直す。

## 方針

- **pane を読まない。** pane の出力は直近の分しか残らず、tab や workspace が増えるほど読み取りの手間が増える。原因を一番よく知っているのは、その場のエージェント本人である。本人が記録すれば、pane を後から再構成しなくてよい。
- **事実を文の形で残す。** 記録の中心は、文書にそのまま書ける一文の事実（`fact`）とする。レビューのときに探索をやり直さずに済み、記録の目的であるトークンの節約がレビューでも効く。
- **同じ問題は 1 件にまとめる。** 新しく作る前に検索する。同じ問題なら発生（hit）を追記する。頻度とコストの合計から優先度を決める。
- **修正の効果を測る。** 修正済み（closed / fixed）の項目に hit が付いたら、それは再発である。文書の場所や書き方が効いていないと分かる。
- **agtask と同じ場所に保存する。** DB ファイルは agtask の `tasks.db` と同じディレクトリに置く。保存先の決まり方、workspace の目印、sandbox の書込許可は agtask と共通で、新しい権限の差分は生まれない。tasks.db のスキーマ（`user_version = 1`）や orch-board には影響しない。

## 対象

| kind | 記録するもの | 例 |
| --- | --- | --- |
| `knowledge` | コード・履歴・試行を読んで初めて分かった事実のうち、文書にあれば読むだけで済んだもの | テストの実行方法、生成物で編集してはいけないファイル、どの repo が機能 X を持つか |
| `failure` | 予測できた理由で失敗し、やり直したビルド・テスト・lint・format | 事前に必要な codegen を知らずにテストが落ちた、既存の失敗と区別できずに調べた、全体テストを流したが対象を絞る方法があった |
| `environment` | sandbox・権限・認証・ネットワーク・dev shell による失敗 | dev shell の外で実行して依存が無かった、DB に書けなかった |
| `instruction` | skill・AGENTS.md・依頼文が曖昧・誤り・矛盾していて手戻りしたもの。文書はあるが見つけにくかったものも含む | skill の手順が古いコマンドを指していた |
| `tooling` | CLI の使い方を誤り、`--help` や試行で調べ直したもの | herdr のオプション名を誤った |

記録しないもの:

- 課題の本質としての探索。変更対象のコードを読み、理解することは作業そのものである。
- TDD の意図した失敗や、自分の変更のバグを直す通常の反復。
- 一度きりの打ち間違い。

判断の基準は「この一文が最初から書かれていれば、その探索や失敗は起きなかったか」である。

## コスト

エージェントは自分のトークン数を正確に知らない。そのため、粗い段階で自己申告する。

| cost | 目安 | 重み |
| --- | --- | --- |
| `low` | 無駄になったツール呼び出しが 3〜5 回、または短い再実行 1 回 | 1 |
| `mid` | 6〜20 回、全体テストの再実行、数分の待ち | 3 |
| `high` | 20 回を超える、再実行の繰り返し、人間の判断待ち、方針の放棄 | 9 |

3 回未満は記録しない。`--steps` に無駄になった呼び出しの概数を書けば、後から重みを見直せる。
項目のスコアは、全 hit の重みの合計とする。

## 保存先

- agtask の [保存先](agtask.md#保存先) の規則で `tasks.db` のパスを決め、同じディレクトリの `friction.db` を使う。`AGTASK_DB` を指定した場合も、その兄弟ファイルにする。
- `tasks.db` が無ければ `NOT_INITIALIZED` で終わる。friction のためだけに `.agtask/` を作らない。勝手な場所に DB を作らないためである。
- `friction.db` は、最初の書き込みで作る（WAL、スキーマ作成は agtask の `init` と同じ手順）。読み取りで無い場合や、スキーマが未作成（`user_version = 0`）の場合は、空の結果を返し、ファイルを作らない。
- 書き込みが検証で失敗するとトランザクションは戻るが、開いた `friction.db` のファイルは残ることがある。中身は空で、読み取りでは空として扱う。
- workspace のルート（`cwd` と `scope` の基準）は、DB ディレクトリの親とする。目印の workspace ならそのルート、通常の repo なら main worktree のルート。`AGTASK_DB` を指定した場合も同じ規則で決まる。ルートの外（ルートの外に置いた linked worktree など）は絶対パスで記録する。
- 並行実行、busy timeout、エラーコード、終了コード、`--json` の形は agtask と同じにする。

## データモデル

全テーブルを `STRICT` で作り、`PRAGMA user_version = 1` を設定する。`hits` と `events` は追記専用で、トリガーで UPDATE / DELETE を拒否する。

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;  -- 'next_seq'

CREATE TABLE items (
  id TEXT PRIMARY KEY,               -- FR-<連番>
  seq INTEGER NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('knowledge','failure','environment','instruction','tooling')),
  title TEXT NOT NULL,               -- 1 行の要約（120 文字以内）
  fact TEXT NOT NULL,                -- 文書に書ける形の事実・手順（1000 文字以内）
  scope TEXT NOT NULL,               -- 影響範囲。workspace のルートからの相対パス。'.' は全体
  target TEXT,                       -- 書くべき場所の案: AGENTS.md、docs/x.md、skill:<name> など
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','accepted','closed')),
  resolution TEXT CHECK (resolution IN ('fixed','wontfix','duplicate')),
  ref TEXT,                          -- fixed: commit・PR・文書パス、wontfix: 理由、duplicate: FR-ID
  closed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'closed') = (resolution IS NOT NULL))
) STRICT;

CREATE TABLE hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items(id),
  cost TEXT NOT NULL CHECK (cost IN ('low','mid','high')),
  steps INTEGER CHECK (steps >= 0),
  basis TEXT NOT NULL,               -- 気づいた経緯: 実行したコマンド、読んだファイル、エラーの要旨（1000 文字以内）
  after_close INTEGER NOT NULL CHECK (after_close IN (0, 1)),  -- closed の後の発生（再発）
  task TEXT,                         -- agtask のタスク ID
  cwd TEXT NOT NULL,                 -- workspace のルートからの相対パス
  pane TEXT,                         -- HERDR_PANE_ID
  model TEXT,                        -- 自己申告のモデル名
  actor TEXT NOT NULL,
  at TEXT NOT NULL
) STRICT;

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES items(id),
  kind TEXT NOT NULL CHECK (kind IN ('created','state','note')),
  text TEXT,
  data TEXT NOT NULL DEFAULT '{}',   -- state: {"from","to","resolution","ref"}
  actor TEXT NOT NULL,
  at TEXT NOT NULL
) STRICT;
```

- 文字数の上限を超えたら `USAGE` で終わる。ログを丸ごと貼るのを防ぎ、レビューで読む量を抑えるためである。
- `cwd` と `scope` の既定値は、cwd の Git の toplevel を workspace のルートからの相対パスにしたもの。Git の外なら `.`。
- `items` の更新は、状態の変更と `target` の変更だけ。`fact` は変えない。事実が違っていたら `closed / wontfix` にして作り直す。

## コマンド

`agtask friction <sub>` とする。共通オプション（`--json`、`--as`、`--help`）と actor の規則は agtask と同じ。
書き込みは actor が必須。herdr の子では承認済みの名前を使う。それ以外では CLI 名（`claude`、`codex`）を使う。

| コマンド | 内容 |
| --- | --- |
| `search <word>... [--all]` | `title`・`fact`・`target`・`scope` に全ての語を含む項目（大文字小文字を区別しない）。既定は `open`・`accepted` と `closed / fixed`。`--all` で全て。スコア順に最大 10 件 |
| `add <title> --kind <k> --fact <text\|-> --cost <c> --basis <text\|-> [--scope <p>] [--target <p>] [--steps <n>] [--task <id>] [--model <m>]` | 項目と最初の hit を作る。返り値は `FR-ID` |
| `hit <FR-ID> --cost <c> --basis <text\|-> [--steps <n>] [--task <id>] [--model <m>]` | 既存の項目に発生を追記する。`closed` なら `after_close = 1`。状態は変えない。`duplicate` で閉じた項目は `INVALID_STATE` とし、`details.ref` に重複先を返す |
| `ls [--state <s>]... [--kind <k>]... [--scope <prefix>] [--since <日時>]` | スコア順の一覧。`--scope` は前方一致（パスの区切り単位）。`--since` を付けると、その日時以降の hit だけで件数とスコアを数え、hit の無い項目は出さない（`report` も同じ） |
| `show <FR-ID>` | 項目、全 hit、全イベント |
| `report [--since <日時>] [--limit <n>]` | レビュー用の Markdown。再発、open / accepted のスコア順、`target` ごとのまとめ、の順 |
| `accept <FR-ID> [--target <p>] [--note <text>]` | `open` → `accepted`。直すと決めたもの |
| `close <FR-ID> --resolution fixed\|wontfix\|duplicate --ref <text>` | `closed` にする。`duplicate` の `--ref` は存在する FR-ID |
| `reopen <FR-ID> --reason <text>` | `closed` → `open`。再発の修正をやり直すとき |
| `note <FR-ID> <text\|->` | 経緯を追記する |

`report` の人間向けの形:

```markdown
# friction report

- DB: /work/ws/.agtask/friction.db
- 生成: 2026-11-07T10:00:00.000Z / 期間: 2026-10-31 以降

## 再発（closed 後の hit）

- FR-4 [fixed: abc1234] hub のテストは codegen が先に要る — 再発 2 件（最後: 2026-11-06T09:12:00.000Z）

## 未対応（スコア順）

- FR-9 [open] score 21 (hit 4) knowledge / scope hub / target hub/AGENTS.md
  - fact: hub の単体テストは `pnpm --filter hub test`。ルートの `pnpm test` は全 repo を流し 15 分かかる。
  - 直近の basis: `pnpm test` を実行し 15 分待った後、package.json を読んで filter を知った

## target ごと

- hub/AGENTS.md: FR-9, FR-12
- skill:herdr-orchestrate: FR-3
```

## 呼び出し経路

記録は「作業の終わり」に行う。途中で毎回止まって記録すると、それ自体がコストになるためである。ただし、コストが `high` の出来事は忘れないうちに記録してよい。

| 場面 | 誰が | どこで指示するか |
| --- | --- | --- |
| herdr-orchestrate の子の提出前 | 実装・調査・CLI の子 | [agtask 操作](../skills/herdr-orchestrate/references/agtask.md) の「子への指示」 |
| レビューで reject したとき | レビュアー | 同「レビュー」。差し戻しの原因が予測できたもの（format 未実行など） |
| オーケストレーションの最終報告 | 親 | herdr-orchestrate の「実行」。配置・通知・polling など、全体の進め方の問題 |
| 単独のセッションの終わり | 各エージェント | グローバルな AGENTS.md / CLAUDE.md。本文は [context.md](../skills/friction-log/context.md) で、`lib.agentContext.friction-log` として公開する（[取り込み方](usage.md#グローバル指示に取り込む)） |

## 実装と連携

- CLI は [agtask.mjs](../tools/agtask/agtask.mjs) の `friction` サブコマンド群。保存先の解決は agtask の `location()` を共有する。受け入れテストは [friction.test.mjs](../tools/agtask/test/friction.test.mjs)。
- 再発は、`closed / fixed` の項目について `closed_at` より後の hit で数える。`after_close` は記録時点の事実として残し、`reopen` の後は再発に数えない。
- skill は `nix/agent-tools/agent-skills.nix` で登録する。herdr-orchestrate は、子の提出前・レビューの差し戻し・親の最終報告で friction-log を使う。herdr-pane-review は先に `friction report` を読み、pane の読み取りを協調の問題に絞る。

## 今後の検討

- 自己申告のコストを、実際の消費量で補正する。Claude Code と Codex のセッションログには usage が残るため、`hits` にセッション ID を足せば後から突き合わせられる。
- orch-board に open の件数と再発を表示する。

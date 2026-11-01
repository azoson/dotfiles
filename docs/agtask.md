---
type: Reference
title: agtask
description: herdr-orchestrate で使う、ローカルのエージェント用タスク・依存グラフ管理 CLI の仕様とリファレンス。
---

# agtask

長いエージェント作業の計画・成果物・検証の証拠・進捗を、Git 管理外の SQLite に記録する CLI。
完了は受け入れ条件ごとの証拠とレビューで判定し、中断後は `handoff` で再開できる要約を出す。
herdr-orchestrate での使い方は [agtask 操作](../skills/herdr-orchestrate/references/agtask.md) を参照する。

- 記録だけを行う。担当ファイル・書込可否は表示用で、強制は sandbox と CLI の権限設定が担う。
- `wait` / `watch` などの待機機能は作らない。完了通知は herdr で行う。
- タスクの編集・削除コマンドは作らない。受け入れ条件を変えると証拠が無効になるため、`cancel` して `add` し直す。
- actor 名は自己申告で、認証ではない。取り違え防止に使う。

## 実装と配置

- `tools/agtask/agtask.mjs`: Node 24 の単一 ESM ファイル。`node:` 組み込みモジュールだけを使い、外部依存を持たない。DB は `node:sqlite` の `DatabaseSync`。
- `tools/agtask/test/*.test.mjs`: 受け入れテスト。repo のルートで `node --test 'tools/agtask/test/*.test.mjs'` を実行する。
- Nix: `packages.<system>.agtask` として、[node.nix](../nix/agent-tools/node.nix) の Node で `agtask.mjs` を実行するラッパーを提供する。Home Manager モジュールの `home.packages` と `devShells.<system>.agent-tools` に加え、`nix flake check` でテストを実行する。テストには `git` が要る。
- バージョンは `0.1.0`、DB スキーマは `1`。

## 保存先

次の順で DB ファイルを決める。

1. 環境変数 `AGTASK_DB` が空でなければ、その値。相対パスは cwd 基準で絶対パスにする。
2. cwd で `git rev-parse --path-format=absolute --git-common-dir` が成功し、結果を `C`、その親ディレクトリを `R` として次を全て満たせば `<R>/.agtask/tasks.db`。`R` は main worktree のルートで、同じ repo の全 worktree が同じ DB に解決する。
   - `C` の basename が `.git`。
   - `git --git-dir=<C> rev-parse --is-bare-repository` の出力が `false`。
3. 2. の条件を満たさない Git repo（bare repo とその worktree、`--separate-git-dir` など）では、`git rev-parse --show-toplevel` が成功すればその結果 `T` の `<T>/.agtask/tasks.db`。worktree ごとに別の DB になる。
4. それ以外（Git 外、`git` が無い、作業ツリーの外）は `<cwd>/.agtask/tasks.db`。

`git` は `execFileSync` で cwd を指定して呼び、標準エラーは捨てる。失敗や `git` が無い場合は次の段へ進む。
`init` 以外は DB ファイルが無ければ `NOT_INITIALIZED` で終了する。ファイルはあるが開けない・書けない場合は `DB_ACCESS` で終了する。

CLI は既定の保存先への `init` で `.agtask/.gitignore`（内容 `*`）を作り、DB を Git の追跡対象から除外する。既存の `.gitignore` は変更せず、`AGTASK_DB` 指定時は作らない。`.git/` には何も書かない。
Home Manager で global ignore も設定する場合は、[利用手順](usage.md#agtask-の-global-ignore) を参照する。
sandbox が cwd 配下だけを書込可にする場合、DB ディレクトリが子の cwd 配下になければ書込許可が要る。2. で解決した場合、main worktree のルートを cwd にした子は追加の権限なしで書け、cwd が下位ディレクトリや別の worktree の子には許可が要る。運用は [agtask 操作](../skills/herdr-orchestrate/references/agtask.md#実行前親) を参照する。

## データモデル

### ID

- タスク ID は `<PREFIX>-<連番>`（例: `AGT-12`）。PREFIX は `init --prefix` で決め、`^[A-Z][A-Z0-9]{0,9}$`。既定は `AGT`。
- 連番は DB 内で 1 から増やし、再利用しない。入力は大文字小文字を区別せず、大文字に正規化する。PREFIX が異なる ID は `NOT_FOUND`。
- 受け入れ条件はタスク内で 1 からの番号で指す。イベントと証拠は DB 全体の整数 ID。

### 状態

| 状態 | 意味 |
| --- | --- |
| `todo` | 未着手 |
| `in_progress` | 担当が作業中 |
| `review` | 提出済みでレビュー待ち |
| `done` | レビューで受け入れ済み。終端 |
| `blocked` | 判断・外部要因待ち。`blocked_from` に戻り先を保存 |
| `failed` | 断念。終端 |
| `cancelled` | 取り消し。終端 |

`ready` は保存しない。「状態が `todo` で、依存先が全て `done`」を問い合わせ時に計算する。`blocked_by` は依存先のうち `done` でないもの。

### テーブル

全テーブルを `STRICT` で作り、`PRAGMA user_version = 1` を設定する。タスクは削除しない。

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,          -- 'prefix', 'next_seq'
  value TEXT NOT NULL
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('planning','research','implementation','review','cli')),
  goal TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'todo'
    CHECK (state IN ('todo','in_progress','review','done','blocked','failed','cancelled')),
  blocked_from TEXT CHECK (blocked_from IN ('todo','in_progress','review')),
  agent TEXT,                    -- 担当エージェント名。add で予約、claim で確定
  pane TEXT,                     -- herdr の pane ID
  reviewer TEXT,                 -- accept / reject できる名前。NULL なら agent 以外
  plan TEXT,                     -- 構成案の版（例: v2）
  fix_rounds INTEGER NOT NULL DEFAULT 0 CHECK (fix_rounds >= 0),
  max_fix_rounds INTEGER NOT NULL DEFAULT 2 CHECK (max_fix_rounds >= 0),
  next_action TEXT,
  outputs TEXT NOT NULL DEFAULT '[]',  -- 成果物の JSON 文字列配列
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE criteria (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  idx INTEGER NOT NULL CHECK (idx >= 1),
  text TEXT NOT NULL,
  PRIMARY KEY (task_id, idx)
) STRICT;

CREATE TABLE task_files (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  path TEXT NOT NULL,
  writable INTEGER NOT NULL CHECK (writable IN (0, 1)),
  PRIMARY KEY (task_id, path)
) STRICT;

CREATE TABLE deps (
  task_id TEXT NOT NULL REFERENCES tasks(id),     -- 依存する側
  depends_on TEXT NOT NULL REFERENCES tasks(id),  -- 依存される側
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id <> depends_on)
) STRICT;

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL CHECK (kind IN ('created','state','dep_added','dep_removed',
    'note','decision','issue','resolved','next','evidence')),
  text TEXT,
  data TEXT NOT NULL DEFAULT '{}',  -- JSON オブジェクト
  actor TEXT NOT NULL,
  at TEXT NOT NULL
) STRICT;

CREATE TABLE evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  criterion INTEGER NOT NULL,
  round INTEGER NOT NULL,           -- 記録時の fix_rounds
  stage TEXT NOT NULL CHECK (stage IN ('work','review')),
  verdict TEXT NOT NULL CHECK (verdict IN ('verified','incorrect','unresolved')),
  basis TEXT NOT NULL,              -- 根拠: 実行したコマンドと結果、確認した箇所
  missing TEXT,                     -- unresolved のときの不足証拠
  artifacts TEXT NOT NULL DEFAULT '[]',
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  FOREIGN KEY (task_id, criterion) REFERENCES criteria(task_id, idx),
  CHECK ((verdict = 'unresolved') = (missing IS NOT NULL))
) STRICT;
```

`events`・`evidence`・`criteria` は追記専用。`BEFORE UPDATE` と `BEFORE DELETE` のトリガーで `RAISE(ABORT, ...)` する。

`events.data` の内容:

| kind | text | data |
| --- | --- | --- |
| `created` | NULL | `{}` |
| `state` | 理由（無ければ NULL） | `{"from","to","command"}`。claim は `agent`・`pane`、reject は `fix_rounds`、submit は `summary`・`round` を追加（[完了サマリー](#完了サマリー)） |
| `dep_added` / `dep_removed` | NULL | `{"depends_on"}` |
| `note` / `decision` | 本文 | `{}` |
| `issue` | 本文 | `{}`。reject が作るものは `{"reject":true,"round":<reject 前の round>}` |
| `resolved` | 本文 | `{"resolves":<issue のイベント ID>}` |
| `next` | 次のアクション。消去時は NULL | `{}` |
| `evidence` | NULL | `{"evidence_id","criterion","verdict","stage"}` |

時刻は `new Date().toISOString()` の UTC 文字列。

## 共通仕様

### 引数

- `node:util` の `parseArgs`（`strict: true`, `allowPositionals: true`）で解析する。オプションは位置引数の前後どちらでもよく、`--` 以降は位置引数。
- 共通オプション: `--json`、`--as <name>`、`-h` / `--help`。`agtask --version` はバージョンを出す。
- `agtask --help`、`agtask help [<command>]`、`agtask <command> --help` は使い方（引数・オプション・前提条件）を標準出力に出して 0 で終わる。DB は開かない。
- `--json` 付きの help と version も DB を開かず、`{"ok":true,"help":"<人間向けと同じ本文>"}` / `{"ok":true,"version":"0.1.0"}` の 1 行 JSON を出す。
- 文字列の値は前後の空白を除いて保存し、空なら `USAGE`。繰り返し可能なオプションは同じ値を一つにまとめる。
- `note` と `next` の本文、`submit --summary` に `-` を渡すと標準入力全体を本文にする。
- 整数の値は 0 以上の 10 進整数。それ以外は `USAGE`。

### actor

- 読み取りコマンドは `ls` / `ready` / `show` / `history` / `graph` / `handoff`。これらと `init` 以外は actor が必須。`--as` が `AGTASK_AGENT` より優先する。どちらも無ければ `USAGE`。
- 書式は `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$`。`--agent`・`--reviewer` も同じ。
- herdr-orchestrate では承認済みの子の名前を使う。

### 出力

- 人間向け: 書き込みは 1 行（例: `AGT-2: in_progress -> review`）、一覧は表形式。`show` は詳細、`history` は記録順の履歴を出す。この形式は機械向けの安定インターフェースではないが、`show`・`history`・`handoff`・`graph` の内容と順序は下記に従う。
- 人間向けのエラー: 標準エラーに `agtask: <message> [<CODE>]` を 1 行出す。
- `--json`: 成功・失敗とも標準出力に JSON オブジェクトを 1 行（`JSON.stringify` + 改行）だけ出し、標準エラーには何も出さない。成功は `"ok": true`、失敗は次の形。

```json
{"ok":false,"error":{"code":"NOT_READY","message":"AGT-3 の依存が未完了: AGT-2","details":{"blocked_by":["AGT-2"]}}}
```

### 終了コード

| 終了コード | error.code | 主な details |
| --- | --- | --- |
| 0 | - | - |
| 1 | `INTERNAL`, `SCHEMA_TOO_NEW` | `{"user_version"}` |
| 2 | `USAGE` | - |
| 3 | `NOT_INITIALIZED`, `NOT_FOUND` | `{"db"}`, `{"id"}` |
| 4 | `INVALID_STATE` | `{"state","allowed":[...]}` |
| 4 | `NOT_READY` | `{"blocked_by":[...]}` |
| 4 | `ALREADY_ASSIGNED`, `NOT_OWNER` | `{"agent"}` |
| 4 | `NOT_REVIEWER` | `{"reviewer","agent"}` |
| 4 | `GATE_FAILED` | [完了ゲート](#完了ゲート) を参照 |
| 4 | `CYCLE` | `{"path":["AGT-1","AGT-3","AGT-1"]}` |
| 4 | `PREFIX_MISMATCH` | `{"prefix"}` |
| 4 | `FIX_LIMIT_EXCEEDED` | `{"fix_rounds","max_fix_rounds"}` |
| 5 | `BUSY` | `{"timeout_ms"}` |
| 6 | `DB_ACCESS` | `{"db","sqlite_code"}` |

`node:sqlite` が投げるエラーの `errcode` が 5・6 なら `BUSY`、8・14 は `DB_ACCESS`、DB の `user_version` が 1 より大きければ `SCHEMA_TOO_NEW` に対応させる。

### JSON のタスク表現

`ls`・`ready`・`add`・状態を変えるコマンドは次の共通形を返す。`outputs` は文字列配列、`deps` と `blocked_by` は ID の配列（連番順）。

```json
{
  "id": "AGT-2", "title": "agtask を実装する", "role": "implementation",
  "goal": "docs/agtask.md の仕様どおりに CLI とテストを作る",
  "state": "in_progress", "ready": false, "blocked_from": null,
  "agent": "agtask-impl", "pane": "w1:p3", "reviewer": "agtask-review",
  "plan": "v2", "fix_rounds": 0, "max_fix_rounds": 2,
  "next_action": null, "outputs": [],
  "files": [{"path": "tools/agtask/", "writable": true}, {"path": "docs/agtask.md", "writable": false}],
  "criteria": [{"index": 1, "text": "node --test 'tools/agtask/test/*.test.mjs' が全て成功する"}],
  "deps": ["AGT-1"], "blocked_by": [],
  "created_by": "orchestrator", "created_at": "2026-11-01T10:00:00.000Z", "updated_at": "2026-11-01T10:05:00.000Z"
}
```

証拠とイベントの形:

```json
{"id": 5, "task": "AGT-2", "criterion": 1, "round": 0, "stage": "work", "verdict": "verified",
 "basis": "node --test 'tools/agtask/test/*.test.mjs': 38 pass, 0 fail", "missing": null,
 "artifacts": ["tools/agtask/test/claim.test.mjs"], "by": "agtask-impl", "at": "2026-11-01T10:30:00.000Z"}
{"id": 12, "task": "AGT-2", "kind": "decision", "text": "ID の正規化は大文字", "data": {}, "by": "agtask-impl", "at": "2026-11-01T10:20:00.000Z"}
```

## 並行実行

複数のエージェントが同じ DB へ同時に書く前提で、次を守る。

- 1 プロセス 1 接続。`new DatabaseSync(db, { timeout, readOnly })` で開き、`PRAGMA foreign_keys = ON` と `PRAGMA synchronous = NORMAL` を設定する。読み取りコマンドは `readOnly: true`。
- `timeout`（busy timeout）の既定は 5000 ms。`AGTASK_BUSY_TIMEOUT_MS` で上書きする。超えたら `BUSY` で終わり、アプリ側で再試行しない。例外は次の `init` の WAL 切替だけ。
- `journal_mode = WAL` は `init` がトランザクション外で設定する（DB に永続化される）。`PRAGMA journal_mode` が既に `wal` なら切り替えない。切替は並行 init で busy timeout を待たずに `BUSY` になりうるため、`init` の開始から busy timeout の期限内に限り、`BUSY` / `LOCKED` で失敗した切替を短い間隔（10〜50 ms）で再試行する。期限を過ぎたら `BUSY`。
- ネットワークファイルシステム上の DB は対象外。
- 書き込みコマンドは最初に `BEGIN IMMEDIATE` を実行し、前提条件の確認・ID の採番・更新・イベント追記を同じトランザクションで行って `COMMIT` する。失敗時は `ROLLBACK` し、何も残さない。トランザクション外で前提条件を確認しない。
- 読み取りコマンドは複数の SELECT を一つの `BEGIN` … `COMMIT` で囲み、同じスナップショットを読む。
- 状態を変える更新は `tasks.updated_at` も更新する。

## コマンド

位置引数の `<id>` はタスク ID。`--json` と `--as` は全コマンド共通なので省略する。

### 状態遷移

| コマンド | 遷移前 | 遷移後 | 実行できる actor |
| --- | --- | --- | --- |
| `claim` | `todo`（ready） | `in_progress` | `agent` が空か actor と一致 |
| `release` | `in_progress` | `todo` | 誰でも |
| `submit` | `in_progress` | `review` | `agent` |
| `accept` | `review` | `done` | `reviewer`。未設定なら `agent` 以外 |
| `reject` | `review` | `in_progress`、上限超過なら `blocked` | `accept` と同じ |
| `block` | `todo` / `in_progress` / `review` | `blocked` | 誰でも |
| `unblock` | `blocked` | `blocked_from` の状態 | 誰でも |
| `fail` | `todo` / `in_progress` / `review` / `blocked` | `failed` | 誰でも |
| `cancel` | `todo` / `in_progress` / `review` / `blocked` | `cancelled` | 誰でも |

遷移前の状態が合わなければ `INVALID_STATE`（`details.allowed` に許される状態）。各遷移は `state` イベントを追記する。
`blocked` 以外へ移るとき `blocked_from` は NULL に戻す。`next_action` は `submit`・`accept`・`fail`・`cancel` で NULL に戻し、`--next` があればその値にする。

状態を変えるコマンドの JSON:

```json
{"ok":true,"task":{"id":"AGT-2","state":"review","...":"..."},"transition":{"from":"in_progress","to":"review"},"event":21}
```

### init

`agtask init [--prefix <PREFIX>]`

- DB ディレクトリを再帰的に作り、DB・WAL・スキーマ・`meta`（`prefix`、`next_seq = 1`）を作る。actor は不要。
- 保存先を `AGTASK_DB` 以外で決めた場合、DB ディレクトリに `.gitignore` が無ければ内容 `*\n` で作る。既存の `.gitignore` は変えない。`AGTASK_DB` の場合は作らない（指定先の他のファイルを無視させないため）。初期化済みの DB に対する `init` でも、この確認は行う。
- 既に初期化済みなら DB を変えず `created: false`。`--prefix` が既存と異なれば `PREFIX_MISMATCH`。
- WAL への切替は [並行実行](#並行実行) のとおり、既に `wal` なら行わず、`BUSY` / `LOCKED` なら busy timeout の期限内で再試行する。
- 同時実行に備え、スキーマ作成は `BEGIN IMMEDIATE` 内で `user_version` を確認してから行う。`.gitignore` は排他作成（`wx` フラグ）し、`EEXIST` は無視する。
- 返り値の `gitignore` は `created`（今回作成）/ `exists`（既存）/ `skipped`（`AGTASK_DB`）。

```json
{"ok":true,"db":"/home/u/repo/.agtask/tasks.db","prefix":"AGT","created":true,"gitignore":"created"}
```

### add

`agtask add <title> --role <role> --goal <text> --criterion <text>... [--write <path>]... [--read <path>]... [--dep <id>]... [--agent <name>] [--reviewer <name>] [--plan <version>] [--max-fix-rounds <n>] [--next <text>]`

- `--role` は `planning` / `research` / `implementation` / `review` / `cli`。`--goal` と 1 つ以上の `--criterion` は必須。条件は指定順に 1 から番号を振る。
- `--write` は書込可、`--read` は読取のみの担当ファイル。同じパスを両方に指定したら `USAGE`。パスは指定どおり保存し、存在を確認しない。
- `--dep` の各タスクが存在しなければ `NOT_FOUND`、`failed` / `cancelled` なら `INVALID_STATE`。
- `--agent` と `--reviewer` が同じなら `USAGE`。`--max-fix-rounds` の既定は 2。
- `created`、各依存の `dep_added`、`--next` があれば `next` のイベントを追記する。返り値は `{"ok":true,"task":{...}}`。

### dep add / dep rm

`agtask dep add <id> <depends-on>...` / `agtask dep rm <id> <depends-on>...`

- `<id>` が `<depends-on>` に依存する、という向き。`<id>` は `todo` か `blocked` であること。
- `add`: 依存先が無ければ `NOT_FOUND`、`failed` / `cancelled` なら `INVALID_STATE`、自分自身や循環になる組なら `CYCLE`（`details.path` に循環の経路）。既存の組は飛ばして `existing` に入れる。
- `rm`: 存在しない組があれば `NOT_FOUND`。
- どちらも全体を一つのトランザクションで行い、一つでも失敗すれば何も変えない。

```json
{"ok":true,"task":"AGT-3","added":["AGT-1"],"existing":["AGT-2"]}
{"ok":true,"task":"AGT-3","removed":["AGT-1"]}
```

### ls / ready

- `agtask ls [--state <state>]... [--agent <name>] [--plan <version>] [--ready]`: 連番順のタスク一覧。条件は AND。
- `agtask ready [--agent <name>]`: ready なタスク。`--agent` があれば `agent` が空か一致するものだけ。`ls --ready` と同じ。
- いずれも `{"ok":true,"tasks":[...]}` を返す。

### show

`agtask show <id>`

オプションなしで 1 タスクの詳細を出す。追加の `--detail` は設けない。全状態が対象で、存在しない ID は `NOT_FOUND`。読み取りは同一スナップショットで行う。

人間向けは `# <id> <title>` を先頭に、次の節を順に出す。未設定の単一値は `-`、空の一覧は `- なし`。長文を省略せず、複数行の値は続きの行を字下げして表示する。

| 節 | 必須の内容・順序 |
| --- | --- |
| `Task` | 目的、役割、状態、ready、blocked_from、構成案、修正回数/上限、担当、pane、レビュアー、作成者、作成日時、更新日時 |
| `Files` | 担当ファイルを登録順に、各パスと `書込可` / `読取のみ` |
| `Dependencies` | 依存先、未完了の依存先、依存される先を別項目にし、それぞれ ID を連番順に表示 |
| `Outputs` | 現在の `outputs` を保存順に表示 |
| `Summary` | [完了サマリー](#完了サマリー)の本文と提出情報、無ければ `未登録` |
| `Criteria` | 条件番号順に本文、現ラウンドの `work`、`review`。証拠が無ければ `未記録`。あれば証拠 ID、round、verdict、by、at、basis、missing、artifacts を全て表示 |
| `Decisions` | 全 decision をイベント ID 順に、イベント ID・本文・by・at |
| `Open issues` | handoff と同じ導出と順序（ブロック理由、未解消 issue、現ラウンドの不備、前回レビュー、未検証） |
| `Next action` | handoff と同じ導出。保存された `next_action` を優先 |

`Criteria` の work/review は既存 `show --json` と同じ選択（現ラウンド・stage の最新 ID、actor では絞らない）。完了ゲートと handoff の自己検証は引き続き担当者の work だけを使う。全ラウンドの証拠や解消済み issue・通常 note は `history <id>` で確認する旨を末尾に表示する。

`--json` は既存の `task`・`evidence`・`events` を維持し、トップレベルに `summary` のみを追加する。`task` は共通形に加え、`criteria` の各要素に現ラウンドの最新証拠 `work` / `review`（無ければ null）、`dependents`（このタスクに依存する ID、連番順）を持つ。全証拠と全イベントはそれぞれ ID 昇順を維持する。人間向け節を JSON に重複追加しない。

```json
{"ok":true,"task":{"id":"AGT-2","...":"...","criteria":[{"index":1,"text":"...","work":{"id":5,"...":"..."},"review":null}],"dependents":["AGT-4"]},"evidence":[],"events":[],"summary":null}
```

### history

`agtask history <id>`

- 1 タスクの全イベントを `events.id ASC` で出す。フィルター・件数制限・逆順オプションは設けない。全状態が対象で actor は不要。ID の正規化、`NOT_FOUND`、DB エラー、help、終了コードは他の読み取りコマンドと同じ。
- 「時系列」は DB への記録順を意味する。`at` は表示用 UTC 時刻で、同時刻や時計の巻き戻りでも ID 順を変えない。別タスクのイベントによる ID の飛びは許容する。
- note / decision / issue / resolved / next / evidence / state / created / dep_added / dep_removed を省略しない。解消済み issue、過去ラウンドの証拠、差し戻された提出も残す。追記専用の既存データを更新しない。
- 人間向けは `# <id> <title> — history` の後に各イベントを表示する。見出しは `## #<id> <at> <kind> (<by>)`、続けて本文（null なら `-`）と `Data: <data の1行 JSON>` を出す。本文の改行は字下げして保持する。空の履歴は `- なし`。
- `state` ではさらに `<from> -> <to> / <command>` を表示する。submit ではサマリー本文（無ければ `未登録`）と round（旧データで無ければ `-`）を表示する。reject の理由・修正回数、resolved の参照先、next の消去（text が null）は上記の本文・Data で識別できる。
- `evidence` イベントでは `data.evidence_id` で同じタスクの証拠を引き、証拠 ID、criterion、round、stage、verdict、basis、missing、artifacts、by、at を表示する。参照先が無ければ `証拠なし: #<evidence_id>` と表示し履歴は読み続ける。イベントの無い証拠について架空のイベントは生成しない。
- JSON は下記の形。`task` は正規化済み ID 文字列。`events` と `evidence` は `show --json` の同名配列と完全に同じ（それぞれ全件・ID 昇順）。証拠本文を events 内に重複追加せず、利用側が ID で対応付ける。空なら `[]`。取得は同一読み取りトランザクション内。

```json
{"ok":true,"task":"AGT-2","events":[{"id":21,"task":"AGT-2","kind":"state","text":null,"data":{"from":"in_progress","to":"review","command":"submit","summary":"詳細表示と履歴を追加。受入テスト成功。","round":0},"by":"agtask-impl","at":"2026-11-01T10:40:00.000Z"}],"evidence":[]}
```

### claim / release

`agtask claim <id> [--pane <pane>]`

- `--pane` の既定は `HERDR_PANE_ID`、それも無ければ NULL。
- `todo` で依存先が全て `done`、かつ `agent` が空か actor と一致するときだけ取得し、`agent = actor`、`pane`、`in_progress` にする。
- 依存が未完了なら `NOT_READY`、別の actor が予約・取得済みなら `ALREADY_ASSIGNED`。
- 同じ actor が `in_progress` のタスクを再度 claim したら成功とし、pane が違えば更新する。
- 返り値は状態を変えるコマンドの形に `changed`（変更の有無）を加える。再 claim では `transition` が null。

`agtask release <id> --reason <text> [--unassign]`

- `in_progress` を `todo` に戻し、`pane` を NULL にする。`--unassign` があれば `agent` も NULL にする。担当の交代に使う。

### note / next

`agtask note <id> <text|-> [--kind note|decision|issue] [--resolve <event-id>]`

- `--kind` の既定は `note`。`decision` は決定、`issue` は未解決点。どの状態でも追記できる。
- `--resolve` は同じタスクの `issue` イベントを解消済みにし、kind `resolved` で記録する。`--kind` と併用したら `USAGE`。対象が無い・`issue` でなければ `NOT_FOUND`、解消済みなら `INVALID_STATE`。
- 返り値は `{"ok":true,"event":{...}}`。

`agtask next <id> (<text|-> | --clear)`

- `next_action` を設定または消去し、`next` イベントを追記する。

### evidence

`agtask evidence <id> --criterion <n> --verdict verified|incorrect|unresolved --basis <text> [--missing <text>] [--artifact <path>]...`

- `in_progress` では `agent` だけが記録でき（違えば `NOT_OWNER`）、`stage = work`。担当の自己検証にあたる。
- `review` では `reviewer`（未設定なら `agent` 以外）だけが記録でき（違えば `NOT_REVIEWER`）、`stage = review`。
- その他の状態は `INVALID_STATE`。条件番号が無ければ `NOT_FOUND`。
- `--missing` は `unresolved` のとき必須、それ以外で指定したら `USAGE`。`round` には現在の `fix_rounds` を入れる。
- `evidence` イベントも追記する。返り値は `{"ok":true,"evidence":{...}}`。

### submit / accept / reject

`agtask submit <id> --output <path>... [--summary <text|->] [--next <text>]`

- actor が `agent` でなければ `NOT_OWNER`。[完了ゲート](#完了ゲート) を満たせば `outputs` を指定値で置き換え、`review` にする。
- `--summary` は任意の完了サマリー。省略した従来の呼び出しも成功する。保存・再提出・表示の規則は次節に従う。成功 JSON は既存の状態遷移の形を維持する（サマリーは `show` / `handoff` / `history` で取得）。

`agtask accept <id> [--note <text>]`

- actor が `reviewer`（未設定なら `agent` 以外）でなければ `NOT_REVIEWER`。ゲートを満たせば `done` にする。`--note` は `state` イベントの理由に入れる。

`agtask reject <id> --reason <text> [--next <text>]`

- 実行者は `accept` と同じ。`fix_rounds` を 1 増やし、`--reason` を本文とする `issue` イベント（`data.reject = true`）を追記する。
- 増やした後の `fix_rounds` が `max_fix_rounds` 以下なら `in_progress`。超えたら `blocked`（`blocked_from = in_progress`、理由 `fix_limit_exceeded`）にする。
- `next_action` は `--next`、無ければ `修正: <reason>`。返り値に `fix_limit_exceeded`（真偽値）を加え、真なら人間向け出力に `修正上限を超過: <fix_rounds>/<max_fix_rounds>` を出す。終了コードは 0。

### 完了サマリー

サマリーは担当が提出時に記す成果・変更・検証・残件の自由文であり、受入判定ではない。`done` にできるのは従来どおりレビュアーの `accept` だけ。

- `--summary <text>` は前後の空白を除去し、内部の改行を保持する。`--summary -` は UTF-8 の標準入力全体を同じ規則で読む。指定した値が空・空白だけ（空の標準入力を含む）なら `USAGE`。省略とは区別する。ファイル読み込み用オプションや別の summary コマンドは追加しない。
- 保存先は既存の submit の `state` イベントの `data`。`summary` は本文文字列または省略時の null、`round` は提出時の `tasks.fix_rounds`。`text` は従来どおり null とし、`from` / `to` / `command` を保つ。tasks の列、テーブル、イベント kind、トリガー、`user_version = 1` は変更しない。
- 状態遷移・outputs 更新・イベント保存は同一の書き込みトランザクション。本文の検証やゲートで失敗したらサマリーもイベントも残さない。サマリーの有無は submit / accept ゲートに影響しない。
- 表示用の `summary` は、そのタスクの `kind = state` かつ `data.command = submit` のうち **ID 最大のイベントを先に選び**、そこから導出する。本文が無い/null/空なら null。サマリーを持つ古い提出を検索して補わない。
- 新データに本文がある場合の共通 JSON 形は下記。`event` / `by` / `at` は選んだイベント、`round` は保存された提出ラウンド。これは `show` のトップレベル、`handoff.tasks[]`、`handoff.finished[]` の `summary` に同じ形で加える。共通のタスク表現や `ls` / `ready` の JSON は変更しない。

```json
{"text":"詳細表示と履歴を追加。\n受入テスト成功。","round":0,"event":21,"by":"agtask-impl","at":"2026-11-01T10:40:00.000Z"}
```

- 人間向けは `完了サマリー（直近提出）` とし、本文、イベント ID、提出 round、by、at を表示する。提出 round が現在の `fix_rounds` より小さければ `前回提出・差し戻し済み` を併記する。`review` 中はレビュー待ちのままで、サマリーがあっても受入済みとは表示しない。状態は Task（終了済み一覧なら行頭）で確認できる。
- reject は過去の submit イベントを消去・更新しない。再提出前は前回のサマリーを上記ラベル付きで表示する。再提出で新本文を渡せば新しいものに置き換わり、省略すれば表示用 summary は null。いずれも古い本文は history と show の events に残る。
- accept / block / unblock / release / fail / cancel / note / next はサマリーを更新しない。レビュー途中の block/unblock や受入後も同じ直近提出を参照する。accept の `--note` をサマリーの代わりには使わない。
- 旧 DB のタスク、未提出タスク、旧 CLI が作った最新 submit（summary キー無し）は `summary: null`、人間向けは `未登録`。過去の証拠・note・outputs から本文を推測せず、移行や埋め戻しも行わない。旧イベントの round 欠落も許容する。防御的に summary が非文字列、または本文ありでも round が非負の安全整数でない場合は表示用 summary を null とし、生の data は履歴に残す。
- 新旧 CLI の併用では、旧 CLI は追加 data キーをそのまま読め、旧方式の submit は引き続き可能。新 CLI は上記の欠落値規則で読む。JSON 互換性は既存キー・型・配列順を保った追加のみとし、利用側は未知のキーを許容する。新しい `history` / `--summary` を旧 CLI で実行できるという意味ではない。

### block / unblock / fail / cancel

- `agtask block <id> --reason <text>`: 現在の状態を `blocked_from` に保存して `blocked` にする。
- `agtask unblock <id> [--note <text>] [--max-fix-rounds <n>]`: `blocked_from` の状態に戻す。`--max-fix-rounds` があれば先に上限を更新する。戻り先が `in_progress` で `fix_rounds > max_fix_rounds` なら `FIX_LIMIT_EXCEEDED`。
- `agtask fail <id> --reason <text>`: `failed` にする。
- `agtask cancel <id> --reason <text>`: `cancelled` にする。依存しているタスクは ready にならないので、必要なら `dep rm` する。

### graph

`agtask graph [--format text|mermaid]`

- 既定は `text`。`--json` では形式によらず `{"ok":true,"nodes":[{"id","title","state","ready"}],"edges":[{"from":"AGT-1","to":"AGT-2"}]}` を返す。edge は依存される側から依存する側。
- 並び順は位相順で、同順位は連番の小さい順（Kahn 法）。

text 形式は 1 タスク 1 行。ready なら状態を `todo, ready` と書き、依存があれば ` <- ` の後に連番順で並べる。

```text
AGT-1 [done] 仕様を確定する
AGT-2 [in_progress] 実装する <- AGT-1
AGT-3 [todo, ready] 運用資料を直す <- AGT-1
AGT-4 [todo] 統合を確認する <- AGT-2, AGT-3
```

mermaid 形式はノード（連番順）、edge（依存する側、依存される側の連番順）、`class` 行、全状態の `classDef` の順。ID の `-` は `_` に、タイトルの `"` は `#quot;` に置き換える。

```text
flowchart TD
  AGT_1["AGT-1 仕様を確定する<br/>done"]
  AGT_2["AGT-2 実装する<br/>in_progress"]
  AGT_1 --> AGT_2
  class AGT_1 done
  class AGT_2 in_progress
  classDef todo fill:#ffffff,stroke:#999999
  classDef in_progress fill:#dbeafe,stroke:#2563eb
  classDef review fill:#fef3c7,stroke:#d97706
  classDef done fill:#dcfce7,stroke:#16a34a
  classDef blocked fill:#fee2e2,stroke:#dc2626
  classDef failed fill:#e5e7eb,stroke:#dc2626
  classDef cancelled fill:#e5e7eb,stroke:#6b7280
```

### handoff

`agtask handoff [<id>...] [--all]`

再開用の progress note を出す。形式は [handoff の形式](#handoff-の形式)。

- ID 指定なし: 終端でないタスクを全項目で出し、終端のタスクは `## 終了済み` に 1 行ずつ出す。
- ID 指定あり: 指定したタスクだけを、状態によらず全項目で出す（`## 終了済み` は出さない）。
- `--all`: 全タスクを全項目で出す。

## 完了ゲート

「現ラウンド」は `round = fix_rounds` の証拠。各条件の判定には、そのラウンド・stage での最新（ID 最大）の証拠を使う。

| ゲート | 条件 |
| --- | --- |
| `submit` | 全条件で、`agent` が記録した最新の `work` 証拠が `verified`。`--output` が 1 つ以上。reject が作った `issue` が全て解消済み。 |
| `accept` | 全条件で、最新の `review` 証拠が `verified`。 |
| `reject` | `--reason` が必須。証拠は必須にしない（条件外の問題も差し戻せるようにする）。 |

`done` にできるのは `accept` だけ。reject 後は新しいラウンドになるため、担当は全条件の証拠を記録し直し、reject の `issue` を `note --resolve` で解消してから提出する。
失敗時は `GATE_FAILED` で次の details を返す。

```json
{"stage":"review","round":1,"failing":[{"criterion":2,"verdict":"unresolved"},{"criterion":3,"verdict":null}],"missing_outputs":false,"open_reject_issues":[]}
```

## handoff の形式

記事の progress note に Summary を加えた Markdown（Task / Outputs / Summary / Completed / Decisions / Open issues / Next action）。値が無い項目は `-`、空の節は `- なし`。ただし Summary が null のときは `- 未登録`。タスクは位相順で並べる。

```markdown
# agtask handoff

- DB: /home/u/repo/.agtask/tasks.db
- 生成: 2026-11-01T11:00:00.000Z
- 状態: todo 1 / in_progress 1 / review 0 / blocked 0 / done 1 / failed 0 / cancelled 0
- ready: AGT-3

## AGT-2 agtask を実装する

### Task

- 目的: docs/agtask.md の仕様どおりに CLI とテストを作る
- 役割: implementation / 状態: in_progress / 構成案: v2 / 修正: 1/2
- 担当: agtask-impl (w1:p3) / レビュー: agtask-review
- 依存: AGT-1 (done)
- 担当ファイル: tools/agtask/ (書込可), docs/agtask.md (読取のみ)

### Outputs

- tools/agtask/agtask.mjs

### Summary

- 完了サマリー（直近提出）: #16 / round 0 / agtask-impl / 2026-11-01T10:40:00.000Z / 前回提出・差し戻し済み
- 詳細表示と履歴を追加。受入テスト成功。

### Completed

- [1] node --test 'tools/agtask/test/*.test.mjs' が全て成功する — 自己検証: node --test 'tools/agtask/test/*.test.mjs': 38 pass, 0 fail

### Decisions

- #12 ID の正規化は大文字 (agtask-impl)

### Open issues

- #18 reject: claim の競合テストが無い
- [2] 前回レビュー incorrect: 並行 claim で 2 件成功した
- [3] 未検証: handoff が仕様の形式で出る

### Next action

- 修正: claim の競合テストが無い

## 終了済み

- AGT-1 [done] 仕様を確定する — Outputs: docs/agtask.md — Summary: 未登録
```

各節の内容:

- Summary: [完了サマリー](#完了サマリー)の共通規則に従う。本文は省略せず、改行の続きは字下げして表示する。ID 指定と `--all` でも同じ節を出す。
- 終了済みの各行: 従来の Outputs の後に ` — Summary: 未登録` または ` — Summary: <本文> (#<event>, round <round>, <by>, <at>)` を追加する。本文の改行は文字としての `\n` に置き換えて 1 行を保つ。差し戻し済みなら括弧内に `前回提出・差し戻し済み` を併記する。done / failed / cancelled の区別と、本文を省略しないことを維持する。
- Completed: 現ラウンドで最新の `review` 証拠が `verified` なら `受入確認: <basis>`、そうでなく `agent` の最新 `work` 証拠が `verified` なら `自己検証: <basis>`。
- Decisions: `decision` イベントを `#<id> <text> (<actor>)` で ID 順に。
- Open issues: 次の順に並べる。
  1. `blocked` なら `ブロック: <理由>`。
  2. 未解消の `issue` イベント。`#<id> <text>`、reject 由来は `#<id> reject: <text>`。
  3. 現ラウンドの最新判定（`review` があればそれ、無ければ `agent` の `work`）が `incorrect` / `unresolved` の条件。`[n] incorrect: <basis>`、`[n] unresolved: <basis> / 不足: <missing>`。
  4. `in_progress` かつ `fix_rounds > 0` なら、前ラウンドの最新 `review` 判定のうち `incorrect` / `unresolved`。`[n] 前回レビュー <verdict>: <basis>`。
  5. `in_progress` / `review` で、Completed にも 3. にも無い条件。`[n] 未検証: <条件>`。
- Next action: `next_action` があればその値。無ければ状態から決める。

| 状態 | Next action |
| --- | --- |
| `todo`（ready） | `claim 待ち`。`agent` があれば `claim 待ち（<agent>）` |
| `todo`（未 ready） | `依存待ち: <blocked_by をカンマ区切り>` |
| `in_progress` | `作業中（<agent>）` |
| `review` | `レビュー待ち（<reviewer>）`。未設定なら `レビュー待ち（担当以外）` |
| `blocked` | `判断待ち: <理由>` |
| 終端 | `なし` |

`--json` では同じ内容を構造で返す。

```json
{"ok":true,"db":"/home/u/repo/.agtask/tasks.db","generated_at":"2026-11-01T11:00:00.000Z",
 "counts":{"todo":1,"in_progress":1,"review":0,"blocked":0,"done":1,"failed":0,"cancelled":0},
 "ready":["AGT-3"],
 "tasks":[{"id":"AGT-2","title":"agtask を実装する",
   "task":{"goal":"...","role":"implementation","state":"in_progress","plan":"v2","fix_rounds":1,"max_fix_rounds":2,
           "agent":"agtask-impl","pane":"w1:p3","reviewer":"agtask-review","deps":[{"id":"AGT-1","state":"done"}],"files":[]},
   "outputs":["tools/agtask/agtask.mjs"],
   "summary":{"text":"詳細表示と履歴を追加。受入テスト成功。","round":0,"event":16,"by":"agtask-impl","at":"2026-11-01T10:40:00.000Z"},
   "completed":[{"criterion":1,"text":"...","stage":"work","basis":"..."}],
   "decisions":[{"event":12,"text":"ID の正規化は大文字","by":"agtask-impl","at":"..."}],
   "open_issues":[{"type":"issue","event":18,"text":"...","reject":true},
                  {"type":"previous_review","criterion":2,"verdict":"incorrect","basis":"...","missing":null},
                  {"type":"unverified","criterion":3,"text":"..."}],
   "next_action":"修正: claim の競合テストが無い"}],
 "finished":[{"id":"AGT-1","title":"仕様を確定する","state":"done","outputs":["docs/agtask.md"],"summary":null}]}
```

`open_issues[].type` は `blocked` / `issue` / `evidence` / `previous_review` / `unverified`。summary 以外の JSON フィールド、タスクの選択・並び順・counts・ready の意味は従来どおり。finished の差し戻し表示判定は DB の fix_rounds との比較で行い、そのための新フィールドは追加しない。

## 受け入れテストの観点

`node:test` で書き、CLI を `process.execPath` の子プロセスとして実行する。各テストは一時ディレクトリと `AGTASK_DB` を使い、環境変数 `GIT_*` と `AGTASK_AGENT` を除いて起動する。判定は `--json` の出力と終了コードで行い、`handoff` と `graph` は本文も比べる。

- 保存先: `AGTASK_DB` の優先（相対パスは cwd 基準）。main worktree のルート・その下位ディレクトリ・`git worktree add` した worktree から、いずれも `<main worktree>/.agtask/tasks.db` に解決する。bare repo の worktree と `--separate-git-dir` の repo は `<show-toplevel>/.agtask/tasks.db`、bare repo 内と Git 外は `<cwd>/.agtask/tasks.db`。未初期化で `NOT_INITIALIZED`（終了コード 3）。
- .gitignore: 既定の保存先への `init` で `.agtask/.gitignore` が内容 `*` で作られ、`git status --porcelain` が空のまま。既存の `.gitignore` は変わらず `gitignore: "exists"`。`AGTASK_DB` では作らず `skipped`。`init` の前後で `.git/` 配下のファイル一覧が同じ（`git status` を実行する前に比べる）。
- init: WAL になる、二重実行で `created: false`、`--prefix` の不一致で `PREFIX_MISMATCH`、`user_version` が大きい DB で `SCHEMA_TOO_NEW`。
- 並行 init: 新しい DB に 8 プロセスで同時に `init` し、全て終了コード 0、`created: true` が 1 件、DB が WAL。テストを再実行して通った結果だけで判断しない。
- 引数: 未知のコマンド（`constructor` や `__proto__` など `Object.prototype` と同名の語を含む）・オプション、必須値の欠落、空文字、不正な role・verdict・整数、actor 未指定で `USAGE`（終了コード 2）。
- help / version: 全ての help の書き方と `--version` が DB 無しで 0。`--json` 付きでは `{"ok":true,"help":...}` / `{"ok":true,"version":"0.1.0"}` の 1 行 JSON。
- 終了コード: 失敗を確認する全テストで、`error.code` と [終了コード](#終了コード) の表の値が一致することを厳密に比べる。並行 claim の失敗も含む。
- ID: 連番、大文字小文字の正規化、別 PREFIX で `NOT_FOUND`。
- 依存: 自己依存と間接的な循環で `CYCLE` と経路、重複追加は `existing`、`dep rm` の存在しない組で何も変わらない、`todo` / `blocked` 以外で `INVALID_STATE`。
- ready: 依存が全て `done` の `todo` だけ、`blocked` / `cancelled` の依存先では ready にならない、`--agent` の絞り込み。
- claim: 未完了の依存で `NOT_READY`、予約者以外で `ALREADY_ASSIGNED`、同じ actor の再 claim は成功、`HERDR_PANE_ID` の既定値。
- 並行 claim: 同じ ready タスクに 8 プロセスで同時に claim し、成功が 1 件、他は `ALREADY_ASSIGNED`。
- 並行書き込み: 複数プロセスで同時に `add` と `note` を行い、ID の重複・欠番やイベントの欠落が無い。書き込みロックを保持した状態で `AGTASK_BUSY_TIMEOUT_MS` を短くして `BUSY`（終了コード 5）。
- 状態遷移: 遷移表の全組み合わせで許可・`INVALID_STATE` を確認、`block` → `unblock` で元の状態に戻る、終端からは遷移できない。
- 証拠: stage の自動判定、`NOT_OWNER` / `NOT_REVIEWER`、`unresolved` の `--missing` 必須、存在しない条件番号。
- ゲート: 証拠の欠落・`incorrect`・`unresolved`・他人の `work` 証拠・`--output` 無し・未解消の reject issue で `submit` が `GATE_FAILED`。`accept` は全条件の `review` が `verified` のときだけ成功し、担当者自身では `NOT_REVIEWER`。
- reject: `fix_rounds` の増加、reject の `issue` 追加、前ラウンドの証拠がゲートに数えられない、`max_fix_rounds` 超過で `blocked` と `fix_limit_exceeded: true`、`unblock` は上限を上げるまで `FIX_LIMIT_EXCEEDED`。
- 追記専用: `events`・`evidence`・`criteria` の UPDATE / DELETE がトリガーで失敗する。
- 失敗時の原子性: エラーになった書き込みコマンドの後で DB が変わっていない。
- 出力: `--json` は成功・失敗とも標準出力の 1 行 JSON のみ、人間向けエラーは標準エラー。
- graph: text と mermaid が上記形式に一致、位相順と同順位の連番順、`--json` の nodes / edges。
- handoff: Summary を含む 7 節の並び、Open issues の順序と内容、Next action の導出、ID 指定と `--all`、`--json` の構造。
- DB_ACCESS: 書込不可のディレクトリにある DB で終了コード 6（root で実行される環境では skip）。

### 詳細表示・サマリー・履歴の検証

以下を実装時に CLI の受け入れテストへ追加する。計画段階では保存先・既存コード・JSON 形との整合を確認し、新機能の実行結果とは区別する。

| ケース | 操作と確認する結果 |
| --- | --- |
| show 詳細 | 目的、担当・レビュー・pane、read/write ファイル、deps/blocked_by/dependents、outputs、next、決定、未解消 issue を持つタスクを作る。人間向け各節の順序・全項目・長文/改行・空値を確認。JSON の従来フィールド・型・ID 順が変わらず、追加はトップレベル summary のみ |
| 条件と証拠 | work/review の verified・incorrect・unresolved と missing/artifacts を用意し、Criteria に全情報が出ることを確認。reject 後は現 round の証拠のみを選び、過去分は history と show.evidence に残る。既存の他人の work 証拠の表示とゲート判定も維持 |
| 旧 DB / 未登録 | 変更前 CLI で作ったスキーマ 1 の fixture（未提出・review・done を含む）を新 CLI で init し直さず読む。summary キーの無い submit、note や accept --note に本文があるケースも show/handoff で null / 未登録。schema・user_version・旧イベントが不変 |
| 保存と stdin | submit --summary の文字列と標準入力で、前後の空白除去・複数行・日本語・引用符を確認。state.data の summary/round と同じイベントの from/to/command を検査。show と handoff の summary オブジェクトが一致し、history でも本文・提出元が分かる |
| 省略とエラー | 従来の submit --output は成功し data.summary は null。空文字・空白・空 stdin は USAGE、状態/担当違反とゲート失敗は既存のエラー。失敗前後の DB スナップショットが同じ。summary があっても証拠や output の不足を通さない |
| reject / 再提出 | round 0 のサマリー A → reject（round 1）で、直近 summary は A・round 0、表示は差し戻し済み。issue 解消と全 work 証拠の再登録後、B で再提出すると B・round 1。再度 reject して summary 省略で再提出すると null（A/B に戻らない）。history には各 submit が A/B/null と元の round のまま残る |
| その他の状態 | review の block/unblock と accept 後に同じ summary が残る。reject 上限超過の blocked も差し戻しラベルを出す。release、fail、cancel、note、next は本文を上書きしない。サマリーの無い done でも正常に読める |
| handoff の全経路 | ID なしの tasks と finished、ID 指定、--all で summary を表示。done/failed/cancelled の終了済み行には本文または未登録。改行は終了済み行のみ文字列の `\n`。既存 6 節の相対順、counts、ready、Next action を保つ |
| history 順序・内容 | created から依存変更・claim・note/decision/issue/resolved・next（消去含む）・evidence・submit・reject・再提出・accept までを確認。fixture のイベントを同時刻/逆行時刻で INSERT し、時刻に依らず ID 昇順。別タスクのイベントは混じらず ID の飛びを許容。human の state と証拠の詳細、JSON の events/evidence が show の配列と一致 |
| 不完全な既存データ | submit の summary/round 欠落や不正な型で落ちず、表示用 summary は null、生 data は維持。証拠の参照先欠落は history human で明示、JSON は原状の events/evidence。イベント無しなら空履歴。既存レコードの UPDATE/DELETE は使わず fixture の INSERT で準備 |
| 互換性と I/O | 旧 CLI が新しい submit イベントの追加キーを読め、旧 CLI で再提出した後は新 CLI の summary が null。既存受入テストを継続し、人間向け期待値は新しい show/7 節 handoff に更新。history を help テストへ加え、actor 不要、ID 正規化、NOT_FOUND、DB 未初期化、1 行 JSON・stderr 空・終了コードを検証 |

---
name: friction-log
description: 作業の終わりに、文書にない事実を探索で調べたことや、予測できた失敗のやり直しを agtask friction で workspace の DB に記録する。作業を終える前、herdr-orchestrate で提出する前、探索や再実行で大きく手間取った直後に使う。
---

# friction log

自分が払った「本来は要らなかったコスト」を記録する。コマンドの構文は `agtask friction --help` を正とする。仕様は dotfiles の `docs/friction.md` にあり、skill の配置先には含まれない。

## 記録するか

基準は「この一文が最初から文書に書かれていれば、その探索や失敗は起きなかったか」。

- 記録する: 文書にない事実をコードや試行で調べた、予測できた理由でビルド・テスト・lint をやり直した、sandbox や認証で止まった、skill や AGENTS.md の指示が曖昧・誤りで手戻りした、CLI の使い方を調べ直した。文書はあったが見つけにくかった場合も含む。
- 記録しない: 変更対象のコードを理解するための探索、TDD の意図した失敗、自分のバグを直す通常の反復、一度きりの打ち間違い、無駄が 3 回未満のツール呼び出し。
- 1 回の作業で多くても 3 件まで。コストの大きい順に選ぶ。

| kind | 内容 |
| --- | --- |
| `knowledge` | 文書にあれば読むだけで済んだ事実 |
| `failure` | 予測できた理由でのビルド・テスト・lint・format のやり直し |
| `environment` | sandbox・権限・認証・ネットワーク・dev shell |
| `instruction` | skill・AGENTS.md・依頼文の曖昧さ・誤り・見つけにくさ |
| `tooling` | CLI の使い方の誤り |

| cost | 無駄の目安 |
| --- | --- |
| `low` | ツール呼び出し 3〜5 回、または短い再実行 1 回 |
| `mid` | 6〜20 回、全体テストの再実行、数分の待ち |
| `high` | 20 回超、再実行の繰り返し、人間の判断待ち、方針の放棄 |

## 手順

1. 既存の項目を探す。語は 1〜3 個に絞る。

   ```bash
   agtask friction search <語>... --json
   ```

2. 同じ問題があれば発生を追記する。

   ```bash
   agtask friction hit FR-9 --as "$NAME" --cost mid --steps 8 \
     --basis "pnpm test を実行して 15 分待った後、package.json で filter を知った"
   ```

3. 無ければ作る。`--fact` には、文書にそのまま書ける一文を書く。自分で確かめた事実だけを書き、推測は書かない。

   ```bash
   agtask friction add "hub のテストを対象を絞って実行する方法" --as "$NAME" \
     --kind knowledge --cost mid --steps 8 --scope hub --target hub/AGENTS.md \
     --fact "hub の単体テストは pnpm --filter hub test。ルートの pnpm test は全 repo を流し 15 分かかる。" \
     --basis "pnpm test を実行して 15 分待った後、package.json で filter を知った"
   ```

- `--as` は、herdr の子なら承認済みの名前、それ以外は CLI 名（`claude`、`codex`）を使う。agtask のタスクがあれば `--task <ID>`、分かればモデル名を `--model` に付ける。
- `--target` は直すべき場所の案。毎回読まれる短い事実は repo の AGENTS.md、長い手順は `docs/`、skill の誤りは `skill:<name>` と書く。

## 秘匿

`--fact` と `--basis` には、トークン、secret、個人情報、本番の値を書かない。エラーは要旨だけを書き、ログを貼らない。

## 記録できないとき

`NOT_INITIALIZED`、`DB_ACCESS`、`agtask` が無い、のいずれかなら、記録を諦める。sandbox の無効化や書込許可の追加で回避しない。
代わりに、最終報告の末尾に「friction（未記録）」として、kind・title・fact・cost・basis を箇条書きで残す。

## 報告

記録した FR-ID を最終報告に書く。herdr-orchestrate の子なら、submit の summary の残件に書く。

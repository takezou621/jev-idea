# docs/08 — MVP セットアップ手順（#27）

docs/07 の検証対象プロジェクト（第一対象: **jev-mcp 自身**）で MVP を使い始めるまでの
手順。配線（`.mcp.json`・`.claude/settings.json`・`.github/workflows/jev-observe.yml`）は
リポジトリ同梱済みのため、する作業は **build・キー登録・動作確認** に集約される。
使い始めてからの運用は docs/07「実使用期間と手順」（この文書の「対応表」節に要約）。

「使い始めるまでの摩擦」は検証対象（docs/07 の付随データ）。手順どおり実施した
所要時間は docs/07 の指示どおり **#27 の PR に記録する**。

## 前提

- Node.js 22 LTS・npm（GitHub Actions と同じ版）
- 判定には `TYPESAFE_API_KEY`（実判定）。未設定でも各配線は fail-open で止まらないが、
  判定は `status: "failed"` になり observe 記録は積めない（docs/06 契約）。
  キーなしで動作を確認する方法は付録 A（開発用スタブ）
- 「新規環境」とは、このリポジトリを新しく clone した直後の状態を指す
- CLI は `node packages/core/dist/bin/<名前>.js` 形式で実行する（PATH には入らない）

## 手順

### 1. clone と build

```sh
git clone https://github.com/takezou621/jev-mcp
cd jev-mcp
npm ci
npm run build --workspace=@jev/core
```

`packages/core/dist/bin/` に `jev-judge.js`（判定 MCP サーバー）・`jev-observe.js`
（PR 判定 (a)・CI 用）・`jev-stop.js`（Stop フック CLI）・`jev-review.js`
（tp/fp 分類）ができる。

### 2. 環境変数（ローカル判定用 — **フック起動の前に**）

`TYPESAFE_API_KEY` をシェル環境に置く（`.zshrc` 等に `export` してから、この
リポジトリで Claude Code を起動する）。jev-judge・jev-observe・jev-stop はすべて
親プロセスの環境を継承して起動するため、**キー設定より前にセッションを開始していた
場合は、キー設定後にセッションを再起動する**。判定の実行口は jev-judge に 1 か所
に集約されるため、設定する変数はこの 1 つだけ。

### 3. jev-judge 登録（同梱済み — 確認のみ）

リポジトリルートの `.mcp.json` が jev-judge を登録する。Claude Code では、この
リポジトリを開いて MCP サーバーの使用を承認すれば登録完了。goose では
`goose configure` の extensions に同じコマンドを登録する（docs/06「登録手順」）。

### 4. Stop フック設定（同梱済み — 確認のみ）

`.claude/settings.json` が Stop 時に `jev-stop` CLI を起動する（timeout 300 秒・
fail-open。observe 中は実 block しない）。設定の変更は不要。

### 5. CI observe 配線（同梱済み — secret のみ）

`.github/workflows/jev-observe.yml` が `.ts`・`packages/core` 配下・workflow 自体に
触れる PR で自動実行される。イベントは `pull_request_target`（workflow 定義は
常に main 側）で、判定の道具（CLI・jev-judge）は base branch（trusted revision）
から build し、PR コードは build・実行せず evidence 素材（diff・使用箇所・
定義ファイル）としてのみ使う（#44。secret `TYPESAFE_API_KEY` が PR コードや
PR 由来の workflow 定義に渡る経路がない）。GitHub リポジトリの **Settings →
Secrets and variables → Actions** に `TYPESAFE_API_KEY` を登録する。未登録でも
workflow は緑になるが、summary に「判定に失敗」が載り observe 記録は積めない。
fork PR は job がスキップされて緑になる（外部由来の diff に実キーを使わない）。

### 6. 動作確認（examples/age）

`examples/age/README.md` の手順に従い、Stop フックの即時フィードバックを確認する:

1. **通る変更**: `examples/age/sample.ts` にコメント 1 行を足してターンを終える →
   `systemMessage` に「diff が触れたアサーション: adult-age」と判定 summary が
   表示される（summary に載るのは criterion の verdict と action。
   p・confidence は出ない）
2. **would-block になる変更**: `register` に検証を通らない経路を足してターンを終える →
   summary が表示され、would-block（本来の reason）は判定ログに記録される
   （observe 中は止まらない。人間は判定ログの reason を読んで tp/fp を分類する）
3. **クリーン**: 変更を戻してターンを終える → 何も表示されない（判定も走らない）

CI observe は `.ts` または `packages/core` 配下に触れる PR で自動実行される。
`--base origin/main` の判定対象は
**コミット済み diff**（CI と同じ `<base>...HEAD`）。未コミット変更
（`git diff HEAD`）を判定するのは Stop フックの担当で、両者とも jev-judge 経由の
同一判定ポイントが走る。API キーなしでこの一巡を確認する手順は付録 A。

## 使い始め — docs/07 実使用手順との対応

| docs/07 の手順 | やること | 使うもの |
|---|---|---|
| 1. セットアップ | この文書の手順 1〜6。所要時間を #27 の PR に書く（docs/07 DoD） | — |
| 2. 通常どおり開発 | 特別な作業はしない。Stop フック・CI が自動で判定する | — |
| 3. tp/fp 分類と体感タグ | would-block のたび、**人間が**分類する。体感タグは `--feeling ok\|annoy\|ignore` で付ける（ok=納得 / annoy=邪魔 / ignore=無関心。未指定の再分類では前の feeling を引き継ぐ） | `node packages/core/dist/bin/jev-review.js list --dir <log-dir>` → `… <番号> tp\|fp\|unclear [--feeling ok\|annoy\|ignore] [メモ] --dir <log-dir>` |
| 4. 定性メモ | 「これがないと困る / 困った」場面をそのつど記録する | `jev-review` のメモ欄（または #28 の定性メモ） |
| 5. 週次サマリ | 件数と内訳（tp/fp・体感内訳 — 体感を**記録した**介入のうち「邪魔」の割合を含む）と所要時間（docs/07 R2 の p95・failed 数）を確認する | `node packages/core/dist/bin/jev-review.js report --dir <log-dir>`（prefix 別の feeling 内訳・latency 集計付き。#28 で整備済みの実行口） |

log-dir の所在:

- **ローカル判定**（Stop フック・付録 A の一巡）: 既定 `~/.jev/logs`
  （`JEV_LOG_DIR`・`--log-dir` で上書き）。`reviews.jsonl` も同じ場所に残る
- **CI 判定（実 PR）**: workflow が artifact `jev-observe-logs` として保存する。
  PR ページからダウンロードして展開し、`--dir <展開先>` で分類する
  （artifact は 30 日で失効するため、分類は早めに。#28 で運用に合わせて整備）。
  artifact はリポジトリの読み取り権限者が取得できる（public リポジトリでは
  事実上誰でも）。そのため判定ログには機密（キー等）を含めない前提で
  workflow が組まれている

注意:

- tp/fp 分類・体感タグ・定性メモは**人間の作業**（docs/07「実使用は人間が行う」）。
  エージェントは記録を埋め合わせしない（AGENTS.md の誠実さのルール）
- `jev-review list` の番号は list 実行時点の並び。分類までの間に判定ログが
  増えると番号がずれるため、ref 直指定（`jev-YYYY-MM-DD.jsonl:<行番号>`）も可
- tp と分類した事例はゴールデン化の材料になる（`jev-golden`・docs/05）
- 判定ログと `reviews.jsonl` は 0700/0600 で残る。リポジトリには入れない。
  p が運用上出てくる場所はこのログと上記の artifact のみ（ホスト出力には出ない）

## 付録 A — API キーなしでの動作確認（開発用スタブ）

実キーのない環境（CI 検証・初回お試し）では、プロバイダを開発用スタブに向ける:

```sh
node packages/core/scripts/dev-stub-api.mjs 8787   # 別ターミナル
export TYPESAFE_BASE_URL=http://127.0.0.1:8787
unset TYPESAFE_API_KEY   # 実キーを設定済みの場合は解除する（スタブにキーを送らない）
```

スタブの既定 answers は criteria `completion` のみで、PR 判定 (a) の criteria
（`bypass`・`basis-consistency`・`input-path`）は**回答欠落（unknown）になる** —
迂回変更でも would-block にはならず、summary に「unknown → escalate」の事実が
載る。would-block の一巡を試すには answers を渡す（下記 A-1）。
実判定・実 PR での observe 記録には手順 2・5 のキー登録が必要。

### A-1. observe 判定 → tp/fp 記録 → レポートの一巡（ローカル検証用）

CI の PR 判定 (a) と同じ条件を API キーなしで通す手順。**スモーク用の分離ブランチ
（または worktree）で行う** — 既存の作業ブランチに迂回変更を commit すると、
`--base origin/main` からの差分に無関係な `.ts` 変更まで判定対象に混ざる。
`--base origin/main` の判定対象はコミット済み diff のため、observe 判定は変更を
**commit してから**実行する:

```sh
# 0. スタブを answers 付きで起し直す（付録 A 本体で起したスタブがある場合は
#    停止してから — 同じポート 8787 を使うため重複起動は失敗する）
cat > /tmp/jev-smoke-answers.json <<'EOF'
{
  "bypass": { "type": "noul", "noul": 0.9 },
  "basis-consistency": { "type": "noul", "noul": 0.7 },
  "input-path": { "type": "noul", "noul": 0.1 }
}
EOF
node packages/core/scripts/dev-stub-api.mjs 8787 /tmp/jev-smoke-answers.json

# 1. 判定（docs/08 手順 6.2 の迂回変更を examples/age/sample.ts に commit しておく）
export TYPESAFE_BASE_URL=http://127.0.0.1:8787
node packages/core/dist/bin/jev-observe.js --base origin/main --log-dir /tmp/jev-smoke
# → summary に「diff が触れたアサーション」と判定 summary（p は出ない）

# 2. would-block の確認と tp/fp 分類（docs/07 手順 3。分類は人間の作業。
#    --feeling は体感タグ（ok=納得 / annoy=邪魔 / ignore=無関心））
node packages/core/dist/bin/jev-review.js list --dir /tmp/jev-smoke
node packages/core/dist/bin/jev-review.js <番号> tp --feeling annoy --dir /tmp/jev-smoke <メモ>

# 3. レポート（docs/07 手順 5）
node packages/core/dist/bin/jev-review.js report --dir /tmp/jev-smoke
```

Stop フック（未コミット変更 `git diff HEAD` の判定）を単独で確認する場合は、
迂回変更を commit せずに残したまま実行する:

```sh
echo "{\"cwd\":\"$PWD\"}" | node packages/core/dist/bin/jev-stop.js --log-dir /tmp/jev-smoke
# → {"systemMessage": ...}（未コミットの迂回変更で出る。クリーンなら出力なし・exit 0）
```

検証後はスタブの向きを解除する（残すと実判定が停止済みスタブに飛ぶ）:

```sh
unset TYPESAFE_BASE_URL
```

判定ログと `reviews.jsonl` は `--log-dir` に 0700/0600 で残る。

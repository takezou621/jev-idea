# 6. ホスト統合 — MCP サーバー化とエージェント組み込み

各アイデアの判定資産を、エージェントホスト（Claude Code、goose、その他 MCP クライアント）
から利用できる形にする。「判定はどこで行われ、誰がアクションを実行するか」を固定する
のがこの設計の目的である。

## 原則

1. **判定と決定は MCP サーバー側、実行はホスト側**。docs/05 の 2 層構造（回答層・
   判定層）をサーバー内で完結させ、ツールの返り値は構造化されたアクション
   （pass / block / warn / escalate）のみにする。回答確率 p をホストの LLM に
   渡さない —— LLM が「p = 0.7 だから通そう」と再解釈する入り口を塞ぐ
   （jev-claude の「中間帯の断定」罠のホスト版防止）
2. **fail-open はツールの契約**。Jev 不通時、jev-judge は `status: "failed"` と
   failMode に従うアクションを構造化して返し、ホストはフローを止めない（docs/05
   のフェイルオープン原則の MCP 版）
3. **evidence はパス参照を基本にする**。生データ（diff、コード、ログ）を会話経由で
   LLM に転写させない。サーバーがリポジトリ内のパスを読む。転写ミスと機密の
   二次送出の経路を同時に断つ
4. **収集はアダプタで吸収**。ホストごとの生ログ・フック形式の差分は、共通イベント
   スキーマ（docs/02）への**決定的な変換（アダプタ）**にだけ閉じ込める。解釈
   （Jev 分類）はホスト非依存のままにする

## MCP サーバー構成

| サーバー | ツール | 担当する設計 |
|---|---|---|
| `jev-judge` | `judge` | docs/05 の判定レイヤー。全アイデアの判定ポイントの実行口 |
| `thought-graph` | `thoughts_for`, `explain_with_evidence` | docs/02（docs/02 どおり。ホスト非依存になる） |
| `jev-fork`（将来） | `fork`, `attach` | docs/03。本体は CLI が主で、MCP 化は後回し |

### jev-judge のツール契約

```jsonc
// judge の入力
{
  "point": "req-assertion-a",        // 登録済み JudgmentPoint の id（docs/05 の型）
  "evidence": {
    "kind": "paths",                 // paths が基本。inline は小さいもののみ
    "paths": ["requirements/user.req.ts", ".jev/work/pr-123.patch"]
  },
  "opts": { "budgetMs": 5000, "repeats": 1 }
}

// judge の出力
{
  "status": "judged",
  "action": { "kind": "block", "reason": "検証を迂回する経路 3 箇所" },
  "summary": "質問 1 で迂回を検出。質問 2・3 は未確定（人間確認対象）"
}
```

- `point` の実体（criteria・evidence 組立て・decision）はサーバーに登録済みの
  JudgmentPoint 定義。ホストは id を選んで呼ぶだけ
- `reason` は事実のみ（docs/05 の契約どおり）。判定語をホストの LLM に撒かない
- `summary` に p を含めない。p は判定ログ（0700/0600）で人間のみが見る

実装上の確定事項（#5）:

- 出力は `{status, action, summary}` の 3 キーのみ（structuredContent と
  content[0].text に同一内容）。p・confidence・answers は出力のどこにも現れない。
  Issue #5 の DoD 記載の `status: "error"` は docs/05・06 の `status: "failed"`
  を正とする（docs/05 の型に合わせる）
- `summary` は宣言済み criterion の verdict（true/false/unknown）と action のみ。
  例: `synth-open: completion=false → block`。failed 時は
  `判定点id: 判定に失敗 (理由)。failMode <mode> に従い <action> を返す`
- **evidence のマージ規則**: サーバーは point.evidence() を 1 回呼んで base を
  取り、呼び出し evidence を **data に追記**する（`meta: base.meta,
  data: [...base.data, ...呼び出し分]`）。meta の組立ては point 定義のみが行い、
  呼び出し側からは meta を受け取らない。生テキストはそのまま（加工・要約なし）で
  state に入る
- paths: サーバーが readFileSync で読む。section の `source` にパス、
  `sourceTime` に mtime（ISO 8601）を残す。存在しないパス・非ファイルは入力エラー
- **evidence root（paths の読み取り範囲）**: realpath 解決（symlink 実体）のうえ、
  evidence root 配下のパスのみ読める（docs/06 原則 3 の「リポジトリ内のパス」の
  実装。ホスト LLM 指定の任意パス — .env・~/.ssh 等 — から機密を読み外部 API に
  送出する経路を閉じる）。root は `JEV_EVIDENCE_ROOT` 環境変数で変更可、
  既定はサーバーの cwd。1 ファイル 1,048,576 バイト（1 MiB）超も入力エラー
- inline: 1 セクション 4096 文字上限。超過は入力エラー
- **既定予算・repeats 上限**: `opts.budgetMs` 未指定時の総予算は 120000 ms
  （1 件の遅い判定が stdio ループ全体を専有しないため）。`opts.repeats` は
  1〜5 の整数
- **isError のセマンティクス**: 入力不正（未知 point・evidence root 外のパス・
  上限超過・不正 opts）は `isError: true` のツール結果。judge の失敗
  （`status: "failed"` + failMode に従う action）は契約どおりの正常な結果なので
  isError を立てない
- failed 時 `summary` のエラー部分は空白正規化 + 200 文字丸め（生応答本文に p が
  混入しうる出水口を狭くする）。エラー全文は判定ログ（0700/0600）で人間のみが見る
- 判定ログは `label: "mcp"` で記録される（`jev-review` のレポートで mcp グループに
  分離される）

### 登録手順（配線）

- **Claude Code**: リポジトリルートの `.mcp.json`（本リポジトリに同梱）:
  `{"mcpServers": {"jev-judge": {"command": "node", "args": ["packages/core/dist/bin/jev-judge.js"]}}}`。
  事前に `packages/core` で `npm run build` が必要
- **goose**: `goose configure` の extensions で stdio MCP サーバーとして同じ
  コマンドを登録する。recipe 経由で使う場合は recipe の `extensions` に書く
- プロバイダは `TYPESAFE_API_KEY`（未設定なら `TYPESAFE_BASE_URL` をスタブに向けて
  検証する。両方未設定でもサーバーは起動し、判定は `status: "failed"` +
  failMode に従う action になる）

### 定義は 1 か所、ホスト差分は配線だけ

判定ポイント定義（質問・しきい値・decision）をホストごとに変えない。変えると
ゴールデンと tp/fp 分類がホストごとに分裂する。ホスト差分があるのは配線だけ:

| 配線点 | Claude Code | goose |
|---|---|---|
| 判定の呼び出し | MCP ツール呼び出し（エージェント・フックから） | MCP ツール呼び出し（エージェント・recipe から） |
| 収集（docs/02） | PostToolUse → claude-code アダプタ | PostToolUse 相当フック → goose アダプタ |
| closed ゲート（機密） | PreToolUse（deny） | PreToolUse（exit code で deny） |
| ループ系（docs/04） | スキル / エージェント | recipe |

**注**: goose のフックのイベント種別とペイロードの正確な仕様は本設計時点で一部
未確認（PreToolUse の deny（exit code）と PostToolUse 相当の存在まで確認）。
設計はアダプタ層で差分を吸収する前提なので、種別の差はアダプタの実装詳細に
留まり、判定側の設計には波及しない。実装時に公式ドキュメントで確定する。

## goose への組み込み

- **extensions 登録**: jev-judge と thought-graph を stdio MCP サーバーとして
  `goose configure`（または config.yaml）に登録する。MCP クライアントであれば
  Claude Code 向けに作ったサーバーがそのまま動く
- **recipe で docs/04 の双対ループを実装する**:
  - 提案者と反証者は subrecipe（または別セッション）に分離
  - 審判は recipe の手順内で jev-judge を呼ぶ。recipe の指示文に「返ってきた
    action に従う」と明記する（p は返ってこない構造なので、再解釈の余地が
    構造的に無い）
- **hooks**: PreToolUse に機密ゲート（docs/02 判定 C・docs/03 判定 (a) 相当、
  closed）を配線し、PostToolUse 相当に収集（docs/02）を配線する
- distro 化（jev 系 extension を内蔵した goose の配布）は将来検討

## Claude Code への組み込み

既存設計のとおり:

- docs/01: CI（GitHub Actions）+ Stop フックの即時フィードバック
- docs/02: PostToolUse 収集 + thought-graph MCP 参照
- docs/04: スキル / エージェントでループ + jev-judge
- jev-claude の資産（transcript.mjs、jev-lib.mjs）を直接再利用する

## アダプタ層

```
[claude-code アダプタ]        [goose アダプタ]
  transcript.jsonl              セッションログ
  PostToolUse(Edit diff)        PostToolUse 相当(diff)
        │                             │
        └──→ 共通イベントスキーマ（docs/02 のイベント） ←──┘
                        │
            正規化（決定的）→ Jev 分類（ホスト非依存）→ 思考グラフ
```

- アダプタは「ホストの生ログ → イベント」の**決定的な変換のみ**。判断を含まない
- 取れないイベントは「取れない」でよい（docs/02 の unclear を捨てない原則と同じ
  形）。欠落を解釈層に流さない
- アダプタのテストはホストの実出力をフィクスチャ化して行う（仕様が版で変わる
  ため、実データでの回帰を持つ）

## 実装計画

docs/05 の Phase 0 に 0-5 / 0-6 を追加する形:

| ステップ | 内容 | 完了条件 |
|---|---|---|
| 0-1 〜 0-4 | docs/05 どおり（jev-lib.mjs の一般化、メタ分離、多数決 + observe、ゴールデン） | docs/05 の完了条件どおり |
| 0-5 | jev-judge MCP サーバー化（stdio） | Claude Code と goose の両方から同一 point・同一 evidence で同一 action が返る（同一ゴールデンを 2 ホストで通す） |
| 0-6 | goose アダプタ（収集）の最小実装 | goose セッションからイベント列が取れ、docs/02 の正規化に流せる |

Phase 2（docs/02）の完了条件に「goose から thought-graph を登録し参照できる」を
加える。docs/04 の recipe 化は Phase 1 の 1-2（ループ配線）で行う。

## リスクと罠

| 罠 | この設計での出現形 | 対処 |
|---|---|---|
| ホスト LLM による p の再解釈 | ツールが p を返すと「0.7 だから通す」等の二次判断が起きる | p を返さない。action のみを返す |
| evidence の会話経由転写 | LLM が diff を読み要約してツールに渡すと、転写ミスと機密漏出が起きる | evidence は paths 参照が基本。inline は小さいもののみ |
| recipe への判定語混入 | recipe の指示文に「違反を見つけたら止めろ」等を書くと審判が汚染される（overview 原則 4 の recipe 版） | 指示文は手順のみ。判定語は JudgmentPoint の criteria にのみ書く |
| ホストごとのしきい値調整 | 「goose ではうまく動かないから」等の理由でしきい値を変えるとゴールデンが分裂する | 定義は 1 か所。変えるなら jev-core 側で変え、両ホストで同じゴールデンを回す |
| フック仕様の揺れ | goose のフック種別・ペイロードは版で変わる可能性がある | アダプタ層に閉じ込める。アダプタの回帰はホスト実出力のフィクスチャで行う |

## 検証方法

- **両ホスト同一判定**: jev-judge を Claude Code / goose の両方から同一呼び出しし、
  docs/05 のゴールデンと同一の action が返ること。実 API を叩かない検証では
  `TYPESAFE_BASE_URL` を開発用スタブ（`packages/core/scripts/dev-stub-api.mjs`、
  `POST /v1/systemone` に固定 answers を返す）に向ける:
  1. `node packages/core/scripts/dev-stub-api.mjs 8787`（既定 answers は block 側）
  2. `TYPESAFE_BASE_URL=http://127.0.0.1:8787` を付けて jev-judge を両ホストに登録
  3. 同一 point（例: `synth-open`）・同一 evidence で両ホストから judge を呼び、
     返ってきた action が一致することを確認する（0-5 の完了条件）
- **recipe 完走**: goose の recipe で docs/04 のループが収束まで完走すること
- **closed ゲート**: PreToolUse deny で機密ゲートが goose でも作動すること
- **正直な限界**: goose の recipe / hooks の正確な文法・種別は本設計時点で一部
  未確認（上記の注）。ツール契約とアダプタ層を先に固めておくことで、仕様差は
  吸収可能な範囲に限定される

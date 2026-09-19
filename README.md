# jev-mcp

## 概要

Jev（TypeSafe AI の判定専用モデル）を判定エンジンとして、開発の「手のリズムを止める
原因」を断つ 4 つのツールを設計・実装するリポジトリ。ツールは **MCP サーバー /
エージェント配線**として提供し、Claude Code・goose など MCP クライアントの
エージェントから直接使える形を目指す。

判定の実行と決定はホスト側（LLM）に置かない。MCP サーバー側の共通判定レイヤー
jev-core に閉じ、ホストには構造化されたアクション（pass / block / warn / escalate）の
みを返す。回答確率 p はホストに渡らない —— 確率の解釈を LLM のその場の判断に任せると
判定が再現できなくなるためである（docs/05、docs/06）。

| # | アイデア | 何を Jev に委ねるか | エージェントへの提供形 | 設計書 |
|---|---|---|---|---|
| 1 | 要件アサーション駆動開発 | 宣言と実装の整合、要件自体の妥当性 | CI（GitHub Actions）+ フック + jev-judge | [docs/01-requirement-assertions.md](docs/01-requirement-assertions.md) |
| 2 | 思考ログ（思考差分）の同期 | イベントの分類・集約、説明文の裏取り | thought-graph MCP サーバー | [docs/02-thought-graph.md](docs/02-thought-graph.md) |
| 3 | インスタント・フォーク | 機密の有無、復元の再現性 | 独立 CLI（`snapper` / `jev fork`）。fork/attach の MCP 化は将来 | [docs/03-instant-fork.md](docs/03-instant-fork.md) |
| 4 | コードとテストの双対自動生成 | 反例の審判、テスト強度、収束判定 | recipe（goose）/ スキル（Claude Code）+ jev-judge | [docs/04-dual-generation.md](docs/04-dual-generation.md) |

## 目的

コードを書く時間そのものではなく、その周辺 —— 仕様漏れのレビュー往復、文脈を探す
時間、環境の再現、テストの重複記述 —— が開発のリズムを壊す。4 つのアイデアはいずれも
これらを**判定に変換**して Jev に委ねる。設計の軸は 2 つ:

1. **決定的に済む部分は機械で扱う**: 構造検証、PBT ジェネレータ生成、変異テスト、
   依存グラフの特定など。Jev に聞かない
2. **意味の判断だけを Jev に委ねる**: 宣言と実装の整合、イベントの分類、機密の有無、
   収束の判定。しきい値で決めきれない境界は人間へエスカレーションする（仕様であり、
   手抜きではない）

この分け方が効く根拠は、姉妹リポジトリ
[jev-claude](https://github.com/takezou621/jev-claude) の実測にある（Jev のレイテンシ
中央値 584ms・判定 1 回 $0.000067 未満・境界で block/pass が振れる不安定さ・
確率を二値に潰す場所がすべて誤判定の入り口になること）。本リポジトリはその知見を
継承する。

## ゴール

測定可能な完了条件（詳細は各設計書の実装計画）:

- **判定基盤**: Claude Code と goose の両方から、同一 point・同一 evidence で
  同一 action が返る（docs/06 0-5）
- **アイデア 4**: 仕様 DSL から双対ループが収束まで自動完走し、曖昧さが質問として
  人間に届く（docs/04 1-4）
- **アイデア 2**: 「なぜこの実装か」への回答が証拠付きで出て、生成説明の
  ハルシネーションを捕捉する（docs/02 2-4）
- **アイデア 1**: 実 PR で observe 判定を積み、fp 率を測定した上で block を
  有効化できる（docs/01 3-2/3-3）
- **アイデア 3**: サンプルアプリでバグ発生 → 記録 → ローカルリプレイが動き、
  同一シードのリプレイ応答が一致する（docs/03 4-0）

着手順は判定基盤（Phase 0）を最初に、判定が本質でインフラ要らずの 4 → 2 → 1 → 3
の順。ロードマップ全体は
[docs/00-overview.md](docs/00-overview.md) を参照。

## 設計書

ホスト統合の設計（MCP サーバー構成、jev-judge のツール契約、アダプタ層、goose
組み込み）は [docs/06-host-integration.md](docs/06-host-integration.md) に、
全体像と共通の設計原則は [docs/00-overview.md](docs/00-overview.md) に、共通判定
レイヤー jev-core の設計（judge() インターフェース、確率の確定規則、メタ分離
プロトコル）は [docs/05-jev-core.md](docs/05-jev-core.md) にまとめている。

## 構成（予定）

```
jev-mcp/
├── README.md
├── docs/            # 設計書（現状ここが本体）
└── packages/        # 実装フェーズで追加
    ├── core/           # 共通判定レイヤー（jev-core）→ jev-judge MCP サーバー
    ├── thought-graph/  # 思考グラフ収集・参照 → thought-graph MCP サーバー
    ├── dual/           # 双対ループ（recipe / CLI）
    └── adapters/       # ホスト収集アダプタ（claude-code / goose）
```

## ライセンス

MIT

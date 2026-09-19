# jev-mcp

Jev（TypeSafe AI の判定専用モデル）を判定エンジンとして、開発の「手のリズムを止める
原因」を断つ 4 つのツールを設計・実装するリポジトリ。ツールは **MCP サーバー /
エージェント配線**として提供し、Claude Code・goose など MCP クライアントの
エージェントから直接使える形を目的とする。

解く問題は共通している。コードを書く時間そのものではなく、その周辺 —— 仕様漏れの
レビュー往復、文脈を探す時間、環境の再現、テストの重複記述 —— が開発のリズムを壊す。
4 つのアイデアはいずれも、これらを**判定に変換**して Jev に委ねる。判定の実行と決定は
ホスト側（LLM）に置かず、MCP サーバー側の jev-core に閉じる（docs/06）。

| # | アイデア | 何を Jev に委ねるか | エージェントへの提供形 | 設計書 |
|---|---|---|---|---|
| 1 | 要件アサーション駆動開発 | 宣言と実装の整合、要件自体の妥当性 | CI（GitHub Actions）+ フック + jev-judge | [docs/01-requirement-assertions.md](docs/01-requirement-assertions.md) |
| 2 | 思考ログ（思考差分）の同期 | イベントの分類・集約、説明文の裏取り | thought-graph MCP サーバー | [docs/02-thought-graph.md](docs/02-thought-graph.md) |
| 3 | インスタント・フォーク | 機密の有無、復元の再現性 | 独立 CLI（`snapper` / `jev fork`）。fork/attach の MCP 化は将来 | [docs/03-instant-fork.md](docs/03-instant-fork.md) |
| 4 | コードとテストの双対自動生成 | 反例の審判、テスト強度、収束判定 | recipe（goose）/ スキル（Claude Code）+ jev-judge | [docs/04-dual-generation.md](docs/04-dual-generation.md) |

ホスト統合の設計（MCP サーバー構成、jev-judge のツール契約、アダプタ層、goose
組み込み）は [docs/06-host-integration.md](docs/06-host-integration.md) に、
全体像と共通の設計原則は [docs/00-overview.md](docs/00-overview.md) に、共通判定
レイヤー jev-core の設計（judge() インターフェース、確率の確定規則、メタ分離
プロトコル）は [docs/05-jev-core.md](docs/05-jev-core.md) にまとめている。
設計の前提となる実測知見（Jev のレイテンシ・コスト・境界の不安定さ、確率回答を二値に
潰す場所が誤判定の入り口になること）は姉妹リポジトリ
[jev-claude](https://github.com/takezou621/jev-claude) で確定済みであり、本リポジトリは
それを継承する。

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

実装の着手順は overview のロードマップを参照（結論: Phase 0 = jev-core の共通基盤と
MCP サーバー化 → 4 → 2 → 1 → 3。判定ループが本質でインフラ要らずの 4 から着手し、
フック資産を再利用する 2、型システム設計が重い 1、OS レベル技術の検証が要る 3 の順）。

## ライセンス

MIT

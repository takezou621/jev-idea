/**
 * jev-core の実不変条件の宣言（docs/01 層 1）。
 * 値の由来は docs/05・docs/06。実装側の使用箇所（mcp/jev-judge.ts・log.ts）と
 * の整合は PR 判定 (a) が守る —— 宣言と実装がズレた diff は block/warn 対象
 */
import { require } from "../assertions/dsl.js";

/** judge ツール多数決の試行回数（docs/05「多数決」・実装側 MAX_REPEATS=5） */
export const JudgeRepeats = require.number("judge-repeats", {
  within: [1, 5],
  basis: "多数決の試行回数は 1〜5 回。上限 5 はコストと予算の飽和防止のための実装上限（MAX_REPEATS）と同値",
  basisRef: { type: "doc", path: "docs/05-jev-core.md" },
  severity: "business",
});

/** inline evidence 1 セクションの上限文字数（docs/06 原則 3・実装側 INLINE_MAX_CHARS=4096） */
export const InlineSectionChars = require.number("inline-section-chars", {
  within: [1, 4096],
  basis: "inline evidence は 1 セクション 4KB 上限。転写ミスと機密の二次送出を防ぐため、大きいものは paths で渡す",
  basisRef: { type: "doc", path: "docs/06-host-integration.md" },
  severity: "business",
});

/** paths で読める 1 ファイルの上限バイト数（docs/06 原則 3・実装側 PATHS_MAX_BYTES=1MiB） */
export const PathsMaxBytes = require.number("paths-max-bytes", {
  within: [1, 1048576],
  basis: "paths で読める 1 ファイルは 1MiB 上限。判定対象の生データとしては十分大きく、過読の経路を閉じる",
  basisRef: { type: "doc", path: "docs/06-host-integration.md" },
  severity: "business",
});

/** 判定ログ 1 日分ファイルの命名規約（docs/05 判定ログ仕様・jev-YYYY-MM-DD.jsonl） */
export const LogFileName = require.pattern("log-file-name", {
  pattern: "^jev-[0-9]{4}-[0-9]{2}-[0-9]{2}\\.jsonl$",
  basis: "判定ログは日次ファイル jev-YYYY-MM-DD.jsonl に追記する（ディレクトリ 0700 / ファイル 0600）。日跨ぎで新ファイルに切り替わる",
  basisRef: { type: "doc", path: "docs/05-jev-core.md" },
  severity: "business",
});

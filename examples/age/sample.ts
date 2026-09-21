/**
 * jev Stop フック（#21）の動作確認サンプル — 「宣言 + 検証 + 使用」の最小構成。
 * 宣言（AdultAge）と使用（register）を 1 ファイルに置き、どちらを変更しても
 * Stop フックが「アサーション adult-age に触れた変更」として検出する。
 *
 * このファイルはコンパイル対象外（touched 検出が ts-morph で AST を直接読む）。
 * 実行手順・違反変更の作り方は同ディレクトリの README.md
 */
import { compileAssertion, type TypeOf } from "../../packages/core/src/assertions/compile.js";
import { require } from "../../packages/core/src/assertions/dsl.js";

/** 宣言: 成年（18〜99）のみ登録できる（docs/01 層 1 のサンプル定義） */
export const AdultAge = require.number("adult-age", {
  within: [18, 99],
  basis: "規約第 3 条: 本サービスは 18 歳以上 99 歳以下を対象とする",
  basisRef: { type: "doc", path: "docs/terms.md", section: "3" },
  severity: "legal",
});

/** 使用: この型を通った値だけが register から流れる意図 */
export type RegisteredAge = TypeOf<typeof AdultAge>;

/** 検証器（docs/01 層 1。境界外の値は violation を返す） */
const checkAdultAge = compileAssertion(AdultAge);

/**
 * 使用箇所（判定 (a) の検出対象）。この関数を変更して Stop すると、フックは
 * 事実として「diff が触れたアサーション: adult-age」と両判定の結果を表示する。
 * 違反変更の例（README 手順 2）: `if (age >= 100) return age;` のように
 * checkAdultAge を通らない経路をこの関数に足す
 */
export function register(age: number): RegisteredAge {
  const violation = checkAdultAge(age);
  if (violation !== null) throw new Error(violation.message);
  return age;
}

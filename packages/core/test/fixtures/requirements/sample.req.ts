/**
 * docs/01 層 1 のサンプル（実装計画 3-1 の DoD「サンプル型がコンパイルされ、
 * 検証器が境界値で弾く」の対象）。このファイルが typecheck（tsconfig.test.json
 * が test 配下を include）でコンパイルされること自体が DoD の 1 半分。
 * 検証器での境界値確認は assertions-compile.test.ts が行う
 */
import type { CheckedBy, TypeOf } from "../../../src/assertions/compile.js";
import { require } from "../../../src/assertions/dsl.js";

export const AdultAge = require.number("adult-age", {
  within: [18, 99],
  basis: "規約第 3 条: 本サービスは 18 歳以上 99 歳以下を対象とする",
  basisRef: { type: "doc", path: "docs/terms.md", section: "3" },
  severity: "legal",
});

export const EmployeeId = require.pattern("employee-id", {
  pattern: "[A-Z]{2,}-\\d{4,}",
  flags: "i",
  basis: "社員番号は接頭辞 2 文字以上 + ハイフン + 4 桁以上の番号",
  basisRef: { type: "doc", path: "docs/hr.md" },
  severity: "business",
  checkedBy: ["EmployeeIdCheck"],
});

export type User = {
  age: TypeOf<typeof AdultAge> & CheckedBy<"LegalCheck">;
};

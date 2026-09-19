/**
 * アサーション検証器生成（docs/01 層 1・#17 PR 2 の DoD 1 件目）。
 * - DoD: サンプル型がコンパイルされ、検証器が境界値で弾く
 *   （コンパイル = tsconfig.test.json が test/fixtures/requirements/sample.req.ts を
 *   typecheck。検証器 = このファイルの境界値テスト）
 *
 * Jev は呼ばない・ネットワークなし（決定的な構造検証のみ）
 */
import { describe, expect, it } from "vitest";
import { compileAssertion } from "../src/assertions/compile.js";
import type { CheckedBy, TypeOf } from "../src/assertions/compile.js";
import { require } from "../src/assertions/dsl.js";
import { AdultAge, EmployeeId, type User } from "./fixtures/requirements/sample.req.js";

describe("compileAssertion — within-range（境界値で弾く）", () => {
  const isAdult = compileAssertion(AdultAge);

  it("境界外（17・100）を弾き、境界値（18・99）と中央を通す", () => {
    expect(isAdult(17)).toMatchObject({ id: "adult-age", kind: "below-min", message: expect.stringContaining("below the minimum 18") });
    expect(isAdult(100)).toMatchObject({ id: "adult-age", kind: "above-max", message: expect.stringContaining("above the maximum 99") });
    expect(isAdult(18)).toBeNull();
    expect(isAdult(99)).toBeNull();
    expect(isAdult(50)).toBeNull();
  });

  it("数値でない値（文字列・NaN）を弾く。エラー文は事実のみ", () => {
    expect(isAdult("18")).toMatchObject({ kind: "not-a-number" });
    expect(isAdult(NaN)).toMatchObject({ kind: "not-a-number" });
    expect(isAdult(null)).toMatchObject({ kind: "not-a-number" });
    // 判定語（違反・迂回等）を含まない
    expect(isAdult(17)!.message).not.toContain("違反");
  });

  it("範囲を変えた定義からは別の境界を持つ検証器ができる", () => {
    const def = require.number("driver-age", {
      within: [16, 80],
      basis: "運転免許の取得年齢 16 歳以上",
      basisRef: { type: "doc", path: "docs/rules.md" },
      severity: "legal",
    });
    const isDriver = compileAssertion(def);
    expect(isDriver(15)).toMatchObject({ id: "driver-age", kind: "below-min" });
    expect(isDriver(16)).toBeNull();
    // 15 は driver（min 16）では境界外だが、adult（min 18）でも弾かれる — 別の検証器
    expect(isDriver(17)).toBeNull();
    expect(isAdult(15)).toMatchObject({ id: "adult-age", kind: "below-min" });
  });
});

describe("compileAssertion — pattern", () => {
  const isEmployeeId = compileAssertion(EmployeeId);

  it("パターンに合わない文字列を弾き、合う文字列を通す。flags も効く", () => {
    expect(isEmployeeId("AB-1234")).toBeNull();
    // flags: "i" — 小文字でも通る
    expect(isEmployeeId("ab-1234")).toBeNull();
    expect(isEmployeeId("ab1234")).toMatchObject({ id: "employee-id", kind: "pattern-mismatch" });
    expect(isEmployeeId("AB-12")).toMatchObject({ kind: "pattern-mismatch" });
  });

  it("文字列でない値を弾く", () => {
    expect(isEmployeeId(1234)).toMatchObject({ kind: "not-a-string" });
  });

  it("未検証の定義（入れ子量指定子）は compile で落とす（JSON 経路のすり抜け防止）", () => {
    expect(() =>
      compileAssertion({
        id: "bad",
        kind: "pattern",
        pattern: "((a+))+",
        basis: "根拠",
        basisRef: { type: "doc", path: "docs/x.md" },
        severity: "style",
      }),
    ).toThrow(/unvalidated/);
  });

  it("検証を通った構文不正のパターンは id 付きのエラーになる（生の SyntaxError を外に出さない）", () => {
    // "(" は validateAssertionDef の対象外（構文検査はしない）で RegExp 生成時に落ちる
    expect(() =>
      compileAssertion({
        id: "broken-paren",
        kind: "pattern",
        pattern: "(",
        basis: "根拠",
        basisRef: { type: "doc", path: "docs/x.md" },
        severity: "style",
      }),
    ).toThrow(/invalid pattern for assertion broken-paren/);
  });
});

describe("型レベル DSL（TypeOf・CheckedBy — コンパイルは typecheck が担う）", () => {
  it("サンプル型の検証器が境界値で弾く（DoD）", () => {
    // fixture（docs/01 例）から生成した検証器で境界を確認
    expect(compileAssertion(AdultAge)(17)).toMatchObject({ kind: "below-min" });
    expect(compileAssertion(AdultAge)(18)).toBeNull();
    expect(compileAssertion(EmployeeId)("ab-1234")).toBeNull();
  });

  it("TypeOf と CheckedBy が値として使える（ユーザー型の宣言どおり）", () => {
    // docs/01 例: age: TypeOf<typeof AdultAge> & CheckedBy<"LegalCheck">
    const user: User = { age: 20 };
    const age: TypeOf<typeof AdultAge> & CheckedBy<"LegalCheck"> = user.age;
    expect(age).toBe(20);
    expect(compileAssertion(AdultAge)(user.age)).toBeNull();
  });
});

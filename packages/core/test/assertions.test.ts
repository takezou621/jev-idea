/**
 * アサーション DSL — 構造部分（docs/01・#17 PR 1 の DoD）。
 * - DoD: basis なし・未 quote の basisRef がエラーになる（モジュール読み込み時 =
 *   ビルダー呼び出し時点で落ちる。docs/01「DSL がコンパイルエラーにする」）
 * - DoD: ReDoS 上限テスト（入れ子量指定子の検出・pattern 長・flags・定義サイズ）
 *
 * Jev は呼ばない（最重要原則 1 — 決定的な構造検証）。ネットワークなし・実 API なし
 */
import { describe, expect, it } from "vitest";
import {
  hasNestedQuantifier,
  MAX_DEF_JSON_BYTES,
  MAX_PATTERN_LENGTH,
  validateAssertionDef,
  type AssertionDef,
  type DefValidationError,
} from "../src/assertions/validate.js";
import { require } from "../src/assertions/dsl.js";

const DOC_REF = { type: "doc", path: "docs/01-requirement-assertions.md", section: "データモデル" } as const;
const URL_REF = { type: "url", path: "https://laws.e-gov.go.jp/law/417AC0000000120", quote: "成年に達した者は…" } as const;

describe("validateAssertionDef — basis・basisRef（DoD: 根拠のない定義はエラー）", () => {
  it("有効な within-range 定義はエラーなし", () => {
    const errors = validateAssertionDef({
      id: "adult-age",
      kind: "within-range",
      within: [18, 99],
      basis: "成年年齢 18 歳以上を扱うため",
      basisRef: DOC_REF,
      severity: "legal",
    });
    expect(errors).toEqual([]);
  });

  it("basis なし（欠落・空文字・空白のみ）はエラーになる", () => {
    const missing = validateAssertionDef({
      id: "adult-age",
      kind: "within-range",
      within: [18, 99],
      basis: undefined as unknown as string,
      basisRef: DOC_REF,
      severity: "legal",
    });
    expect(missing.map((e) => e.path)).toContain("basis");
    for (const basis of ["", "   "]) {
      const errors = validateAssertionDef({
        id: "adult-age",
        kind: "within-range",
        within: [18, 99],
        basis,
        basisRef: DOC_REF,
        severity: "legal",
      });
      expect(errors.map((e) => e.path)).toContain("basis");
    }
  });

  it("url の basisRef に固定引用 quote がないとエラー（CI は URL を fetch しない）", () => {
    const noQuote = validateAssertionDef({
      id: "adult-age",
      kind: "within-range",
      within: [18, 99],
      basis: "根拠",
      basisRef: { type: "url", path: "https://example.com/law", quote: undefined as unknown as string },
      severity: "legal",
    });
    expect(noQuote.map((e) => e.path)).toContain("basisRef.quote");
    const emptyQuote = validateAssertionDef({
      id: "adult-age",
      kind: "within-range",
      within: [18, 99],
      basis: "根拠",
      basisRef: { type: "url", path: "https://example.com/law", quote: " " },
      severity: "legal",
    });
    expect(emptyQuote.map((e) => e.path)).toContain("basisRef.quote");
  });

  it("url の basisRef に quote があれば通る", () => {
    const errors = validateAssertionDef({
      id: "adult-age",
      kind: "within-range",
      within: [18, 99],
      basis: "根拠",
      basisRef: URL_REF,
      severity: "legal",
    });
    expect(errors).toEqual([]);
  });

  it("doc の basisRef はリポジトリ相対のみ。絶対パス・.. での外出はエラー", () => {
    for (const path of ["/etc/passwd", "../outside.md", "a/../../b.md"]) {
      const errors = validateAssertionDef({
        id: "x",
        kind: "pattern",
        pattern: "a+",
        basis: "根拠",
        basisRef: { type: "doc", path },
        severity: "style",
      });
      expect(errors.map((e) => e.path)).toContain("basisRef.path");
    }
    expect(validateAssertionDef({
      id: "x",
      kind: "pattern",
      pattern: "a+",
      basis: "根拠",
      basisRef: { type: "doc", path: "docs/01.md" },
      severity: "style",
    })).toEqual([]);
  });

  it("basisRef の type が doc でも url でもない・basisRef 欠落もエラー", () => {
    const badType = validateAssertionDef({
      id: "x",
      kind: "pattern",
      pattern: "a+",
      basis: "根拠",
      basisRef: { type: "book", path: "a" } as unknown as never,
      severity: "style",
    });
    expect(badType.map((e) => e.path)).toContain("basisRef.type");
    const missing = validateAssertionDef({
      id: "x",
      kind: "pattern",
      pattern: "a+",
      basis: "根拠",
      basisRef: undefined as unknown as never,
      severity: "style",
    });
    expect(missing.map((e) => e.path)).toContain("basisRef");
  });
});

describe("validateAssertionDef — 構造（kind・severity・within・サイズ）", () => {
  it("severity は legal | business | style のみ", () => {
    for (const ok of ["legal", "business", "style"] as const) {
      const errors = validateAssertionDef({ id: "x", kind: "pattern", pattern: "a+", basis: "根拠", basisRef: DOC_REF, severity: ok });
      expect(errors).toEqual([]);
    }
    const bad = validateAssertionDef({
      id: "x",
      kind: "pattern",
      pattern: "a+",
      basis: "根拠",
      basisRef: DOC_REF,
      severity: "critical" as unknown as "legal",
    });
    expect(bad.map((e) => e.path)).toContain("severity");
  });

  it("within は数値ペアで min < max", () => {
    const reversed = validateAssertionDef({ id: "x", kind: "within-range", within: [99, 18], basis: "根拠", basisRef: DOC_REF, severity: "legal" });
    expect(reversed.map((e) => e.path)).toContain("within");
    const notNumbers = validateAssertionDef({
      id: "x",
      kind: "within-range",
      within: "18-99" as unknown as [number, number],
      basis: "根拠",
      basisRef: DOC_REF,
      severity: "legal",
    });
    expect(notNumbers.map((e) => e.path)).toContain("within");
  });

  it("定義 JSON が上限を超えるとエラー（MAX_DEF_JSON_BYTES）", () => {
    const big: AssertionDef = {
      id: "x",
      kind: "pattern",
      pattern: "a+",
      basis: "根拠" + "あ".repeat(MAX_DEF_JSON_BYTES),
      basisRef: DOC_REF,
      severity: "style",
    };
    const errors = validateAssertionDef(big);
    expect(errors.some((e) => e.message.includes(`${MAX_DEF_JSON_BYTES} bytes`))).toBe(true);
  });
});

describe("ReDoS 上限（docs/01「ReDoS 的な定義」の対処）", () => {
  const def = (pattern: string): AssertionDef => ({ id: "x", kind: "pattern", pattern, basis: "根拠", basisRef: DOC_REF, severity: "style" });
  const paths = (errors: DefValidationError[]) => errors.map((e) => e.path);

  it("入れ子量指定子 ((a+)+ 形) は validateAssertionDef でエラー", () => {
    expect(paths(validateAssertionDef(def("(a+)+")))).toContain("pattern");
    expect(paths(validateAssertionDef(def("(?:a+)+")))).toContain("pattern");
    expect(paths(validateAssertionDef(def("(a*b*)*c")))).toContain("pattern");
    expect(paths(validateAssertionDef(def("(x{2,5}){3}")))).toContain("pattern");
    // 量指定子を含む内側グループを持つ外側グループの quantify も同じ危険形
    expect(paths(validateAssertionDef(def("((a+))+")))).toContain("pattern");
    expect(paths(validateAssertionDef(def("(x(a+))+")))).toContain("pattern");
    // 有界でも保守的に拒否する（簡易検査の意図。緩めるならこの行とテストを直す）
    expect(paths(validateAssertionDef(def("(a+){2}")))).toContain("pattern");
  });

  it("hasNestedQuantifier: 危険な形は true、平たいパターンは false", () => {
    expect(hasNestedQuantifier("(a+)+")).toBe(true);
    expect(hasNestedQuantifier("(?:a+)+")).toBe(true);
    expect(hasNestedQuantifier("(a*)*")).toBe(true);
    expect(hasNestedQuantifier("(a+b)+")).toBe(true);
    expect(hasNestedQuantifier("((a+)?b)+")).toBe(true);
    expect(hasNestedQuantifier("((a+))+")).toBe(true);
    expect(hasNestedQuantifier("(x(a+))+")).toBe(true);
    // 平たい・繰り返しなしは安全側
    expect(hasNestedQuantifier("a+b+")).toBe(false);
    expect(hasNestedQuantifier("[a-z]+\\d*")).toBe(false);
    expect(hasNestedQuantifier("(a+b)c")).toBe(false);
    expect(hasNestedQuantifier("(a)b(c)")).toBe(false);
  });

  it("hasNestedQuantifier: グループ修飾子の ? は量指定子と数えない", () => {
    expect(hasNestedQuantifier("(?:abc)+")).toBe(false);
    expect(hasNestedQuantifier("(?<y>\\d)+")).toBe(false);
    expect(hasNestedQuantifier("(?<=a)b+")).toBe(false);
    expect(hasNestedQuantifier("(?!-)[a-z]+")).toBe(false);
    // 修飾子付きグループの中身がネストしている場合は検出する
    expect(hasNestedQuantifier("(?:a+)+")).toBe(true);
    expect(hasNestedQuantifier("(?<y>(?:a+))+")).toBe(true);
  });

  it("hasNestedQuantifier: 文字クラス内とエスケープは無視する", () => {
    expect(hasNestedQuantifier("[a+]+")).toBe(false);
    expect(hasNestedQuantifier("a\\+b")).toBe(false);
    expect(hasNestedQuantifier("(\\+)+")).toBe(false);
    expect(hasNestedQuantifier("[[]+")).toBe(false);
  });

  it("pattern 長の上限（MAX_PATTERN_LENGTH）", () => {
    const ok = validateAssertionDef(def("a".repeat(MAX_PATTERN_LENGTH)));
    expect(ok).toEqual([]);
    const over = validateAssertionDef(def("a".repeat(MAX_PATTERN_LENGTH + 1)));
    expect(paths(over)).toContain("pattern");
    expect(over[0]!.message).toContain(String(MAX_PATTERN_LENGTH));
  });

  it("flags は状態を持つ g/m/y を許さない。i / u / v は可", () => {
    for (const bad of ["g", "m", "y", "gi"]) {
      const errors = validateAssertionDef({ id: "x", kind: "pattern", pattern: "a", flags: bad, basis: "根拠", basisRef: DOC_REF, severity: "style" });
      expect(errors.map((e) => e.path)).toContain("flags");
    }
    for (const good of ["i", "u", "v", "iu"]) {
      const errors = validateAssertionDef({ id: "x", kind: "pattern", pattern: "a", flags: good, basis: "根拠", basisRef: DOC_REF, severity: "style" });
      expect(errors).toEqual([]);
    }
    // u と v は併用不可（new RegExp が SyntaxError になるため検証で落とす）
    const uv = validateAssertionDef({ id: "x", kind: "pattern", pattern: "a", flags: "uv", basis: "根拠", basisRef: DOC_REF, severity: "style" });
    expect(uv.map((e) => e.path)).toContain("flags");
  });

  it("JSON 経路の型不正を黙って通さない（null・within 長・checkedBy）", () => {
    // 検証器は total。JSON.parse の結果が null でも TypeError を投げず 1 件のエラー
    for (const bad of [null, undefined, "x", 42]) {
      const errors = validateAssertionDef(bad as unknown as AssertionDef);
      expect(errors).toEqual([{ path: "definition", message: expect.stringContaining("must be an object") }]);
    }
    const longWithin = validateAssertionDef({
      id: "x",
      kind: "within-range",
      within: [18, 99, 100] as unknown as [number, number],
      basis: "根拠",
      basisRef: DOC_REF,
      severity: "legal",
    });
    expect(longWithin.map((e) => e.path)).toContain("within");
    const badCheckedBy = validateAssertionDef({
      id: "x",
      kind: "pattern",
      pattern: "a",
      basis: "根拠",
      basisRef: DOC_REF,
      severity: "style",
      checkedBy: 5 as unknown as string[],
    });
    expect(badCheckedBy.map((e) => e.path)).toContain("checkedBy");
    const goodCheckedBy = validateAssertionDef({ id: "x", kind: "pattern", pattern: "a", basis: "根拠", basisRef: DOC_REF, severity: "style", checkedBy: ["LegalCheck"] });
    expect(goodCheckedBy).toEqual([]);
  });

  it("within の境界: min === max はエラー、min+1 は通る", () => {
    const equal = validateAssertionDef({ id: "x", kind: "within-range", within: [18, 18], basis: "根拠", basisRef: DOC_REF, severity: "legal" });
    expect(equal.map((e) => e.path)).toContain("within");
    const adjacent = validateAssertionDef({ id: "x", kind: "within-range", within: [17, 18], basis: "根拠", basisRef: DOC_REF, severity: "legal" });
    expect(adjacent).toEqual([]);
  });
});

describe("require ビルダー（docs/01「DSL がコンパイルエラーにする」）", () => {
  it("docs/01 例の形で書けて、検証済み定義が返る", () => {
    const def = require.number("adult-age", {
      within: [18, 99],
      basis: "成年年齢 18 歳以上を扱うため",
      basisRef: DOC_REF,
      severity: "legal",
      checkedBy: ["LegalCheck"],
    });
    expect(def).toEqual({
      id: "adult-age",
      kind: "within-range",
      within: [18, 99],
      basis: "成年年齢 18 歳以上を扱うため",
      basisRef: DOC_REF,
      severity: "legal",
      checkedBy: ["LegalCheck"],
    });
  });

  it("basis なしはビルダー呼び出し時点で throw する（モジュール読み込みで落ちる = コンパイルエラー相当）", () => {
    expect(() =>
      require.number("adult-age", {
        within: [18, 99],
        basis: undefined as unknown as string,
        basisRef: DOC_REF,
        severity: "legal",
      }),
    ).toThrow(/basis/);
  });

  it("未 quote の url basisRef も throw。エラー文に原因が全部入る", () => {
    expect(() =>
      require.pattern("sig", {
        pattern: "(a+)+",
        basis: "署名の書式",
        basisRef: { type: "url", path: "https://example.com/spec" } as unknown as never,
        severity: "business",
      }),
    ).toThrow(/quote/);
    expect(() =>
      require.pattern("sig", {
        pattern: "(a+)+",
        basis: "署名の書式",
        basisRef: DOC_REF,
        severity: "business",
      }),
    ).toThrow(/nested quantifier/);
    expect(() =>
      require.pattern("sig", {
        pattern: "a",
        flags: "g",
        basis: "署名の書式",
        basisRef: DOC_REF,
        severity: "business",
      }),
    ).toThrow(/flag/);
  });
});

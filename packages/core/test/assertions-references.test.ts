/**
 * アサーション定義シンボル → 使用箇所の決定的逆引き（docs/01 判定 (a) の機械部分・
 * #17 PR 2）。ts-morph の in-memory SourceFile で走査ロジックを確認する
 * （実際のリポジトリ走査・Project 組み立ては判定 (a) 配線 = #18 の範囲）。
 *
 * Jev は呼ばない・ネットワークなし
 */
import { describe, expect, it } from "vitest";
import { Project, type SourceFile } from "ts-morph";
import { findAssertionUsages } from "../src/assertions/references.js";

function projectWith(files: Record<string, string>): SourceFile[] {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, content] of Object.entries(files)) {
    project.createSourceFile(path, content);
  }
  return project.getSourceFiles();
}

const REQ = `export const AdultAge = require.number("adult-age", { within: [18, 99] });\n`;

describe("findAssertionUsages — 使用箇所の特定（docs/01 判定 (a) の機械部分）", () => {
  it("import 節と宣言そのものは数えず、関数内の使用を enclosing 付きで返す", () => {
    const sources = projectWith({
      "/req/sample.req.ts": REQ,
      "/user.ts": `import { AdultAge } from "./req/sample.req.js";\nexport function registerUser(age: number) { return check(AdultAge, age); }\n`,
    });
    const usages = findAssertionUsages(sources, "AdultAge");
    expect(usages).toEqual([
      { file: "/user.ts", symbol: "AdultAge", enclosing: "registerUser", enclosingKind: "function" },
    ]);
  });

  it("クラスメソッド内の使用は enclosingKind: method", () => {
    const sources = projectWith({
      "/req/sample.req.ts": REQ,
      "/user.ts": `import { AdultAge } from "./req/sample.req.js";\nexport class UserService {\n  validate(age: number) { return check(AdultAge, age); }\n}\n`,
    });
    expect(findAssertionUsages(sources, "AdultAge")).toEqual([
      { file: "/user.ts", symbol: "AdultAge", enclosing: "validate", enclosingKind: "method" },
    ]);
  });

  it("トップレベル変数（arrow 関数）での使用は enclosingKind: variable", () => {
    const sources = projectWith({
      "/req/sample.req.ts": REQ,
      "/user.ts": `import { AdultAge } from "./req/sample.req.js";\nconst checkAge = (v: number) => check(AdultAge, v);\n`,
    });
    expect(findAssertionUsages(sources, "AdultAge")).toEqual([
      { file: "/user.ts", symbol: "AdultAge", enclosing: "checkAge", enclosingKind: "variable" },
    ]);
  });

  it("同一関数内の複数回使用は複数件。別シンボルは引かない", () => {
    const sources = projectWith({
      "/req/sample.req.ts": REQ,
      "/user.ts": `import { AdultAge, Other } from "./req/sample.req.js";\nconst Other = 1;\nexport function f(x: number) { return check(AdultAge, x) || check(AdultAge, x) || Other === Other; }\n`,
    });
    const usages = findAssertionUsages(sources, "AdultAge");
    expect(usages).toHaveLength(2);
    expect(usages.every((u) => u.enclosing === "f" && u.enclosingKind === "function")).toBe(true);
    // import 節と宣言（const Other = 1）は使用と数えない。関数内の 2 回の使用のみ
    expect(findAssertionUsages(sources, "Other")).toEqual([
      { file: "/user.ts", symbol: "Other", enclosing: "f", enclosingKind: "function" },
      { file: "/user.ts", symbol: "Other", enclosing: "f", enclosingKind: "function" },
    ]);
  });

  it("使用箇所が無いシンボルは空配列（定義変更時の使用箇所一覧が空なら表示も空）", () => {
    const sources = projectWith({ "/req/sample.req.ts": REQ, "/unrelated.ts": `export const x = 1;\n` });
    expect(findAssertionUsages(sources, "AdultAge")).toEqual([]);
  });

  it("既知の限界: エイリアス import（X as Y）経由の使用は検出できない（偽陰性を固定）", () => {
    // JSDoc の限界どおり。#18 の呼び出し側はこの漏れを前提に evidence を組む
    const sources = projectWith({
      "/req/sample.req.ts": REQ,
      "/user.ts": `import { AdultAge as AA } from "./req/sample.req.js";\nexport function f(age: number) { return check(AA, age); }\n`,
    });
    expect(findAssertionUsages(sources, "AdultAge")).toEqual([]);
  });

  it("既知の限界: プロパティ名（obj.X・型リテラルの X）は使用と数える（偽陽性を固定）", () => {
    // 識別子テキスト照合のため、値の使用でない次の 2 つも数えてしまう:
    //   - 型リテラル { AdultAge: number } のプロパティ名
    //   - プロパティアクセス obj.AdultAge のプロパティ名
    const sources = projectWith({
      "/req/sample.req.ts": REQ,
      "/user.ts": `import { AdultAge } from "./req/sample.req.js";\nexport function f(obj: { AdultAge: number }): number { return obj.AdultAge; }\n`,
    });
    const usages = findAssertionUsages(sources, "AdultAge");
    expect(usages).toHaveLength(2);
    expect(usages.every((u) => u.enclosing === "f")).toBe(true);
  });
});

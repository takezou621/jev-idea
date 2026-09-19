/**
 * diff が触れるアサーションの決定的特定（docs/01 判定 (a)・#18）。
 * ts-morph の in-memory SourceFile で走査ロジックを確認する
 * （実リポジトリの Project 組み立ては配線 = jev-observe CLI の範囲）。
 *
 * Jev は呼ばない・ネットワークなし（決定的な特定のみ）
 */
import { describe, expect, it } from "vitest";
import { Project, type SourceFile } from "ts-morph";
import { extractAssertionDefs, findTouchedAssertions } from "../src/assertions/touched.js";

function projectWith(files: Record<string, string>): SourceFile[] {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, content] of Object.entries(files)) {
    project.createSourceFile(path, content);
  }
  return project.getSourceFiles();
}

const REQ = `import { require } from "./dsl.js";\nexport const AdultAge = require.number("adult-age", { within: [18, 99] });\nexport const EmployeeId = require.pattern("employee-id", { pattern: "[A-Z]+\\\\d+" });\nexport const NotAssertion = 1;\n`;

describe("extractAssertionDefs — 定義シンボルの抽出", () => {
  it("require.number / require.pattern の変数宣言から symbol と id を抽出する。非 DSL 宣言は数えない", () => {
    const sources = projectWith({ "/req/sample.req.ts": REQ });
    expect(extractAssertionDefs(sources[0]!)).toEqual([
      { symbol: "AdultAge", id: "adult-age", file: "/req/sample.req.ts" },
      { symbol: "EmployeeId", id: "employee-id", file: "/req/sample.req.ts" },
    ]);
  });

  it("公開名 requireAssertion のビルダー呼び出しも抽出する（index.ts の export 名。require と同一形）", () => {
    const sources = projectWith({
      "/x.ts": `import { requireAssertion } from "./index.js";\nconst a = requireAssertion.number("adult-age", { within: [18, 99] });\nconst b = requireAssertion.pattern("employee-id", { pattern: "[A-Z]+\\\\d+" });\n`,
    });
    expect(extractAssertionDefs(sources[0]!)).toEqual([
      { symbol: "a", id: "adult-age", file: "/x.ts" },
      { symbol: "b", id: "employee-id", file: "/x.ts" },
    ]);
  });

  it("既知の限界: require / requireAssertion 以外のビルダー名・文字列リテラルでない第一引数は抽出できない", () => {
    const sources = projectWith({
      "/x.ts": `import { assertions } from "./dsl.js";\nconst a = assertions.number("adult-age", {});\nconst b = require.pattern(idFromConfig(), {});\nconst c = require.other("x", {});\n`,
    });
    expect(extractAssertionDefs(sources[0]!)).toEqual([]);
  });

  it("既知の限界: 同名シンボルの別定義は id の帰属を区別できない（触れた方ではない id も含まれる。過検出方向）", () => {
    const sources = projectWith({
      "/a.req.ts": `import { require } from "./dsl.js";\nexport const AdultAge = require.number("adult-age", {});\n`,
      "/b.req.ts": `import { require } from "./dsl.js";\nexport const AdultAge = require.number("senior-age", {});\n`,
      "/user.ts": `import { AdultAge } from "./b.req.js";\nexport function f(v: number) { return check(AdultAge, v); }\n`,
    });
    const touched = findTouchedAssertions(sources, ["/user.ts"]);
    expect(touched.map((t) => t.id).sort()).toEqual(["adult-age", "senior-age"]);
  });
});

describe("findTouchedAssertions — 変更ファイルとの交差", () => {
  it("使用箇所のあるファイルが変更ファイルに含まれるアサーションを返す。usages は変更ファイル内の分だけ", () => {
    const sources = projectWith({
      "/req/sample.req.ts": REQ,
      "/user.ts": `import { AdultAge, EmployeeId } from "./req/sample.req.js";\nexport function register(age: number) { return check(AdultAge, age); }\nexport function emp(e: string) { return check(EmployeeId, e) || check(EmployeeId, e); }\n`,
      "/other.ts": `import { AdultAge } from "./req/sample.req.js";\nexport function legacy(v: number) { return check(AdultAge, v); }\n`,
    });
    const touched = findTouchedAssertions(sources, ["/user.ts"]);
    expect(touched).toHaveLength(2);
    expect(touched.map((t) => t.id).sort()).toEqual(["adult-age", "employee-id"]);
    const adult = touched.find((t) => t.id === "adult-age")!;
    expect(adult.symbol).toBe("AdultAge");
    expect(adult.defFile).toBe("/req/sample.req.ts");
    expect(adult.usages).toEqual([{ file: "/user.ts", symbol: "AdultAge", enclosing: "register", enclosingKind: "function" }]);
    const emp = touched.find((t) => t.id === "employee-id")!;
    expect(emp.usages).toHaveLength(2);
  });

  it("変更ファイルに使用箇所が無ければ空配列（定義ファイルのみの変更も結果に現れない。判定 (b) は #20 の範囲）", () => {
    const sources = projectWith({
      "/req/sample.req.ts": REQ,
      "/user.ts": `import { AdultAge } from "./req/sample.req.js";\nexport function register(age: number) { return check(AdultAge, age); }\n`,
    });
    expect(findTouchedAssertions(sources, ["/req/sample.req.ts"])).toEqual([]);
    expect(findTouchedAssertions(sources, ["/unrelated.ts"])).toEqual([]);
  });

  it("同一ファイル内の無関係な変更にも反応する（ファイルレベルの粗い近似。偽陽性方向に倒れる設計）", () => {
    const sources = projectWith({
      "/req/sample.req.ts": REQ,
      "/user.ts": `import { AdultAge } from "./req/sample.req.js";\nexport function register(age: number) { return check(AdultAge, age); }\nexport function unrelated() { return 1; }\n`,
    });
    expect(findTouchedAssertions(sources, ["/user.ts"])).toHaveLength(1);
  });

  it("エイリアス import 経由の使用は検出できない（findAssertionUsages と同じ限界。呼び出し側の evidence 前提）", () => {
    const sources = projectWith({
      "/req/sample.req.ts": REQ,
      "/user.ts": `import { AdultAge as AA } from "./req/sample.req.js";\nexport function f(v: number) { return check(AA, v); }\n`,
    });
    expect(findTouchedAssertions(sources, ["/user.ts"])).toEqual([]);
  });
});

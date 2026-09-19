/**
 * diff が触れるアサーションの決定的特定（docs/01 判定 (a)「特定のみ・判定ではない」）。
 *
 * 定義シンボル抽出 → findAssertionUsages による使用箇所 → 変更ファイルとの交差。
 * 依存グラフによる到達判定の第 1 段階は「使用箇所のあるファイルが diff にある」
 * のファイルレベル（docs/01「ファイル・シンボルの依存グラフ」の粗い近似。
 * 使用箇所を含む関数自体が無変更でも同一ファイル内の変更に反応する偽陽性方向に
 * 倒れる — observe 段階では検出漏れより過検出が安全）。判定は Jev が行い、
 * ここは事実の列挙のみ（最重要原則 1・2）
 */
import { Node, type CallExpression, type SourceFile, type VariableDeclaration } from "ts-morph";
import { findAssertionUsages, type AssertionUsage } from "./references.js";

export type AssertionDefSymbol = {
  /** 定義シンボル（`export const AdultAge = ...` の AdultAge） */
  symbol: string;
  /** DSL に渡った定義 id（`require.number("adult-age", ...)` の "adult-age"） */
  id: string;
  /** 定義ファイル（ts-morph Project に渡したパス） */
  file: string;
};

export type TouchedAssertion = {
  id: string;
  symbol: string;
  defFile: string;
  /** 変更ファイル内にある使用箇所（生の列挙。整形は呼び出し側） */
  usages: AssertionUsage[];
};

/**
 * 1 ファイルからアサーション定義シンボルを抽出する（決定的）。
 * 対象は `const <name> = require.number("<id>", ...)` / `require.pattern(...)`
 * （公開名 `requireAssertion` の同形も同じ）の変数宣言。
 *
 * 既知の限界（識別子テキスト照合ベース。findAssertionUsages と同系列）:
 * - `require` / `requireAssertion` 以外の名前（エイリアス import 等）からの
 *   ビルダー呼び出しは抽出できない
 * - 変数宣言以外（オブジェクトプロパティ・配列要素への格納）の定義は抽出できない
 * - 同名シンボルが複数ファイルで別定義（id 違い）のとき、定義ファイルを
 *   区別できないため、触れた方ではない id も touched に入る（過検出方向）
 */
export function extractAssertionDefs(source: SourceFile): AssertionDefSymbol[] {
  const out: AssertionDefSymbol[] = [];
  source.forEachDescendant((node) => {
    if (!Node.isVariableDeclaration(node)) return;
    const def = defFromDeclaration(node, source.getFilePath());
    if (def !== undefined) out.push(def);
  });
  return out;
}

function defFromDeclaration(decl: VariableDeclaration, file: string): AssertionDefSymbol | undefined {
  const init = decl.getInitializer();
  if (init === undefined || !Node.isCallExpression(init)) return undefined;
  const builder = builderCall(init);
  if (builder === undefined) return undefined;
  const first = init.getArguments()[0];
  if (first === undefined || !Node.isStringLiteral(first)) return undefined;
  return { symbol: decl.getName(), id: first.getLiteralText(), file };
}

/**
 * `require.number(...)` / `require.pattern(...)` のみ受ける（それ以外は undefined）。
 * レシーバは公開名 `requireAssertion` も許す（index.ts の export 名。これを
 * 狭めると標準的な import 形式の定義が黙って抽出されない — 検出漏れ方向）。
 * それ以外の名前（エイリアス import 等）は既知の限界として抽出しない
 */
const BUILDER_RECEIVERS = new Set(["require", "requireAssertion"]);

function builderCall(call: CallExpression): "number" | "pattern" | undefined {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return undefined;
  if (!BUILDER_RECEIVERS.has(expr.getExpression().getText())) return undefined;
  const name = expr.getName();
  return name === "number" || name === "pattern" ? name : undefined;
}

/**
 * 全ソースから触れたアサーションを特定する（決定的）。
 * changedFiles は usage.file と同一形式・同一解像度のパス集合（完全一致で照合。
 * 呼び出し側が git 相対パスを sources のパス形式へ解決する）。
 * 使用箇所の無いシンボル・定義ファイルのみの変更は結果に現れない
 * （定義変更の判定は docs/01 判定 (b) = Issue #20 の範囲）
 */
export function findTouchedAssertions(sources: readonly SourceFile[], changedFiles: readonly string[]): TouchedAssertion[] {
  const changed = new Set(changedFiles);
  const defs = sources.flatMap(extractAssertionDefs);
  const out: TouchedAssertion[] = [];
  for (const def of defs) {
    const usages = findAssertionUsages(sources, def.symbol).filter((u) => changed.has(u.file));
    if (usages.length === 0) continue;
    out.push({ id: def.id, symbol: def.symbol, defFile: def.file, usages });
  }
  return out;
}

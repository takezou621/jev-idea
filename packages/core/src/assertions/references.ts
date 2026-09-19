/**
 * アサーション定義シンボル → 使用箇所の決定的逆引き（docs/01 判定 (a)・#17 PR 2）。
 *
 * docs/01「アサーション定義のシンボル → 使用箇所を ts-morph で逆引きし、
 * 使用箇所を含む関数・クラスへの diff の到達を依存グラフで見る」の機械部分
 * （特定のみ・判定ではない）。docs/01「正直な限界」の緩和策
 * 「定義変更時の使用箇所一覧の強制表示」でも使う。判断・分類を含まず、
 * Jev は呼ばない（最重要原則 1）
 *
 * モノレポのみ対応（docs/01「別リポジトリ問題」— 定義と使用箇所が別リポジトリの
 * 場合は依存グラフが途切れる。将来課題）
 */
import { Node, SyntaxKind, type Identifier, type SourceFile } from "ts-morph";

export type AssertionUsage = {
  /** 使用箇所のあるファイル（ts-morph Project に渡したパス） */
  file: string;
  symbol: string;
  /** 使用を囲む関数・クラス・メソッド・変数宣言の名前（無ければ null） */
  enclosing: string | null;
  enclosingKind: "function" | "class" | "method" | "variable" | null;
};

/**
 * sources 内で symbolName の識別子が使われている箇所を列挙する。
 * import 節と宣言そのもの（`export const X = ...` の X）は使用と数えない。
 * 戻り値は使用の生の列挙（同一関数内で複数回使われれば複数件）。整形は呼び出し側
 *
 * 既知の限界（識別子テキスト照合ベースの簡易検査。docs/01「特定のみ・判定ではない」
 * の範囲で型解決はしない）:
 * - エイリアス import（`import { X as Y }` 経由の使用）は検出できない（偽陰性）
 * - 同名の無関係なローカル・同名プロパティ（`obj.X`）は使用と数える（偽陽性）
 * - 再 export 文（`export { X } from ...`）は使用 1 件として数える
 *
 * 呼び出し側（#18 の判定 (a) 配線）はこれを網羅した逆引きとみなさず、
 * evidence にこの限界を含めて扱うこと（検出漏れ → レビュー対象から抜ける方向に倒れるため）
 */
export function findAssertionUsages(sources: readonly SourceFile[], symbolName: string): AssertionUsage[] {
  const usages: AssertionUsage[] = [];
  for (const source of sources) {
    source.forEachDescendant((node) => {
      if (!Node.isIdentifier(node) || node.getText() !== symbolName) return;
      if (isDeclarationName(node)) return;
      if (node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) return;
      usages.push({ file: source.getFilePath(), symbol: symbolName, ...describeEnclosing(node) });
    });
  }
  return usages;
}

/** 宣言の名前ノード（const X の X、function X の X 等）は使用ではない */
function isDeclarationName(id: Identifier): boolean {
  const parent = id.getParent();
  if (parent === undefined) return false;
  if ((Node.isVariableDeclaration(parent) || Node.isFunctionDeclaration(parent) || Node.isClassDeclaration(parent) || Node.isMethodDeclaration(parent)) && parent.getNameNode() === id) {
    return true;
  }
  return false;
}

function describeEnclosing(id: Identifier): Pick<AssertionUsage, "enclosing" | "enclosingKind"> {
  const enc = id.getFirstAncestor((n) =>
    Node.isFunctionDeclaration(n) ||
    Node.isClassDeclaration(n) ||
    Node.isMethodDeclaration(n) ||
    Node.isArrowFunction(n) ||
    Node.isFunctionExpression(n),
  );
  if (enc === undefined) {
    const varDecl = id.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    return varDecl === undefined ? { enclosing: null, enclosingKind: null } : { enclosing: varDecl.getName(), enclosingKind: "variable" };
  }
  if (Node.isClassDeclaration(enc)) return { enclosing: enc.getName() ?? null, enclosingKind: "class" };
  if (Node.isMethodDeclaration(enc)) return { enclosing: enc.getName() ?? null, enclosingKind: "method" };
  if (Node.isFunctionDeclaration(enc)) return { enclosing: enc.getName() ?? null, enclosingKind: "function" };
  // arrow / function expression は名前を持たない。代入先の変数名が最も近い事実
  const varDecl = enc.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  return varDecl === undefined ? { enclosing: null, enclosingKind: null } : { enclosing: varDecl.getName(), enclosingKind: "variable" };
}

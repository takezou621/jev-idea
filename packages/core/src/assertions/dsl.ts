/**
 * アサーション定義 DSL のビルダー（docs/01・#17 PR 1）。
 *
 * docs/01 例の `require.number(...)` を実現する。検証（validateAssertionDef）を
 * モジュールの読み込み時点で通し、根拠（basis）のない定義はここで throw する
 * —— docs/01「DSL がコンパイルエラーにする」の実装。実行時検証は CI で
 * validateAssertionDef を一括回すためにも独立公開する
 *
 * 識別子 `require` は @types/node の NodeRequire と衝突しうるため、export 時の
 * リネーム（`export { asserters as require }`）で提供する
 */
import {
  validateAssertionDef,
  type AssertionDef,
  type BasisRef,
  type PatternDef,
  type Severity,
  type WithinRangeDef,
} from "./validate.js";

type Basis = { basis: string; basisRef: BasisRef; severity: Severity; checkedBy?: string[] };

function checked<T extends AssertionDef>(def: T): T {
  const errors = validateAssertionDef(def);
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new Error(`invalid assertion definition (${def.id}): ${detail}`);
  }
  return def;
}

const asserters = {
  /** 数値の範囲（docs/01 例: 成年 18〜99） */
  number(id: string, opts: { within: [number, number] } & Basis): WithinRangeDef {
    return checked({
      id,
      kind: "within-range",
      within: opts.within,
      basis: opts.basis,
      basisRef: opts.basisRef,
      severity: opts.severity,
      ...(opts.checkedBy === undefined ? {} : { checkedBy: opts.checkedBy }),
    });
  },
  /** 正規表現パターン（検証を通った pattern ソースを文字列のまま保持） */
  pattern(id: string, opts: { pattern: string; flags?: string } & Basis): PatternDef {
    return checked({
      id,
      kind: "pattern",
      pattern: opts.pattern,
      ...(opts.flags === undefined ? {} : { flags: opts.flags }),
      basis: opts.basis,
      basisRef: opts.basisRef,
      severity: opts.severity,
      ...(opts.checkedBy === undefined ? {} : { checkedBy: opts.checkedBy }),
    });
  },
};

export { asserters as require };

/**
 * アサーション定義 → ランタイム検証器の生成（docs/01 層 1・#17 PR 2）。
 *
 * docs/01「WithinRange 相当は検証器（実行時に境界値で弾く）と型（ブランド型）の
 * ペアにコンパイルされる」の実装。決定的な部分のみで Jev は呼ばない
 * （最重要原則 1）。compile は validateAssertionDef を通った定義のみ受け付ける
 * （JSON 経路で未検証の定義が検証器をすり抜けない。ReDoS 上限もここで再適用）
 *
 * CheckedBy は docs/01「コンパイラへの過信」罠への対処として、JSDoc に
 * 「宣言であり検証は別」を明示している（LSP ホバーにこれが出る）
 */
import {
  validateAssertionDef,
  type AssertionDef,
  type PatternDef,
  type WithinRangeDef,
} from "./validate.js";

declare const assertionBrand: unique symbol;

/**
 * 定義 id でブランドした型。検証器（compileAssertion）を通った値だけが持つべき型。
 * ブランドは optional のため plain number / string も代入は通る（これは強制ではなく
 * 宣言の整理。実行時の強制は検証器の役割 — 呼び出し側が検証器を通す）
 */
export type TypeOf<D extends AssertionDef> = D extends WithinRangeDef
  ? number & { readonly [assertionBrand]?: D["id"] }
  : D extends PatternDef
    ? string & { readonly [assertionBrand]?: D["id"] }
    : never;

/**
 * 意味の宣言（docs/01 層 2 への逃し口）。
 *
 * **これは宣言であり検証ではない。** この型が付いていても、宣言した意味の検証は
 * Jev 判定（層 2）と人間のレビューで別に行われる。「型が通ったから要件は満たされた」
 * ではない（docs/01「コンパイラへの過信」）。構造検証器が書けない制約だけに使い、
 * 機械で証明できるものは require.number / require.pattern で書く
 */
export type CheckedBy<K extends string> = { readonly __checkedBy?: readonly K[] };

/** 検証器が弾いた事実（判定語を含まない。docs/01「機械検出結果は事実の形で渡す」） */
export type AssertionViolation = {
  id: string;
  kind: "not-a-number" | "not-a-string" | "below-min" | "above-max" | "pattern-mismatch";
  message: string;
};

export type CompiledAssertion = (value: unknown) => AssertionViolation | null;

function violation(id: string, kind: AssertionViolation["kind"], message: string): AssertionViolation {
  return { id, kind, message };
}

/** 定義から検証関数を生成する。未検証の定義は throw する（ビルダー経由なら通過済み） */
export function compileAssertion(def: AssertionDef): CompiledAssertion {
  const errors = validateAssertionDef(def);
  if (errors.length > 0) {
    throw new Error(`cannot compile unvalidated assertion definition (${def.id}): ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  }
  if (def.kind === "within-range") {
    return compileWithinRange(def);
  }
  return compilePattern(def);
}

function compileWithinRange(def: WithinRangeDef): CompiledAssertion {
  const [min, max] = def.within;
  return (value) => {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return violation(def.id, "not-a-number", `value must be a number for assertion ${def.id}`);
    }
    if (value < min) {
      return violation(def.id, "below-min", `value ${value} is below the minimum ${min} of assertion ${def.id}`);
    }
    if (value > max) {
      return violation(def.id, "above-max", `value ${value} is above the maximum ${max} of assertion ${def.id}`);
    }
    return null;
  };
}

function compilePattern(def: PatternDef): CompiledAssertion {
  // flags・入れ子量指定子・パターン長は validateAssertionDef で検証済み。ただし
  // 構文不正（開き括弧の対応崩れ等）は検証対象外なので、ここで初めて SyntaxError
  // になりうる — 生の SyntaxError に id が載らないため id 付きのエラーに差し替える
  let re: RegExp;
  try {
    re = new RegExp(def.pattern, def.flags);
  } catch (err) {
    throw new Error(`invalid pattern for assertion ${def.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return (value) => {
    if (typeof value !== "string") {
      return violation(def.id, "not-a-string", `value must be a string for assertion ${def.id}`);
    }
    if (!re.test(value)) {
      return violation(def.id, "pattern-mismatch", `value does not match the pattern of assertion ${def.id}`);
    }
    return null;
  };
}

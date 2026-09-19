/**
 * アサーション定義の決定的検証（docs/01 層 1・#17 PR 1）。
 * 構造で証明できる部分のみを機械的に検査する（最重要原則 1）。Jev は呼ばない。
 *
 * - basis は必須（docs/01: 根拠のないアサーションは意味の判定 (b) が成立せず、
 *   Jev に渡す evidence が「宣言だけ」になるため）
 * - basisRef の url 型は取得時点の固定引用 quote を必須にする（CI は外部 URL を
 *   fetch しない。本文の変化が判定の再現性を壊すため・docs/01 データモデル）
 * - ReDoS 上限（docs/01「ReDoS 的な定義」の対処・jev-claude と同じ思想）:
 *   定義サイズ・パターン長・入れ子量指定子の検査。正規表現はソース文字列の
 *   まま保持し、検査を通ったものだけが検証器（PR 2）に渡る。定義「件数」の
 *   上限はこの関数の担当外 — ファイル単位の一括検査（PR 2・CI）で設ける
 */

export type BasisRef =
  | { type: "doc"; path: string; section?: string }
  | { type: "url"; path: string; quote: string };

export type Severity = "legal" | "business" | "style";

export type WithinRangeDef = {
  id: string;
  kind: "within-range";
  within: [number, number];
  basis: string;
  basisRef: BasisRef;
  severity: Severity;
  checkedBy?: string[];
};

export type PatternDef = {
  id: string;
  kind: "pattern";
  /** 正規表現ソース（RegExp ではなく文字列で保持。検証を通るまで compile しない） */
  pattern: string;
  /** 状態を持つ g/m/y は許さない。許可は i / u / v */
  flags?: string;
  basis: string;
  basisRef: BasisRef;
  severity: Severity;
  checkedBy?: string[];
};

export type AssertionDef = WithinRangeDef | PatternDef;

/** 定義 1 件の JSON シリアライズ上限（バイト） */
export const MAX_DEF_JSON_BYTES = 8192;

/** pattern ソースの上限文字数 */
export const MAX_PATTERN_LENGTH = 256;

export const ALLOWED_PATTERN_FLAGS = new Set(["i", "u", "v"]);

export type DefValidationError = { path: string; message: string };

export function validateAssertionDef(def: AssertionDef): DefValidationError[] {
  const errors: DefValidationError[] = [];
  const push = (path: string, message: string) => errors.push({ path, message });

  // CI が JSON.parse の結果（null になりうる）をそのまま渡す経路があるため、
  // 検証器は TypeError を投げるのでなく 1 件のエラーとして返す（total である）
  if (typeof def !== "object" || def === null) {
    push("definition", "definition must be an object");
    return errors;
  }

  if (typeof def.id !== "string" || def.id.trim().length === 0) {
    push("id", "id must be a non-empty string");
  }
  if (typeof def.basis !== "string" || def.basis.trim().length === 0) {
    push("basis", "basis is required: 根拠のないアサーションは判定 (b) が成立しない (docs/01)");
  }
  validateBasisRef(def.basisRef, push);
  validateCheckedBy(def.checkedBy, push);
  if (def.severity !== "legal" && def.severity !== "business" && def.severity !== "style") {
    push("severity", "severity must be one of: legal, business, style");
  }

  if (def.kind === "within-range") {
    const within: unknown = def.within;
    if (!Array.isArray(within) || within.length !== 2) {
      push("within", "within must be a [number, number] pair");
    } else {
      const [min, max] = within as unknown[];
      if (typeof min !== "number" || typeof max !== "number" || Number.isNaN(min) || Number.isNaN(max)) {
        push("within", "within must be a [number, number] pair");
      } else if (!(min < max)) {
        push("within", `within requires min < max (got: [${min}, ${max}])`);
      }
    }
  } else if (def.kind === "pattern") {
    if (typeof def.pattern !== "string" || def.pattern.length === 0) {
      push("pattern", "pattern must be a non-empty string");
    } else {
      if (def.pattern.length > MAX_PATTERN_LENGTH) {
        push("pattern", `pattern exceeds ${MAX_PATTERN_LENGTH} chars (got: ${def.pattern.length})`);
      }
      if (hasNestedQuantifier(def.pattern)) {
        push("pattern", "pattern contains a nested quantifier like (a+)+ — ReDoS の危険な形 (docs/01)");
      }
    }
    if (def.flags !== undefined) {
      if (typeof def.flags !== "string") {
        push("flags", "flags must be a string");
      } else {
        for (const f of def.flags) {
          if (!ALLOWED_PATTERN_FLAGS.has(f)) push("flags", `flag "${f}" is not allowed (allowed: i, u, v)`);
        }
        // u と v は JS 仕様上併用不可。検証を通すと PR 2 の compile 時に初めて落ちるため、ここで落とす
        if (def.flags.includes("u") && def.flags.includes("v")) {
          push("flags", 'flags "u" and "v" cannot be combined');
        }
      }
    }
  } else {
    push("kind", "kind must be one of: within-range, pattern");
  }

  const bytes = Buffer.byteLength(JSON.stringify(def), "utf8");
  if (bytes > MAX_DEF_JSON_BYTES) {
    push("definition", `definition exceeds ${MAX_DEF_JSON_BYTES} bytes (got: ${bytes})`);
  }
  return errors;
}

function validateCheckedBy(v: unknown, push: (path: string, message: string) => void): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    push("checkedBy", "checkedBy must be an array of strings");
  }
}

function validateBasisRef(ref: unknown, push: (path: string, message: string) => void): void {
  if (typeof ref !== "object" || ref === null) {
    push("basisRef", "basisRef is required: { type: doc | url, ... }");
    return;
  }
  const { type, path, quote } = ref as Record<string, unknown>;
  if (type !== "doc" && type !== "url") {
    push("basisRef.type", 'basisRef.type must be "doc" or "url"');
    return;
  }
  if (typeof path !== "string" || path.trim().length === 0) {
    push("basisRef.path", "basisRef.path is required");
    return;
  }
  if (type === "doc") {
    // doc はリポジトリ内の相対パスで指す（CI が読む。リポジトリ外・絶対パスは対象外）
    if (path.startsWith("/") || path.startsWith("\\")) {
      push("basisRef.path", `doc basisRef.path must be a repo-relative path (got: ${path})`);
    } else if (path.split(/[\\/]/).includes("..")) {
      push("basisRef.path", `doc basisRef.path must not escape the repo (got: ${path})`);
    }
    return;
  }
  // url: CI は外部 URL を fetch しない。取得時点の固定引用を必須にする（docs/01）
  if (typeof quote !== "string" || quote.trim().length === 0) {
    push("basisRef.quote", "url basisRef requires a fixed quote: CI は URL を fetch しないため (docs/01)");
  }
}

/**
 * 入れ子量指定子（(?:a+)+、((a+))+ など）の静的検査。文字クラス内・エスケープ済み
 * 文字は無視し、グループ修飾子（(?: / (?= / (?<name> 等）の ? は量指定子と数えない。
 * 「量指定子を含むグループ自体が quantify される」形を括弧の各深さで捉える
 * （((a+))+ を見逃さない）。完全な線形時間性の証明ではなく「壊れた/悪意ある
 * パターンを判定前に落とす」ための簡易検査（docs/01 の位置づけ）。保守的に
 * 有界な (a+){2} も拒否する（リテラル { は文字クラスか \{ で書く）
 */
export function hasNestedQuantifier(pattern: string): boolean {
  // スタックの各要素は「その深さのグループ（または全体）内で量指定子が現れたか」
  const quantified: boolean[] = [false];
  let inClass = false;
  let escaped = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      quantified.push(false);
      // グループ修飾子の ? は量指定子ではない。(?: (?= (?! と lookbehind (?<= (?<! は
      // 修飾子部を読み飛ばし、名前付き (?<name> は > まで読み飛ばす
      if (pattern[i + 1] === "?") {
        if (pattern[i + 2] === "<" && (pattern[i + 3] === "=" || pattern[i + 3] === "!")) {
          i += 3;
        } else if (pattern[i + 2] === "<") {
          const close = pattern.indexOf(">", i + 2);
          if (close > i) i = close;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (ch === ")") {
      const hadQuantifier = quantified.pop();
      // 内側に量指定子があった事実は enclosing 深度にも伝播させる
      // （((a+))+ の外側 ) の pop 値を true にするため）
      if (hadQuantifier) quantified[quantified.length - 1] = true;
      if (hadQuantifier && isQuantifierStart(pattern, i + 1)) return true;
      continue;
    }
    if (isQuantifierStart(pattern, i)) {
      quantified[quantified.length - 1] = true;
      if (ch === "{") {
        const close = pattern.indexOf("}", i);
        if (close > i) i = close;
      }
    }
  }
  return false;
}

function isQuantifierStart(pattern: string, i: number): boolean {
  const ch = pattern[i];
  return ch === "+" || ch === "*" || ch === "?" || ch === "{";
}

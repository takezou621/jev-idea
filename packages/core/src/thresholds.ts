/**
 * 回答層 — docs/05「回答層の確定規則」の実装。
 * すべての判定ポイントで同一の正規化・二値化を行う（最重要原則 3:
 * 確率の二値化は回答層の 1 か所にのみ集約）。
 */
import type { Answer, ResolvedThresholds, Thresholds } from "./types.js";

/** docs/05 の初期値。しきい値は各判定ポイントが上書きできる。 */
export const DEFAULT_THRESHOLDS: ResolvedThresholds = Object.freeze({
  trueMin: 0.75,
  falseMax: 0.25,
  minConfidence: 0.5,
});

/**
 * 判定ポイントのしきい値上書きを解決する。未指定（undefined）のフィールドは
 * 既定値を使う。minConfidence だけは null が意味を持つ（ゲート無効）ため、
 * undefined と null を区別する。
 *
 * falseMax が trueMin 以上の逆転設定は jev-claude の学習（fth = min(fth, th - 0.05)）
 * どおり falseMax = trueMin - 0.05 に強制する（p=0.5 が true になる自壊設定を
 * 静かに通さない。throw にはしない — 設定ミスでフローを止めない）。
 */
export function resolveThresholds(t?: Thresholds): ResolvedThresholds {
  const trueMin = t?.trueMin ?? DEFAULT_THRESHOLDS.trueMin;
  const falseMaxRaw = t?.falseMax ?? DEFAULT_THRESHOLDS.falseMax;
  return {
    trueMin,
    falseMax: Math.min(falseMaxRaw, Math.max(0, trueMin - 0.05)),
    minConfidence:
      t?.minConfidence === undefined ? DEFAULT_THRESHOLDS.minConfidence : t.minConfidence,
  };
}

/**
 * docs/05「score の正規化」: p_norm = score / (length - 1)。
 * criteria 1 件（length === 1）のときは 1。
 * score 型の Criterion は最低 2 段（SDK 制約）だが、規則自体は 1 段にも定義される。
 */
export function normScore(score: number, rubricLength: number): number {
  if (rubricLength <= 1) return 1;
  return score / (rubricLength - 1);
}

/**
 * 回答層の二値化。docs/05 の確定規則:
 * - true:   p ≥ trueMin かつ confidence ≥ minConfidence
 * - false:  p ≤ falseMax かつ confidence ≥ minConfidence
 * - unknown: 上記以外（中間帯、confidence < minConfidence、confidence 欠落）
 *
 * 「unknown を false に潰さない」が鉄則（最重要原則 5）。
 * minConfidence: null のとき confidence ゲートを適用しない（SDK noul =
 * boolean 型は confidence を持たないため、その型の p ベース二値化に使う）。
 */
export function verdict(
  answer: Answer | undefined,
  th: ResolvedThresholds = DEFAULT_THRESHOLDS,
): "true" | "false" | "unknown" {
  if (!answer) return "unknown";
  if (th.minConfidence !== null) {
    if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) {
      return "unknown";
    }
    if (answer.confidence < th.minConfidence) return "unknown";
  }
  if (answer.p >= th.trueMin) return "true";
  if (answer.p <= th.falseMax) return "false";
  return "unknown";
}

/**
 * score 型の分布集計: norm（Answer.distribution のキー）が normThreshold 未満の
 * 段の確率質量の合計。1 で頭打ちする。分布が無ければ undefined
 * （集計できない = 確信ゲートは通さない）。
 *
 * exclude に distribution キー（"0.5" など）を渡すとその段を集計から外す。
 * jev-claude verify-done.mjs の学習の継承: 段 2「実装は済んでいるが、必要な
 * 検証が行われていない」は検証が「必要だった」ときだけ未完了側に数える。
 * これは分布の決定的集計であり、二値化（block するか否か）は判定層が行う。
 */
export function massBelow(
  answer: Answer | undefined,
  normThreshold: number,
  exclude?: readonly string[],
): number | undefined {
  if (!answer?.distribution) return undefined;
  const excluded = new Set(exclude ?? []);
  let sum = 0;
  for (const [key, prob] of Object.entries(answer.distribution)) {
    if (excluded.has(key)) continue;
    const norm = Number(key);
    if (!Number.isFinite(norm)) continue; // 段の正規化値でないキーは不正データ
    if (typeof prob !== "number" || !Number.isFinite(prob)) continue;
    if (norm < normThreshold) sum += prob;
  }
  return Math.min(1, sum);
}

/**
 * 多数決 helper（docs/05 回答層の確定規則表・#3）。
 *
 * 同一 evidence で repeats 回判定した結果の criterion ごとの多数決。
 * docs/05: 「3 回の p の幅が 0.3 以上なら『ばらつき大』として unknown にする」
 * （境界の不安定さの実測への対応）。
 *
 * - 幅 ≥ MAJORITY_SPREAD_MAX → confidence を欠落させた Answer を返す
 *   （confidence 欠落は常に unknown — 原則 5。分布も信頼できないので落とす）
 * - 幅 < MAJORITY_SPREAD_MAX → p は下側中央値（実在する試行の値で決定的に
 *   選ぶ）。confidence は**全試行に存在するときだけ**最小値を採用する
 *   （1 試行でも欠落すれば欠落 = unknown に倒す。unknown を false に潰さない）。
 *   distribution は中央値 p を持つ試行から採用する（p と分布の整合）
 * - 回答の欠落した試行が 1 つでもあれば、その criterion の回答は無し
 *   （decision では verdict unknown になる）
 *
 * 多数決の対象は Answer の合成のみ。二値化（true/false/unknown）は verdict の
 * 1 か所で行う（原則 3: 二値化は回答層に集約）。
 */
import type { Answer, Criterion } from "./types.js";

/** docs/05: p の幅 ≥ 0.3 なら「ばらつき大」で unknown にする */
export const MAJORITY_SPREAD_MAX = 0.3;

/** 幅の比較の浮動小数点の丸め誤差の余裕（docs/05）。0.7 - 0.4 =
 * 0.29999999999999993 のような実数表現のズレで「ばらつき大」が漏れないよう、
 * 境界は unknown 側に寄せる */
const SPREAD_EPSILON = 1e-9;

export function majorityAnswers(
  criteria: readonly Criterion[],
  attempts: readonly Record<string, Answer>[],
): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const c of criteria) {
    const list = attempts.map((a) => a[c.id]);
    if (list.some((a) => !a)) continue;
    const answers = list as Answer[];
    if (answers.length === 0) continue; // 試行なし = 回答なし（decision では unknown）
    const ps = answers.map((a) => a.p);
    const sorted = [...ps].sort((x, y) => x - y);
    // 下側中央値（length ≥ 1 は上で保証）。実在する試行の値で決定的に選ぶ
    const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
    if (Math.max(...ps) - Math.min(...ps) >= MAJORITY_SPREAD_MAX - SPREAD_EPSILON) {
      // ばらつき大: unknown 表現。confidence・distribution は落とす
      out[c.id] = { criterion: c.id, p: median };
      continue;
    }
    const confidences = answers.map((a) => a.confidence);
    const allHaveConfidence = confidences.every((v) => typeof v === "number");
    const medianAnswer = answers.find((a) => a.p === median)!;
    out[c.id] = {
      criterion: c.id,
      p: median,
      ...(allHaveConfidence
        ? { confidence: Math.min(...(confidences as number[])) }
        : {}),
      ...(medianAnswer.distribution === undefined
        ? {}
        : { distribution: medianAnswer.distribution }),
    };
  }
  return out;
}

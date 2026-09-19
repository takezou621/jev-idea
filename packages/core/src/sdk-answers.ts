/**
 * SDK 応答の検証・正規化（jev-claude jev-lib.mjs fromSdkAnswers の一般化）。
 *
 * なぜ検証が要るか（jev-claude の敵対テストで発見・AGENTS.md 罠リストの継承）:
 * 範囲外の値をそのまま使うと、確率 5 や score -3 が「明確な主張」として扱われ、
 * 壊れた応答で block してしまう。値が不正な回答は**回答ごと落として**
 * decision に届かなくし、下流のしきい値判定を素通りさせる（フェイルオープン）。
 */
import { normScore } from "./thresholds.js";
import type { Answer, Criterion, RawSdkAnswer } from "./types.js";

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const prob = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 && n <= 1 ? n : null;
};
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function fromSdkAnswers(
  criteria: readonly Criterion[],
  raw: Record<string, unknown> | undefined,
): Record<string, Answer> {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const out: Record<string, Answer> = {};
  for (const [id, a] of Object.entries(raw ?? {})) {
    const criterion = byId.get(id);
    if (!criterion || !isPlainObject(a)) continue;

    // 応答の型名は経路で揺れる（Gateway は 'noul'、スタブは 'boolean'）。
    // 両方を受ける。確率の位置も noul / probability の両方を見る。
    // boolean 判定は criterion の型とも一致させる（score 型への noul 応答は
    // 規約外 = 欠落。正規化も分布も無い p が decision に流れるのを防ぐ）
    if ((a.type === "noul" || a.type === "boolean") && criterion.type === "boolean") {
      const p = prob(a.noul ?? a.probability);
      if (p === null) continue; // 範囲外・非数は採用しない
      out[id] = { criterion: id, p };
    } else if (a.type === "score" && criterion.type === "score") {
      const scoreMax = criterion.rubric.length - 1;
      const score = num(a.score);
      // rubric の範囲外は壊れた応答。完了度は判定に使わない
      // （jev-claude: 敵対テストで score -3 / 99 が block を起こした）
      if (score === null || score < 0 || score > scoreMax) continue;
      const confidence = prob(a.confidence);
      const distribution = toNormDistribution(a.probabilities, scoreMax);
      // 分布の合計が 1 を超えるのは壊れた応答。このままでは P(未完了) の和が
      // 1 を超え、「確信ある未完了」を偽造できてしまうので回答ごと捨てる
      if (distribution === null) continue;
      out[id] = {
        criterion: id,
        p: normScore(score, criterion.rubric.length),
        ...(confidence === null ? {} : { confidence }),
        ...(distribution === undefined ? {} : { distribution }),
      };
    }
    // choice 型と未知の type は落とす（choice の回答層規定は docs/05 に無く、
    // 本 PR の範囲外。規定する PR で受け口を足す）
  }
  return out;
}

/**
 * 段番号キー（"0".."n-1"）の生分布を norm キー（i / scoreMax）に変換する。
 * 不正な値・範囲外の段（非整数・負・scoreMax 超）は除去してから、**有効段のみ**
 * で合計を検証する（docs/05: 除去して受け、回答は捨てない。範囲外段に質量を
 * 積んで有効段を廃棄に追い込む経路を閉じる）。合計 > 1 + 1e-6 は壊れた応答と
 * して null を返す（呼び出し側は回答ごと捨てる）。
 * rubric 1 段（scoreMax === 0）のときは norm 1 に集約する（規則「criteria 1 件のときは 1」）。
 */
function toNormDistribution(
  probs: unknown,
  scoreMax: number,
): Record<string, number> | null | undefined {
  if (!isPlainObject(probs)) return undefined;
  const cleaned: Record<string, number> = {};
  for (const [k, v] of Object.entries(probs)) {
    const n = prob(v);
    if (n === null) continue; // 不正値は除去
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i > scoreMax) continue; // 範囲外の段は除去
    cleaned[k] = n;
  }
  const total = Object.values(cleaned).reduce((x, y) => x + y, 0);
  if (total > 1 + 1e-6) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(cleaned)) {
    const i = Number(k);
    out[String(scoreMax === 0 ? 1 : i / scoreMax)] = v;
  }
  return out;
}

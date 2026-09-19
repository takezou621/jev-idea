/**
 * Criterion → SDK 質問の組立て。判定ポイントの criteria は SDK の質問型に
 * そのまま写像される（判定ポイント定義はホストごとに変えない — AGENTS.md）。
 */
import type { NoulQuestion, ScoreQuestion } from "@typesafe-ai/sdk";
import type { Criterion } from "./types.js";

export type JevQuestions = Record<string, NoulQuestion | ScoreQuestion>;

export function toSdkQuestions(criteria: readonly Criterion[]): JevQuestions {
  const out: JevQuestions = {};
  for (const c of criteria) {
    if (c.type === "score") {
      out[c.id] = { type: "score", instructions: c.question, criteria: c.rubric };
    } else {
      out[c.id] = {
        type: "noul",
        instructions: c.question,
        ...(c.meanings ? { criteria: { true: c.meanings.true, false: c.meanings.false } } : {}),
      };
    }
  }
  return out;
}

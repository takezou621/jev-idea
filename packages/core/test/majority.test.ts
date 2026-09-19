/**
 * 多数決 helper（docs/05 回答層の確定規則表・#3 DoD 1）。
 * 同一 evidence で 3 回判定し、p の幅 ≥ 0.3 なら「ばらつき大」として
 * unknown にする。実 API を叩かず stub provider で合成ケースを作る
 * （AGENTS.md テスト方針）。expected は人手で確定する。
 */
import { describe, expect, it } from "vitest";
import { judge } from "../src/judge.js";
import { DEFAULT_THRESHOLDS, verdict } from "../src/thresholds.js";
import { majorityAnswers } from "../src/majority.js";
import type {
  Action,
  Answer,
  Criterion,
  JudgeProvider,
  JudgmentPoint,
  ResolvedThresholds,
} from "../src/types.js";

const scoreCriterion: Criterion = {
  type: "score",
  id: "completion",
  question: "完了しているか",
  rubric: ["未完了", "ほぼ完了", "完了"],
};

// DoD 1 の合成ケース: provider が回ごとに p を振る。score 2 / 1 / 0
// → p = 1.0 / 0.5 / 0.0、幅 1.0 ≥ 0.3 → 多数決は unknown になる。
// カウンタをテスト間で共有しないよう、テストごとに新しく作る
const makeSpreadProvider = (): JudgeProvider => {
  const scores = [2, 1, 0];
  let i = 0;
  return async () => ({
    answers: {
      completion: {
        type: "score",
        score: scores[i++ % scores.length],
        confidence: 0.9,
      },
    },
    usage: { input_tokens: 10, output_tokens: 2 },
    model: "stub",
  });
};

const pointOf = (): JudgmentPoint => ({
  id: "majority-point",
  criteria: [scoreCriterion],
  evidence: () => ({ meta: [{ title: "前提", text: "fact" }], data: [{ text: "payload" }] }),
  decision: (answers: Record<string, Answer>, th: ResolvedThresholds): Action => {
    const v = verdict(answers.completion, th);
    if (v === "unknown") return { kind: "escalate", question: "完了の有無を確認" };
    if (v === "false") return { kind: "block", reason: "未完了側の回答が多数" };
    return { kind: "pass" };
  },
  failMode: "open",
});

describe("多数決 helper（#3 DoD 1）", () => {
  it("p が振れる合成ケースで多数決が unknown を返す（judge 経由 → escalate）", async () => {
    const run = await judge(pointOf(), {
      provider: makeSpreadProvider(),
      repeats: 3,
      log: false,
    });
    expect(run.status).toBe("judged");
    // ゴールデン（人手確定）: 幅 1.0 ≥ 0.3 → unknown → escalate。
    // unknown を false に潰さない（原則 5）
    expect(run.action.kind).toBe("escalate");
  });

  it("repeats 未指定は 1 回判定（多数決なし。既定の契約）", async () => {
    const run = await judge(pointOf(), { provider: makeSpreadProvider(), log: false });
    expect(run.status).toBe("judged");
    // 1 回目は p 1.0 → true → pass
    expect(run.action.kind).toBe("pass");
  });

  it("repeats に非有限数（NaN / 0 / 負）を渡しても 1 回判定に倒る", async () => {
    for (const repeats of [Number.NaN, 0, -1]) {
      const run = await judge(pointOf(), {
        provider: makeSpreadProvider(),
        repeats,
        log: false,
      });
      expect(run.status).toBe("judged");
      expect(run.action.kind).toBe("pass");
    }
  });

  it("複数試行の usage は総和、model は最終試行でログに残る", async () => {
    const entries: unknown[] = [];
    const models = ["stub-a", "stub-b"];
    let i = 0;
    const run = await judge(pointOf(), {
      provider: async () => ({
        answers: {
          completion: { type: "score", score: 2, confidence: 0.9 },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
        model: models[i++ % models.length]!,
      }),
      repeats: 2,
      log: (e) => entries.push(e),
    });
    expect(run.status).toBe("judged");
    const e = entries[0] as { usage?: { input_tokens: number; output_tokens: number }; model?: string };
    // 2 試行分の総和（docs/05: ログの usage）
    expect(e.usage).toEqual({ input_tokens: 20, output_tokens: 4 });
    // model は最終試行のもの
    expect(e.model).toBe("stub-b");
  });

  it("2 試行目で provider が失敗したら status: failed（failMode に従う）", async () => {
    let i = 0;
    const run = await judge(pointOf(), {
      provider: async () => {
        if (i++ === 0) {
          return {
            answers: { completion: { type: "score", score: 2, confidence: 0.9 } },
          };
        }
        throw new Error("second try failed");
      },
      repeats: 3,
      log: false,
    });
    expect(run.status).toBe("failed");
    if (run.status === "failed") {
      // provider 障害は failMode open → pass
      expect(run.action.kind).toBe("pass");
      expect(run.error.message).toBe("second try failed");
    }
  });

  it("幅 ≥ 0.3 では confidence を欠落させた Answer（unknown 表現）になる", () => {
    const m = majorityAnswers(
      [scoreCriterion],
      [
        { completion: { criterion: "completion", p: 0.0, confidence: 0.9 } },
        { completion: { criterion: "completion", p: 0.5, confidence: 0.9 } },
        { completion: { criterion: "completion", p: 1.0, confidence: 0.9 } },
      ],
    );
    expect(m.completion).toEqual({ criterion: "completion", p: 0.5 });
    // confidence 欠落 → verdict unknown（unknown を false に潰さない）
    expect(verdict(m.completion, DEFAULT_THRESHOLDS)).toBe("unknown");
  });

  it("幅がちょうど 0.3 のときも「ばらつき大」で unknown（docs/05 の ≥ 規定）", () => {
    const m = majorityAnswers(
      [scoreCriterion],
      [
        { completion: { criterion: "completion", p: 0.35, confidence: 0.9 } },
        { completion: { criterion: "completion", p: 0.5, confidence: 0.9 } },
        { completion: { criterion: "completion", p: 0.65, confidence: 0.9 } },
      ],
    );
    expect(m.completion).toEqual({ criterion: "completion", p: 0.5 });
  });

  it("幅が浮動小数点表現で 0.3 未満に見える値（0.7 - 0.4）も「ばらつき大」で unknown", () => {
    // 0.7 - 0.4 = 0.29999999999999993。ε 余裕（docs/05 の FP 注記）で
    // 境界は unknown 側に寄せる
    const m = majorityAnswers(
      [scoreCriterion],
      [
        { completion: { criterion: "completion", p: 0.4, confidence: 0.9 } },
        { completion: { criterion: "completion", p: 0.5, confidence: 0.9 } },
        { completion: { criterion: "completion", p: 0.7, confidence: 0.9 } },
      ],
    );
    expect(m.completion).toEqual({ criterion: "completion", p: 0.5 });
    expect(verdict(m.completion, DEFAULT_THRESHOLDS)).toBe("unknown");
  });

  it("幅 < 0.3 では p の中央値と confidence 最小値（全試行にあるときだけ）で多数決する", () => {
    const m = majorityAnswers(
      [scoreCriterion],
      [
        { completion: { criterion: "completion", p: 0.0, confidence: 0.8 } },
        { completion: { criterion: "completion", p: 0.1, confidence: 0.6 } },
        { completion: { criterion: "completion", p: 0.1, confidence: 0.9 } },
      ],
    );
    expect(m.completion).toEqual({ criterion: "completion", p: 0.1, confidence: 0.6 });
    expect(verdict(m.completion, DEFAULT_THRESHOLDS)).toBe("false");
  });

  it("1 試行でも confidence が欠落すれば多数決でも欠落（unknown に倒す）", () => {
    const m = majorityAnswers(
      [scoreCriterion],
      [
        { completion: { criterion: "completion", p: 0.0, confidence: 0.8 } },
        { completion: { criterion: "completion", p: 0.1 } },
        { completion: { criterion: "completion", p: 0.1, confidence: 0.9 } },
      ],
    );
    expect(m.completion).toEqual({ criterion: "completion", p: 0.1 });
  });

  it("回答の欠落した試行があれば criterion の回答は無し（verdict unknown）", () => {
    const m = majorityAnswers(
      [scoreCriterion],
      [
        { completion: { criterion: "completion", p: 0.0, confidence: 0.9 } },
        {},
        { completion: { criterion: "completion", p: 0.1, confidence: 0.9 } },
      ],
    );
    expect(m.completion).toBeUndefined();
    expect(verdict(m.completion, DEFAULT_THRESHOLDS)).toBe("unknown");
  });

  it("distribution は中央値 p の試行から採用する（p と分布の整合）", () => {
    const m = majorityAnswers(
      [scoreCriterion],
      [
        { completion: { criterion: "completion", p: 0.0, confidence: 0.9, distribution: { "0": 1 } } },
        { completion: { criterion: "completion", p: 0.1, confidence: 0.8, distribution: { "0.5": 1 } } },
        { completion: { criterion: "completion", p: 0.1, confidence: 0.9, distribution: { "1": 1 } } },
      ],
    );
    expect(m.completion).toEqual({
      criterion: "completion",
      p: 0.1,
      confidence: 0.8,
      distribution: { "0.5": 1 },
    });
  });
});

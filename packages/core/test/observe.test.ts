/**
 * observe モード（docs/05「フェイルオープンと observe」・#3 DoD 2）。
 * observe は gate: "reversible" の block 型に限定。block を記録するが
 * 呼び出し側（フック・CI）には pass を返し、実挙動に影響しない。
 * 実 API を叩かず stub provider で固定応答を作る（AGENTS.md テスト方針）。
 */
import { describe, expect, it } from "vitest";
import { judge } from "../src/judge.js";
import { verdict } from "../src/thresholds.js";
import type { LogEntry } from "../src/log.js";
import type {
  Action,
  Answer,
  JudgeProvider,
  JudgmentPoint,
  ResolvedThresholds,
} from "../src/types.js";

// score 0（p = 0）→ verdict false → decision は block を返す stub
const blockProvider: JudgeProvider = async () => ({
  answers: { gate: { type: "score", score: 0, confidence: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 2 },
  model: "stub",
});

const pointOf = (over: Partial<JudgmentPoint>): JudgmentPoint => ({
  id: "observe-point",
  criteria: [
    { type: "score", id: "gate", question: "ゲートを通るか", rubric: ["不通過", "通過"] },
  ],
  evidence: () => ({ meta: [], data: [] }),
  decision: (answers: Record<string, Answer>, th: ResolvedThresholds): Action => {
    const v = verdict(answers.gate, th);
    if (v === "false") return { kind: "block", reason: "ゲート条件を満たす回答が無い" };
    if (v === "unknown") return { kind: "escalate", question: "ゲート条件を確認" };
    return { kind: "pass" };
  },
  failMode: "open",
  ...over,
});

describe("observe モード（#3 DoD 2）", () => {
  it("observe 中の block は would-block として記録され、呼び出し側には pass を返す", async () => {
    const entries: LogEntry[] = [];
    const run = await judge(pointOf({ gate: "reversible", observe: true }), {
      provider: blockProvider,
      log: (e) => entries.push(e),
    });
    // 実挙動: block しない（observe の契約。フック・CI の挙動が変わらない）
    expect(run.status).toBe("judged");
    expect(run.action).toEqual({ kind: "pass" });
    // ログ: would-block の記録（本来の block reason を含む。tp/fp 分類の対象）
    expect(entries).toHaveLength(1);
    expect(entries[0]!.would_block).toEqual({ reason: "ゲート条件を満たす回答が無い" });
    // ログの action は実際に返した action
    expect(entries[0]!.action).toBe("pass");
  });

  it("observe 無しでは block がそのまま返る（現行どおり）", async () => {
    const entries: LogEntry[] = [];
    const run = await judge(pointOf({}), {
      provider: blockProvider,
      log: (e) => entries.push(e),
    });
    expect(run.action).toEqual({ kind: "block", reason: "ゲート条件を満たす回答が無い" });
    expect(entries[0]!.would_block).toBeUndefined();
  });

  it("gate: irreversible では observe を適用しない（closed ゲートに observe しない）", async () => {
    const entries: LogEntry[] = [];
    const run = await judge(pointOf({ gate: "irreversible", observe: true }), {
      provider: blockProvider,
      log: (e) => entries.push(e),
    });
    expect(run.action).toEqual({ kind: "block", reason: "ゲート条件を満たす回答が無い" });
    expect(entries[0]!.would_block).toBeUndefined();
  });

  it("gate 未指定では observe を適用しない", async () => {
    const run = await judge(pointOf({ observe: true }), { provider: blockProvider, log: false });
    expect(run.action).toEqual({ kind: "block", reason: "ゲート条件を満たす回答が無い" });
  });

  it("block 以外の action には observe を適用しない（warn はそのまま返る）", async () => {
    // score 1（p = 1）→ verdict true → warn を返す decision
    const passProvider: JudgeProvider = async () => ({
      answers: { gate: { type: "score", score: 1, confidence: 0.9 } },
    });
    const entries: LogEntry[] = [];
    const run = await judge(
      pointOf({
        gate: "reversible",
        observe: true,
        decision: (a: Record<string, Answer>, th: ResolvedThresholds): Action => {
          if (verdict(a.gate, th) === "true") return { kind: "warn", note: "ゲート通過（警告付き）" };
          return { kind: "block", reason: "ブロック" };
        },
      }),
      { provider: passProvider, log: (e) => entries.push(e) },
    );
    expect(run.action).toEqual({ kind: "warn", note: "ゲート通過（警告付き）" });
    expect(entries[0]!.would_block).toBeUndefined();
  });

  it("failed 時には observe を適用しない（判定失敗は would-block ではない）", async () => {
    const broken: JudgeProvider = async () => {
      throw new Error("network down");
    };
    const run = await judge(
      pointOf({ gate: "reversible", observe: true, failMode: "closed" }),
      { provider: broken, log: false },
    );
    expect(run.status).toBe("failed");
    // closed の failureAction（block）は observe で置換されない
    expect(run.action.kind).toBe("block");
  });
});

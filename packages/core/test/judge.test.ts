/**
 * judge() — 判定実行・failMode・総予算・出力契約（docs/05・docs/06）。
 * 実 API を叩かない（provider を注入。AGENTS.md テスト方針）。
 */
import { describe, expect, it } from "vitest";
import { judge } from "../src/judge.js";
import type {
  Action,
  Answer,
  Criterion,
  JudgeProvider,
  ResolvedThresholds,
} from "../src/types.js";

const BOOLEAN: Criterion = {
  type: "boolean",
  id: "bypass",
  question: "検証を迂回する経路があるか",
};

const SCORE: Criterion = {
  type: "score",
  id: "completeness",
  question: "完了度",
  rubric: ["未実装", "部分的", "実装済み検証なし", "検証に失敗", "完了"],
};

const okProvider: JudgeProvider = async () => ({
  answers: {
    bypass: { type: "noul", noul: 0.95 },
    completeness: { type: "score", score: 4, confidence: 0.9 },
  },
  usage: { input_tokens: 100, output_tokens: 0 },
  model: "stub",
});

const point = (
  decision: (answers: Record<string, Answer>, th: ResolvedThresholds) => Action,
  failMode: "open" | "closed" | "escalate" = "open",
) => ({
  id: "test-point",
  criteria: [BOOLEAN, SCORE],
  evidence: () => ({ meta: [], data: [{ text: "生データ" }] }),
  decision,
  failMode,
});

describe("judge — 正常系", () => {
  it("provider の回答が decision に渡り、その action が返る", async () => {
    let seen: Record<string, Answer> | undefined;
    let seenTh: ResolvedThresholds | undefined;
    const r = await judge(
      point((answers, th) => {
        seen = answers;
        seenTh = th;
        return { kind: "block", reason: "検証コマンドの実行痕跡が transcript にない" };
      }),
      { provider: okProvider, log: false },
    );
    expect(r.status).toBe("judged");
    if (r.status === "judged") {
      expect(r.action.kind).toBe("block");
      expect(seen?.bypass?.p).toBe(0.95);
      expect(seen?.completeness?.p).toBe(1);
      // judge が point.thresholds を解決して decision に渡す（既定値）
      expect(seenTh).toEqual({
        trueMin: 0.75,
        falseMax: 0.25,
        minConfidence: 0.5,
      });
    }
  });

  it("point.thresholds の上書きが decision に渡るしきい値に反映される", async () => {
    let seenTh: ResolvedThresholds | undefined;
    const base = point((_, th) => {
      seenTh = th;
      return { kind: "pass" };
    });
    const r = await judge(
      { ...base, thresholds: { trueMin: 0.6, falseMax: 0.2, minConfidence: null } },
      { provider: okProvider, log: false },
    );
    expect(r.status).toBe("judged");
    expect(seenTh).toEqual({ trueMin: 0.6, falseMax: 0.2, minConfidence: null });
  });

  it("falseMax が trueMin を逆転する上書きは強制される（falseMax = trueMin - 0.05）", async () => {
    let seenTh: ResolvedThresholds | undefined;
    const base = point((_, th) => {
      seenTh = th;
      return { kind: "pass" };
    });
    const r = await judge(
      { ...base, thresholds: { trueMin: 0.3, falseMax: 0.6 } },
      { provider: okProvider, log: false },
    );
    expect(r.status).toBe("judged");
    // 逆転設定は jev-claude の学習どおり強制（p=0.5 が true になる自壊設定を防ぐ）
    expect(seenTh?.trueMin).toBe(0.3);
    expect(seenTh?.falseMax).toBeCloseTo(0.25);
    expect(seenTh?.minConfidence).toBe(0.5);
  });

  it("検証で落ちた回答は decision に届かない（unknown に倒す）", async () => {
    const badProvider: JudgeProvider = async () => ({
      answers: {
        bypass: { type: "noul", noul: 5 },
        completeness: { type: "score", score: 99, confidence: 0.9 },
      },
    });
    let seen: Record<string, Answer> | undefined;
    await judge(
      point((answers) => {
        seen = answers;
        return { kind: "pass" };
      }),
      { provider: badProvider, log: false },
    );
    expect(seen).toEqual({});
  });
});

describe("judge — 失敗時は例外を投げず status: failed + failMode に従う action（docs/05）", () => {
  const failProvider: JudgeProvider = async () => {
    throw new Error("TYPESAFE_API_KEY is not set");
  };

  it.each(["open", "closed", "escalate"] as const)("%s", async (failMode) => {
    const r = await judge(point(() => ({ kind: "pass" }), failMode), {
      provider: failProvider,
      log: false,
    });
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.error).toBeInstanceOf(Error);
      if (failMode === "open") expect(r.action).toEqual({ kind: "pass" });
      if (failMode === "closed")
        expect(r.action.kind).toBe("block"); // reason は事実のみ（実装側で確認）
      if (failMode === "escalate") expect(r.action.kind).toBe("escalate");
    }
  });

  it("closed の block reason に判定語・p を含まない（事実のみ）", async () => {
    const r = await judge(point(() => ({ kind: "pass" }), "closed"), {
      provider: failProvider,
      log: false,
    });
    if (r.status !== "failed") throw new Error("unreachable");
    if (r.action.kind !== "block") throw new Error("unreachable");
    expect(r.action.reason).not.toMatch(/違反|迂回|違反した|不正/);
    expect(r.action.reason).not.toMatch(/0\.\d+|p=/);
  });

  it("失敗ログの error に失敗段階のプレフィックスが付く", async () => {
    const entries: unknown[] = [];
    await judge(point(() => ({ kind: "pass" })), {
      provider: failProvider,
      log: (e) => entries.push(e),
    });
    expect(entries).toHaveLength(1);
    const e = entries[0] as { status: string; error?: string };
    expect(e.status).toBe("failed");
    expect(e.error).toMatch(/^provider: /);
  });
});

describe("judge — 総予算（budgetMs。AGENTS.md: SDK タイムアウトは 1 試行あたり）", () => {
  it("budgetMs 超過で status: failed、例外を投げない", async () => {
    const slowProvider: JudgeProvider = (_req) =>
      new Promise((_resolve, reject) => {
        // signal で中断されるまで pending する
        _req.signal.addEventListener("abort", () => reject(_req.signal.reason));
      });
    const r = await judge(point(() => ({ kind: "pass" }), "open"), {
      provider: slowProvider,
      budgetMs: 50,
      log: false,
    });
    expect(r.status).toBe("failed");
  });

  it("budgetMs 内で完了すれば judged", async () => {
    const r = await judge(point(() => ({ kind: "pass" })), {
      provider: okProvider,
      budgetMs: 5000,
      log: false,
    });
    expect(r.status).toBe("judged");
  });
});

describe("judge — 出力契約（docs/06: ホストにはアクションのみ）", () => {
  it("Judgment の action に確率 p が現れない", async () => {
    const r = await judge(
      point((answers) => {
        // decision 内で answers の p を参照していても、返す action に載せなければ漏れない
        void answers;
        return { kind: "warn", note: "迂回は検出されず" };
      }),
      { provider: okProvider, log: false },
    );
    if (r.status !== "judged") throw new Error("unreachable");
    const json = JSON.stringify(r.action);
    expect(json).not.toMatch(/"p":/);
  });

  it("Judgment.answers は docs/05 どおり p を含み、p が外に現れるのは answers とログ（0600）だけ", async () => {
    const r = await judge(point(() => ({ kind: "pass" })), {
      provider: okProvider,
      log: false,
    });
    if (r.status !== "judged") throw new Error("unreachable");
    // answers は docs/05 の Judgment 型に含まれる（core 内完結。ホストには
    // jev-judge 経由で action のみを渡す）
    expect(Object.keys(r.answers.bypass ?? {})).toEqual(["criterion", "p"]);
  });
});

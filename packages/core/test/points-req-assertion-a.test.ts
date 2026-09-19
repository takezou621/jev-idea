/**
 * PR 判定 (a) の判定ポイント（docs/01 判定 (a)・#18）。
 *
 * decision は回答層の verdict だけで決定的に動くこと（ネットワークなし・
 * stub 回答）。しきい値の質問別差（質問 1 は既定・質問 2・3 は 0.6 上書き）が
 * 回答層側で効くことを確認する（decision 内で生 p を見ない — 原則 3）。
 * observe 属性（a1 のみ gate: reversible + observe: true）も固定する
 */
import { describe, expect, it } from "vitest";
import { resolveThresholds, verdict } from "../src/thresholds.js";
import { REQ_ASSERTION_A1, REQ_ASSERTION_A23 } from "../src/points/req-assertion-a.js";
import type { Action, Answer, ResolvedThresholds } from "../src/types.js";

const bool = (p: number, confidence = 0.9): Answer => ({ criterion: "", p, confidence });

const runA1 = (answers: Record<string, Answer>): Action => REQ_ASSERTION_A1.decision(answers, resolveThresholds(REQ_ASSERTION_A1.thresholds));
const runA23 = (answers: Record<string, Answer>): Action => REQ_ASSERTION_A23.decision(answers, resolveThresholds(REQ_ASSERTION_A23.thresholds));

describe("REQ_ASSERTION_A1（質問 1・迂回検出・block）", () => {
  it("属性は docs/01・docs/05 の設計どおり（minConfidence: null・observe: true・gate: reversible・failMode: open・true/false は既定）", () => {
    expect(REQ_ASSERTION_A1.id).toBe("req-assertion-a1");
    expect(REQ_ASSERTION_A1.observe).toBe(true);
    expect(REQ_ASSERTION_A1.gate).toBe("reversible");
    expect(REQ_ASSERTION_A1.failMode).toBe("open");
    // noul 応答は confidence を持たないため p ベース二値化（docs/05・sdk-answers）。
    // trueMin / falseMax は未指定=既定
    expect(REQ_ASSERTION_A1.thresholds).toEqual({ minConfidence: null });
    const th = resolveThresholds(REQ_ASSERTION_A1.thresholds);
    expect(th.trueMin).toBe(0.75);
    expect(th.falseMax).toBe(0.25);
    expect(th.minConfidence).toBeNull();
    expect(REQ_ASSERTION_A1.criteria).toHaveLength(1);
    expect(REQ_ASSERTION_A1.criteria[0]?.id).toBe("bypass");
  });

  it("true → block。reason は criterion がしきい値を満たした事実の形", () => {
    const action = runA1({ bypass: bool(0.9) });
    expect(action.kind).toBe("block");
    if (action.kind === "block") {
      expect(action.reason).toContain("bypass");
      // 判定語の断定（「迂回した」等の実装への断定）を書かない
      expect(action.reason).not.toContain("迂回した");
      expect(action.reason).not.toContain("違反");
    }
  });

  it("false → pass", () => {
    expect(runA1({ bypass: bool(0.05) })).toEqual({ kind: "pass" });
  });

  it("unknown（中間帯）→ escalate。質問 2・3 に進まない判断の材料になる", () => {
    const action = runA1({ bypass: bool(0.5) });
    expect(action.kind).toBe("escalate");
  });

  it("minConfidence: null では confidence は二値化に使われない。confidence 欠落・低 confidence でも p だけで判定する", () => {
    // noul 応答の実形（confidence なし・sdk-answers.ts）でも p だけで二値化される
    expect(runA1({ bypass: { criterion: "bypass", p: 0.95 } }).kind).toBe("block");
    // confidence がしきい値未満でも無視される（confidence ゲート無効）
    expect(runA1({ bypass: bool(0.95, 0.3) }).kind).toBe("block");
  });

  it("回答欠落は unknown（escalate）。黙って pass にしない", () => {
    expect(runA1({}).kind).toBe("escalate");
  });
});

describe("REQ_ASSERTION_A23（質問 2・3・trueMin 0.6 上書き・warn）", () => {
  const th: ResolvedThresholds = resolveThresholds(REQ_ASSERTION_A23.thresholds);

  it("属性は docs/01・docs/05 の設計どおり（trueMin 0.6 上書き・minConfidence: null・observe なし・failMode: open・criteria 2 件）", () => {
    expect(REQ_ASSERTION_A23.id).toBe("req-assertion-a23");
    expect(REQ_ASSERTION_A23.thresholds?.trueMin).toBe(0.6);
    expect(REQ_ASSERTION_A23.thresholds?.minConfidence).toBeNull();
    expect(REQ_ASSERTION_A23.observe).toBeUndefined();
    expect(REQ_ASSERTION_A23.failMode).toBe("open");
    expect(REQ_ASSERTION_A23.criteria.map((c) => c.id)).toEqual(["basis-consistency", "input-path"]);
    expect(REQ_ASSERTION_A23.criteria.length).toBeGreaterThan(0);
  });

  it("しきい値 0.6 の上書きが回答層で効く（0.6〜0.75 の帯が true になる。既定なら unknown）", () => {
    // 0.65 は既定（0.75）では unknown、0.6 上書きでは true
    expect(verdict(bool(0.65), resolveThresholds(undefined))).toBe("unknown");
    expect(verdict(bool(0.65), th)).toBe("true");
  });

  it("1 criterion の true → warn。note は true になった criterion の事実のみ", () => {
    const action = runA23({ "basis-consistency": bool(0.7), "input-path": bool(0.05) });
    expect(action.kind).toBe("warn");
    if (action.kind === "warn") {
      expect(action.note).toContain("basis-consistency");
      expect(action.note).not.toContain("input-path");
    }
  });

  it("両 criterion true → warn（列挙）", () => {
    const action = runA23({ "basis-consistency": bool(0.9), "input-path": bool(0.9) });
    expect(action.kind).toBe("warn");
    if (action.kind === "warn") {
      expect(action.note).toContain("basis-consistency");
      expect(action.note).toContain("input-path");
    }
  });

  it("両 false → pass", () => {
    expect(runA23({ "basis-consistency": bool(0.05), "input-path": bool(0.05) })).toEqual({ kind: "pass" });
  });

  it("unknown あり（true ありでも）→ escalate。unknown を先に返す（原則 5）", () => {
    expect(runA23({ "basis-consistency": bool(0.5), "input-path": bool(0.05) }).kind).toBe("escalate");
    expect(runA23({ "basis-consistency": bool(0.9), "input-path": bool(0.5) }).kind).toBe("escalate");
  });

  it("回答欠落は escalate（原則 5）", () => {
    expect(runA23({}).kind).toBe("escalate");
    expect(runA23({ "basis-consistency": bool(0.9) }).kind).toBe("escalate");
  });
});

describe("evidence base（meta の組立ては point 定義のみ）", () => {
  it("base meta は前提の説明で、機械特定の限界を事実として含む。data は空（呼び出し側が paths で追記）", () => {
    for (const point of [REQ_ASSERTION_A1, REQ_ASSERTION_A23]) {
      const ev = point.evidence();
      expect(ev.meta).toHaveLength(1);
      expect(ev.meta[0]?.text).toContain("エイリアス import");
      expect(ev.meta[0]?.text).not.toContain("違反している");
      expect(ev.data).toEqual([]);
    }
  });
});

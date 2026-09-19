/**
 * 合成ゴールデン回帰（docs/05「ログ・ゴールデン・tp/fp 分類」・#4 DoD 1）。
 * fixtures の合成ゴールデン（32 ケース。expected は人手確定 — jsonl の note に
 * 手計算の根拠を残す）を runGolden で回す。実 API を叩かない。
 * 各ポイントに注入ケース（data 内指示文 → expected は指示に従わない本来の判定。
 * docs/05「各判定ポイントのゴールデンに注入ケース 1 件以上必須」）を含む。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  createGoldenCase,
  loadGoldenCases,
  loadFlaky,
  markFlaky,
  runGolden,
} from "../src/golden.js";
import { SYNTH_POINTS } from "../src/synth-points.js";

const fixturesDir = fileURLToPath(new URL("./fixtures/golden", import.meta.url));

describe("合成ゴールデン回帰（#4 DoD 1: 20 件以上で回帰が動く）", () => {
  it("fixtures の全ゴールデンケース（20 件以上）が expected と一致する", async () => {
    const report = await runGolden(fixturesDir, SYNTH_POINTS);
    // DoD: 合成ゴールデン 20 件以上
    expect(report.summary.total).toBeGreaterThanOrEqual(20);
    // expected は人手確定（cases.jsonl の expected_action）。全ケース一致
    expect(report.summary).toEqual({
      total: report.summary.total,
      pass: report.summary.total,
      fail: 0,
      unset: 0,
      flaky: 0,
    });
    // 合成ゴールデンは 4 ポイントに分配されている（closed / observe / open / boolean）
    const pointIds = new Set(report.results.map((r) => r.point_id));
    expect([...pointIds].sort()).toEqual(["synth-boolean", "synth-closed", "synth-observe", "synth-open"]);
  });

  it("closed ゲートのゴールデンに provider 失敗経路が含まれる（failMode closed → block）", async () => {
    const report = await runGolden(fixturesDir, SYNTH_POINTS);
    const failCase = report.results.find((r) => r.point_id === "synth-closed" && r.case === "provider-failure");
    expect(failCase?.status).toBe("pass");
    expect(failCase?.actual).toEqual({
      kind: "block",
      reason: "判定を実行できなかったためゲートを閉じた (point: synth-closed)",
    });
  });

  it("各判定ポイントに注入ケース（data 内指示文）が 1 件以上ある（docs/05・AGENTS.md 必須）", async () => {
    const report = await runGolden(fixturesDir, SYNTH_POINTS);
    for (const pointId of ["synth-boolean", "synth-closed", "synth-observe", "synth-open"]) {
      const injections = report.results.filter((r) => r.point_id === pointId && r.case.startsWith("injection"));
      expect(injections.length, `${pointId} に注入ケースがない`).toBeGreaterThanOrEqual(1);
      // 注入ケースは expected（応答に基づく本来の判定）と一致 — data 指示に従わない
      expect(injections.every((r) => r.status === "pass"), `${pointId} の注入ケースが expected 不一致`).toBe(true);
    }
  });
});

describe("createGoldenCase — expected の自動生成をしない", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-golden-create-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("スケルトンは expected_action: UNSET で作られ、回帰では fail（unset）に数える", async () => {
    createGoldenCase(dir, "synth-open", {
      case: "created-case",
      evidence: { meta: [{ title: "前提", text: "合成" }], data: [{ text: "合成" }] },
      attempts: [{ completion: { type: "score", score: 2, confidence: 0.9 } }],
    });
    const cases = loadGoldenCases(dir, "synth-open");
    expect(cases).toHaveLength(1);
    expect(cases[0]!.case).toBe("created-case");
    // expected は UNSET（ツールが expected を自動生成しない。人手で確定するまで回帰不能）
    expect(cases[0]!.expected_action).toBe("UNSET");

    const report = await runGolden(dir, SYNTH_POINTS);
    expect(report.results[0]!.status).toBe("unset");
    expect(report.summary.unset).toBe(1);
  });

  it("同 case 名の再作成は拒否する（expected の上書き防止）", () => {
    expect(() =>
      createGoldenCase(dir, "synth-open", {
        case: "created-case",
        evidence: { meta: [], data: [] },
        attempts: [{ completion: { type: "score", score: 0 } }],
      }),
    ).toThrow(/already exists/);
  });
});

describe("FLAKY — 境界で揺れる同一入力を分母から外す（docs/05）", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-golden-flaky-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flaky 登録したケースは status: flaky になり、pass/fail の分母から外れる", async () => {
    const jsonl = [
      JSON.stringify({
        case: "boundary-case",
        evidence: { meta: [], data: [{ text: "合成" }] },
        attempts: [{ completion: { type: "score", score: 2, confidence: 0.9 } }],
        expected_action: { kind: "pass" },
      }),
    ].join("\n");
    mkdirSync(join(dir, "synth-open"), { recursive: true });
    writeFileSync(join(dir, "synth-open", "cases.jsonl"), `${jsonl}\n`);
    markFlaky(dir, "synth-open/boundary-case", "境界で block/pass が揺れる");
    expect(loadFlaky(dir).has("synth-open/boundary-case")).toBe(true);

    const report = await runGolden(dir, SYNTH_POINTS);
    expect(report.results[0]!.status).toBe("flaky");
    // flaky は total に数えるが pass / fail には入らない（分母から外れる）
    expect(report.summary).toEqual({ total: 1, pass: 0, fail: 0, unset: 0, flaky: 1 });
  });
});

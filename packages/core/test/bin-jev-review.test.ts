/**
 * jev-review CLI の引数処理と表示（#28。bin-jev-observe / bin-jev-stop と同じ流儀）。
 * ロジック層（記録・引き継ぎ・集計）は review.test.ts。ここでは CLI 層 —
 * --feeling の検証（不正値は exit 1・値欠落はエラー）と report の feeling
 * 内訳行（annoy 割合の分母は記録済み体感 = docs/07 R3 と同じ）— を
 * 実際の main(argv) 経由で検査する。実 API を叩かない（AGENTS.md テスト方針）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/bin/jev-review.js";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const WOULD_BLOCK_LINE = JSON.stringify({
  at: "2026-09-20T00:00:00.000Z",
  status: "judged",
  action: "pass",
  point_id: "req-assertion-a1",
  reasons: [],
  ms_total: 1,
  fail_mode: "open",
  would_block: { reason: "false しきい値を満たした criterion: bypass" },
});

function writeLog(dir: string, lines: number): void {
  writeFileSync(join(dir, "jev-2026-09-20.jsonl"), `${Array(lines).fill(WOULD_BLOCK_LINE).join("\n")}\n`);
}

let logs: string[] = [];
let errors: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logs = [];
  errors = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("jev-review CLI — --feeling の検証（#28）", () => {
  it("ok|annoy|ignore 以外の feeling 値は exit 1 で拒否する（reviews.jsonl には書かない）", async () => {
    const dir = tempDir("jev-review-cli-bad-feeling-");
    writeLog(dir, 1);
    const code = await main(["1", "tp", "--feeling", "meh", "--dir", dir]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("feeling must be one of ok|annoy|ignore");
    expect(() => readFileSync(join(dir, "reviews.jsonl"))).toThrow();
  });

  it("--feeling の値欠落（次が別フラグ）は argValue の契約どおりエラーになる", async () => {
    const dir = tempDir("jev-review-cli-missing-value-");
    writeLog(dir, 1);
    await expect(main(["1", "tp", "--feeling", "--dir", dir])).rejects.toThrow(/missing value for --feeling/);
  });

  it("分類は --feeling 付きで成功し、reviews.jsonl に feeling を追記する", async () => {
    const dir = tempDir("jev-review-cli-classify-");
    writeLog(dir, 1);
    const code = await main(["1", "tp", "--feeling", "annoy", "--dir", dir, "迂回は事実として検出"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("classified tp (annoy): jev-2026-09-20.jsonl:1");
    const rec = JSON.parse(readFileSync(join(dir, "reviews.jsonl"), "utf8").trim()) as {
      ref: string;
      classification: string;
      feeling: string;
      note?: string;
    };
    expect(rec.ref).toBe("jev-2026-09-20.jsonl:1");
    expect(rec.classification).toBe("tp");
    expect(rec.feeling).toBe("annoy");
    expect(rec.note).toBe("迂回は事実として検出");
  });

  it("list は分類済みマークに feeling を併記する（feeling 未記録は [tp]、未分類は [?] のまま）", async () => {
    const dir = tempDir("jev-review-cli-list-");
    writeLog(dir, 2);
    await main(["1", "tp", "--feeling", "annoy", "--dir", dir]);
    logs = [];
    const code = await main(["list", "--dir", dir]);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("[tp:annoy] jev-2026-09-20.jsonl:1");
    expect(out).toContain("[?] jev-2026-09-20.jsonl:2");
  });
});

describe("jev-review CLI — report の feeling 内訳行（#28 週次サマリ）", () => {
  it("prefix 別に feeling 内訳行を出し、annoy 割合の分母は記録済み体感（docs/07 R3 と同じ）", async () => {
    const dir = tempDir("jev-review-cli-report-");
    writeLog(dir, 2);
    await main(["1", "tp", "--feeling", "annoy", "--dir", dir]);
    // :2 は未分類（unrecorded）。total 分母なら 50.0% になってしまうので、
    // 100.0% が出ることで分母が記録済み（ok+annoy+ignore）であることが固定される
    const code = await main(["report", "--dir", dir]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("feeling ok=0 annoy=1 ignore=0 unrecorded=1 (annoy 100.0%)");
  });

  it("体感が 1 件も記録されていない場合は割合を出さない（0 での比較を防ぐ）", async () => {
    const dir = tempDir("jev-review-cli-report-empty-");
    writeLog(dir, 1);
    const code = await main(["report", "--dir", dir]);
    expect(code).toBe(0);
    const line = logs.find((l) => l.includes("feeling "))!;
    expect(line).toBe("    feeling ok=0 annoy=0 ignore=0 unrecorded=1");
  });
});

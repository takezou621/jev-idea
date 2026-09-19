/**
 * 判定ログ — docs/05 判定ログ仕様（jev-claude の実装を一般化）。
 * answers / reasons / トークン数 / 所要時間（試行ごとと judge 全体）/
 * evidence の由来ファイルと時刻 / コマンド文字列先頭 200 文字 /
 * ディレクトリ 0700 / ファイル 0600。
 * 判定ログの実データはリポジトリに入れないため、書き込み先は tmp で確認する。
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileSink, type LogEntry } from "../src/log.js";
import { judge } from "../src/judge.js";
import type { Criterion, JudgeProvider } from "../src/types.js";

const BOOLEAN: Criterion = {
  type: "boolean",
  id: "bypass",
  question: "検証を迂回する経路があるか",
};

const provider: JudgeProvider = async () => ({
  answers: { bypass: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 42, output_tokens: 3 },
  model: "stub",
});

describe("judge のログ（docs/05 判定ログ仕様）", () => {
  const entries: LogEntry[] = [];
  const sink = (e: LogEntry) => entries.push(e);

  it("必須フィールドを含むログが 1 件出る", async () => {
    const r = await judge(
      {
        id: "log-point",
        criteria: [BOOLEAN],
        evidence: () => ({
          meta: [{ title: "前提", text: "事実列" }],
          data: [{ text: "生データ", source: "/tmp/state.txt", sourceTime: "2026-09-19T00:00:00Z", command: "node -e 'console.log(1)'" }],
        }),
        decision: () => ({ kind: "block", reason: "検証コマンドの実行痕跡が transcript にない" }),
        failMode: "open",
      },
      {
        provider,
        log: sink,
        label: "stop",
        project: "jev-mcp",
        sessionId: "test-session",
      },
    );
    expect(r.status).toBe("judged");
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.label).toBe("stop");
    expect(e.point_id).toBe("log-point");
    expect(e.project).toBe("jev-mcp");
    expect(e.session_id).toBe("test-session");
    expect(e.status).toBe("judged");
    expect(e.action).toBe("block");
    expect(e.reasons).toEqual(["検証コマンドの実行痕跡が transcript にない"]);
    expect(e.answers).toEqual({ bypass: { criterion: "bypass", p: 0.9 } });
    expect(e.usage).toEqual({ input_tokens: 42, output_tokens: 3 });
    expect(typeof e.ms_total).toBe("number");
    // 試行ごとの所要時間（多数決 helper は複数試行になるため配列）
    expect(Array.isArray(e.ms_try)).toBe(true);
    expect(typeof e.at).toBe("string");
    // evidence の由来（docs/05「evidence の由来ファイルと時刻」）。
    // 生テキストはスナップショット（#4）に譲り、ログには由来のみを残す
    expect(e.evidence).toEqual([
      { index: 0, section: "meta", title: "前提" },
      {
        index: 1,
        section: "data",
        source: "/tmp/state.txt",
        sourceTime: "2026-09-19T00:00:00Z",
        command: "node -e 'console.log(1)'",
      },
    ]);
  });

  it("meta と data の分離が section 種別としてログに記録される（#2 DoD 2）", async () => {
    const r = await judge(
      {
        id: "log-meta-data",
        criteria: [BOOLEAN],
        evidence: () => ({
          meta: [
            { title: "検出 1", text: "事実 1" },
            { title: "検出 2", text: "事実 2" },
          ],
          data: [{ text: "生データ" }],
        }),
        decision: () => ({ kind: "pass" }),
        failMode: "open",
      },
      { provider, log: sink },
    );
    expect(r.status).toBe("judged");
    const e = entries[entries.length - 1]!;
    expect(e.evidence?.map((s) => s.section)).toEqual(["meta", "meta", "data"]);
  });

  it("コマンド文字列は先頭 200 文字に切る", async () => {
    const long = "x".repeat(500);
    const r = await judge(
      {
        id: "log-cmd",
        criteria: [BOOLEAN],
        evidence: () => ({ meta: [], data: [{ text: "d", command: long }] }),
        decision: () => ({ kind: "pass" }),
        failMode: "open",
      },
      { provider, log: sink },
    );
    expect(r.status).toBe("judged");
    const e = entries[entries.length - 1]!;
    expect(e.evidence?.[0]?.command).toHaveLength(200);
  });

  it("失敗時のログに error と failMode に従った action が残る", async () => {
    const before = entries.length;
    const r = await judge(
      {
        id: "log-fail",
        criteria: [BOOLEAN],
        evidence: () => ({ meta: [], data: [{ text: "d" }] }),
        decision: () => ({ kind: "pass" }),
        failMode: "closed",
      },
      {
        provider: async () => {
          throw new Error("network down");
        },
        log: sink,
      },
    );
    expect(r.status).toBe("failed");
    const e = entries[entries.length - 1]!;
    expect(entries.length).toBe(before + 1);
    expect(e.point_id).toBe("log-fail");
    expect(e.status).toBe("failed");
    // 失敗段階のプレフィックス付き（provider 障害と decision のバグを区別する）
    expect(e.error).toBe("provider: network down");
    expect(e.action).toBe("block");
  });

  it("ログ書き込みが失敗しても judge は成功する（best effort）", async () => {
    const r = await judge(
      {
        id: "log-broken",
        criteria: [BOOLEAN],
        evidence: () => ({ meta: [], data: [{ text: "d" }] }),
        decision: () => ({ kind: "pass" }),
        failMode: "open",
      },
      {
        provider,
        log: () => {
          throw new Error("disk full");
        },
      },
    );
    expect(r.status).toBe("judged");
  });
});

describe("fileSink — ディレクトリ 0700 / ファイル 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-log-test-"));
  const logDir = join(dir, "logs");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("既定ディレクトリを作り、jsonl に 1 行 1 エントリで追記する", () => {
    const sink = fileSink(logDir);
    const entry = (pointId: string, status: "judged" | "failed"): LogEntry => ({
      at: new Date().toISOString(),
      point_id: pointId,
      status,
      action: "pass",
      reasons: [],
      ms_total: 0,
      fail_mode: "open",
    });
    // ディレクトリ・ファイルは最初の書き込み時に作られる（常駐プロセスでも
    // fd を握らず、日跨ぎで新ファイルに切り替わる）
    sink(entry("p1", "judged"));
    expect(statSync(logDir).mode & 0o777).toBe(0o700);
    sink(entry("p2", "failed"));
    const files = readdirSync(logDir).filter((f) => f.startsWith("jev-") && f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(logDir, files[0]!), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).point_id).toBe("p2");
    expect(statSync(join(logDir, files[0]!)).mode & 0o777).toBe(0o600);
  });

  it("既存ディレクトリの権限は緩めない", () => {
    const loose = join(dir, "loose");
    mkdirSync(loose, { mode: 0o755 });
    const sink = fileSink(loose);
    sink({
      at: new Date().toISOString(),
      point_id: "p3",
      status: "judged",
      action: "pass",
      reasons: [],
      ms_total: 0,
      fail_mode: "open",
    });
    // 既存ディレクトリを作り直して権限を広げることはしない
    expect(statSync(loose).mode & 0o777).toBe(0o755);
  });
});

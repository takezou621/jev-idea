/**
 * jev-judge MCP クライアント（src/mcp/client.ts・#18 配線）。
 *
 * spawn するサーバーは node 標準ライブラリだけで書いた stub スクリプト
 * （1 行 1 メッセージの JSON-RPC・応答列を引数の json ファイルで指定）。
 * プロセス境界・initialize ハンドシェイク・tools/call の往復・isError・
 * タイムアウト・プロセス断・close を本物の child_process 経由で確認する
 * （dist ビルドに依存しない。実 jev-judge bin との E2E はビルド後の smoke）。
 * Jev は呼ばない（ネットワークなし — AGENTS.md テスト方針）
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CLIENT_BUDGET_MS, McpClientError, startJevJudgeClient } from "../src/mcp/client.js";

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const STUB_SCRIPT = `
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
const seq = JSON.parse(readFileSync(process.argv[2], "utf8"));
let i = 0;
const rl = createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
  if (line.trim().length === 0) continue;
  const msg = JSON.parse(line);
  if (msg.id === undefined) continue; // 通知は無視（server 側と同じ契約）
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } } }) + "\\n");
    continue;
  }
  const item = seq[Math.min(i, seq.length - 1)];
  i++;
  if (item === "EXIT") process.exit(3);
  if (item === "SILENT") continue; // 応答しない（タイムアウトテスト用）
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: item }) + "\\n");
}
`;

function startStub(seq: unknown[]) {
  const dir = tempDir("jev-client-");
  const script = join(dir, "stub.mjs");
  const seqFile = join(dir, "seq.json");
  writeFileSync(script, STUB_SCRIPT);
  writeFileSync(seqFile, JSON.stringify(seq));
  return { dir, command: [process.execPath, script, seqFile] };
}

const OK_RESULT = {
  isError: false,
  content: [{ type: "text", text: '{"status":"judged","action":{"kind":"pass"},"summary":"p: judge ok"}' }],
  structuredContent: { status: "judged", action: { kind: "pass" }, summary: "req-assertion-a1: bypass=false → pass" },
};

describe("startJevJudgeClient — 実プロセス経由の JSON-RPC（docs/06 配線側）", () => {
  it("initialize → judge（tools/call）の往復が通り、structuredContent をそのまま返す", async () => {
    const { command } = startStub([OK_RESULT]);
    const client = await startJevJudgeClient({ command, budgetMs: 5000 });
    try {
      const out = await client.judge({ point: "req-assertion-a1", evidence: { kind: "inline", inline: [{ text: "x" }] }, opts: { repeats: 3 } });
      expect(out).toEqual({ status: "judged", action: { kind: "pass" }, summary: "req-assertion-a1: bypass=false → pass" });
    } finally {
      await client.close();
    }
  });

  it("isError の結果は throw（入力不正は配線エラーとして上位に届く）。2 回目も呼べる", async () => {
    const { command } = startStub([OK_RESULT, { isError: true, content: [{ type: "text", text: "evidence path not found: x" }] }]);
    const client = await startJevJudgeClient({ command, budgetMs: 5000 });
    try {
      await expect(client.judge({ point: "req-assertion-a1" })).resolves.toMatchObject({ status: "judged" });
      await expect(client.judge({ point: "req-assertion-a1" })).rejects.toThrow(/evidence path not found/);
      // throw してもクライアントは壊れない（プロセスは生きている）
      await expect(client.judge({ point: "x" })).rejects.toThrow(McpClientError);
    } finally {
      await client.close();
    }
  });

  it("出力契約（docs/06 {status, action, summary}）から外れる応答は throw", async () => {
    const { command } = startStub([{ isError: false, content: [], structuredContent: { foo: 1 } }]);
    const client = await startJevJudgeClient({ command, budgetMs: 5000 });
    try {
      await expect(client.judge({ point: "req-assertion-a1" })).rejects.toThrow(/unexpected output/);
    } finally {
      await client.close();
    }
  });

  it("タイムアウトで throw し、プロセスは close できる", async () => {
    const { command } = startStub(["SILENT"]);
    const client = await startJevJudgeClient({ command, budgetMs: 150 });
    try {
      await expect(client.judge({ point: "req-assertion-a1" })).rejects.toThrow(/timed out/);
      await client.close();
    } finally {
      await client.close();
    }
  });

  it("プロセス断（stub が exit）で pending は reject し、以降の judge も reject", async () => {
    const { command } = startStub(["EXIT"]);
    const client = await startJevJudgeClient({ command, budgetMs: 5000 });
    await expect(client.judge({ point: "req-assertion-a1" })).rejects.toThrow(/exited/);
    await expect(client.judge({ point: "req-assertion-a1" })).rejects.toThrow(McpClientError);
    await client.close();
  });

  it("spawn できないコマンドは起動時に throw（プロセス error 経由）", async () => {
    await expect(startJevJudgeClient({ command: ["/nonexistent/jev-nothing"], budgetMs: 2000 })).rejects.toThrow(/jev-judge/);
  });

  it("CLIENT_BUDGET_MS はサーバー側 judge の既定予算より余裕がある", () => {
    expect(CLIENT_BUDGET_MS).toBeGreaterThan(120000);
  });
});

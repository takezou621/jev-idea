/**
 * jev-judge MCP サーバーの stdio クライアント（docs/06・#18 配線）。
 *
 * ホスト（jev-observe CLI・CI）から jev-judge bin を spawn して JSON-RPC で
 * judge を呼ぶ。判定の実行と決定はサーバー側（core）で完結し、クライアントが
 * 受け取るのは {status, action, summary} のみ（最重要原則 2。p はこの層にも
 * 現れない — jev-judge の出力契約）。依存最小主義のため標準ライブラリのみ。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Action } from "../types.js";

/** 既定で spawn する jev-judge bin（dist 配置。テスト・src 実行時は command を上書きする） */
export const JEV_JUDGE_BIN = fileURLToPath(new URL("../bin/jev-judge.js", import.meta.url));

/** jev-judge ツールの出力（docs/06 契約: {status, action, summary}。p・answers は含まれない） */
export type JudgeToolOutput = {
  status: "judged" | "failed";
  action: Action;
  summary: string;
};

export type JevJudgeClientOptions = {
  /** spawn コマンド。既定は [process.execPath, JEV_JUDGE_BIN] */
  command?: readonly string[];
  /** サーバープロセスの cwd（既定: process.cwd()）。paths の解決起点にもなる */
  cwd?: string;
  /** 追加環境変数（JEV_LOG_DIR・JEV_EVIDENCE_ROOT 等）。process.env にマージして渡す */
  env?: Record<string, string>;
  /** 1 回の tools/call のタイムアウト（ミリ秒）。超過でその呼び出しを reject
   *  する（プロセスは生存するため close() で回収する）。
   *  サーバー側 judge の既定予算 120000 より余裕を持たせる（起動時間分） */
  budgetMs?: number;
};

export type JevJudgeClient = {
  /** judge ツールを呼ぶ。サーバー側の判定失敗（status: "failed"）は正常応答。
   *  isError の結果（入力不正）・タイムアウト・プロセス断は throw */
  judge(input: { point: string; evidence?: unknown; opts?: unknown }): Promise<JudgeToolOutput>;
  /** プロセスを終了させる（stdin 断 → 終了待ち → タイムアウトで SIGKILL） */
  close(): Promise<void>;
};

type Pending = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export class McpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpClientError";
  }
}

/** クライアント既定のタイムアウト。サーバー側 judge 既定 120s + 起動・書き出しの余裕 */
export const CLIENT_BUDGET_MS = 150000;

export async function startJevJudgeClient(opts: JevJudgeClientOptions = {}): Promise<JevJudgeClient> {
  const command = opts.command ?? [process.execPath, JEV_JUDGE_BIN];
  const proc = spawn(command[0]!, command.slice(1), {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderrTail: string[] = [];
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderrTail.push(chunk.toString());
    if (stderrTail.length > 20) stderrTail.shift();
  });

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let dead: Error | undefined;
  let closed = false;
  const rl = createInterface({ input: proc.stdout!, terminal: false });
  rl.on("line", (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 1 行 1 メッセージ契約の外の断片は無視（stdout は JSON-RPC 専用 — docs/06）
    }
    const { id, error, result } = msg as Record<string, unknown>;
    if (typeof id !== "number" || !pending.has(id)) return;
    const p = pending.get(id)!;
    pending.delete(id);
    clearTimeout(p.timer);
    if (error !== undefined) {
      const e = error as { message?: string };
      p.reject(new McpClientError(`mcp error ${JSON.stringify(error)}: ${e.message ?? ""}`));
      return;
    }
    p.resolve(result);
  });

  const markDead = (err: Error) => {
    dead = err;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };
  proc.on("error", (err) => markDead(new McpClientError(`jev-judge process error: ${err.message}`)));
  proc.on("exit", (code, signal) =>
    markDead(new McpClientError(`jev-judge exited (code=${code ?? "null"} signal=${signal ?? "null"})${stderrNote(stderrTail)}`)),
  );

  const request = (method: string, params: unknown, budgetMs: number): Promise<unknown> => {
    if (dead !== undefined) return Promise.reject(dead);
    const id = nextId++;
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpClientError(`mcp ${method} timed out (${budgetMs}ms)`));
      }, budgetMs);
      pending.set(id, { resolve, reject, timer });
      // 書き込み断（プロセス断）は exit イベント経由で markDead が拾う
      proc.stdin!.write(`${req}\n`);
    });
  };

  // initialize → 応答 → initialized 通知（通知は応答なし。サーバー側が無視する）。
  // 失敗時はクライアントを受け取る前に throw するため、spawn したプロセスを
  // ここで回収する（呼び出し側に close() の機会はない）
  const budget = opts.budgetMs ?? CLIENT_BUDGET_MS;
  try {
    await request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "jev-mcp-client", version: "0.1.0" } }, budget);
  } catch (err) {
    proc.kill("SIGKILL");
    throw err;
  }
  proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  return {
    async judge(input) {
      const result = await request("tools/call", { name: "judge", arguments: input }, budget);
      const r = result as { isError?: boolean; content?: { text?: string }[]; structuredContent?: unknown };
      if (r?.isError === true) {
        throw new McpClientError(`judge tool error: ${r.content?.map((c) => c.text ?? "").join(" ") ?? "unknown"}`);
      }
      // 出力契約（docs/06）: {status, action, summary}。欠けている応答は契約違反として扱う
      const sc = r?.structuredContent as JudgeToolOutput | undefined;
      if (sc === undefined || typeof sc.status !== "string" || typeof sc.summary !== "string" || typeof sc.action !== "object" || sc.action === null) {
        throw new McpClientError(`judge tool returned unexpected output: ${JSON.stringify(result).slice(0, 200)}`);
      }
      return sc;
    },
    async close() {
      if (closed) return;
      closed = true;
      // 既に exit しているプロセスには exit イベントが再来しない
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      proc.stdin!.end();
      const t = setTimeout(() => proc.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(t);
    },
  };
}

function stderrNote(tail: string[]): string {
  const s = tail.join("").trim();
  return s.length > 0 ? ` stderr: ${s.slice(-500)}` : "";
}

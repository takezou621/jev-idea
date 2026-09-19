/**
 * 最小の MCP（stdio トランスポート・JSON-RPC 2.0）実装（docs/06・#5）。
 *
 * 依存最小主義（AGENTS.md）のため公式 SDK を使わず、jev-judge が要る範囲
 * （initialize / ping / tools/list / tools/call + 通知の無視）だけを扱う。
 * stdout には JSON-RPC メッセージ以外を一切書かない（診断は stderr）。
 *
 * ツールレベルの失敗（入力不正・実行時エラー）は isError: true の結果として
 * 返す（MCP の規約。プロトコルエラーは未知メソッド等のプロトコル違反のみ）。
 */
import { createInterface } from "node:readline";

/** 既定のプロトコル版。クライアントが版を指定したらそれをそのまま返す（寛容側） */
export const PROTOCOL_VERSION = "2025-06-18";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolCallResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

export type ServerState = {
  serverInfo: { name: string; version: string };
  tools: readonly ToolDef[];
  call: (name: string, args: unknown) => Promise<ToolCallResult>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

function ok(id: JsonRpcResponse["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcResponse["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function errorResult(message: string): ToolCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * 1 行（1 メッセージ）を処理する。応答のないメッセージ（通知・空行・
 * パース不能な他方式のフレーム）は undefined を返す。テストはここを直接叩く
 */
export async function handleMessage(state: ServerState, line: string): Promise<JsonRpcResponse | undefined> {
  if (line.trim().length === 0) return undefined;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, PARSE_ERROR, "parse error");
  }
  if (typeof msg !== "object" || msg === null) return fail(null, INVALID_REQUEST, "invalid request");
  const { jsonrpc, id, method, params } = msg as Record<string, unknown>;
  if (jsonrpc !== "2.0" || typeof method !== "string") return fail(asId(id), INVALID_REQUEST, "invalid request");
  if (id === undefined) return undefined; // 通知（initialized / cancelled など）は無視

  switch (method) {
    case "initialize": {
      const requested = (typeof params === "object" && params !== null ? (params as Record<string, unknown>).protocolVersion : undefined);
      return ok(asId(id), {
        protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: state.serverInfo,
      });
    }
    case "ping":
      return ok(asId(id), {});
    case "tools/list":
      return ok(asId(id), { tools: state.tools });
    case "tools/call": {
      const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
      const name = p.name;
      if (typeof name !== "string" || !state.tools.some((t) => t.name === name)) {
        return fail(asId(id), INVALID_PARAMS, `unknown tool: ${String(name)}`);
      }
      try {
        return ok(asId(id), await state.call(name, p.arguments));
      } catch (err) {
        // ツール実行の失敗はプロトコルエラーにしない（isError の結果として返す）
        return ok(asId(id), errorResult(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      return fail(asId(id), METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

function asId(id: unknown): JsonRpcResponse["id"] {
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** stdio ループ。stdin の 1 行を 1 メッセージとして順に処理し、応答だけを stdout へ書く */
export async function runStdio(
  state: ServerState,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const rl = createInterface({ input, terminal: false });
  for await (const line of rl) {
    const resp = await handleMessage(state, line);
    if (resp !== undefined) output.write(`${JSON.stringify(resp)}\n`);
  }
}

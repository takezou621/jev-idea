/**
 * jev-judge MCP サーバー（stdio・docs/06・#5）。
 *
 * 判定の実行と決定はここ（core）で完結し、ホストには action のみを返す
 * （最重要原則 2）。判定ポイント定義は 1 か所（合成ゴールデン用の SYNTH_POINTS
 * + 実ポイント。docs/06「実ポイントはここに登録する」）。
 */
import { SYNTH_POINTS } from "../synth-points.js";
import { REQ_ASSERTION_A1, REQ_ASSERTION_A23 } from "../points/req-assertion-a.js";
import type { JudgmentPoint, JudgeProvider } from "../types.js";
import type { LogSink } from "../log.js";
import { judgeTool, type JevJudgeDeps } from "./jev-judge.js";
import type { ServerState } from "./protocol.js";

export const SERVER_NAME = "jev-judge";
export const SERVER_VERSION = "0.1.0";

export type CreateJevJudgeServerOptions = Omit<JevJudgeDeps, "points"> & {
  points?: readonly JudgmentPoint[];
  provider?: JudgeProvider;
  log?: LogSink | false;
  name?: string;
  version?: string;
};

export function createJevJudgeServer(opts: CreateJevJudgeServerOptions = {}): ServerState {
  const deps: JevJudgeDeps = {
    points: opts.points ?? [...SYNTH_POINTS, REQ_ASSERTION_A1, REQ_ASSERTION_A23],
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    ...(opts.log === undefined ? {} : { log: opts.log }),
    ...(opts.logDir === undefined ? {} : { logDir: opts.logDir }),
    ...(opts.evidenceRoot === undefined ? {} : { evidenceRoot: opts.evidenceRoot }),
  };
  const { tool, call } = judgeTool(deps);
  return {
    serverInfo: { name: opts.name ?? SERVER_NAME, version: opts.version ?? SERVER_VERSION },
    tools: [tool],
    call: (name, args) => call(args),
  };
}

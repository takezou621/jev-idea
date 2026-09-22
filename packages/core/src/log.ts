/**
 * 判定ログ — docs/05 判定ログ仕様の実装（jev-claude の log() を一般化）。
 * 判定ログ・スナップショットは機密を含むためリポジトリに入れない
 * （ディレクトリ 0700 / ファイル 0600、既定は ~/.jev/logs）。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { LogFileName } from "./requirements/core.req.js";
import type { Action, Answer, Evidence, FailMode } from "./types.js";

export type LogEvidenceSection = {
  /** meta + data を通したセクション番号 */
  index: number;
  /** meta / data の種別（docs/05 メタ分離。判定ログに分離を記録する — #2 DoD 2） */
  section: "meta" | "data";
  title?: string;
  /** evidence の由来（ファイルパスなど） */
  source?: string;
  /** 由来の時刻（ファイル mtime など） */
  sourceTime?: string;
  /** 由来コマンド。先頭 200 文字のみ（docs/05 判定ログ仕様） */
  command?: string;
};

export type LogEntry = {
  at: string;
  label?: string;
  point_id: string;
  project?: string;
  session_id?: string;
  status: "judged" | "failed";
  action: Action["kind"];
  reasons: string[];
  /** 正規化済み Answer（ログは 0600 の機密扱い。ホストには出ない） */
  answers?: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
  model?: string;
  ms_total: number;
  /** provider 試行ごとの所要時間（多数決 helper は複数試行 — docs/05「試行ごと」） */
  ms_try?: number[];
  /**
   * observe 中の would-block（docs/05・#3）。block になったが pass を返した
   * 記録。reason は本来の block の事実文。tp/fp 分類の対象（#4）
   */
  would_block?: { reason: string };
  evidence?: LogEvidenceSection[];
  fail_mode: FailMode;
  error?: string;
};

export type LogSink = (entry: LogEntry) => void;

/** ログエントリの evidence 由来部を組立てる。生テキストは載せない（スナップショットは #4）。 */
export function toLogEvidence(evidence: Evidence): LogEvidenceSection[] {
  const out: LogEvidenceSection[] = [];
  let i = 0;
  const push = (section: "meta" | "data", s: (typeof evidence)["meta"][number]) => {
    out.push({
      index: i++,
      section,
      ...(s.title === undefined ? {} : { title: s.title }),
      ...(s.source === undefined ? {} : { source: s.source }),
      ...(s.sourceTime === undefined ? {} : { sourceTime: s.sourceTime }),
      ...(s.command === undefined ? {} : { command: s.command.slice(0, 200) }),
    });
  };
  for (const s of evidence.meta) push("meta", s);
  for (const s of evidence.data) push("data", s);
  return out;
}

/** docs/05: block の reason と同様、reasons はアクションの事実文のみ。 */
export function toReasons(action: Action): string[] {
  switch (action.kind) {
    case "block":
      return [action.reason];
    case "warn":
      return [action.note];
    case "escalate":
      return [action.question];
    case "pass":
      return [];
  }
}

/** ログディレクトリの解決（fileSink と review（#4）で共有。docs/05 配置） */
export function resolveLogDir(logDir?: string): string {
  return logDir ?? process.env.JEV_LOG_DIR ?? join(homedir(), ".jev", "logs");
}

/**
 * jsonl への追記シンク。ディレクトリ 0700 / ファイル 0600（docs/05）。
 * 既存ディレクトリ・ファイルの権限は変えない（利用者が持つ権限を勝手に締めない）。
 * 書き込みのたびにパスを解決して追記する（常駐プロセス — #5 の MCP サーバー —
 * で fd を握りっぱなしにしない。日跨ぎで新ファイルに切り替わる）。
 * ログ失敗は判定に影響させない（呼び出し側の best effort）。
 */
export function fileSink(logDir?: string): LogSink {
  return (entry: LogEntry) => {
    try {
      const dir = resolveLogDir(logDir);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        chmodSync(dir, 0o700); // umask で緩まないように
      }
      const now = new Date();
      const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
      const path = join(dir, `jev-${local.toISOString().slice(0, 10)}.jsonl`);
      // 宣言済み命名規約（core.req.ts）から外れるファイル名は書かない。
      // 書かなかった事実は stderr に出す（判定には影響させない — docs/05「ログ失敗は
      // 判定に影響しない」。ただし黙っていると「判定が一度も走らなかった」と区別できない）
      if (!new RegExp(LogFileName.pattern).test(basename(path))) {
        process.stderr.write(`jev log: file name does not match the declared pattern, judgment log not written (${basename(path)})\n`);
        return;
      }
      const existed = existsSync(path);
      appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
      if (!existed) chmodSync(path, 0o600);
    } catch {
      // ディレクトリ・ファイルが用意できない環境でも判定は動く（サイレント）
    }
  };
}

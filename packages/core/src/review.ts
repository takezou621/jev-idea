/**
 * review — tp/fp 分類（docs/05「ログ・ゴールデン・tp/fp 分類」・#4）。
 *
 * 判定ログ（block / would-block）を一覧し、人間が `tp | fp | unclear` で
 * 分類する。分類は**追記・後勝ち**（覆した経過も reviews.jsonl に残る）。
 * tp はゴールデン化の材料。テスト由来のログ（label の `golden-` / `mj-`
 * 接頭辞）は実運用と分けて数える。機密の扱いは判定ログと同じ（0700 / 0600）。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveLogDir, type LogEntry } from "./log.js";

export type Classification = "tp" | "fp" | "unclear";

export type ReviewEntry = {
  /** ログ上の位置（"jev-YYYY-MM-DD.jsonl:<行番号>"。分類は ref に対して記録する） */
  ref: string;
  entry: LogEntry;
};

export type ReviewRecord = {
  at: string;
  ref: string;
  classification: Classification;
  note?: string;
};

export type ReviewCounts = {
  total: number;
  unclassified: number;
  tp: number;
  fp: number;
  unclear: number;
};

export type ReviewReport = {
  /** label 接頭辞別（"golden-" / "mj-" はテスト由来。接頭辞なしは実運用 "production"） */
  by_prefix: { prefix: string; counts: ReviewCounts }[];
  /** tp/fp 表（point_id 別） */
  by_point: { point_id: string; counts: ReviewCounts }[];
};

/**
 * block か would-block のログだけが tp/fp 分類の対象（docs/05）。status:
 * "judged" に限定する — failMode 経路（status: "failed"）の block は判定の
 * 正誤ではなく故障であり、tp/fp 表の分母に入れると品質指標が濁る
 * （docs/05「判定失敗の failMode 経路は would-block ではない」と同型の分離）
 */
function isReviewTarget(e: LogEntry): boolean {
  return e.status === "judged" && (e.action === "block" || e.would_block !== undefined);
}

/** logDir の判定ログを走査し、分類対象のエントリを決定的な順序（ファイル名・行番号）で返す */
export function loadReviewTargets(logDir?: string): ReviewEntry[] {
  const dir = resolveLogDir(logDir);
  if (!existsSync(dir)) return [];
  const out: ReviewEntry[] = [];
  for (const name of readdirSync(dir).filter((n) => /^jev-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
    const lines = readFileSync(join(dir, name), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim().length === 0) continue;
      try {
        const entry = JSON.parse(lines[i]!) as LogEntry;
        if (isReviewTarget(entry)) out.push({ ref: `${name}:${i + 1}`, entry });
      } catch {
        // 壊れたログ行は分類対象にしない（ログは best effort 出力。review を止めない）
      }
    }
  }
  return out;
}

/**
 * 分類の読み込み。同一 ref に複数レコードがある場合は**後勝ち**（docs/05 追記・後勝ち）。
 * 壊れた行は `reviews.jsonl:<行番号>` 付きで拒否する（golden.ts parseJsonl と同じ
 * 流儀。黙ってスキップすると tp にしたはずの分類が消えたように見える）
 */
export function loadClassifications(logDir?: string): Map<string, ReviewRecord> {
  const name = "reviews.jsonl";
  const file = join(resolveLogDir(logDir), name);
  const latest = new Map<string, ReviewRecord>();
  if (!existsSync(file)) return latest;
  for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
    if (line.trim().length === 0) continue;
    const at = (m: string) => `${name}:${i + 1}: ${m}`;
    let r: ReviewRecord;
    try {
      r = JSON.parse(line) as ReviewRecord;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(at(`invalid JSON (${msg})`));
    }
    if (typeof r.ref !== "string" || r.ref.length === 0) {
      throw new Error(at("ref must be a non-empty string"));
    }
    if (r.classification !== "tp" && r.classification !== "fp" && r.classification !== "unclear") {
      throw new Error(at("classification must be tp|fp|unclear"));
    }
    latest.set(r.ref, r);
  }
  return latest;
}

/** 分類を追記する。覆した経過も残す（既存レコードの書き換え・削除はしない） */
export function recordClassification(
  logDir: string | undefined,
  ref: string,
  classification: Classification,
  note?: string,
): void {
  const dir = resolveLogDir(logDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }
  const file = join(dir, "reviews.jsonl");
  const existed = existsSync(file);
  const record: ReviewRecord = {
    at: new Date().toISOString(),
    ref,
    classification,
    ...(note === undefined ? {} : { note }),
  };
  appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
  if (!existed) chmodSync(file, 0o600);
}

/** label の接頭辞（"golden-" / "mj-" 等）。接頭辞なしは実運用扱い */
export function labelPrefix(e: LogEntry): string {
  const label = e.label;
  if (label === undefined) return "production";
  const i = label.indexOf("-");
  if (i <= 0) return "production";
  return label.slice(0, i);
}

function emptyCounts(): ReviewCounts {
  return { total: 0, unclassified: 0, tp: 0, fp: 0, unclear: 0 };
}

/**
 * 分離集計 + tp/fp 表（docs/05「golden- / mj- 接頭辞の分離集計、tp/fp 表」）。
 * レポート自体は数値のみ（p や confidence を含まない）。
 */
export function reviewReport(logDir?: string): ReviewReport {
  const targets = loadReviewTargets(logDir);
  const latest = loadClassifications(logDir);
  const byPrefix = new Map<string, ReviewCounts>();
  const byPoint = new Map<string, ReviewCounts>();
  for (const t of targets) {
    const c = latest.get(t.ref)?.classification;
    const bump = (m: Map<string, ReviewCounts>, key: string) => {
      const counts = m.get(key) ?? emptyCounts();
      counts.total++;
      if (c === undefined) counts.unclassified++;
      else counts[c]++;
      m.set(key, counts);
    };
    bump(byPrefix, labelPrefix(t.entry));
    bump(byPoint, t.entry.point_id);
  }
  const sortEntries = <T>(entries: [string, T][]) =>
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    by_prefix: sortEntries([...byPrefix]).map(([prefix, counts]) => ({ prefix, counts })),
    by_point: sortEntries([...byPoint]).map(([point_id, counts]) => ({ point_id, counts })),
  };
}

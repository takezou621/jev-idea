/**
 * Evidence → state テキスト。
 *
 * 本実装は暫定の単純連結。メタ分離プロトコル（docs/05: meta と data の
 * 境界マーカー + 固定文 + 注入敵対ゴールデン）は #2（0-2）で導入する。
 * state の加工はここで止め、判定語・要約を付けない（evidence の
 * data セクションは生のままを契約とする）。
 */
import type { Evidence, Section } from "./types.js";

function sectionToText(s: Section): string {
  return s.title ? `[${s.title}]\n${s.text}` : s.text;
}

export function evidenceToState(evidence: Evidence): string {
  const meta = evidence.meta.map(sectionToText).join("\n\n");
  const data = evidence.data.map(sectionToText).join("\n\n");
  return [meta, data].filter((part) => part.length > 0).join("\n\n");
}

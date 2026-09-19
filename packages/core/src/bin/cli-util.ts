/** CLI（jev-golden / jev-review）共通の引数パース */

/** フラグの値を取り出す。フラグがあるのに値が欠落・別フラグならエラーにする
 *  （黙って既定値に落ちると意図しないディレクトリに書き込む事故になる） */
export function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return v;
}

/** 位置引数（flags とその値を除いた引数）を取り出す */
export function positional(args: string[], flags: string[]): string[] {
  const skip = new Set<number>();
  for (const f of flags) {
    // 同一フラグが複数回現れても全部スキップする（誤用時に残片が位置引数に混ざらないように）
    for (let i = args.indexOf(f); i >= 0; i = args.indexOf(f, i + 1)) {
      skip.add(i);
      skip.add(i + 1);
    }
  }
  return args.filter((_, i) => !skip.has(i));
}

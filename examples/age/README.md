# jev Stop フックの動作確認サンプル（#21）

`sample.ts`（アサーション `adult-age` の宣言 + 使用）を材料に、Claude Code の
Stop フック（`jev-stop` CLI）が「このターンで触れたアサーション」を事実として
表示する様子を確認する。observe 中のため停止は妨げない（記録と表示のみ。実
block は #19 以降）。

## 前提

1. `packages/core` で `npm run build`（フックは `packages/core/dist/bin/jev-stop.js` を起動する）
2. `.claude/settings.json` の Stop フックが有効なセッションでこのリポジトリを開く
   （判定には `TYPESAFE_API_KEY` が必要。未設定でも fail-open で「判定に失敗」が
   事実として表示される）

## 確認手順

1. **検出**: `examples/age/sample.ts` の `register` に何らかの変更をする
   （コメント 1 行の追加でよい）。ターンを終える（Stop する）と、フックが
   `systemMessage` で次の事実を表示する:
   - `diff が触れたアサーション: adult-age`
   - `req-assertion-a1: …` / `req-assertion-a23: …`（jev-judge の summary。p は含まれない）
2. **違反変更**: `register` に検証を通らない経路を足して Stop する。例:

   ```ts
   export function register(age: number): RegisteredAge {
     if (age >= 100) return age; // 検証を通さない経路（迂回）
     const violation = checkAdultAge(age);
     if (violation !== null) throw new Error(violation.message);
     return age;
   }
   ```

   判定 (a) の迂回観点（質問 1）の結果が事実として表示される（observe 中のため
   block はされない。would-block は判定ログに記録される）。`checkAdultAge` 自体は
   境界外（17・100 など）を violation で返すため、迂回経路は「検証が存在するのに
   通らない」実質的な違反になる
3. **クリーン**: 変更を commit または stash して Stop すると、何も表示せずに
   終わる（判定も実行しない）
4. **ログ**: `~/.jev/logs`（または `--log-dir` / `JEV_LOG_DIR`）に判定ログが
   0700/0600 で残る。p はこのログでだけ人間が見る

## 対象範囲の近似

「このターンで触れた」は `git diff HEAD`（未コミットの tracked 変更）の近似。
untracked（新規ファイル）は対象外で、ターン単位の正確な抽出は transcript 収集
（#22・docs/02）の範囲。`sample.ts` は宣言と使用が同一ファイルのため、定義側
（`require.number` の塊）を変更しても同様に検出される。

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Claude Code PreToolUse hook: ExitPlanMode（plan 承認要求）の前に、plan 本文を
// check-plan へ通す。実装前ワークフロー（risk-modeling / codebase-recon）の成果物
// または工程明記が無い plan での実装移行を、実装が始まる前にローカルで止める。
// 検査できない状況（stdin 不正・plan 本文を取得できない等）は fail-open とする。
// fail-open はゲートのサイレント無効化になり得るため stderr に 1 行残す
// （最終防衛線は従来どおり PR 段階の check-pr-body hook + CI artifacts-gate）。
// check-plan.js は mdast 依存（devDependencies）を持つため静的 import しない（#409）。
// npm install 前の fresh clone では依存解決に失敗する — その場合も main() 内の
// 動的 import + fail-open で吸収する（check-pr-body.js と同じパターン）。
// readPlanFile は node ビルトインのみ依存のため静的 export のまま維持する。
// 登録: .claude/settings.json の hooks.PreToolUse（matcher: ExitPlanMode）

function failOpen(reason) {
  if (reason) console.error(`check-plan-gates hook: ${reason}（検査をスキップします）`);
  process.exit(0);
}

// plan ファイル（plan-file モード）として読んでよいパスか検証して本文を返す。
// 対象外・検証失敗は null（呼び出し側が fail-open を選ぶ）。
// - プロジェクト配下 or ~/.claude 配下のみ（plan ファイルの既定置き場）。symlink 脱出を
//   防ぐため realpath 後にセグメント単位で包含判定する（startsWith 判定は禁止: INVARIANTS #12）
// - 巨大ファイルによるメモリ圧迫を避けるためサイズ上限つき
const MAX_PLAN_FILE_BYTES = 1_000_000;
export function readPlanFile(candidate, { projectDir, homeDir } = {}) {
  if (typeof candidate !== 'string' || !candidate.endsWith('.md')) return null;
  const roots = [
    projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    path.join(homeDir ?? homedir(), '.claude'),
  ];
  try {
    const real = realpathSync(candidate);
    const contained = roots.some((root) => {
      let realRoot;
      try {
        realRoot = realpathSync(root);
      } catch {
        return false; // root 不存在（~/.claude が無い等）はそのrootを対象外に
      }
      const rel = path.relative(realRoot, real);
      if (rel === '' || path.isAbsolute(rel)) return false;
      // 先頭セグメントの完全一致で判定する（rel.startsWith('..') だと `..plan.md` のような
      // 正当なファイル名まで root 外扱いになる）
      return rel.split(path.sep)[0] !== '..';
    });
    if (!contained) return null;
    const stat = statSync(real);
    // ディレクトリ等の非通常ファイルは isFile() で弾く（readFileSync の EISDIR 等の
    // 例外を制御フローに使わない。#408 Gemini 指摘）
    if (!stat.isFile() || stat.size > MAX_PLAN_FILE_BYTES) return null;
    return readFileSync(real, 'utf-8');
  } catch {
    return null; // 不存在・権限なし等は対象外として次の候補へ
  }
}

// stdin をストリームで全読みする。async 文脈では stdin が non-blocking になることがあり、
// readFileSync(0) は書き込み側（パイプ）が遅いと EAGAIN で失敗しうるため同期読みは使わない
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  // 手動実行（stdin が TTY）では stdin 読みが入力待ちでハングするため即 fail-open する
  if (process.stdin.isTTY) failOpen();

  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    failOpen('stdin の JSON を解釈できません');
  }

  const toolInput = input?.tool_input;

  // plan 本文の取得（優先順）: tool_input.plan → tool_input 中の実在 .md パス。
  // Claude Code のバージョンで tool_input の shape が揺れる（plan-file モードでは
  // plan 本文が引数に載らないことがある）ため、フィールド名に依存せず走査する。
  // 「plans ディレクトリの最新ファイルを漁る」案は別セッションの plan を掴む誤爆が
  // あるため採らない。フィールド名に "plan" を含む値を優先して探索する（無関係な
  // .md 参照フィールドが先に列挙された場合に誤って拾われるのを防ぐ #408 Gemini 指摘）
  let plan = null;
  const rawPlan =
    typeof toolInput?.plan === 'string' && toolInput.plan.trim() ? toolInput.plan : null;
  if (rawPlan !== null) {
    // tool_input.plan が読み取り可能な .md パスなら本文を読む（plan-file モードで plan に
    // パスが入る版がある。パスをそのまま本文扱いすると「ファイル名だけの docs 判定」で
    // 未充足 plan が素通りする #408 Codex 指摘）。パスでなければ readPlanFile が null を
    // 返すので rawPlan をそのまま本文として使う
    const asFile = readPlanFile(rawPlan);
    plan = asFile !== null ? asFile : rawPlan;
  }
  if (plan === null && toolInput && typeof toolInput === 'object') {
    const entries = Object.entries(toolInput);
    const planEntries = entries.filter(([key]) => key.toLowerCase().includes('plan'));
    const otherEntries = entries.filter(([key]) => !key.toLowerCase().includes('plan'));
    for (const [, value] of [...planEntries, ...otherEntries]) {
      const text = readPlanFile(value);
      if (text !== null) {
        plan = text;
        break;
      }
    }
  }
  if (plan === null) failOpen('plan 本文を取得できません');

  let checkPlan;
  try {
    ({ checkPlan } = await import('../check-plan.js'));
  } catch (err) {
    // 依存未解決（fresh clone）とそれ以外（check-plan 自体の構文エラー等）を stderr で
    // 区別する。どちらも fail-open だが、後者を fresh clone 扱いすると実装バグが
    // 「npm install してください」に見えて発見が遅れる
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      failOpen('check-plan を読み込めません（npm install 前の fresh clone の可能性）');
    }
    failOpen(`check-plan の読み込みで例外が発生しました: ${err?.message ?? err}`);
  }

  let errors, warnings;
  try {
    ({ errors, warnings } = checkPlan({ plan }));
  } catch (err) {
    failOpen(`検査中に例外が発生しました: ${err?.message ?? err}`);
  }
  // PreToolUse hook の stderr がエージェントに返るのは exit 2 のときのみ。
  // exit 0 時の警告は transcript にのみ残るログ用途
  for (const w of warnings) console.error(`check-plan-gates: ⚠ ${w}`);
  if (errors.length > 0) {
    console.error(
      'check-plan-gates hook: この plan には実装前ワークフローの工程・成果物がありません:',
    );
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error(
      'plan を修正してから再度 ExitPlanMode してください。コード変更を含まない計画等の例外は <!-- plan-gate: skip (理由) --> を plan に明記。',
    );
    process.exit(2); // exit 2 = ツール呼び出しをブロックし、stderr をエージェントに返す
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

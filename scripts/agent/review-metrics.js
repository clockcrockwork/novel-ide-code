// レビュー起動の計測。
//
// 目的: レビュー実行の共通化・モード分離で本当にレビューコストが下がったか・品質が落ちて
// いないかを
// 後から評価できるようにする。**独自の計測基盤は作らない** — 1 起動 1 行の JSONL 追記と
// 集計コマンドだけを持つ。
//
// 取得可能な指標（orchestrator が起動時・完了時に持っている値）と、
// Claude Code から取得できない指標を明示的に分ける（後者を取るために計測基盤を足さない）。
//
// 出力: `$(git rev-parse --git-path agent-review)/metrics.jsonl`

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ANGLE_TOKENS, CONDITIONAL_ANGLE_TOKENS } from './review-angle-tokens.js';
import { REVIEW_MODES } from './review-exec-config.js';
import { reviewRoot } from './review-snapshot.js';

const METRICS_FILE = 'metrics.jsonl';

// 取得可能: orchestrator が起動時・完了時に確定できる値のみ
export const OBTAINABLE_METRICS = [
  'snapshotId',
  'angle',
  'mode',
  'fresh',
  'model',
  'effort',
  'maxTurns',
  'status', // complete | incomplete | error（incomplete = maxTurns 到達等の未完了）
  'durationMs', // 親セッションが起動→完了で計測する壁時計時間
  'newFindings',
  'confirmedFindings',
  'externalFindings',
  'escalation',
];

// 取得不能: Claude Code はサブエージェントの内訳（トークン・turn・tool call）を
// 親セッションへ返さない。これらを取るための独自計測基盤は追加しない（非目的）。
// turn 数の近似としては maxTurns 到達の有無（status='incomplete'）のみが観測できる。
export const UNOBTAINABLE_METRICS = {
  tokens: 'サブエージェントのトークン消費は親セッションへ返らない',
  turns: 'turn 数は返らない。近似指標は status=incomplete（maxTurns 到達）の有無のみ',
  toolCalls: 'tool call 数は返らない',
};

export function metricsFile(cwd = process.cwd()) {
  return join(reviewRoot(cwd), METRICS_FILE);
}

export function record(entry, cwd = process.cwd()) {
  const root = reviewRoot(cwd);
  mkdirSync(root, { recursive: true });
  if (entry.angle && !(entry.angle in ANGLE_TOKENS) && !(entry.angle in CONDITIONAL_ANGLE_TOKENS)) {
    throw new Error(`未知の観点です: ${entry.angle}`);
  }
  if (entry.mode && !REVIEW_MODES[entry.mode]) {
    throw new Error(`未知のレビューモードです: ${entry.mode}`);
  }
  const row = { at: new Date().toISOString() };
  for (const key of OBTAINABLE_METRICS) {
    if (entry[key] !== undefined) row[key] = entry[key];
  }
  appendFileSync(join(root, METRICS_FILE), `${JSON.stringify(row)}\n`);
  return row;
}

export function readAll(cwd = process.cwd()) {
  const file = metricsFile(cwd);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function summarize(rows) {
  const byAngle = Object.create(null);
  let fresh = 0;
  let cont = 0;
  let incomplete = 0;
  let durationMs = 0;
  let newFindings = 0;
  let confirmed = 0;
  let external = 0;
  const byMode = Object.create(null);
  for (const m of Object.keys(REVIEW_MODES)) byMode[m] = 0;
  for (const r of rows) {
    if (r.angle) {
      byAngle[r.angle] = (byAngle[r.angle] ?? 0) + 1;
    }
    if (r.mode) byMode[r.mode] = (byMode[r.mode] ?? 0) + 1;
    if (r.fresh === true) fresh += 1;
    if (r.fresh === false) cont += 1;
    if (r.status === 'incomplete') incomplete += 1;
    durationMs += r.durationMs ?? 0;
    newFindings += r.newFindings ?? 0;
    confirmed += r.confirmedFindings ?? 0;
    external += r.externalFindings ?? 0;
  }
  return {
    invocations: rows.length,
    byAngle,
    byMode,
    fresh,
    continued: cont,
    incomplete,
    durationMs,
    newFindings,
    confirmedFindings: confirmed,
    externalFindings: external,
    escalations: rows.filter((r) => r.escalation).length,
  };
}

export function formatSummary(s) {
  const lines = [];
  lines.push(`レビュアー起動数: ${s.invocations}（fresh ${s.fresh} / 継続 ${s.continued}）`);
  lines.push(
    `モード別: ${Object.entries(s.byMode)
      .map(([k, v]) => `${REVIEW_MODES[k]?.label ?? k} ${v}`)
      .join(' / ')}`,
  );
  lines.push(
    `観点別: ${
      Object.entries(s.byAngle)
        .map(
          ([k, v]) => `${ANGLE_TOKENS[k]?.label ?? CONDITIONAL_ANGLE_TOKENS[k]?.label ?? k} ${v}`,
        )
        .join(' / ') || '(なし)'
    }`,
  );
  lines.push(
    `所見: 新規 ${s.newFindings} / 既出確認 ${s.confirmedFindings} / 外部新規 ${s.externalFindings}`,
  );
  lines.push(`未完了（maxTurns 到達等）: ${s.incomplete}`);
  lines.push(`Tier エスカレーション: ${s.escalations}`);
  lines.push(`合計実行時間: ${Math.round(s.durationMs / 1000)} 秒`);
  lines.push('');
  lines.push('取得不能な指標（独自計測基盤は追加しない）:');
  for (const [k, why] of Object.entries(UNOBTAINABLE_METRICS)) lines.push(`  - ${k}: ${why}`);
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const out = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === 'record') {
    const num = (v) => (v === undefined ? undefined : Number.parseInt(v, 10));
    const row = record({
      snapshotId: typeof args.snapshot === 'string' ? args.snapshot : undefined,
      angle: typeof args.angle === 'string' ? args.angle : undefined,
      mode: typeof args.mode === 'string' ? args.mode : undefined,
      // --fresh も --continue も無ければ未記録（undefined）にする。省略を false に倒すと
      // 集計上「継続」として数えられ、fresh/継続比が実態とずれる
      fresh:
        args.fresh === true || args.fresh === 'true'
          ? true
          : args.continue === true || args.continue === 'true'
            ? false
            : undefined,
      model: typeof args.model === 'string' ? args.model : undefined,
      effort: typeof args.effort === 'string' ? args.effort : undefined,
      maxTurns: num(args['max-turns']),
      status: typeof args.status === 'string' ? args.status : 'complete',
      durationMs: num(args['duration-ms']),
      newFindings: num(args['new-findings']),
      confirmedFindings: num(args['confirmed-findings']),
      externalFindings: num(args['external-findings']),
      escalation: args.escalation === true || args.escalation === 'true',
    });
    process.stdout.write(`${JSON.stringify(row)}\n`);
    return;
  }
  if (cmd === 'report') {
    process.stdout.write(formatSummary(summarize(readAll())));
    return;
  }
  process.stderr.write('usage: review-metrics.js <record|report> [options]\n');
  process.exit(1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])review-metrics\.js$/.test(process.argv[1])
) {
  main();
}

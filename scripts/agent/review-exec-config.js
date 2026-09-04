// 観点レビュアーの実行設定（model / effort / maxTurns）と再探索トリガーの正本。
// prose 側の正本: docs/agent-workflows/review-angles/README.md「レビューモード」「観点別の
// 再探索トリガー」「実行設定」。README との drift は tests/reviewExecConfig.test.js が機械検出する。
//
// classify-changes.js / review-angle-tokens.js と同じく **依存フリー**を維持する
// （node ビルトインのみ。CI から npm ci なしで参照できるように）。

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ANGLE_TOKENS, CONDITIONAL_ANGLE_TOKENS } from './review-angle-tokens.js';

// ---------------------------------------------------------------------------
// レビューモード
// ---------------------------------------------------------------------------

// 各周回でレビュアーに渡す「何を対象に何を問うか」の区分。
// 単純に「2周目以降は所見確認だけ」にすると、修正で探索空間が変わった観点の新規探索が
// 止まり初回の盲点が固定化するため、3 区分を明示的に分ける。
//
// **`findings-check`（所見確認）は machine が提案・記録しないモード**（`review-plan.js` の
// `MACHINE_RECORDABLE_MODES`）。所見の有無を machine state が持たなくなったため、起動側が
// review budget の枠（正本: docs/agent-workflows/review-angles/README.md
// 「review budget（自動探索の上限）」の枠表）に従って手動で起動し、実施と結果は
// docs/pr/PR-{番号}.md が持つ。
// 区分の語彙・patch・model 方針はレビュアーへ渡す指示として引き続きここが正本。
export const REVIEW_MODES = {
  'findings-check': {
    label: '所見確認',
    // 対象は前回所見＋修正差分のみ。新規探索は求めない
    patch: 'previous-to-current',
    explores: false,
  },
  'diff-explore': {
    label: '差分探索',
    // 前回 snapshot → 現在 snapshot の修正差分を対象に**新しい欠陥**を探索する
    patch: 'previous-to-current',
    explores: true,
  },
  'full-rescan': {
    label: '全体再探索',
    // merge-base → 現在 snapshot の PR 全体を fresh reviewer が探索する
    patch: 'base-to-current',
    explores: true,
  },
};

export const REVIEW_MODE_NAMES = Object.keys(REVIEW_MODES);

// ---------------------------------------------------------------------------
// 変更シグナル（review-plan.js が snapshot から算出し、本表が消費する）
// ---------------------------------------------------------------------------

// シグナル名の閉じた語彙。review-plan.js の deriveSignals とここが唯一の接点。
// 未知のシグナル名がトリガー表に現れたら tests/reviewExecConfig.test.js が落とす。
export const CHANGE_SIGNALS = [
  'code', // 非 prose ファイルの変更（classify-changes の codeChanged）
  'test', // tests/ e2e/ *.test.js *.spec.js
  'config', // ワークフロー・設定ファイル
  'dep', // 依存 manifest
  'designDoc', // 実行可能設計文書（DESIGN_DOC_PATTERNS）
  'recordDoc', // 記憶レコード（RECORD_DOC_PATTERNS）
  'docsOther', // 上記以外の説明文書
  'highRisk', // 高リスク領域（second-opinion-review.md §1）
  'guard', // ガード種（正規表現・バリデーション・分類器）の変更
  'newFile', // ファイル追加
  'deletion', // ファイル削除
  'conventionDoc', // 規約の正本（CLAUDE.md / REVIEW_GUIDELINES.md / INVARIANTS.md）
  'specAnchor', // 仕様アンカー（MVP_PLAN / ARCHITECTURE / docs/data-model）
  'riskTable', // 想定ケース表を含む計画文書
  // 設計文書の**意味的**変更（誤字修正と区別する）。完了条件・対象範囲・工程順・実行主体・
  // 中断/復旧手順・例外/境界・新しい成果物/規則/役割のいずれかに触れた疑いがある
  'semanticDoc',
];

// 高リスク領域（second-opinion-review.md §1 の表を機械判定へ落としたもの）。
// prose 側の正本は second-opinion-review.md で、drift は tests/reviewExecConfig.test.js が検出する。
export const HIGH_RISK_PATTERNS = [
  /^src\/lib\/tiptap\//, // editor: Tiptap / ProseMirror
  /^src\/components\/editor\//,
  /^src\/lib\/db\.js$/, // persistence: IndexedDB
  /^src\/lib\/lsCache\.js$/,
  /^src\/stores\//,
  /^src\/lib\/sync\.js$/, // GitHub sync / Worker
  /^src\/lib\/workerClient\.js$/,
  /^worker\//,
  /^scripts\/gh\//, // security boundary: 外部入力検証・token・repo 境界
  /^scripts\/policy\//,
  /^src\/lib\/markdown\.js$/, // 本文処理の性能・sanitize
  /^src\/lib\/diffCore\.js$/,
  /^src\/workers\//,
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
];

// ガード種（正規表現・バリデーション・分類器）を含むパス。patch 本文の走査と併用する。
export const GUARD_PATH_PATTERNS = [/^scripts\/agent\//, /^scripts\/policy\//, /^scripts\/gh\//];

// 規約の正本
export const CONVENTION_DOC_PATTERNS = [
  /^CLAUDE\.md$/,
  /^AGENTS\.md$/,
  /^GEMINI\.md$/,
  /^docs\/REVIEW_GUIDELINES\.md$/,
  /^docs\/data-model\/INVARIANTS\.md$/,
];

// 仕様アンカー（review-spec が期待挙動を自力導出する元）
export const SPEC_ANCHOR_PATTERNS = [
  /^docs\/MVP_PLAN\.md$/,
  /^docs\/ARCHITECTURE\.md$/,
  /^docs\/data-model\//,
  /^docs\/FUTURE_MAP\.md$/,
];

// 想定ケース表の所在（review-riskmodel のアンカー）
export const RISK_TABLE_PATTERNS = [
  /^docs\/planning\//,
  /^docs\/agent-workflows\/risk-modeling\.md$/,
];

export const TEST_PATTERNS = [/^tests?\//, /^e2e\//, /\.(test|spec)\.[cm]?[jt]sx?$/];

export const CONFIG_PATTERNS = [
  /^\.github\//,
  /^[^/]*\.(json|ya?ml|toml)$/,
  /^\.[^/]*rc(\.[cm]?js|\.json|\.ya?ml)?$/,
  /^(vite|vitest|playwright|eslint|knip|jscpd|depcruise)\.config\./,
];

// 設計文書の「意味的変更」を示す語彙。**誤字修正と区別する**ための肯定シグナル。
// 単なる語句の言い換えでは立たず、拘束力のある記述（完了条件・範囲・工程順・実行主体・
// 中断/復旧・例外/境界・新しい成果物/規則/役割）に触れた場合に立つ。
// 検出は fail-closed 側（迷ったら意味的変更とみなす）— 誤字だけと**証明できる**場合のみ落とす。
export const SEMANTIC_DOC_MARKERS = [
  // 完了条件・受け入れ条件
  '完了条件',
  '受け入れ条件',
  'Entry gate',
  'Verification gate',
  'Required artifacts',
  'Ground truth',
  // 対象範囲・スコープ
  '対象',
  '範囲',
  'スコープ',
  '非目的',
  '免除',
  '例外',
  '境界',
  // 工程順・手順
  '手順',
  'ステップ',
  '工程',
  '順序',
  '先に',
  '最終',
  // 実行主体
  '実行主体',
  '担当',
  'orchestrator',
  'implementer',
  'サブエージェント',
  '起動',
  // 中断・復旧
  '中断',
  '復旧',
  '再開',
  '差し戻し',
  '打ち切り',
  'LIMIT',
  // 規則・役割・成果物
  '必須',
  '禁止',
  '正本',
  '成果物',
  'ロール',
  '役割',
  '規則',
  'Tier',
  '収束',
];

// ---------------------------------------------------------------------------
// 観点別の再探索トリガー
// ---------------------------------------------------------------------------

// 各観点について「修正差分の新規探索が必要な条件 / base からの全体再探索が必要な条件」を
// 宣言する。
//
// 評価順（review-plan.js の selectMode）:
//   1. escalated（`escalate` による加算・Tier 再検証）→ full-rescan（fresh 強制）
//   2. 直近の起動が incomplete / error → 所見ゼロ扱いにせず再探索
//   3. 未実施（この観点をこの実効 Tier で一度も起動していない）→ full-rescan（初回探索）
//   4. fullRescanSignals のいずれかが修正差分に立つ → full-rescan
//   5. exploreSignals のいずれかが修正差分に立つ → diff-explore
//   6. どれにも当たらない → 起動しない（skip）
//
// **この表は予算を知らない。** 「対象が変わったか」までを答え、「何回まで自動で探索させるか」は
// `review-plan.js` の `applyBudget` が別に決める（正本:
// docs/agent-workflows/review-angles/README.md「review budget（自動探索の上限）」）。
//
// **「未解消の所見がある → findings-check」は評価順にない。** 所見の有無は machine state に
// 無く、`所見確認` の起動は予算の枠に従って起動側が判断する（上記 REVIEW_MODES のコメント）。
//
// `alwaysExplore: true` の観点は 5 を無条件に満たす（修正差分が空でない限り）。
export const ANGLE_TRIGGERS = {
  subtractive: {
    // 減算のアンカーは「追加されたもの」そのもの。修正で何かを足した時点で再探索対象になる
    alwaysExplore: true,
    exploreSignals: ['newFile', 'code', 'designDoc', 'docsOther', 'recordDoc'],
    fullRescanSignals: ['semanticDoc'],
  },
  riskmodel: {
    alwaysExplore: false,
    exploreSignals: ['code', 'guard', 'test'],
    // 想定ケース表そのものが動いたらアンカーが変わる＝全体を突き合わせ直す
    fullRescanSignals: ['riskTable'],
  },
  spec: {
    alwaysExplore: false,
    exploreSignals: ['code', 'designDoc', 'semanticDoc'],
    // 期待挙動の導出元が動いたら PR 全体を導出し直す
    fullRescanSignals: ['specAnchor'],
  },
  adversarial: {
    alwaysExplore: false,
    exploreSignals: ['code', 'config', 'test', 'newFile', 'semanticDoc'],
    // ガード種の修正は境界そのものを動かす＝受理集合の差分を全体で取り直す
    fullRescanSignals: ['guard', 'highRisk'],
  },
  quality: {
    alwaysExplore: false,
    exploreSignals: ['code', 'newFile', 'test'],
    fullRescanSignals: ['conventionDoc'],
  },
  operability: {
    alwaysExplore: false,
    exploreSignals: ['designDoc', 'semanticDoc', 'config'],
    // 手順・状態機械の再定義は全体のトレースをやり直す必要がある
    fullRescanSignals: ['semanticDoc'],
  },
  cleanup: {
    // 清掃は他系統収束後の最終1周でのみ起動する（README）。起動されたら常に探索する
    alwaysExplore: true,
    exploreSignals: ['deletion', 'code', 'designDoc', 'docsOther'],
    fullRescanSignals: [],
  },
  memory: {
    alwaysExplore: false,
    exploreSignals: ['recordDoc', 'designDoc', 'code'],
    fullRescanSignals: ['recordDoc'],
  },
};

// ---------------------------------------------------------------------------
// 実行設定（model / effort / maxTurns）
// ---------------------------------------------------------------------------

// **Claude Code の制約（docs/en/sub-agents で確認）**:
// - `model` は frontmatter に加えて起動時（Agent tool の model パラメータ）でも上書きできる
//   → モードごとの上下は起動時に実現できる
// - `effort` / `maxTurns` は frontmatter のみ（起動時パラメータが無い）
//   → frontmatter には**そのエージェントが取りうる最も重いモード**の値を置く（fail-closed。
//      軽いモードで過剰になる分は許容し、重いモードで能力不足になる事故を避ける）
// - 解決順は CLAUDE_CODE_SUBAGENT_MODEL（環境変数）> 起動時 model > frontmatter > 親セッション
//   → 環境変数が frontmatter を無効化しうるため、inspectEffectiveConfig() で検査・記録する

// 観点ごとの基準（frontmatter に書く値＝最重モードの値）。
// 一律 low にしない: 期待挙動の自力導出・攻撃構成が本質の観点（仕様・敵対的）は探索能力が
// 結果を決めるため上位モデル＋高 effort。diff とアンカーへの照合が主体の高リスク観点
// （減算・運用性）は中位モデル＋高 effort。機械的照合寄りの観点（risk-model 検証・品質・
// 記憶適合・清掃）は中位モデル＋medium。maxTurns は実測の tool 使用回数（30〜48）を
// 上限に近い値で切り、超過は incomplete 契約で人間判断へ返す（2026-09 の実測で見直し）。
export const ANGLE_EXEC_BASELINE = {
  subtractive: { model: 'sonnet', effort: 'high', maxTurns: 35 },
  riskmodel: { model: 'sonnet', effort: 'medium', maxTurns: 35 },
  spec: { model: 'opus', effort: 'high', maxTurns: 35 },
  adversarial: { model: 'opus', effort: 'high', maxTurns: 45 },
  quality: { model: 'sonnet', effort: 'medium', maxTurns: 40 },
  operability: { model: 'sonnet', effort: 'high', maxTurns: 35 },
  cleanup: { model: 'sonnet', effort: 'medium', maxTurns: 35 },
  memory: { model: 'sonnet', effort: 'medium', maxTurns: 25 },
};

// 観点レビュアー以外の review-* エージェント（Tier 必須集合の外）。
export const NON_ANGLE_EXEC_BASELINE = {
  'review-retrospective': { model: 'sonnet', effort: 'medium', maxTurns: 30 },
};

// モード別の model 引き下げ（起動時 model パラメータで適用する）。
// 所見確認は「前回所見が直ったか」の機械的照合なので中位モデルで足りる。
// ただし敵対的は「修正自体をどう騙すか」が本質で、所見確認でも騙されうるため下げない。
const MODEL_RANK = ['haiku', 'sonnet', 'opus'];

const MODE_MODEL_CAP = {
  'findings-check': 'sonnet',
  'diff-explore': null, // 基準どおり
  'full-rescan': null, // 基準どおり
};

// 所見確認でも model を下げない観点（騙し耐性が必要なもの）
const NO_DOWNGRADE_ANGLES = new Set(['adversarial']);

function capModel(model, cap) {
  if (!cap) return model;
  const mi = MODEL_RANK.indexOf(model);
  const ci = MODEL_RANK.indexOf(cap);
  if (mi < 0 || ci < 0) return model;
  return mi <= ci ? model : cap;
}

/**
 * 観点 × モードの実行設定を返す。
 * `model` は起動時に渡す値、`effort` / `maxTurns` は frontmatter で固定される値
 * （frontmatterEffort / frontmatterMaxTurns として同じ値を返し、実効値の記録に使う）。
 */
export function resolveExecConfig(angle, mode, { escalated = false } = {}) {
  const base = ANGLE_EXEC_BASELINE[angle];
  if (!base) throw new Error(`未知の観点です: ${angle}`);
  if (!REVIEW_MODES[mode]) throw new Error(`未知のレビューモードです: ${mode}`);
  let model = base.model;
  if (!NO_DOWNGRADE_ANGLES.has(angle) && !escalated) {
    model = capModel(model, MODE_MODEL_CAP[mode]);
  }
  return {
    angle,
    mode,
    model,
    effort: base.effort,
    maxTurns: base.maxTurns,
    // frontmatter は最重モード基準で固定されるため、軽いモードでは effort が過剰になる。
    // 実効値の記録・比較のために基準値も返す
    baselineModel: base.model,
  };
}

// ---------------------------------------------------------------------------
// frontmatter の実効設定検査
// ---------------------------------------------------------------------------

// フラットな YAML frontmatter（`key: value` のみ）を読む。yaml 依存を持たないための最小実装。
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const out = Object.create(null);
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    out[kv[1]] = kv[2].trim();
  }
  return out;
}

/**
 * `.claude/agents/review-*.md` の frontmatter を読み、本表との drift と
 * 環境変数による上書きを報告する。
 *
 * 返り値: { entries, errors, envOverrides }
 */
export function inspectEffectiveConfig(repoRoot, env = process.env) {
  const dir = join(repoRoot, '.claude', 'agents');
  const files = readdirSync(dir).filter((f) => f.startsWith('review-') && f.endsWith('.md'));
  const expectedByName = Object.create(null);
  for (const angle of Object.keys(ANGLE_EXEC_BASELINE)) {
    expectedByName[`review-${angle}`] = { angle, ...ANGLE_EXEC_BASELINE[angle] };
  }
  for (const [name, cfg] of Object.entries(NON_ANGLE_EXEC_BASELINE)) {
    expectedByName[name] = { angle: null, ...cfg };
  }

  const entries = [];
  const errors = [];
  for (const file of files.sort()) {
    const text = readFileSync(join(dir, file), 'utf-8');
    const fm = parseFrontmatter(text);
    const name = fm?.name ?? file.replace(/\.md$/, '');
    const expected = expectedByName[name];
    if (!expected) {
      errors.push(
        `${file}: 実行設定表（ANGLE_EXEC_BASELINE / NON_ANGLE_EXEC_BASELINE）に ${name} の行がありません`,
      );
      continue;
    }
    const actual = {
      model: fm?.model,
      effort: fm?.effort,
      maxTurns: fm?.maxTurns === undefined ? undefined : Number(fm.maxTurns),
      tools: fm?.tools,
    };
    for (const key of ['model', 'effort', 'maxTurns']) {
      if (actual[key] === undefined) {
        errors.push(
          `${file}: frontmatter に \`${key}\` がありません（親セッション設定の無条件継承を避けるため必須）`,
        );
      } else if (actual[key] !== expected[key]) {
        errors.push(
          `${file}: frontmatter の ${key}=${actual[key]} が実行設定表の ${expected[key]} と一致しません（正本: scripts/agent/review-exec-config.js）`,
        );
      }
    }
    if (actual.tools === undefined) {
      errors.push(
        `${file}: frontmatter に \`tools\` がありません（キー不在は全ツール継承＝制限の解除に当たる）`,
      );
    } else if (/\bAgent\b/.test(actual.tools)) {
      errors.push(
        `${file}: tools に Agent が含まれています（観点レビュアーはオーケストレーションを兼務しない）`,
      );
    }
    entries.push({ file, name, expected, actual });
  }
  for (const name of Object.keys(expectedByName)) {
    if (!entries.some((e) => e.name === name)) {
      errors.push(
        `.claude/agents/${name}.md がありません（実行設定表に行があるのにラッパーが不在）`,
      );
    }
  }

  // 環境変数による上書き（frontmatter より優先される・または実行形態を変える設定）
  const envOverrides = [];
  if (env.CLAUDE_CODE_SUBAGENT_MODEL) {
    envOverrides.push(
      `CLAUDE_CODE_SUBAGENT_MODEL=${env.CLAUDE_CODE_SUBAGENT_MODEL}（frontmatter の model より優先されます）`,
    );
  }
  if (env.MAX_THINKING_TOKENS) {
    envOverrides.push(`MAX_THINKING_TOKENS=${env.MAX_THINKING_TOKENS}`);
  }
  if (env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH) {
    envOverrides.push(
      `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=${env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH}`,
    );
  }
  return { entries, errors, envOverrides };
}

// 観点キーの整合（ANGLE_TOKENS + CONDITIONAL_ANGLE_TOKENS = トリガー表 = 実行設定表）
export const ALL_ANGLE_KEYS = [
  ...Object.keys(ANGLE_TOKENS),
  ...Object.keys(CONDITIONAL_ANGLE_TOKENS),
];

function main() {
  const repoRoot = process.argv[2] ?? process.cwd();
  const { entries, errors, envOverrides } = inspectEffectiveConfig(repoRoot);
  for (const e of entries) {
    process.stdout.write(
      `${e.name}: model=${e.actual.model} effort=${e.actual.effort} maxTurns=${e.actual.maxTurns}\n`,
    );
  }
  for (const o of envOverrides) process.stdout.write(`環境変数による上書き: ${o}\n`);
  if (errors.length > 0) {
    for (const err of errors) process.stderr.write(`ERROR ${err}\n`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])review-exec-config\.js$/.test(process.argv[1])
) {
  main();
}

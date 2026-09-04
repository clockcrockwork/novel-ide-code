#!/usr/bin/env node
/**
 * docs/pr/PR-*.md を解析して PR レビュー項目を分類・出力する。
 *
 * 使用例:
 *   node scripts/analyze-pr-history.js                     # Markdown をコンソールへ
 *   node scripts/analyze-pr-history.js --json              # JSON のみ出力
 *   node scripts/analyze-pr-history.js > docs/pr-analysis/latest.md
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PR_DIR = join(ROOT, 'docs', 'pr');
const OUT_DIR = join(ROOT, 'docs', 'pr-analysis');

const JSON_ONLY = process.argv.includes('--json');
const SAVE_JSON = process.argv.includes('--save');

// ✅ で始まるセルのみ「実際に対応した問題」とみなす
const ADDRESSED_RE = /^✅/;

// カテゴリ定義（優先度順。最初にマッチしたもの）
const CATEGORIES = [
  {
    id: 'console-debug',
    label: 'console/debug残留',
    lintable: true,
    keywords: ['console', 'デバッグ', 'debug', 'log残留'],
  },
  {
    id: 'unused',
    label: '未使用変数・import',
    lintable: true,
    keywords: ['未使用', 'unused', '使われていない', 'dead code', 'dead rule'],
  },
  {
    id: 'xss-security',
    label: 'XSS・セキュリティ',
    lintable: true,
    keywords: [
      'XSS',
      'innerHTML',
      'dangerouslySet',
      'サニタイズ',
      'sanitize',
      'CORS',
      'CSRF',
      'バリデーション',
      'validation',
      'injection',
      'SSRF',
    ],
  },
  {
    id: 'local-storage',
    label: 'localStorage直接操作',
    lintable: true,
    keywords: ['localStorage', '直接操作', 'storage直接'],
  },
  {
    id: 'null-safety',
    label: 'null/undefined安全性',
    lintable: true,
    keywords: [
      'null 参照',
      'undefined',
      'NaN',
      'null チェック',
      'optional chaining',
      '?.',
      'null安全',
      'null ガード',
      '型チェック',
      'typeof',
    ],
  },
  // 日付・タイムゾーン: toISOString() による UTC 日付抽出など、ローカル時刻とのずれ。
  // local/no-utc-date-slice で `.toISOString().slice(0,10)` を検出可能（PR#168/#207/#210/#226）。
  {
    id: 'date-timezone',
    label: '日付・タイムゾーン（UTC ずれ）',
    lintable: true,
    keywords: [
      'toisostring',
      'totimestring',
      'utc',
      '日付がずれ',
      '日付ずれ',
      '前日にズレ',
      '前日へ',
      'ローカル時刻',
      'getfullyear',
      'タイムゾーン',
      'jst',
    ],
  },
  // stale クロージャ: 初回 1 回登録の onUpdate / 非同期境界（タイマー・pagehide）で
  // prop/state を直接参照し、古い値で本文・dirty を上書きする再発パターン。
  // lint 不能。REVIEW_GUIDELINES「ストア・状態管理」のチェックリストでカバー（PR#112/#264/#301/#304/#306）。
  {
    id: 'stale-closure',
    label: 'stale クロージャ・ref 同期漏れ',
    lintable: false,
    keywords: [
      'stale',
      'クロージャ',
      '陳腐化',
      '焼き付',
      'getstate(',
      'isdestroyed',
      '破棄済',
      'init 時 1 回',
    ],
  },
  // IDB fire-and-forget: dbPut/dbGet の空 catch パターン。
  // PR#153 でユーザー向けエラー握りつぶしのバグになった事例あり。issue#169 で対応予定。
  {
    id: 'idb-fire-and-forget',
    label: 'IDB fire-and-forget（空catch）',
    lintable: true,
    keywords: ['dbPut', 'dbGet', '.catch(() => {})', '握りつぶ', '空キャッチ', 'fire-and-forget'],
  },
  // E2Eテスト安定化: waitForTimeout・IDBレース・auto-wait なし API 等。
  // testing カテゴリより前に評価してE2E固有パターンを先に拾う。
  {
    id: 'e2e-stability',
    label: 'E2Eテスト安定化',
    lintable: true,
    keywords: [
      'waitForTimeout',
      'count()',
      'allTextContents',
      'getByText',
      'reload()',
      'レースコンディション',
      'レース条件',
      'フレーク',
      'flaky',
      'auto-wait',
    ],
  },
  {
    id: 'performance',
    label: 'パフォーマンス・再レンダリング',
    lintable: false,
    keywords: [
      '再レンダリング',
      'rerender',
      'useMemo',
      'useCallback',
      'パフォーマンス',
      'メモリリーク',
      'O(n',
      '再render',
      'メモ化',
      '全アイテム',
    ],
  },
  {
    id: 'error-handling',
    label: 'エラーハンドリング',
    lintable: false,
    keywords: [
      'エラーハンドリング',
      'try-catch',
      'エラー処理',
      'エラー通知',
      'エラー伝播',
      'エラー',
    ],
  },
  {
    id: 'testing',
    label: 'テスト不足・誤検知',
    lintable: false,
    keywords: [
      'テスト',
      'spec',
      'test',
      '偽陰性',
      '偽陽性',
      'false negative',
      'false positive',
      'アサーション',
      'assertion',
    ],
  },
  {
    id: 'dry-refactor',
    label: 'DRY・重複排除',
    lintable: false,
    keywords: ['重複', 'DRY', 'dry', '分割', 'リファクタ', 'refactor', '重複排除'],
  },
  {
    id: 'css-layout',
    label: 'CSS・レイアウト',
    lintable: false,
    keywords: [
      'CSS',
      'レイアウト',
      'transition',
      'animation',
      'dead css',
      'z-index',
      'flex',
      'grid',
    ],
  },
  {
    id: 'lint-rule',
    label: 'lintルール改善',
    lintable: true,
    keywords: [
      'eslint',
      'lint ルール',
      'lint rule',
      '正規表現が不正確',
      'AST',
      'false negative',
      'lint エラー',
    ],
  },
  {
    // 検証ゲート・スクリプトの fail-open（PR#349/#393/#396 で繰り返し指摘）
    id: 'script-gate-robustness',
    label: 'スクリプト・ゲート堅牢性（fail-open）',
    lintable: false,
    keywords: ['exit 0', 'exit code', 'fail-open', 'fail-closed', '素通り', '見落とす', 'すり抜け'],
  },
  {
    id: 'workflow-docs',
    label: 'ワークフロー・ドキュメント',
    lintable: false,
    keywords: [
      'ドキュメント',
      'PR本文',
      'README',
      'コメント欠如',
      'docs',
      'pick-issue',
      'review-pr',
      'pre-commit',
      'create-pr',
      'ワークフロー',
      'プレースホルダ',
      '手順',
    ],
  },
  {
    id: 'architecture',
    label: 'アーキテクチャ・設計',
    lintable: false,
    keywords: ['設計', '構造', 'アーキテクチャ', '責務', 'コンポーネント分割', '依存', '循環'],
  },
];

// ---- #353 段階B: 多軸分類の best-effort 自動プリフィル ----
// スキーマ・統制語彙の正本: docs/planning/pr-history-schema-design.md（§2, §3）。
// 段階Bは judgment_norm / primary_area / disposition_reason / lintable のみ推定し、
// 他の軸は空配列・'unknown' のまま curation（段階C）へ送る（confidence='auto'）。

// keyword → primary_area の優先度順マップ（specific → broad。最初に一致した領域のみ採用）。
// 「テスト」「エラー」級の広い語は最後尾に置き、誤爆は unclassified 側でなく curation で補正する。
export const AREA_KEYWORDS = [
  {
    area: 'tiptap-prosemirror',
    keywords: ['tiptap', 'prosemirror', 'hardbreak', 'decoration', 'ルビ', 'ruby', 'slashcomment', 'inlinecomment', 'pm position'],
  },
  { area: 'test-e2e', keywords: ['e2e', 'playwright', 'waitfortimeout', 'フレーク', 'flaky'] },
  { area: 'github-api-worker', keywords: ['worker', 'hono', 'wrangler', 'cloudflare', 'エンドポイント'] },
  { area: 'github-sync', keywords: ['同期', 'stale sha', 'github 側', 'github側', 'push/pull'] },
  {
    area: 'indexeddb-persistence',
    keywords: ['indexeddb', 'idb', 'dbput', 'dbget', 'onupgradeneeded', 'localstorage'],
  },
  { area: 'security-boundary', keywords: ['xss', 'sanitiz', 'サニタイズ', 'innerhtml', 'injection', 'ssrf', 'csrf', 'トラバーサル', 'traversal', 'secret', 'gitleaks'] },
  { area: 'unicode-text', keywords: ['サロゲート', 'surrogate', 'unicode', '不可視文字', 'コードポイント'] },
  { area: 'performance-large-text', keywords: ['o(n', '長文', '大量テキスト'] },
  { area: 'style-rules', keywords: ['文体', '禁則', '表記ゆれ', 'stylerule', 'style rule'] },
  { area: 'plain-text-roundtrip', keywords: ['roundtrip', 'ラウンドトリップ', 'plaintext', 'シリアライズ'] },
  { area: 'zustand-store-state', keywords: ['zustand', 'セレクター', 'selector', 'ストア購読'] },
  { area: 'modal-sidebar-ux', keywords: ['モーダル', 'modal', 'サイドバー', 'sidebar', 'ドロップダウン', 'dropdown'] },
  { area: 'lint-tooling', keywords: ['eslint', 'lint'] },
  // 'workflow' 単体は docs/agent-workflows/ 等のパス言及で誤爆するため使わない（CI 固有の語のみ）
  { area: 'ci-workflow', keywords: ['ci.yml', '.github/workflows', 'github actions', 'semgrep', 'npm audit', 'required check', 'ジョブ'] },
  { area: 'build-deps', keywords: ['package.json', 'package-lock', 'dependabot', '依存更新'] },
  { area: 'react-ui', keywords: ['usememo', 'usecallback', 'useeffect', '再レンダリング', 'メモ化', 'フック', 'hooks', 'コンポーネント'] },
  { area: 'docs-workflow', keywords: ['ドキュメント', 'readme', 'pr本文', 'テンプレ', '手順', 'docs'] },
  { area: 'architecture', keywords: ['責務', 'アーキテクチャ', '循環依存', '結合度'] },
  { area: 'test-unit', keywords: ['vitest', 'node --test', 'ユニットテスト', '単体テスト', 'アサーション', 'モック', 'mock', 'テスト'] },
];

// 判断セル先頭記号の正規化（§3.7）。VS16（U+FE0F）の有無に依存しないよう bare 記号で前方一致し、
// 出力は正規形へ統一する。既知記号で始まらないセル（非レビュー表の誤パース行・自由文）は null を返し、
// 呼び出し側が detailed から隔離する（黙って混ぜない）。❌ は設計語彙外のため ❓ へフォールバックする。
export function normalizeJudgment(judgment) {
  const j = String(judgment ?? '').replace(/^[\s*_]+/, '');
  if (j.startsWith('✅')) return '✅';
  if (j.startsWith('⏭')) return '⏭️';
  if (j.startsWith('🔁')) return '🔁';
  if (j.startsWith('❓')) return '❓';
  if (j.startsWith('❌')) return '❓';
  return null;
}

// disposition_reason の粗い推定（§3.7）。明確なパターンのみマップし、それ以外は 'unknown' に落とす
// （over-guard 等の確定値を誤って付けない。取りこぼしは curation で拾う）。
export function inferDispositionReason(judgmentNorm, judgment, reason) {
  const text = `${judgment} ${reason}`;
  if (judgmentNorm === '✅') {
    if (/一部|部分/.test(judgment)) return 'unknown';
    if (/重複|対応済み|既に修正/.test(text)) return 'duplicate-already-fixed';
    if (/正規化済み|normalize済/i.test(text)) return 'normalized-upstream';
    return 'valid-fixed';
  }
  if (judgmentNorm === '🔁') return 'duplicate-already-fixed';
  // VS16（U+FE0F）の有無に依存しない比較（normalizeJudgment の出力は正規形だが、
  // 定数リテラル同士でもエディタによる VS16 除去で不一致になり得るため startsWith で防ぐ）
  if (typeof judgmentNorm === 'string' && judgmentNorm.startsWith('⏭')) {
    if (/過剰|over-?guard/i.test(text)) return 'over-guard';
    if (/到達不能|到達し得ない|到達しない|unreachable/i.test(text)) return 'unreachable-by-current-callsite';
    if (/誤読|misread/i.test(text)) return 'reviewer-misread';
    if (/内部保証|内部不変|internal invariant/i.test(text)) return 'internal-invariant';
    if (/設計(が|を)?(先|前提|必要)|requires-design/i.test(text)) return 'requires-design-before-fix';
    if (/別\s*issue|issue\s*化|課題化|フォローアップ|follow-?up/i.test(text)) return 'out-of-scope-follow-up-needed';
    if (/意図的|仕様どおり|仕様通り|intentional/i.test(text)) return 'intentional-design';
    if (/スコープ外|範囲外|mvp外|MVP範囲外/i.test(text)) return 'out-of-scope-not-needed';
    return 'unknown';
  }
  return 'unknown';
}

// 領域を示す語が理由・判断セルにだけ書かれている項目（例: 理由「ProseMirror の position 仕様のため」）も
// 拾えるよう、reason / judgment も分類入力に含める（best-effort・誤爆は curation で補正）
export function classifyArea(summary, response, reason = '', judgment = '') {
  const text = `${summary} ${response} ${reason} ${judgment}`.toLowerCase();
  for (const { area, keywords } of AREA_KEYWORDS) {
    if (keywords.some((kw) => text.includes(kw))) return area;
  }
  return 'unclassified';
}

// 全 judgment（✅/⏭️/🔁/❓）の項目へ多軸フィールドを付与した別コピーを作る（§2）。
// items.json の直列化対象（既存 item オブジェクト）には触れない（byte 互換維持）。
// 戻り値: { detailed, excluded, excludedRows }（隔離行数と、監査用の隔離行識別子リスト）
export function buildDetailedItems(allItems) {
  const detailed = [];
  let excluded = 0;
  const excludedRows = [];
  for (const item of allItems) {
    const judgmentNorm = normalizeJudgment(item.judgment);
    if (judgmentNorm === null) {
      excluded++;
      excludedRows.push(`PR#${item.pr} round${item.round} #${item.num}`);
      continue;
    }
    detailed.push({
      ...item,
      judgment_norm: judgmentNorm,
      primary_area: classifyArea(item.summary, item.response, item.reason, item.judgment),
      secondary_areas: [],
      failure_types: [],
      root_causes: [],
      risk_cases: [],
      preventable_by: [],
      implementation_phase_catchable: 'unknown',
      lintable: CATEGORIES.find((c) => c.id === item.category)?.lintable ?? false,
      disposition_reason: inferDispositionReason(judgmentNorm, item.judgment, item.reason),
      confidence: 'auto',
    });
  }
  return { detailed, excluded, excludedRows };
}

const FOLLOWUP_REASONS = new Set([
  'valid-follow-up-needed',
  'out-of-scope-follow-up-needed',
  'requires-design-before-fix',
  'scope-ordering-required',
]);

function tally(dict, values) {
  // 段階C の手動 curation で不正データ（非配列・非文字列要素・空文字）が混入しても集計を壊さない
  // （防衛。オブジェクト要素が "[object Object]" キーに化けるのを防ぐ。validate は別途 curation 側で行う）
  if (!Array.isArray(values)) return;
  for (const v of values) {
    if (typeof v === 'string' && v) dict[v] = (dict[v] ?? 0) + 1;
  }
}

function sortedCopy(dict) {
  const out = Object.create(null);
  for (const key of Object.keys(dict).sort()) out[key] = dict[key];
  return out;
}

// json を単体で機械的に読む消費者にも「空集計 = リスクなし」と誤読させないための注記（U1）。
// `_` プレフィックスでソート先頭に来る。
const RISK_PATTERNS_JSON_NOTE =
  '空の root_causes / risk_cases はリスクなしを意味しない（curation 未実施）。' +
  '空の領域は docs/pr-analysis/detailed-items.json と docs/pr/PR-*.md を直接参照すること。';

// primary_area 別の集計辞書（§5）。risk-modeling §2.5 が領域キーで引く実インターフェース。
export function buildRiskPatterns(detailedItems) {
  const areas = Object.create(null);
  for (const item of detailedItems) {
    let entry = areas[item.primary_area];
    if (!entry) {
      entry = areas[item.primary_area] = {
        total: 0,
        auto_count: 0,
        curated_count: 0,
        root_causes: Object.create(null),
        risk_cases: Object.create(null),
        preventable_by: Object.create(null),
        followups: [],
      };
    }
    entry.total++;
    if (item.confidence === 'curated') entry.curated_count++;
    else entry.auto_count++;
    tally(entry.root_causes, item.root_causes);
    tally(entry.risk_cases, item.risk_cases);
    tally(entry.preventable_by, item.preventable_by);
    if (FOLLOWUP_REASONS.has(item.disposition_reason)) {
      entry.followups.push({ pr: item.pr, summary: item.summary, disposition_reason: item.disposition_reason });
    }
  }
  const out = Object.create(null);
  out._note = RISK_PATTERNS_JSON_NOTE;
  for (const area of Object.keys(areas).sort()) {
    const e = areas[area];
    out[area] = {
      total: e.total,
      auto_count: e.auto_count,
      curated_count: e.curated_count,
      root_causes: sortedCopy(e.root_causes),
      risk_cases: sortedCopy(e.risk_cases),
      preventable_by: sortedCopy(e.preventable_by),
      followups: e.followups,
    };
  }
  return out;
}

const EMPTY_PATTERN_NOTE =
  'curated 0 件のため root_causes / risk_cases は未集計（**リスクなしを意味しない**。' +
  '`docs/pr-analysis/detailed-items.json` と `docs/pr/PR-*.md` を直接参照すること）';

// 領域別の可読レポート（§5 様式）。生成日は入れない（再実行 diff ノイズ防止・items.json と同方針）。
export function renderRiskPatternsMd(riskPatterns) {
  const lines = [];
  lines.push('# 領域別リスクパターン（#353 段階B 自動生成）');
  lines.push('');
  lines.push('> 生成: `node scripts/analyze-pr-history.js --save`。多軸フィールドは best-effort の自動プリフィル');
  lines.push('> （`confidence: auto`）であり、root_causes / risk_cases 等は curation（段階C）で充足される。');
  lines.push('> 消費側: [risk-modeling.md](../agent-workflows/risk-modeling.md) §2.5（`risk-patterns.json` を領域キーで引く）。');
  lines.push('');
  for (const [area, e] of Object.entries(riskPatterns)) {
    if (area === '_note') continue;
    lines.push(`## ${area}`);
    lines.push('');
    lines.push(`件数: ${e.total}（auto: ${e.auto_count} / curated: ${e.curated_count}）`);
    lines.push('');
    const causes = Object.entries(e.root_causes);
    const cases = Object.entries(e.risk_cases);
    if (causes.length === 0 && cases.length === 0) {
      lines.push(`> ${EMPTY_PATTERN_NOTE}`);
      lines.push('');
    } else {
      if (causes.length > 0) {
        lines.push('過去に多い指摘（root_causes）:');
        for (const [tag, count] of causes) lines.push(`- ${tag}: ${count} 件`);
        lines.push('');
      }
      if (cases.length > 0) {
        lines.push('実装前に確認（risk_cases）:');
        for (const [tag, count] of cases) {
          lines.push(`- [ ] ${tag}（${count} 件）`);
        }
        lines.push('');
      }
    }
    if (e.followups.length > 0) {
      lines.push('将来重要な見送り（follow-up-needed / requires-design 系）:');
      for (const f of e.followups) lines.push(`- PR#${f.pr}: ${f.summary}（${f.disposition_reason}）`);
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

function classify(summary, response) {
  const text = `${summary} ${response}`.toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.keywords.some((kw) => text.includes(kw.toLowerCase()))) {
      return cat.id;
    }
  }
  return 'other';
}

function parsePrFile(filePath, prNumber) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const items = [];
  let round = 0;
  let currentDate = '';
  // ヘッダー行から列位置を動的に決定（コメントID列など追加列があるファイルに対応）
  let colMap = null;

  for (const line of lines) {
    // ラウンドヘッダー: "### 2026-05-17 | commit: `xxx`"
    const roundMatch = line.match(/^###\s+(\d{4}-\d{2}-\d{2})/);
    if (roundMatch) {
      round++;
      currentDate = roundMatch[1];
      continue;
    }

    if (!line.startsWith('|')) continue;
    if (/^\|\s*[-:]+\s*\|/.test(line)) continue;

    const trimmedLine = line.replace(/^\|\s*|\s*\|$/g, '');
    const cells = trimmedLine.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    if (cells.length < 4) continue;

    // ヘッダー行: 列位置マップを構築
    if (/^\|\s*#\s*\|/.test(line)) {
      colMap = {};
      cells.forEach((cell, i) => {
        const h = cell.replace(/\s+/g, '');
        if (cell === '#') colMap.num = i;
        else if (h.includes('レビュアー')) colMap.reviewer = i;
        else if (h.includes('要旨')) colMap.summary = i;
        else if (h.includes('判断')) colMap.judgment = i;
        else if (h.includes('理由')) colMap.reason = i;
        else if (h.includes('対応内容')) colMap.response = i;
      });
      continue;
    }

    // データ行: colMap があればそれを使い、なければ位置で取得
    const get = (key, fallback) => cells[colMap?.[key] ?? fallback] ?? '';
    const num = get('num', 0);
    if (!num.trim()) continue;

    const reviewer = get('reviewer', 1);
    const summary = get('summary', 2);
    const judgment = get('judgment', 3);
    const reason = get('reason', 4);
    const response = get('response', 5);

    const category = classify(summary, response);
    items.push({
      pr: prNumber,
      date: currentDate,
      round,
      num: num.trim(),
      reviewer,
      summary,
      judgment,
      reason,
      response,
      category,
      keywords_matched:
        CATEGORIES.find((c) => c.id === category)?.keywords.filter((kw) =>
          `${summary} ${response}`.toLowerCase().includes(kw.toLowerCase()),
        ) ?? [],
    });
  }

  return items;
}

function main() {
  if (!existsSync(PR_DIR)) {
    process.stderr.write(`Error: ディレクトリが見つかりません: ${PR_DIR}\n`);
    process.exit(1);
  }

  const files = readdirSync(PR_DIR)
    .filter((f) => /^PR-\d+\.md$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)[0], 10);
      const nb = parseInt(b.match(/\d+/)[0], 10);
      return na - nb;
    });

  const allItems = [];
  for (const file of files) {
    const prNumber = parseInt(file.match(/\d+/)[0], 10);
    const items = parsePrFile(join(PR_DIR, file), prNumber);
    allItems.push(...items);
  }

  const addressed = allItems.filter((i) => ADDRESSED_RE.test(i.judgment));

  if (SAVE_JSON) {
    mkdirSync(OUT_DIR, { recursive: true });
    const jsonPath = join(OUT_DIR, 'items.json');
    writeFileSync(jsonPath, JSON.stringify(addressed, null, 2));
    process.stderr.write(`JSON saved: ${jsonPath}\n`);

    // #353 段階B: 多軸出力。全 stringify を先に完了させてから書き込む（部分書き込みの不整合防止）
    const { detailed, excluded, excludedRows } = buildDetailedItems(allItems);
    const riskPatterns = buildRiskPatterns(detailed);
    const detailedJson = JSON.stringify(detailed, null, 2);
    const patternsJson = JSON.stringify(riskPatterns, null, 2);
    const patternsMd = renderRiskPatternsMd(riskPatterns);
    writeFileSync(join(OUT_DIR, 'detailed-items.json'), detailedJson);
    writeFileSync(join(OUT_DIR, 'risk-patterns.json'), patternsJson);
    writeFileSync(join(OUT_DIR, 'risk-patterns.md'), patternsMd);
    process.stderr.write(
      `detailed: ${detailed.length} 件（隔離: ${excluded} 行 = 判断セルが既知記号で始まらない行。非レビュー表の誤パース等）\n`,
    );
    if (excludedRows.length > 0) {
      process.stderr.write(`隔離行: ${excludedRows.join(', ')}\n`);
    }
  }

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(addressed, null, 2) + '\n');
    return;
  }

  // ---- Markdown レポート ----
  const now = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const lines = [];

  lines.push(`# PR履歴分析レポート`);
  lines.push(`> 生成: ${now}  対象: ${files.length} ファイル`);
  lines.push('');

  // 統計
  const byJudgment = {};
  for (const i of allItems) {
    const key = ['✅', '⏭', '🔁', '❓'].find((c) => i.judgment.startsWith(c)) ?? '?';
    byJudgment[key] = (byJudgment[key] ?? 0) + 1;
  }
  lines.push('## 統計サマリー');
  lines.push('');
  lines.push(`| 項目 | 件数 |`);
  lines.push(`|------|------|`);
  lines.push(`| 対象ファイル | ${files.length} |`);
  lines.push(`| 全コメント | ${allItems.length} |`);
  lines.push(`| ✅ 対応済み（分析対象） | ${addressed.length} |`);
  lines.push(`| ⏭️ 見送り | ${byJudgment['⏭'] ?? 0} |`);
  lines.push(`| 🔁 既判断 | ${byJudgment['🔁'] ?? 0} |`);
  lines.push('');

  // カテゴリ別件数
  const byCat = {};
  for (const i of addressed) {
    byCat[i.category] = (byCat[i.category] ?? 0) + 1;
  }

  lines.push('## カテゴリ別件数（対応済みのみ）');
  lines.push('');
  lines.push('| カテゴリ | 件数 | Lint対応可 |');
  lines.push('|---------|------|-----------|');
  const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  for (const [catId, count] of sorted) {
    const cat = CATEGORIES.find((c) => c.id === catId);
    const label = cat?.label ?? 'その他';
    const lintable = cat?.lintable ? '✅' : '—';
    lines.push(`| ${label} | ${count} | ${lintable} |`);
  }
  lines.push('');

  // セクションごとの詳細
  const lintable = addressed.filter((i) => CATEGORIES.find((c) => c.id === i.category)?.lintable);
  const checklist = addressed.filter((i) => {
    const cat = CATEGORIES.find((c) => c.id === i.category);
    return !cat?.lintable && i.category !== 'other' && i.category !== 'architecture';
  });
  const architecture = addressed.filter((i) => i.category === 'architecture');
  const other = addressed.filter((i) => i.category === 'other');

  if (lintable.length > 0) {
    lines.push('## Lintで防げる可能性あり');
    lines.push('');
    lines.push('| PR | 日付 | コメント要旨 | マッチキーワード |');
    lines.push('|----|------|-------------|----------------|');
    for (const i of lintable) {
      const kw = i.keywords_matched.slice(0, 3).join(', ');
      lines.push(`| #${i.pr} | ${i.date} | ${i.summary} | \`${kw}\` |`);
    }
    lines.push('');
  }

  if (checklist.length > 0) {
    lines.push('## チェックリスト候補（絶対必要なもののみ追加を推奨）');
    lines.push('');
    lines.push('| PR | カテゴリ | コメント要旨 |');
    lines.push('|----|---------|-------------|');
    for (const i of checklist) {
      const cat = CATEGORIES.find((c) => c.id === i.category)?.label ?? i.category;
      lines.push(`| #${i.pr} | ${cat} | ${i.summary} |`);
    }
    lines.push('');
  }

  if (architecture.length > 0) {
    lines.push('## アーキテクチャ・設計');
    lines.push('');
    lines.push('| PR | コメント要旨 | 対応内容 |');
    lines.push('|----|-------------|---------|');
    for (const i of architecture) {
      lines.push(`| #${i.pr} | ${i.summary} | ${i.response} |`);
    }
    lines.push('');
  }

  if (other.length > 0) {
    lines.push('## その他（エージェントによる意味的分類が必要）');
    lines.push('');
    lines.push(
      '> キーワードマッチ不能。エージェントが `docs/pr-analysis/items.json` を読み込み意味的に分類する。',
    );
    lines.push('');
    lines.push('| PR | コメント要旨 | 理由 | 対応内容 |');
    lines.push('|----|-------------|------|---------|');
    for (const i of other) {
      lines.push(`| #${i.pr} | ${i.summary} | ${i.reason} | ${i.response} |`);
    }
    lines.push('');
  }

  process.stdout.write(lines.join('\n') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

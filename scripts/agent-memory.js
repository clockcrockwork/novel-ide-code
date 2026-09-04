// 検索型永続記憶基盤 CLI（#436 PR-b）。設計の正本: docs/planning/agent-memory-design.md。
// add / search / show / validate（文法検査＋15セル整合エンジン）＋
// promote / reject / retire / supersede / revise / purge / digest（ライフサイクル遷移・public 同期出力）。
// 単一ファイル・依存フリー（node ビルトインのみ）。named export＋pathToFileURL ガードでテスト可能。
// 機械出力→stdout、エラー・状態→stderr。fail-loud（exit 1）。
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// E2E/CI の seam: AGENT_MEMORY_DIR で正本ディレクトリを差し替え可能にする。
const RECORDS_DIR =
  process.env.AGENT_MEMORY_DIR || join(SCRIPT_DIR, '..', 'docs', 'agent-memory', 'records');
// revise の旧 id 参照走査（best-effort・非ブロッキング）の対象。テスト用 seam。
const DOCS_DIR = process.env.AGENT_MEMORY_DOCS_DIR || join(SCRIPT_DIR, '..', 'docs');

export const ID_RE = /^mem-\d{8}-[a-z0-9]{6}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const KINDS = new Set([
  'decision',
  'constraint',
  'invariant',
  'exception',
  'rejected',
  'lesson',
  'review-check',
]);
export const STATUSES = new Set(['proposed', 'accepted', 'rejected', 'superseded', 'retired']);
export const VISIBILITIES = new Set(['control', 'public']);

// scope 統制語彙。正本は pr-history-schema-design.md §3.1（初期集合＋データ由来†＋sentinel）。
// analyze-pr-history.js の AREA_KEYWORDS と drift しないようテストで包含検査する。
export const SCOPE_VOCAB = new Set([
  'tiptap-prosemirror',
  'plain-text-roundtrip',
  'style-rules',
  'github-sync',
  'github-api-worker',
  'indexeddb-persistence',
  'zustand-store-state',
  'react-ui',
  'modal-sidebar-ux',
  'security-boundary',
  'unicode-text',
  'performance-large-text',
  'test-e2e',
  'test-unit',
  'ci-workflow',
  'docs-workflow',
  // データ由来†
  'lint-tooling',
  'architecture',
  'build-deps',
  // 暫定 sentinel（validate では警告）
  'unclassified',
]);

// スキーマのフィールド並び（書込時のキー順を固定して diff ノイズを抑える）。
export const KNOWN_ORDER = [
  'id',
  'createdAt',
  'kind',
  'status',
  'visibility',
  'scope',
  'paths',
  'title',
  'summary',
  'rationale',
  'sources',
  'supersedes',
  'supersededBy',
  'revisedFrom',
  'replaces',
  'tags',
  'reviewChecks',
  'author',
];
export const KNOWN = new Set(KNOWN_ORDER);
export const REQUIRED = new Set([
  'id',
  'createdAt',
  'kind',
  'status',
  'visibility',
  'scope',
  'title',
  'summary',
  'author',
]);
export const SEARCH_FIELDS = ['title', 'summary', 'rationale', 'tags'];

// 簡易 secret 検査（実スキャンは gitleaks（CI）が担う。設計 §7）。
// トークン実形（level:error）は単語境界に依存せず部分一致で検出（前置文字での回避を防ぐ）。
// inline-credential は教訓・制約レコードでの引用・例示が偽陽性になりやすいため level:warn。
const SECRET_PATTERNS = [
  { name: 'github-token', level: 'error', re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/ },
  { name: 'github-pat', level: 'error', re: /github_pat_[A-Za-z0-9_]{30,}/ },
  { name: 'aws-access-key', level: 'error', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key-block', level: 'error', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'slack-token', level: 'error', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'jwt', level: 'error', re: /eyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/ },
  {
    name: 'inline-credential',
    level: 'warn',
    re: /\b(?:secret|token|api[_-]?key|password|passwd)\b\s*[:=]\s*["'][^"']{8,}["']/i,
  },
];

// 15 セル整合表（設計 §4）。行=新レコードの status、列=旧レコードの supersededBy の状態。
export const LINK_TABLE = {
  proposed: { null: 'legal', self: 'error-proposed-self', other: 'warning-stale' },
  rejected: { null: 'legal', self: 'error-proposed-self', other: 'legal' },
  accepted: { null: 'error-repairable', self: 'normal', other: 'error-unless-chain' },
  superseded: { null: 'error-repairable', self: 'legal', other: 'legal' },
  retired: { null: 'legal', self: 'legal', other: 'legal' },
};

const OPTIONAL_DEFAULTS = {
  paths: [],
  rationale: '',
  sources: [],
  supersedes: [],
  supersededBy: null,
  revisedFrom: [],
  replaces: [],
  tags: [],
  reviewChecks: [],
};

export class CliError extends Error {}

// ---- 日付・id（house style: getFullYear 系。toISOString().slice は lint 禁止） ----

export function formatDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dateCompact(date = new Date()) {
  return formatDate(date).replaceAll('-', '');
}

export function formatId(compact, suffix) {
  return `mem-${compact}-${suffix}`;
}

// ---- 引数パーサ ----

// 値を取らない真偽フラグ（後続の位置引数を値として吸わないようにする）。
const BOOLEAN_FLAGS = new Set(['all', 'any', 'retire-orphans']);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positionals = [];
  const flags = Object.create(null);
  // 単独の `--` は「以降はすべて位置引数（オプション解釈しない）」という標準的な CLI terminator。
  // `--` 始まりの語をクエリ本文（例: search "--path"）として渡したい正当な入力の逃がし弁。
  let literalOnly = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (literalOnly) {
      positionals.push(a);
      continue;
    }
    if (a === '--') {
      literalOnly = true;
      continue;
    }
    if (a.startsWith('--')) {
      // --key=value 構文: 値自体に -- を含めたい場合（例: タイトルに CLI オプション名を書きたい）の
      // 明示的な逃がし弁。空白区切り渡し（--key value）と共存し、次トークンの -- 始まり判定には影響しない。
      const eq = a.indexOf('=');
      if (eq > 2) {
        const key = a.slice(2, eq);
        // boolean フラグ（--all/--any）は値を取らない設計のため、`--all=true` のような =value 構文自体を
        // fail-loud にする（値を捨てて true とみなす片側変換だと、`--all=false` も黙って true になり誤り）。
        if (BOOLEAN_FLAGS.has(key)) {
          throw new CliError(`--${key} は値を取りません（=value 構文は使えません）`);
        }
        flags[key] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { command, positionals, flags };
}

// ---- レコード正規化（省略キー→デフォルト。消費側の統一ビュー） ----

export function normalizeRecord(raw) {
  const r = Object.create(null);
  r.id = raw.id;
  r.createdAt = raw.createdAt;
  r.kind = raw.kind;
  r.status = raw.status;
  r.visibility = raw.visibility;
  r.scope = Array.isArray(raw.scope) ? raw.scope : [];
  r.paths = Array.isArray(raw.paths) ? raw.paths : [];
  r.title = typeof raw.title === 'string' ? raw.title : '';
  r.summary = typeof raw.summary === 'string' ? raw.summary : '';
  r.rationale = typeof raw.rationale === 'string' ? raw.rationale : '';
  r.sources = Array.isArray(raw.sources) ? raw.sources : [];
  r.supersedes = Array.isArray(raw.supersedes) ? raw.supersedes : [];
  r.supersededBy = raw.supersededBy ?? null;
  r.revisedFrom = Array.isArray(raw.revisedFrom) ? raw.revisedFrom : [];
  r.replaces = Array.isArray(raw.replaces) ? raw.replaces : [];
  r.tags = Array.isArray(raw.tags) ? raw.tags : [];
  r.reviewChecks = Array.isArray(raw.reviewChecks) ? raw.reviewChecks : [];
  r.author = typeof raw.author === 'string' ? raw.author : '';
  return r;
}

function collectStrings(record) {
  const out = [];
  for (const v of Object.values(record)) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const e of v) if (typeof e === 'string') out.push(e);
  }
  return out;
}

export function detectSecrets(record) {
  const hits = new Map();
  for (const s of collectStrings(record)) {
    for (const { name, level, re } of SECRET_PATTERNS) {
      if (re.test(s)) hits.set(name, level);
    }
  }
  return [...hits].map(([name, level]) => ({ name, level }));
}

// createdAt / id 日付部が実在する暦日か（DATE_RE は範囲を見ないため補完）。
export function isValidCalendarDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

// ---- 文法検査（§4。1 レコードで自己完結する検査） ----

// checkSecrets: false で secret 検査だけを外す（構造検査は残す）。purge の修復対象で使う——
// 同じ漏洩値が置換チェーンの両側にあると相互待ちになるため。**エラー文字列の部分一致で
// 除外してはならない**: 未知フィールド名に検出メッセージと同じ文字列を仕込むだけで、その
// 未知フィールドの文法エラーごと消え、正規化書込が未知フィールドを黙って落とす（検査が
// データ削除へ反転する）。分離はここで構造的に行う。
export function validateFieldGrammar(raw, { checkSecrets = true } = {}) {
  const errors = [];
  const warnings = [];
  const id = typeof raw.id === 'string' ? raw.id : '(id不明)';
  const tag = (m) => `[${id}] ${m}`;

  for (const k of Object.keys(raw)) {
    if (!KNOWN.has(k)) errors.push(tag(`未知フィールド: ${k}`));
  }
  for (const k of REQUIRED) {
    if (!(k in raw)) errors.push(tag(`必須フィールド欠落: ${k}`));
  }
  // null は supersededBy 以外一律エラー（この後の型検査の `!== null` ガードは二重報告を避けるため）。
  for (const [k, v] of Object.entries(raw)) {
    if (v === null && k !== 'supersededBy') {
      errors.push(tag(`${k} に null は不可（配列型は空配列で表現）`));
    }
  }
  if ('id' in raw && (typeof raw.id !== 'string' || !ID_RE.test(raw.id))) {
    errors.push(tag(`id 形式不正（mem-YYYYMMDD-<6桁>）: ${raw.id}`));
  }
  if ('createdAt' in raw) {
    if (typeof raw.createdAt !== 'string' || !DATE_RE.test(raw.createdAt)) {
      errors.push(tag(`createdAt 形式不正（YYYY-MM-DD）: ${raw.createdAt}`));
    } else if (!isValidCalendarDate(raw.createdAt)) {
      errors.push(tag(`createdAt が実在しない暦日: ${raw.createdAt}`));
    }
  }
  if (
    typeof raw.id === 'string' &&
    ID_RE.test(raw.id) &&
    typeof raw.createdAt === 'string' &&
    DATE_RE.test(raw.createdAt) &&
    raw.id.slice(4, 12) !== raw.createdAt.replaceAll('-', '')
  ) {
    errors.push(tag('id の日付部と createdAt が不一致'));
  }
  if ('kind' in raw && !KINDS.has(raw.kind)) errors.push(tag(`未知 kind: ${raw.kind}`));
  if ('status' in raw && !STATUSES.has(raw.status)) errors.push(tag(`未知 status: ${raw.status}`));
  if ('visibility' in raw && !VISIBILITIES.has(raw.visibility)) {
    errors.push(tag(`未知 visibility: ${raw.visibility}`));
  }
  for (const k of ['title', 'summary', 'author']) {
    if (k in raw && (typeof raw[k] !== 'string' || raw[k].trim() === '')) {
      errors.push(tag(`${k} は非空文字列が必須`));
    }
  }
  if ('rationale' in raw && raw.rationale !== null && typeof raw.rationale !== 'string') {
    errors.push(tag('rationale は文字列'));
  }
  if ('scope' in raw) {
    if (!Array.isArray(raw.scope) || raw.scope.length === 0) {
      errors.push(tag('scope は1要素以上の配列が必須'));
    } else {
      for (const s of raw.scope) {
        if (typeof s !== 'string') {
          errors.push(tag('scope 要素は文字列'));
        } else if (s === 'unclassified') {
          warnings.push(tag('scope に暫定値 unclassified（棚卸しで正本語彙へ解消すること）'));
        } else if (!SCOPE_VOCAB.has(s)) {
          errors.push(
            tag(`未知 scope 語彙: ${s}（逃がし弁: --scope unclassified ＋ tags に scope-proposal:${s}）`),
          );
        }
      }
    }
  }
  for (const k of ['paths', 'sources', 'supersedes', 'revisedFrom', 'replaces', 'tags', 'reviewChecks']) {
    if (k in raw && raw[k] !== null) {
      if (!Array.isArray(raw[k])) errors.push(tag(`${k} は配列`));
      else for (const e of raw[k]) if (typeof e !== 'string') errors.push(tag(`${k} 要素は文字列`));
    }
  }
  if (Array.isArray(raw.supersedes)) {
    const seen = new Set();
    for (const s of raw.supersedes) {
      if (seen.has(s)) errors.push(tag(`supersedes に重複 id: ${s}`));
      if (s === raw.id) errors.push(tag('supersedes に自 id は不可（自己置換はライフサイクル不能）'));
      seen.add(s);
    }
  }
  if ('supersededBy' in raw && raw.supersededBy !== null && typeof raw.supersededBy !== 'string') {
    errors.push(tag('supersededBy は string か null'));
  }
  // revisedFrom は削除済み id への参照（supersedes と逆に、実在しないことが正常）。
  // 実在検査ができない分、要素の id 形式を検査する（型エラーは上の配列型検査で報告済み）。
  if (Array.isArray(raw.revisedFrom)) {
    const seen = new Set();
    for (const s of raw.revisedFrom) {
      if (typeof s !== 'string') continue;
      if (!ID_RE.test(s)) errors.push(tag(`revisedFrom の id 形式不正: ${s}`));
      if (seen.has(s)) errors.push(tag(`revisedFrom に重複 id: ${s}`));
      if (s === raw.id) errors.push(tag('revisedFrom に自 id は不可（自己訂正ループ）'));
      seen.add(s);
    }
  }
  // replaces は rejected / retired になったレコードの差し替えとして add された系譜リンク（#532）。
  // supersedes と違い旧側は書き換えない（既に終端状態のため）＝片方向で完結する。実在検査は
  // validateLinks（index 依存）が行い、ここでは 1 レコードで閉じる形式検査のみ。
  if (Array.isArray(raw.replaces)) {
    const seen = new Set();
    for (const s of raw.replaces) {
      if (typeof s !== 'string') continue;
      if (!ID_RE.test(s)) errors.push(tag(`replaces の id 形式不正: ${s}`));
      if (seen.has(s)) errors.push(tag(`replaces に重複 id: ${s}`));
      if (s === raw.id) errors.push(tag('replaces に自 id は不可（自己差し替えは系譜として無意味）'));
      seen.add(s);
    }
  }
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  if (sources.length === 0) warnings.push(tag('sources が空（参照ゼロ記憶は信頼度低下）'));

  // 自レコードの status ⇔ 自レコードの supersededBy（15セル表とは直交する検査）
  const sb = raw.supersededBy ?? null;
  if (sb !== null && raw.status !== 'superseded') {
    errors.push(tag(`supersededBy 非 null なら status は superseded（現: ${raw.status}）`));
  }
  if (raw.status === 'superseded' && sb === null) {
    errors.push(tag('status superseded なら supersededBy は非 null'));
  }
  if (checkSecrets) {
    for (const { name, level } of detectSecrets(raw)) {
      const msg = tag(`secret らしきパターン検出（${name}）`);
      if (level === 'error') errors.push(msg);
      else warnings.push(msg);
    }
  }
  return { errors, warnings };
}

// ---- リンク整合（§4。index 依存） ----

export function classifyLinkState(old, newId) {
  const sb = old.supersededBy ?? null;
  if (sb === null) return 'null';
  if (sb === newId) return 'self';
  return 'other';
}

export function linkVerdict(newStatus, linkState) {
  const row = LINK_TABLE[newStatus];
  return row ? row[linkState] : 'legal';
}

// 勝者ごと置換のチェーン例外: from から supersededBy を辿って selfId に到達すれば合法（§4）。
export function reachesSelf(fromId, selfId, index, visited = new Set()) {
  let current = fromId;
  while (current != null) {
    if (current === selfId) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    const rec = index[current];
    if (!rec) return false;
    current = rec.supersededBy ?? null;
  }
  return false;
}

export function validateLinks(record, index) {
  const errors = [];
  const warnings = [];
  const tag = (m) => `[${record.id}] ${m}`;

  for (const oldId of record.supersedes) {
    const old = index[oldId];
    if (!old) {
      errors.push(tag(`supersedes 先が存在しない: ${oldId}`));
      continue;
    }
    const state = classifyLinkState(old, record.id);
    const verdict = linkVerdict(record.status, state);
    // 片方向リンク（old.supersededBy: null）が合法なのは old が現アクティブ（accepted）を置換する場合のみ。
    // proposed/rejected/retired の old を置換元にした提案は後続 promote で必ず止まるため fail-fast。
    // self/other 状態（完了済み置換・競合敗北）には適用しない（old=superseded を誤エラーにしない）。
    if (verdict === 'legal' && state === 'null' && old.status !== 'accepted') {
      errors.push(
        tag(`置換元 ${oldId} が accepted でない（status: ${old.status}）。置換元は accepted のみ`),
      );
      continue;
    }
    switch (verdict) {
      case 'legal':
      case 'normal':
        break;
      case 'error-proposed-self':
        errors.push(tag(`${record.status} で旧 ${oldId} を無効化済み（promote 前に無効化してはならない）`));
        break;
      case 'warning-stale':
        warnings.push(
          tag(`stale な置換案: 旧 ${oldId} は既に他レコードへ置換済み（promote は先勝ちで失敗。reject 推奨）`),
        );
        break;
      case 'error-repairable':
        if (record.status === 'accepted') {
          errors.push(
            tag(
              `片方向リンク（旧 ${oldId}）: promote/supersede 途中クラッシュの痕跡。promote ${record.id} 再実行（完遂）または retire ${record.id}（取り下げ）で回復`,
            ),
          );
        } else {
          errors.push(
            tag(`片方向リンク（旧 ${oldId}）: リンク完遂前に置換された状態。promote ${record.id} 再実行で完遂`),
          );
        }
        break;
      case 'error-unless-chain':
        if (!reachesSelf(old.supersededBy, record.id, index)) {
          errors.push(
            tag(
              `並行 supersede の敗北（旧 ${oldId} は他レコードへ置換済み）: retire ${record.id} または supersede ${record.id} <勝者 id> で解消`,
            ),
          );
        }
        break;
      default:
        break;
    }
  }

  if (record.supersededBy !== null) {
    const winner = index[record.supersededBy];
    if (!winner) errors.push(tag(`supersededBy 先が存在しない: ${record.supersededBy}`));
    else if (!winner.supersedes.includes(record.id)) {
      errors.push(tag(`逆リンク宙ぶらりん: ${record.supersededBy} の supersedes に自 id が無い`));
    }
  }

  errors.push(...validateReplacesLinks(record.replaces, index, tag));
  return { errors, warnings };
}

// replaces（#532）: revisedFrom と逆に、指す先は実在必須。差し替え元は終端状態（rejected /
// retired）に限る——accepted の置換は supersedes（双方向リンク・promote で完遂）、proposed の
// 訂正は revise が正規経路で、replaces で代替させるとそれらの検査（先勝ち・空白窓回避・
// revisedFrom 残存検査）を迂回できてしまうため。
// add / revise / promote の 3 箇所から呼ぶ独立関数にする（#531 統合レビュー指摘）——
// promote は record.supersedes の repair-aware 完遂ロジック（applySupersedeWrites）を持つため、
// validateLinks 全体をそのまま書込前ガードに使うと冪等完遂モードと衝突する。replaces だけを
// 対象にした検査を切り出すことで、supersedes 側の状態機械には触れずに同じ穴を塞げる。
function validateReplacesLinks(replaces, index, tag) {
  const errors = [];
  const REPLACEABLE = new Set(['rejected', 'retired']);
  for (const oldId of replaces) {
    const old = index[oldId];
    if (!old) {
      errors.push(tag(`replaces 先が存在しない: ${oldId}（差し替え元は履歴として残る前提）`));
      continue;
    }
    if (!REPLACEABLE.has(old.status)) {
      const hint =
        old.status === 'accepted'
          ? 'accepted の置換は add --supersedes → promote'
          : old.status === 'proposed'
            ? 'proposed の訂正は revise'
            : 'superseded は既に後継を持つ';
      errors.push(
        tag(`replaces 先 ${oldId} が rejected / retired でない（status: ${old.status}）。${hint}`),
      );
    }
  }
  return errors;
}

export function validateAll(rawRecords) {
  const errors = [];
  const warnings = [];

  for (const raw of rawRecords) {
    const g = validateFieldGrammar(raw);
    errors.push(...g.errors);
    warnings.push(...g.warnings);
  }

  const index = Object.create(null);
  const idCounts = Object.create(null);
  for (const raw of rawRecords) {
    if (typeof raw.id === 'string') {
      idCounts[raw.id] = (idCounts[raw.id] || 0) + 1;
      index[raw.id] = normalizeRecord(raw);
    }
  }
  for (const [id, count] of Object.entries(idCounts)) {
    if (count > 1) errors.push(`[${id}] id 衝突（${count} 件）`);
  }

  for (const raw of rawRecords) {
    if (typeof raw.id !== 'string') continue;
    const l = validateLinks(index[raw.id], index);
    errors.push(...l.errors);
    warnings.push(...l.warnings);
  }

  // O6: 同一 old を supersedes に持つ accepted が複数（並行 supersede すり抜けの最終検出線）
  const acceptedByOld = Object.create(null);
  for (const raw of rawRecords) {
    const rec = index[raw.id];
    if (!rec || rec.status !== 'accepted') continue;
    for (const oldId of rec.supersedes) {
      (acceptedByOld[oldId] = acceptedByOld[oldId] || []).push(rec.id);
    }
  }
  for (const [oldId, list] of Object.entries(acceptedByOld)) {
    if (list.length > 1) {
      errors.push(
        `[${oldId}] 同一 old を supersedes に持つ accepted が複数: ${list.join(', ')}（retire / 勝者ごと supersede で解消）`,
      );
    }
  }

  // revise 途中中断の検出: revisedFrom 先（revise が削除したはずの旧 id）が corpus に残存していれば
  // エラー。旧単独レコードの削除は他から参照されず検出線が無いため、この逆制約が §10 (a) の検出線。
  for (const raw of rawRecords) {
    if (typeof raw.id !== 'string') continue;
    const rec = index[raw.id];
    for (const oldId of rec.revisedFrom) {
      if (index[oldId]) {
        errors.push(
          `[${raw.id}] revisedFrom 先が残存: ${oldId}（revise 途中中断の痕跡。旧 ${oldId}.json を削除して完遂するか、新 ${raw.id}.json を削除して revise を取り消してください。取り消す場合は転記済み trailer・更新済み docs 参照も巻き戻すこと）`,
        );
      }
    }
  }

  // 同一旧 id を revisedFrom に持つレコード複数＝並行 revise のフォーク（O6 の supersede 版と同型の
  // 最終検出線）。正当な独立提案の可能性もあるためエラーにせず警告で人間の採否判断へ回す。
  // rejected / retired は「採否判断済み」なので集計から除外する。superseded は単純除外しない——
  // 通常の supersede（revisedFrom を持たない別レコードによる置換）でフォーク片側の系譜が集計から
  // 消えて fail-open になるため、supersededBy 連鎖の終端（生きた後継）に系譜を帰属させる。
  // 後継が同一なら重複計上しない（フォーク両側が supersede で同一勝者に収束した場合は消音）。
  const terminalSuccessor = (rec) => {
    const visited = new Set();
    let cur = rec;
    while (cur && cur.status === 'superseded' && cur.supersededBy && !visited.has(cur.id)) {
      visited.add(cur.id);
      cur = index[cur.supersededBy];
    }
    return cur ?? null;
  };
  const revisersByOld = Object.create(null);
  for (const raw of rawRecords) {
    if (typeof raw.id !== 'string') continue;
    const origin = index[raw.id];
    let holder = origin;
    if (holder.status === 'rejected' || holder.status === 'retired') continue;
    if (holder.status === 'superseded') {
      holder = terminalSuccessor(holder);
      if (!holder || holder.status === 'rejected' || holder.status === 'retired') continue;
    }
    for (const ref of origin.revisedFrom) {
      const list = (revisersByOld[ref] = revisersByOld[ref] || []);
      if (!list.includes(holder.id)) list.push(holder.id);
    }
  }
  for (const [oldId, list] of Object.entries(revisersByOld)) {
    if (list.length > 1) {
      warnings.push(
        `[${oldId}] 同一旧 id を revisedFrom に持つレコードが複数: ${list.join(', ')}（並行 revise のフォーク。人間が採否を判断し、不要側が proposed なら reject、accepted なら supersede / retire で決着する）`,
      );
    }
  }

  // `replaces` に増殖検出は置かない。旧側を書き換えない片方向リンクなので dangling も競合敗北も
  // 起こらず、「同一の rejected を複数が replaces する」は不整合ではなく並行提案（採否は
  // レビューの判断で、validate が warning にしても言えることが増えない）。双方向リンクの
  // `supersedes` とは検出の必要性が異なる。

  // supersededBy 循環検出。検出済み循環の全構成ノードを記録し、同一循環を重複報告しない。
  const cyclesSeen = new Set();
  for (const raw of rawRecords) {
    if (typeof raw.id !== 'string' || cyclesSeen.has(raw.id)) continue;
    const visited = new Set();
    let current = raw.id;
    let cyclic = false;
    while (current != null) {
      if (visited.has(current)) {
        cyclic = true;
        break;
      }
      visited.add(current);
      const rec = index[current];
      if (!rec) break;
      current = rec.supersededBy ?? null;
    }
    if (cyclic) {
      errors.push(`[${raw.id}] supersededBy 循環を検出`);
      for (const n of visited) cyclesSeen.add(n);
    }
  }

  // scope 拡張需要の集計（scope-proposal:* タグ）
  const proposals = Object.create(null);
  for (const raw of rawRecords) {
    const tags = Array.isArray(raw.tags) ? raw.tags : [];
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      const m = /^scope-proposal:(.+)$/.exec(t);
      if (m) proposals[m[1]] = (proposals[m[1]] || 0) + 1;
    }
  }

  return { errors, warnings, proposals };
}

// ---- 検索・glob ----

// glob 照合（`**`=スラッシュ跨ぎ / `*`=非スラッシュ / `?`=非スラッシュ1文字）。
// メモ化再帰で O(pattern×str) に抑え、正規表現バックトラック由来の ReDoS を回避する。
export function globMatch(pattern, str) {
  if (pattern.length > 256 || str.length > 4096) {
    // 病的に長い入力は照合対象にしない（fail-safe）。glob は fs アクセスしない純粋照合。
    if (pattern.length > 256) throw new CliError('glob が長すぎます（256 文字以下）');
    return false;
  }
  const memo = new Map();
  const match = (pi, si) => {
    const key = pi * (str.length + 1) + si;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let res;
    if (pi === pattern.length) {
      res = si === str.length;
    } else if (pattern[pi] === '*') {
      if (pattern[pi + 1] === '*') {
        res = match(pi + 2, si) || (si < str.length && match(pi, si + 1));
      } else {
        res = match(pi + 1, si) || (si < str.length && str[si] !== '/' && match(pi, si + 1));
      }
    } else if (pattern[pi] === '?') {
      res = si < str.length && str[si] !== '/' && match(pi + 1, si + 1);
    } else {
      res = si < str.length && pattern[pi] === str[si] && match(pi + 1, si + 1);
    }
    memo.set(key, res);
    return res;
  };
  return match(0, 0);
}

export function isActive(record) {
  return record.status === 'accepted' && record.supersededBy === null;
}

export function matchQuery(record, terms, { any = false } = {}) {
  const hay = SEARCH_FIELDS.flatMap((f) => {
    const v = record[f];
    return Array.isArray(v) ? v : [v];
  })
    .filter((v) => typeof v === 'string')
    .join('\n')
    .toLowerCase();
  const test = (t) => hay.includes(t.toLowerCase());
  return any ? terms.some(test) : terms.every(test);
}

function splitCsv(value) {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

export function applyFilters(record, filters) {
  if (filters.kind && filters.kind.length && !filters.kind.includes(record.kind)) return false;
  if (filters.status && record.status !== filters.status) return false;
  if (filters.visibility && record.visibility !== filters.visibility) return false;
  if (filters.scope && filters.scope.length && !filters.scope.some((s) => record.scope.includes(s))) {
    return false;
  }
  if (filters.tag && !record.tags.includes(filters.tag)) return false;
  if (filters.path) {
    // レコードの paths 自体が glob（例 worker/src/**）でも、具体パス（--path worker/src/foo.ts）で
    // 引けるよう双方向照合する（クエリを pattern に、保存済み glob を pattern に、両向き）。
    // どちらの向きも、pattern 側に渡す文字列が 256 文字超なら glob 長制限（クエリ側の暴走 glob
    // 対策）に触れて例外を投げるため、各方向は pattern 側の長さを見てから呼ぶ（不一致として扱う）。
    // 完全一致は glob 解釈を経ない単純な文字列比較のため、両者が同一の 256 文字超パスでも
    // 長さ制限の影響を受けずに一致させる（グロブ判定より先に判定する）。
    const matched = record.paths.some((p) => {
      if (typeof p !== 'string') return false;
      if (p === filters.path) return true;
      if (filters.path.length <= 256 && globMatch(filters.path, p)) return true;
      return p.length <= 256 && globMatch(p, filters.path);
    });
    if (!matched) return false;
  }
  return true;
}

export function searchRecords(rawRecords, opts) {
  const filters = opts.filters || {};
  const activeDefault = !opts.all && !filters.status;
  let base = rawRecords.map(normalizeRecord);
  if (activeDefault) base = base.filter(isActive);
  base = base.filter((r) => applyFilters(r, filters));
  if (opts.terms && opts.terms.length) {
    base = base.filter((r) => matchQuery(r, opts.terms, { any: opts.any }));
  }
  return base;
}

// ---- 出力整形 ----

// 改行を含む可能性のあるフィールドをそのまま埋め込むと、複数行にまたがる偽の結果行
// （例: 別レコードの `- [accepted] mem-...` を装う行）を作れてしまうため、出力直前に空白へ正規化する。
function flattenLine(s) {
  return s.replace(/\r\n|\r|\n/g, ' ');
}

export function formatResults(records, format = 'md') {
  if (format === 'json') return JSON.stringify(records, null, 2);
  if (records.length === 0) return '（該当なし）';
  // 検索結果はそのまま LLM へ渡す前提（設計 §5）。title だけでは制約の中身が読めないため summary を必ず含める。
  return records
    .map((r) => {
      const checks = r.reviewChecks.length
        ? `\n  reviewChecks: ${flattenLine(r.reviewChecks.join(' / '))}`
        : '';
      return `- [${r.status}] ${r.id} (${r.kind}; ${r.scope.join(',')}) ${flattenLine(r.title)}\n  summary: ${flattenLine(r.summary)}${checks}`;
    })
    .join('\n');
}

export function formatShow(record) {
  return JSON.stringify(record, null, 2);
}

// ---- レコード IO ----

const MAX_RECORD_BYTES = 1024 * 1024; // 1 記憶は数 KB 想定。巨大ファイルは OOM/DoS 防止で拒否。

// records/ が存在しない、または .json レコードが 0 件の場合の注意喚起。read 系コマンド
// （search / validate / digest / show）に加え、「記憶が見つかりません」を返す書込系コマンド
// （loadTargetRecord 経由の promote / reject / retire / supersede / revise、cmdPurge の未検出
// 分岐）にも適用する（ラウンド2敵対的レビュー A-8／ラウンド3品質2・減算 S-3・運用性10）。
// records/ は control-only（CONTROL_ONLY_DIRS）で public tree には含まれないため、public tree
// 側で読み系コマンドを実行すると常に 0 件になる。「そもそも public tree で対象が無い」と
// 「control repo 側で records/ が誤って空になった（破損疑い）」を同じ0件表示で黙って区別
// できなくすると silent fail-open になるため、結果を出す前に stderr へ1行出す（exit code は
// 変えない）。**呼び出し側が既に読み終えた records 配列を受け取り、二重に readdirSync しない**
// （品質2: 旧実装は loadRecords と本関数の双方が readdirSync していた）。add 等の書込系コマンドは
// 初回実行時に records/ を新規作成する正常フローがあるため対象外。
function noteIfNoRecords(dir, records) {
  if (records.length > 0) return;
  if (!existsSync(dir)) {
    process.stderr.write(
      'note: records/ が存在しません（public tree 相当。public repo には記憶レコードを含めません。' +
        'digest の public 同期は #345 残作業で未提供です。control repo で参照してください）\n',
    );
  } else {
    process.stderr.write(
      'note: records/ は存在しますが記憶が0件です（control repo の破損疑い。誤削除・partial clone を' +
        '確認してください）\n',
    );
  }
}

function loadRecords(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const records = [];
  for (const f of files) {
    const full = join(dir, f);
    // symlink（リポジトリ外・/dev/zero・FIFO への追従）と非通常ファイルを拒否（信頼境界外入力）。
    const st = lstatSync(full);
    if (!st.isFile()) throw new CliError(`通常ファイルでないレコード（symlink 等）: ${f}`);
    if (st.size > MAX_RECORD_BYTES) throw new CliError(`レコードが大きすぎます（${MAX_RECORD_BYTES} バイト超）: ${f}`);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(full, 'utf8'));
    } catch {
      throw new CliError(`レコードの JSON パースに失敗: ${f}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError(`レコードがオブジェクトでない: ${f}`);
    }
    if (basename(f, '.json') !== parsed.id) {
      throw new CliError(`ファイル名と id が不一致: ${f}（id=${parsed.id}）`);
    }
    records.push(parsed);
  }
  return records;
}

function buildIndex(rawRecords) {
  const index = Object.create(null);
  for (const raw of rawRecords) {
    if (typeof raw.id === 'string') index[raw.id] = normalizeRecord(raw);
  }
  return index;
}

function serializeRecord(record) {
  const ordered = Object.create(null);
  for (const k of KNOWN_ORDER) {
    if (REQUIRED.has(k)) {
      ordered[k] = record[k];
      continue;
    }
    const v = record[k];
    let isDefault;
    if (k === 'supersededBy') isDefault = (v ?? null) === null;
    else if (Array.isArray(OPTIONAL_DEFAULTS[k])) isDefault = !Array.isArray(v) || v.length === 0;
    else isDefault = v === undefined || v === '';
    if (!isDefault) ordered[k] = v;
  }
  return JSON.stringify(ordered, null, 2);
}

function writeRecord(dir, record) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.id}.json`), serializeRecord(record));
}

// id 生成の予約集合。現存レコードに加え、revisedFrom が指す削除済み旧 id も予約する——
// 再発行すると validate の残存検査がその新レコードを revise 途中中断と誤判定するため。
export function buildIdReservation(rawRecords) {
  const reserved = Object.create(null);
  for (const raw of rawRecords) {
    if (typeof raw.id === 'string') reserved[raw.id] = true;
    if (Array.isArray(raw.revisedFrom)) {
      for (const ref of raw.revisedFrom) {
        if (typeof ref === 'string') reserved[ref] = true;
      }
    }
  }
  return reserved;
}

function uniqueId(index, now) {
  const compact = dateCompact(now);
  for (let i = 0; i < 1000; i++) {
    const suffix = randomBytes(4).toString('hex').slice(0, 6);
    const id = formatId(compact, suffix);
    if (!index[id]) return id;
  }
  throw new CliError('id 生成に失敗（衝突多発）');
}

// ---- コマンド ----

function requireStr(flags, key, label) {
  const v = flags[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new CliError(`--${key}（${label}）は必須です`);
  }
  return v;
}

// 値を取るオプションの値省略（例: --supersedes で値なし）は splitCsv(true) が黙って空配列に
// 落ちてしまい、意図に反する空値が exit 0 で書き込まれてしまう。
// rationale は空文字が正当値のためフラグ存在時は文字列型のみ検査する（trim 空は許容）。
// split 後に空になる値（--paths "" や --paths ,）も、フラグを明示した意図（記録したい）に
// 反して黙って空配列に落ちるため、値欠落と同様に fail-loud にする（#9 の collectFilters と同じ判断）。
function requireRecordFlagValues(flags, arrayKeys) {
  for (const k of ['rationale', ...arrayKeys]) {
    if (k in flags && typeof flags[k] !== 'string') {
      throw new CliError(`--${k} には値が必要です`);
    }
  }
  for (const k of arrayKeys) {
    if (k in flags && splitCsv(flags[k]).length === 0) {
      throw new CliError(`--${k} の値が空です（指定しないならフラグ自体を省略してください）`);
    }
  }
}

// trailer 行に載る自由文字列の共通ガード。1 行 = 1 記録の機械出力契約と目視レビュー
// （設計 §6.0 が定める唯一の検査点）を守るため、「レビュアーが読んだものと実際の記録が違う」
// を作れる文字クラスを Unicode プロパティで包括的に拒否する（個別列挙は U+061C → U+2063 と
// 2 度漏らした教訓から採らない）:
// - \p{Cc}: C0/C1 制御・DEL（文字クラス直書きだと no-control-regex の eslint-disable が要る）
// - \p{Default_Ignorable_Code_Point}: 不可視文字の包括（ZWSP/ZWJ/BOM/word joiner/変異セレクタ等。
//   双方向制御 \p{Bidi_Control} と U+200B もこの集合に完全に含まれる — 全コードポイント走査で確認済み）
// - U+2028/U+2029: 行区切り。Git 上は 1 行でも GitHub の diff・コミットビューでは改行として
//   描画されるため、偽 trailer 行の注入が成立する
// 既知の残存: U+2800（点字空白）等「不可視に描画されるが上記プロパティに属さない」文字は通る
// （設計 §10 の受容リスク）。
const TRAILER_UNSAFE_RE = /[\u2028\u2029]|\p{Cc}|\p{Default_Ignorable_Code_Point}/u;
const TRAILER_VALUE_MAX = 200;

function requireTrailerSafe(value, flagName) {
  if (TRAILER_UNSAFE_RE.test(value)) {
    throw new CliError(
      `--${flagName} に改行・制御文字・双方向制御・ゼロ幅文字は使えません` +
        '（trailer は 1 行の機械出力契約で、目視レビューが検査点のため表示を偽装できる文字を拒否します）',
    );
  }
  // 上限なしだと trailer 行が際限なく伸び、コミットメッセージ中で他の記録を押し流せる。
  if (value.length > TRAILER_VALUE_MAX) {
    throw new CliError(`--${flagName} が長すぎます（${value.length} 文字。上限 ${TRAILER_VALUE_MAX}）`);
  }
  // trailer は `<op> <id...> by <endorser>` の順で、id 列が可変長のため区切り語 " by " が値の中に
  // 現れると後方分解が曖昧になる（"alice by proxy" は最初の by で切ると別の結果になる）。
  // 集計スクリプトを書く側から見て一意にパースできるよう、値側で禁止する。
  if (/\sby\s/i.test(value)) {
    throw new CliError(
      `--${flagName} に " by " を含められません（trailer の \`<id...> by <endorser>\` 分解が曖昧になります）`,
    );
  }
  return value;
}

// 人間の endorse（判断主体）の記録。設計 §6.0 の legitimacy モデル（#532）。
// レコードには書かない——author と同じ「自己申告の自由文字列がレコードに残る」轍を踏まないため。
// 記録先はコミットメッセージの trailer 一点に絞り、git log --grep で機械列挙できる形にする。
// 値そのものは検証できない（エージェントが人間名を騙れる）。ここで担保するのは「記録の存在」だけで、
// 内容の正当性は PR レビューが検査点（設計 §6.0 の残存リスク）。
// optional: true なら未指定を null で返す（revise の作業ブランチ外経路）。指定された場合の検査は
// 必須時と完全に同一にする——経路ごとに書き分けると片方だけ検査が抜けて trailer 偽造の穴になる。
function requireEndorsement(flags, { optional = false } = {}) {
  if (optional && !('endorsed-by' in flags)) return null;
  const endorser = requireStr(flags, 'endorsed-by', '人間の endorse（判断主体）').trim();
  requireTrailerSafe(endorser, 'endorsed-by');
  // --endorsed-by は Memory-Endorsement trailer にそのまま出力され、案内どおりコミット
  // メッセージへ貼られる。--reason と同じ経路で secret を漏らせるのに検査していなかった
  // （例: token を誤って渡すと exit 0 で trailer に出力される。外部レビュー指摘）。
  // --reason と同じく全 level を拒否する（人間の識別子欄に secret の実値が入る理由が無い）。
  const endorserSecrets = detectSecrets({ endorser });
  if (endorserSecrets.length) {
    throw new CliError(
      `--endorsed-by に secret らしきパターンが含まれます（${endorserSecrets.map((h) => h.name).join(', ')}）。` +
        'この値は Memory-Endorsement trailer としてコミットメッセージに残るため、' +
        '人間の識別子（GitHub handle 等）以外は書かないでください',
    );
  }
  return endorser;
}

// 既知のエージェント名。endorse の主体は人間であるべきなので、これらが endorser に来たら
// 警告する（設計 §6.0 は人間名の「騙り」を受容リスクとするが、騙りですらない自己 endorse は
// 名前を見れば分かるので観測可能にする。ブロックはしない——人間がこの名を使う可能性を
// CLI は否定できないため）。ブランチ命名規約（CLAUDE.md）と同じ語彙。
const KNOWN_AGENT_NAMES = new Set(['claude', 'codex', 'gemini', 'copilot', 'ai', 'agent']);

function warnSelfEndorsement(endorser, records) {
  const lower = endorser.toLowerCase();
  if (KNOWN_AGENT_NAMES.has(lower)) {
    process.stderr.write(
      `warning: --endorsed-by がエージェント名です（${endorser}）。endorse の主体は人間です（設計 §6.0）\n`,
    );
    return;
  }
  // author と同一＝レコードを書いた主体が自分で承認した形。人間が両方を担った正当なケースも
  // あるため警告に留める。
  if (records.some((r) => typeof r.author === 'string' && r.author.toLowerCase() === lower)) {
    process.stderr.write(
      `warning: --endorsed-by が対象レコードの author と同一です（${endorser}）。自己 endorse でないかレビューで確認されます\n`,
    );
  }
}

function writeEndorsementTrailer(command, ids, endorser) {
  process.stderr.write(
    'note: コミットメッセージ本文に endorse の経緯（どこで誰がどう判断したか）を記録し、末尾に下記の trailer を記載してください' +
      '（trailer は本文と空行で区切った独立段落に置く。本文行の直下に貼ると Git のパーサが trailer と認識しない）\n',
  );
  process.stdout.write(`Memory-Endorsement: ${command} ${ids.join(' ')} by ${endorser}\n`);
}

// 変更ゼロ（no-op）の再実行では trailer を stdout に出さない。stdout の trailer は「この実行が
// レコードを遷移させた」ことの機械出力契約で、変更ゼロで発行すると diff を伴わない endorse 記録を
// 任意に量産できる（trailer と実状態遷移の 1:1 対応＝§6.0 の検査点の前提が崩れる。敵対的レビューが
// 実証）。一方、レコード書込後・trailer 発行前に中断した過去の実行の記録は再取得できる必要がある
// ため、回復専用の候補 trailer を stderr に案内する（cmdRevise の unlink 失敗経路と同じ作法:
// stdout は成功時のみの機械出力契約を維持し、回復案内は stderr に置く）。
function adviseRecoveryTrailer(command, ids, endorser) {
  process.stderr.write(
    'note: 変更がないため trailer は stdout に出力しません。過去の実行がレコード書込後・trailer 発行前に' +
      '中断していた（＝コミット履歴に記録が無い）場合のみ、次の行をコミットメッセージ末尾に貼ってください。' +
      '記録の有無は Git の trailer パーサで確認します:\n' +
      `  git log --format='%(trailers:key=Memory-Endorsement,valueonly)' | grep -F ${ids[0]}\n` +
      `Memory-Endorsement: ${command} ${ids.join(' ')} by ${endorser}\n`,
  );
}

// unclassified を使うのに需要シグナル（scope-proposal タグ）が無ければ観測性のため警告。
function unclassifiedWarning(record) {
  if (
    record.scope.includes('unclassified') &&
    !record.tags.some((t) => t.startsWith('scope-proposal:'))
  ) {
    return `[${record.id}] scope に unclassified を使う場合は tags に scope-proposal:<希望語> を付けて拡張需要を記録してください`;
  }
  return null;
}

function cmdAdd(positionals, flags, dir) {
  if (positionals.length > 0) {
    throw new CliError(
      `add は位置引数を取りません（フラグで指定してください）: ${positionals.join(' ')}`,
    );
  }
  if ('status' in flags) {
    throw new CliError('add は常に proposed で作成します（--status は指定できません。昇格は promote）');
  }
  if ('visibility' in flags && typeof flags.visibility !== 'string') {
    throw new CliError('--visibility は値（control|public）が必要です');
  }
  requireRecordFlagValues(flags, ['paths', 'sources', 'supersedes', 'replaces', 'tags', 'reviewChecks']);
  const kind = requireStr(flags, 'kind', 'kind');
  const title = requireStr(flags, 'title', 'title');
  const summary = requireStr(flags, 'summary', 'summary');
  const author = requireStr(flags, 'author', 'author');
  const scope = splitCsv(flags.scope);
  if (scope.length === 0) throw new CliError('--scope（統制語彙・カンマ区切り）は1要素以上必須です');

  // 設計 §2: kind:rejected（不採用案の記録・通常 status:accepted）と status:rejected（提案自体の却下）は直交。
  if (kind === 'rejected') {
    process.stderr.write(
      'note: kind:rejected は「不採用にした代替案とその理由」の記録です（このレコード自体は通常 accepted へ昇格）。' +
        '「提案の却下」は status:rejected（reject コマンド。PR-b2）で別物です。\n',
    );
  }

  const rawRecords = loadRecords(dir);
  const index = buildIndex(rawRecords);
  const now = new Date();
  const id = uniqueId(buildIdReservation(rawRecords), now);
  const record = normalizeRecord({
    id,
    createdAt: formatDate(now),
    kind,
    status: 'proposed',
    visibility: typeof flags.visibility === 'string' ? flags.visibility : 'control',
    scope,
    paths: splitCsv(flags.paths),
    title,
    summary,
    rationale: typeof flags.rationale === 'string' ? flags.rationale : '',
    sources: splitCsv(flags.sources),
    supersedes: splitCsv(flags.supersedes),
    supersededBy: null,
    replaces: splitCsv(flags.replaces),
    tags: splitCsv(flags.tags),
    reviewChecks: splitCsv(flags.reviewChecks),
    author,
  });

  const { errors, warnings } = validateFieldGrammar(record);
  for (const oldId of record.supersedes) {
    const old = index[oldId];
    if (!old) {
      errors.push(`[${id}] supersedes 先が存在しない: ${oldId}`);
    } else if (old.status !== 'accepted') {
      // validateLinks の片方向リンク規則（old は accepted のみ合法）を add 時点で先出しする。
      // ここで弾かないと直後の validate が必ず失敗する壊れた proposed が書き込まれてしまう。
      errors.push(`[${id}] supersedes 先が accepted でない（status: ${old.status}）: ${oldId}`);
    }
  }
  // replaces の実在・status 条件も add 時点で先出しする（直後の validate が必ず失敗する
  // 壊れた proposed を書き込まないため。supersedes と同じ判断）。判定は validateLinks と
  // 同一の関数に寄せ、規則と案内文が経路ごとに食い違わないようにする。
  errors.push(...validateReplacesLinks(record.replaces, index, (m) => `[${id}] ${m}`));
  if (errors.length) {
    throw new CliError(`add 前検証に失敗:\n${errors.join('\n')}`);
  }
  const uw = unclassifiedWarning(record);
  if (uw) warnings.push(uw);
  // 追加時点で非致命の警告（sources 空・unclassified 等）を可視化する（fail-quiet の回避）。
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

  writeRecord(dir, record);
  process.stdout.write(`${id}\n`);
}

// docs 走査（revise の参照警告）は best-effort。巨大ファイルは読込コスト回避で skip
//（MAX_RECORD_BYTES はレコード受理上限で意味が異なるため独立させる）。
const MAX_DOC_SCAN_BYTES = 1024 * 1024;

// 旧 id を参照する docs 内ファイルの best-effort 走査（revise の警告用・非ブロッキング）。
// symlink は追わない（ループ・リポジトリ外追従の防止）。除外は新旧レコードファイルの 2 件のみ
//（新は revisedFrom が旧 id を含む正当参照、旧は削除前の走査時点でまだ実在し自分の id を必ず
// 含むため。records ディレクトリごと除外すると、他レコードの summary 等に残る旧 id 言及＝
// 更新すべき自由文参照が盲点になる）。
function scanDocsReferences(id, excludedFiles) {
  const hits = [];
  const excluded = new Set(excludedFiles.map((f) => resolve(f)));
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // 読めないディレクトリは best-effort で skip
    }
    for (const ent of entries) {
      const full = join(d, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      const lower = ent.name.toLowerCase();
      if (!ent.isFile() || !(lower.endsWith('.md') || lower.endsWith('.json'))) continue;
      if (excluded.has(resolve(full))) continue;
      try {
        if (lstatSync(full).size > MAX_DOC_SCAN_BYTES) {
          // DOCS_DIR 不在時の note と対称に、skip を黙らせない（fail-quiet 回避。exit code 不変）。
          process.stderr.write(`note: 参照走査をスキップしました（1MB 超）: ${full}\n`);
          continue;
        }
        if (readFileSync(full, 'utf8').includes(id)) hits.push(full);
      } catch {
        // 読めないファイルは best-effort で skip
      }
    }
  };
  walk(DOCS_DIR);
  return hits;
}

// コミット済み proposed の自己訂正（設計 §3 の不変性の例外）: 旧を削除し訂正後の内容で再 add する
// 操作を 1 コマンドで原子的に行う。手動 rm＋再 add は中間状態（削除だけコミット）を検出できないため
// 使わない。新レコードは revisedFrom で訂正由来を保持し、validate が「revisedFrom 先の残存」＝途中
// 中断を機械検出する（§10 (a)(d)）。
function cmdRevise(positionals, flags, dir) {
  const oldId = requireSinglePositional(positionals, 'revise');
  if ('status' in flags) {
    throw new CliError('revise の結果は常に proposed です（--status は指定できません。昇格は promote）');
  }
  if ('supersedes' in flags) {
    throw new CliError(
      'revise で置換意図は宣言できません（--supersedes は指定できません。置換は add --supersedes → promote 経路）',
    );
  }
  if ('visibility' in flags && typeof flags.visibility !== 'string') {
    throw new CliError('--visibility は値（control|public）が必要です');
  }
  for (const k of ['kind', 'title', 'summary']) {
    if (k in flags && typeof flags[k] !== 'string') {
      throw new CliError(`--${k} には値が必要です`);
    }
  }
  if ('replaces' in flags) {
    throw new CliError(
      'revise で差し替え系譜は宣言できません（--replaces は指定できません。旧レコードの replaces を継承します）',
    );
  }
  requireRecordFlagValues(flags, ['scope', 'paths', 'sources', 'tags', 'reviewChecks']);
  const author = requireStr(flags, 'author', 'author');
  // 作業ブランチ外の proposed を訂正する正規経路（設計 §3・§6.0。#532 / PR #531 の実績）。
  // CLI は Git を実行せずブランチを判定できないため、どちらの経路かは実行者の申告でしかない。
  // 指定された場合に endorse 記録（trailer）を出すことが CLI の担保範囲で、経路の正しさは
  // レビューが検査点。
  const endorser = requireEndorsement(flags, { optional: true });
  // author は実行主体の記録であり訂正内容ではない。訂正なしの revise は id だけ変わる無意味な
  // 削除＋再作成（監査ノイズ）のため fail-loud にする。
  const OVERRIDE_KEYS = [
    'kind', 'title', 'summary', 'scope', 'visibility', 'paths',
    'rationale', 'sources', 'tags', 'reviewChecks',
  ];
  if (!OVERRIDE_KEYS.some((k) => k in flags)) {
    throw new CliError('訂正内容がありません（--title / --summary 等で訂正後の値を指定してください）');
  }

  const rawRecords = loadRecords(dir);
  const old = loadTargetRecord(rawRecords, oldId, 'revise', dir);
  if (old.status !== 'proposed') {
    if (old.status === 'accepted') {
      throw new CliError(
        `revise は proposed 専用です（現 status: accepted）。accepted の訂正は supersede（後継あり）または retire（後継なし）で行ってください`,
      );
    }
    throw new CliError(
      `revise は proposed 専用です（現 status: ${old.status}）。rejected / superseded / retired は履歴として残し、削除・訂正しません`,
    );
  }
  // supersedes を持つ proposed の削除は置換意図を引き継ぐか落とすかの判断が要る（設計 §3）。
  if (old.supersedes.length > 0) {
    throw new CliError(
      `旧 ${oldId} は supersedes を持ちます（${old.supersedes.join(', ')}）。置換意図の扱いは人間の判断が必要です（revise 対象外。最終報告にエスカレーションしてください）`,
    );
  }
  // 他レコードから参照されている旧を削除すると dangling link で corpus が壊れる。
  const index = buildIndex(rawRecords);
  // 旧自身が未完遂 revise の「新側」（revisedFrom 先が残存）の場合も拒否する。許すと検出リンクの
  // 保持者が削除され、残存検査（唯一の検出線）が fail-open で消えて旧が孤児化する（兄弟 revise 経路）。
  for (const ref of old.revisedFrom) {
    if (index[ref]) {
      throw new CliError(
        `旧 ${oldId} は未完遂の revise の新側です（revisedFrom 先 ${ref} が残存）。先に validate の回復手順（${ref}.json を削除して完遂 / ${oldId}.json を削除して revise を取り消す）で併存状態を解消してください`,
      );
    }
  }
  // 旧がフォーク（同一旧 id を revisedFrom に持つ兄弟が他に居る）の一員の場合も拒否する。片側を
  // revise すると revisedFrom が 1 世代付け替わり、validate のフォーク警告（最終検出線）が消えたまま
  // 重複 proposed が併存するため、先に人間がフォークの採否を判断する。
  for (const rec of Object.values(index)) {
    if (
      rec.id === oldId ||
      rec.status === 'rejected' ||
      rec.status === 'retired' ||
      rec.status === 'superseded'
    ) continue;
    if (rec.revisedFrom.some((ref) => old.revisedFrom.includes(ref))) {
      throw new CliError(
        `旧 ${oldId} は並行 revise のフォークの一員です（${rec.id} と revisedFrom 先を共有）。先に人間がフォークの採否を判断してください（不要側が proposed なら reject、accepted なら supersede / retire）`,
      );
    }
  }
  for (const rec of Object.values(index)) {
    if (rec.id === oldId) continue;
    // replaces も被参照に含める（proposed が replaces 先になることは validate 上ありえないが、
    // 手書き・将来の経路追加で生まれた不正参照を削除で握り潰さないための防御的検査）。
    if (rec.supersedes.includes(oldId) || rec.supersededBy === oldId || rec.replaces.includes(oldId)) {
      throw new CliError(
        `旧 ${oldId} は ${rec.id} から参照されています（supersedes / supersededBy / replaces）。削除できません（人間の判断が必要です）`,
      );
    }
    // 途中中断（新旧併存）状態の旧を再 revise すると、validate の残存検査（唯一の検出線）が
    // 旧削除の副作用で消え、同一旧由来の proposed がフォークして全緑で残る。回復は validate の
    // 案内する2択（完遂 / 取り消し）に限定する。
    if (rec.revisedFrom.includes(oldId)) {
      throw new CliError(
        `旧 ${oldId} は ${rec.id} の revisedFrom から参照されています（revise 途中中断の新旧併存状態）。revise せず validate の回復手順（旧を削除して完遂 / 新を削除して revise を取り消す）に従ってください`,
      );
    }
  }

  const now = new Date();
  const newId = uniqueId(buildIdReservation(rawRecords), now);
  // 未指定フィールドは旧レコードから継承する（全再指定は転記ミス＝#509 の失敗モードを再導入する）。
  // id / createdAt は本日で再生成（旧値を継承すると id 日付部と createdAt の整合検査に落ちる）。
  // revisedFrom は祖先の旧 id を累積する（[...旧の revisedFrom, 今回の旧 id]）。直前 1 世代のみだと
  // 連鎖 revise（A→B→C）で A が corpus から消え、buildIdReservation が A を予約できず、同日中の
  // 再発行が過去の trailer（A -> B）と監査上衝突するため。累積はフォーク検出（祖先共有）も強くする。
  const record = normalizeRecord({
    id: newId,
    createdAt: formatDate(now),
    kind: typeof flags.kind === 'string' ? flags.kind : old.kind,
    status: 'proposed',
    visibility: typeof flags.visibility === 'string' ? flags.visibility : old.visibility,
    scope: 'scope' in flags ? splitCsv(flags.scope) : old.scope,
    paths: 'paths' in flags ? splitCsv(flags.paths) : old.paths,
    title: typeof flags.title === 'string' ? flags.title : old.title,
    summary: typeof flags.summary === 'string' ? flags.summary : old.summary,
    rationale: typeof flags.rationale === 'string' ? flags.rationale : old.rationale,
    sources: 'sources' in flags ? splitCsv(flags.sources) : old.sources,
    supersedes: [],
    supersededBy: null,
    revisedFrom: [...old.revisedFrom, oldId],
    // 差し替え系譜は訂正で失われてはならない（旧が rejected 記録を指していた事実は残す）。
    replaces: old.replaces,
    tags: 'tags' in flags ? splitCsv(flags.tags) : old.tags,
    reviewChecks: 'reviewChecks' in flags ? splitCsv(flags.reviewChecks) : old.reviewChecks,
    author,
  });

  // キー存在だけでは同値再指定（実質 no-op の削除＋再作成＝監査ノイズ・id 差し替えの launder）を
  // 通してしまうため、構築後の実値でも旧との差分を検査する。比較は正規化ベース（NFC・ゼロ幅文字
  // 除去・trim・配列の順序と重複無視）——末尾空白・並べ替え・不可視文字・要素重複だけの「訂正」も
  // no-op として拒否する。同義語い換え等の意味レベルの no-op は検出対象外（原理的に閉じないクラス。§10）。
  // U+200C/U+200D（ZWNJ/ZWJ）は結合・絵文字表示を変える意味のある文字のため除去しない
  //（除去すると絵文字の ZWJ 結合訂正等が偽 no-op になる）。ZERO_WIDTH_RE とは意図が異なる。
  const NOOP_INVISIBLE_RE = /\u200b|\u2060|\ufeff/g;
  const canonStr = (s) => s.normalize('NFC').replace(NOOP_INVISIBLE_RE, '').trim();
  const canon = (v) => {
    if (Array.isArray(v)) {
      return JSON.stringify(
        [...new Set(v.map((e) => (typeof e === 'string' ? canonStr(e) : e)))].sort(),
      );
    }
    if (typeof v === 'string') return JSON.stringify(canonStr(v));
    return JSON.stringify(v);
  };
  if (OVERRIDE_KEYS.every((k) => canon(record[k]) === canon(old[k]))) {
    throw new CliError(
      '訂正内容がありません（指定された値が正規化後すべて旧レコードと同一です。取り下げは人間の reject で行います）',
    );
  }

  const { errors, warnings } = validateFieldGrammar(record);
  if (errors.length) {
    throw new CliError(`revise 前検証に失敗（旧 ${oldId} は無変更）:\n${errors.join('\n')}`);
  }
  // フィールド文法検査は単一レコードで閉じるため、継承した replaces（旧の値をそのまま引き継ぐ）が
  // 実在し rejected/retired を指しているかまでは見ない。旧の replaces が壊れていた場合、ここを
  // 通さずに書込・旧削除まで進めると revise は exit 0 のまま corpus を壊し、次の validate で
  // 初めて判明する（旧は既に削除済みで無変更に戻せない）。書込前に検査する（外部レビュー指摘）。
  // revise の record.supersedes は常に空のため validateLinks 全体でも実質 replaces のみが
  // 検査対象になるが、意図を明確にするため replaces 専用の検査関数を直接呼ぶ。
  const linkErrors = validateReplacesLinks(record.replaces, index, (m) => `[${record.id}] ${m}`);
  if (linkErrors.length) {
    throw new CliError(
      `revise 前検証に失敗（継承した replaces のリンクが不正。旧 ${oldId} は無変更）:\n${linkErrors.join('\n')}`,
    );
  }
  const uw = unclassifiedWarning(record);
  if (uw) warnings.push(uw);
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

  // 新を先に書き、時間のかかる参照走査を旧削除の前に済ませてから旧を消す。unlink 成功後〜stdout
  // 出力までの中断窓（この窓で落ちると新のみ残り validate では検出できず trailer も未出力になる）を
  // 数回の write のみに最小化するため。窓の完全な排除は非トランザクション性ゆえ不能（§10）。
  // クラッシュ中間状態が新旧併存側なら validate が revisedFrom 先の残存として検出し回復手順を案内する。
  writeRecord(dir, record);
  const ownFiles = [join(dir, `${oldId}.json`), join(dir, `${record.id}.json`)];
  if (!existsSync(DOCS_DIR)) {
    // 黙って走査ゼロにしない（fail-quiet 回避）。走査は best-effort のため exit code には影響させない。
    process.stderr.write(`note: 旧 id の参照走査をスキップしました（${DOCS_DIR} が見つかりません）\n`);
  } else {
    for (const f of scanDocsReferences(oldId, ownFiles)) {
      process.stderr.write(
        `warning: 旧 id ${oldId} を参照する in-repo ファイル: ${f}（同一 PR で更新してください）\n`,
      );
    }
  }
  try {
    unlinkSync(join(dir, `${oldId}.json`));
  } catch (e) {
    // 失敗経路でも完遂用の監査情報を stderr に残す（stdout 契約＝成功時のみ機械出力、は維持。
    // 取り消しを選んだ場合に trailer が誤ってコミットへ転記される事故を防ぐ）。参照走査は上で実施済み。
    process.stderr.write(
      `note: 完遂する場合はコミットメッセージ末尾に次の trailer を記載してください: Memory-Revision: ${oldId} -> ${newId}\n`,
    );
    if (endorser !== null) {
      // 作業ブランチ外の訂正では endorsement が必須。成功経路にしか出さないと、手動で旧を
      // 削除して完遂した場合に必須 trailer が欠落する。
      process.stderr.write(
        `note: 同じく次の trailer も必要です: Memory-Endorsement: revise ${oldId} by ${endorser}\n`,
      );
    }
    throw new CliError(
      `旧レコードの削除に失敗しました（原因: ${e instanceof Error ? e.message : e}）。新 ${newId} は書込済みです。旧 ${oldId}.json を削除して完遂するか、新 ${newId}.json を削除して revise を取り消してください（validate が新旧併存を検出します）`,
    );
  }
  process.stderr.write(
    'note: コミットメッセージ本文に実行主体・訂正理由を記録し、末尾に下記の Memory-Revision trailer を記載してください\n',
  );
  if (endorser === null) {
    process.stderr.write(
      `note: 旧レコードが自分の作業ブランチで add したものであることを確認してください（git log <base>..HEAD --diff-filter=A -- docs/agent-memory/records/${oldId}.json）。作業ブランチ外のレコードなら人間の endorse を得て --endorsed-by を付けて実行してください（設計 §6.0）\n`,
    );
  }
  // stdout は機械出力契約: 1 行目が新旧 id の対応、2 行目がコミットメッセージ用 trailer。
  // 既存コマンドの「id のみ」契約から逸脱するのは、trailer 転記（§10 (b)(c)）を機械支援するため。
  process.stdout.write(`${oldId} -> ${newId}\n`);
  process.stdout.write(`Memory-Revision: ${oldId} -> ${newId}\n`);
  if (endorser !== null) {
    // 作業ブランチ外レコードの訂正はレビューが唯一の検査点なので、他コマンドと同じ自己 endorse
    // 警告をここでも出す（旧レコードの author と突き合わせる）。
    warnSelfEndorsement(endorser, [old]);
    writeEndorsementTrailer('revise', [oldId], endorser);
  }
}

// 値を取るフィルタフラグ。値省略（parseArgs が true を入れる）は黙って無視せず fail-loud にする
// （タイプミスで意図せぬ無フィルタ検索が exit 0 になるのを防ぐ）。
const VALUE_FILTER_FLAGS = ['kind', 'scope', 'status', 'visibility', 'tag', 'path'];

function collectFilters(flags) {
  const filters = Object.create(null);
  for (const k of VALUE_FILTER_FLAGS) {
    if (!(k in flags)) continue;
    if (typeof flags[k] !== 'string') {
      throw new CliError(`--${k} には値が必要です`);
    }
    // split 後に空になる値（--scope "" や --kind ,）・trim 後空文字は no-op フィルタになり
    // 空クエリガードを実質すり抜けるため、これも値欠落と同様に fail-loud にする。
    const isEmpty =
      k === 'kind' || k === 'scope' ? splitCsv(flags[k]).length === 0 : flags[k].trim() === '';
    if (isEmpty) {
      throw new CliError(`--${k} の値が空です（絞り込みを外すならフラグ自体を省略してください）`);
    }
  }
  const kind = splitCsv(flags.kind);
  for (const k of kind) {
    if (!KINDS.has(k)) throw new CliError(`--kind に未知の値: ${k}`);
  }
  const scope = splitCsv(flags.scope);
  for (const s of scope) {
    if (!SCOPE_VOCAB.has(s)) throw new CliError(`--scope に未知の値: ${s}`);
  }
  if (typeof flags.status === 'string' && !STATUSES.has(flags.status)) {
    throw new CliError(`--status に未知の値: ${flags.status}`);
  }
  if (typeof flags.visibility === 'string' && !VISIBILITIES.has(flags.visibility)) {
    throw new CliError(`--visibility に未知の値: ${flags.visibility}`);
  }
  if (typeof flags.kind === 'string') filters.kind = kind;
  if (typeof flags.scope === 'string') filters.scope = scope;
  if (typeof flags.status === 'string') filters.status = flags.status;
  if (typeof flags.visibility === 'string') filters.visibility = flags.visibility;
  if (typeof flags.tag === 'string') filters.tag = flags.tag;
  if (typeof flags.path === 'string') filters.path = flags.path;
  return filters;
}

// ゼロ幅・不可視文字（空クエリ判定を素通りさせないため除去してから空白分割する）。
const ZERO_WIDTH_RE = /\u200b|\u200c|\u200d|\u2060|\ufeff/g;

function cmdSearch(positionals, flags, dir) {
  const filters = collectFilters(flags);
  const hasFilters = Object.keys(filters).length > 0;
  // 引用符なしの複数語（search 同期 競合）も引用付き（"同期 競合"）と同じ AND 検索にする。
  const rawQuery = positionals.length > 0 ? positionals.join(' ') : null;
  const terms =
    rawQuery === null ? [] : rawQuery.replace(ZERO_WIDTH_RE, '').split(/[\s　]+/).filter(Boolean);

  if (rawQuery !== null && terms.length === 0) {
    throw new CliError(
      'クエリが空です。絞り込みだけしたい場合はクエリを省略して --scope 等のフィルタを使ってください',
    );
  }
  if (rawQuery === null && !hasFilters) {
    throw new CliError('クエリもフィルタもありません（全件出力は digest の役割です）');
  }

  if ('format' in flags && flags.format !== 'md' && flags.format !== 'json') {
    throw new CliError(`--format は md か json のみ指定できます: ${flags.format}`);
  }
  const rawRecords = loadRecords(dir);
  noteIfNoRecords(dir, rawRecords);
  const results = searchRecords(rawRecords, {
    all: flags.all === true,
    any: flags.any === true,
    filters,
    terms,
  });
  // ヒットしたレコードのみ文法・リンク整合・secret 検査を行う（全件 validate だと無関係な壊れた
  // レコード1件が全 search を止める blast radius が大きすぎるため、影響範囲をヒット結果に限定して
  // fail-loud）。リンク整合（validateLinks）はヒットしたレコード自身の supersedes/supersededBy のみ
  // 検査対象（他レコードの循環・O6 等の corpus 横断検査はヒット限定の対象外）。
  const rawById = Object.create(null);
  for (const raw of rawRecords) {
    if (typeof raw.id === 'string') rawById[raw.id] = raw;
  }
  const index = buildIndex(rawRecords);
  const hitErrors = [];
  for (const r of results) {
    const raw = rawById[r.id];
    if (!raw) continue;
    const { errors } = validateFieldGrammar(raw);
    hitErrors.push(...errors);
    hitErrors.push(...validateLinks(index[r.id], index).errors);
  }
  if (hitErrors.length) {
    throw new CliError(`検索結果に不正なレコードが含まれます（validate で確認してください）:\n${hitErrors.join('\n')}`);
  }
  const format = flags.format === 'json' ? 'json' : 'md';
  process.stdout.write(`${formatResults(results, format)}\n`);
}

function cmdShow(positionals, dir) {
  const id = positionals[0];
  if (!id) throw new CliError('show <id> の id を指定してください');
  if (positionals.length > 1) {
    throw new CliError(`show は id を1つだけ取ります。余った位置引数: ${positionals.slice(1).join(' ')}`);
  }
  const rawRecords = loadRecords(dir);
  noteIfNoRecords(dir, rawRecords);
  const raw = rawRecords.find((r) => r.id === id);
  if (!raw) throw new CliError(`記憶が見つかりません: ${id}`);
  // normalizeRecord は未知フィールド・secret 混入等を無害化して見せてしまうため、search の
  // per-hit 検査（#22）と同じ判断基準で対象レコード単体を文法検査してから表示する。
  const { errors, warnings } = validateFieldGrammar(raw);
  if (errors.length) {
    throw new CliError(`このレコードは不正です（validate で確認してください）:\n${errors.join('\n')}`);
  }
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  process.stdout.write(`${formatShow(normalizeRecord(raw))}\n`);
}

// ---- ライフサイクル遷移（PR-b2。設計 §6）----
// 判断の主体は人間、実行の主体はエージェントでもよい（設計 §6.0 の legitimacy モデル。#532）。
// 4 コマンドとも --endorsed-by を必須にし、endorse をコミット trailer として残させる。
// 「人間の明示操作専用」という主体規定は検証不能（author は自己申告・CLI は Git を実行しない）
// だったため、検証可能な「記録の存在」へ置き換えている。

// 遷移対象レコードの取得＋文法検査（壊れたレコードのまま遷移させない。show と同じ判断基準）。
// dir は「記憶が見つかりません」の直前に noteIfNoRecords を呼ぶためだけに使う（records/ 不在・0件を
// id タイプミスと区別できるようにする。ラウンド3品質2・運用性10。呼び出し側は既に loadRecords 済みの
// rawRecords をそのまま渡すため、本関数側で再度 readdirSync はしない）。
function loadTargetRecord(rawRecords, id, commandName, dir) {
  if (!id) throw new CliError(`${commandName} <id> の id を指定してください`);
  const raw = rawRecords.find((r) => r.id === id);
  if (!raw) {
    noteIfNoRecords(dir, rawRecords);
    throw new CliError(`記憶が見つかりません: ${id}`);
  }
  const { errors } = validateFieldGrammar(raw);
  if (errors.length) {
    throw new CliError(`このレコードは不正です（validate で確認してください）:\n${errors.join('\n')}`);
  }
  return normalizeRecord(raw);
}

function requireSinglePositional(positionals, commandName) {
  if (positionals.length > 1) {
    throw new CliError(
      `${commandName} は id を1つだけ取ります。余った位置引数: ${positionals.slice(1).join(' ')}`,
    );
  }
  return positionals[0];
}

// promote / supersede 共有の置換書込ルーチン（設計 §6「promote の書込順と障害回復」）。
// 前提検査（old が accepted・先勝ち・文法・冪等スキップ）→ 新を先に書く → 旧を書く、の順を守る。
// 逆順は既定検索（accepted×supersededBy null）から新旧とも消える空白窓を作るため禁止。
// oldIds は「今回の呼び出しで処理する対象」を明示的に渡す（newRecord.supersedes 全体ではない）。
// supersede は 1 呼び出し=1 リンクのコマンドなので、既に supersedes に含まれる無関係な過去のリンク
// （勝者ごと置換のチェーン修復で他レコードへ既に完了済みの old 等）を誤って再検査・再エラーにしない。
function applySupersedeWrites(newRecord, oldIds, index, rawById, dir, { writeNew }) {
  const pendingOlds = [];
  for (const oldId of oldIds) {
    const old = index[oldId];
    if (!old) throw new CliError(`置換元が存在しません: ${oldId}`);
    // 冪等な再実行: 既に自レコードへの置換が完遂済みならスキップ。
    if (old.supersededBy === newRecord.id) continue;
    if (old.supersededBy !== null) {
      // 先勝ち（O6）: 他レコードに置換済みの old は奪えない。promote 再実行では回復しない。
      throw new CliError(
        `並行 supersede の敗北: 置換元 ${oldId} は既に ${old.supersededBy} へ置換済みです。` +
          `retire ${newRecord.id} または supersede ${newRecord.id} <勝者 id> で解消してください`,
      );
    }
    if (old.status !== 'accepted') {
      throw new CliError(
        `置換元 ${oldId} が accepted でない（status: ${old.status}）。置換の扱いは人間が判断してください（reject 等）`,
      );
    }
    // old を superseded 化して書き戻す前に文法検査する。正規化書込は未知フィールドや secret 等を
    // 黙って落としてしまうため、壊れたレコードを遷移させない方針（show/search と同じ判断基準）を
    // ここでも守る。
    const rawOld = rawById[oldId];
    if (rawOld) {
      const { errors } = validateFieldGrammar(rawOld);
      if (errors.length) {
        throw new CliError(
          `置換元 ${oldId} のレコードが不正です（validate で確認してください）:\n${errors.join('\n')}`,
        );
      }
    }
    pendingOlds.push(old);
  }
  // step 1: 新レコードを先に書く（クラッシュ時は一時的二重アクティブ＝安全側。validate が検出）。
  if (writeNew) writeRecord(dir, newRecord);
  // step 2: 旧レコードへ supersededBy 付与＋superseded 化。
  for (const old of pendingOlds) {
    old.supersededBy = newRecord.id;
    old.status = 'superseded';
    writeRecord(dir, old);
  }
  // 呼び出し側の no-op 判定に使う。「supersedes 配列が空か」ではなく「今回実際に遷移・リンク修復を
  // 行ったか」でなければ、完遂済みレコードの冪等な再実行が endorse 記録だけを量産できてしまう。
  return { changed: Boolean(writeNew) || pendingOlds.length > 0 };
}

function buildRawById(rawRecords) {
  const rawById = Object.create(null);
  for (const raw of rawRecords) {
    if (typeof raw.id === 'string') rawById[raw.id] = raw;
  }
  return rawById;
}

function cmdPromote(positionals, flags, dir) {
  const id = requireSinglePositional(positionals, 'promote');
  const endorser = requireEndorsement(flags);
  const rawRecords = loadRecords(dir);
  const record = loadTargetRecord(rawRecords, id, 'promote', dir);
  if (record.status === 'rejected' || record.status === 'retired') {
    throw new CliError(`promote は proposed 専用です（現 status: ${record.status}）`);
  }
  const index = buildIndex(rawRecords);
  const rawById = buildRawById(rawRecords);
  // add 時点では replaces 先が rejected/retired だったとしても、add から promote までの間に
  // 対象が purge される等で状態が変わりうる。フィールド文法検査（loadTargetRecord）は単一
  // レコードで閉じるため見ない。書込前に検査しないと promote は exit 0 で Memory-Endorsement
  // trailer まで発行し、直後の validate で初めて corpus の壊れが判明する（revise と同型の穴。
  // #531 統合レビュー指摘）。record.supersedes は applySupersedeWrites の repair-aware ロジックが
  // 別途扱うため、ここでは replaces のみを対象にする。
  const replacesErrors = validateReplacesLinks(record.replaces, index, (m) => `[${id}] ${m}`);
  if (replacesErrors.length) {
    throw new CliError(`promote 前検証に失敗（replaces のリンクが不正。対象は無変更）:\n${replacesErrors.join('\n')}`);
  }
  // 冪等な再実行（リンク完遂モード）: 既に accepted / superseded なら status 遷移（step 1 の書込）は
  // スキップし、旧レコードへのリンク付与（step 2）だけを完遂する。
  const needsTransition = record.status === 'proposed';
  if (needsTransition) record.status = 'accepted';
  // promote は add --supersedes で宣言された全 old を一括で処理する（初回リンク・リンク完遂の両方）。
  const { changed } = applySupersedeWrites(record, record.supersedes, index, rawById, dir, {
    writeNew: needsTransition,
  });
  const noop = !changed;
  if (noop) {
    process.stderr.write(`note: ${id} は既に ${record.status} です（変更なし）\n`);
  }
  process.stdout.write(`${id}\n`);
  // 自己 endorse 警告は no-op でも出す。偽の監査記録を作る誘因が最も強いのが変更ゼロの経路であり、
  // ここだけ警告を飛ばすと詐称の唯一の観測手段が悪用しやすい側で消える（敵対的レビュー指摘）。
  warnSelfEndorsement(endorser, [record]);
  if (noop) {
    adviseRecoveryTrailer('promote', [id], endorser);
  } else {
    writeEndorsementTrailer('promote', [id], endorser);
  }
}

function cmdReject(positionals, flags, dir) {
  const id = requireSinglePositional(positionals, 'reject');
  const endorser = requireEndorsement(flags);
  const rawRecords = loadRecords(dir);
  const record = loadTargetRecord(rawRecords, id, 'reject', dir);
  if (record.status !== 'proposed') {
    throw new CliError(`reject は proposed 専用です（現 status: ${record.status}）`);
  }
  // 却下理由はレコードを変更せず Git コミット / PR に残す（設計 §6。削除もしない＝監査可能性）。
  record.status = 'rejected';
  writeRecord(dir, record);
  process.stdout.write(`${id}\n`);
  warnSelfEndorsement(endorser, [record]);
  writeEndorsementTrailer('reject', [id], endorser);
}

function cmdRetire(positionals, flags, dir) {
  const id = requireSinglePositional(positionals, 'retire');
  const endorser = requireEndorsement(flags);
  const rawRecords = loadRecords(dir);
  const record = loadTargetRecord(rawRecords, id, 'retire', dir);
  if (record.status !== 'accepted') {
    throw new CliError(`retire は accepted 専用です（現 status: ${record.status}）`);
  }
  // 後継なし退役: supersededBy は null のまま（「retired × 片方向」は §4 の表で合法な取り下げ終着）。
  record.status = 'retired';
  writeRecord(dir, record);
  process.stdout.write(`${id}\n`);
  warnSelfEndorsement(endorser, [record]);
  writeEndorsementTrailer('retire', [id], endorser);
}

function cmdSupersede(positionals, flags, dir) {
  const [newId, oldId, ...extra] = positionals;
  if (!newId || !oldId) throw new CliError('supersede <new-id> <old-id> の 2 引数が必要です');
  if (extra.length > 0) {
    throw new CliError(`supersede は id を2つだけ取ります。余った位置引数: ${extra.join(' ')}`);
  }
  if (newId === oldId) throw new CliError('自己置換はできません（new-id と old-id が同一）');
  const endorser = requireEndorsement(flags);
  const rawRecords = loadRecords(dir);
  const record = loadTargetRecord(rawRecords, newId, 'supersede', dir);
  loadTargetRecord(rawRecords, oldId, 'supersede', dir);
  // 既 accepted 同士の後付け置換リンク専用（proposed からの置換は add --supersedes → promote 経路）。
  if (record.status !== 'accepted') {
    throw new CliError(`supersede は accepted 同士専用です（new ${newId} の status: ${record.status}）`);
  }
  const index = buildIndex(rawRecords);
  const rawById = buildRawById(rawRecords);
  // 冪等: new.supersedes に old id が既にあれば追記しない（途中クラッシュ後の再実行で重複を作らない）。
  const needsAppend = !record.supersedes.includes(oldId);
  if (needsAppend) record.supersedes = [...record.supersedes, oldId];
  // supersede は 1 呼び出し=1 リンクのコマンド。処理対象は今回指定された oldId のみ（record.supersedes
  // 全体ではない）。既存の supersedes に入っている無関係な過去のリンク（勝者ごと置換のチェーン修復で
  // 他レコードへ既に完了済みの old 等）を誤って再検査・再エラーにしないため。
  const { changed } = applySupersedeWrites(record, [oldId], index, rawById, dir, {
    writeNew: needsAppend,
  });
  process.stdout.write(`${newId}\n`);
  // promote と同じ理由で、自己 endorse 警告は no-op でも出す。
  warnSelfEndorsement(endorser, [record]);
  if (!changed) {
    process.stderr.write(`note: ${newId} → ${oldId} の置換は完遂済みです（変更なし）\n`);
    adviseRecoveryTrailer('supersede', [newId, oldId], endorser);
  } else {
    writeEndorsementTrailer('supersede', [newId, oldId], endorser);
  }
}

// secret 混入レコードの削除＋リンク整合の回復（設計 §4 の削除例外 (1)。#532）。
// 削除の例外は secret 混入と revise の 2 つだけで、purge は前者専用。リンクに参加したレコードを
// 手で消すと dangling（supersedes 先の消失 / 逆リンク宙ぶらりん）が validate の error として
// 恒久的に残り、解消コマンドが無く JSON 手編集も禁じられているため CI がブロックされる——
// この経路を塞ぐのが本コマンドの目的。
//
// 作業ツリーからの削除しか行わない。Git 履歴からの除去（secret が残る本体）は
// docs/security/public-release-checklist.md の手順で人間が別途実施する（CLI は Git を実行しない）。
function cmdPurge(positionals, flags, dir) {
  const id = requireSinglePositional(positionals, 'purge');
  if (!id) throw new CliError('purge <id> の id を指定してください');
  // id 形式は回復案内より前に検証する。不正 id のまま「対象も修復対象も無い」分岐へ落ちると、
  // 完遂済みと誤認させる文法違反の Memory-Purge / Memory-Endorsement 行を案内してしまう
  // （README はこのエラーを完了済みとして扱えると説明しているため、タイプミスが監査行になる）。
  if (!ID_RE.test(id)) {
    throw new CliError(`id 形式不正（mem-YYYYMMDD-<6桁>）: ${id}`);
  }
  if (!isValidCalendarDate(`${id.slice(4, 8)}-${id.slice(8, 10)}-${id.slice(10, 12)}`)) {
    throw new CliError(`id の日付部が実在しない暦日です: ${id}`);
  }
  const endorser = requireEndorsement(flags);
  const reason = requireTrailerSafe(
    requireStr(flags, 'reason', '削除理由（secret 混入の種別。実値を書かない）').trim(),
    'reason',
  );
  // --reason は Memory-Purge trailer に載り、そのままコミットメッセージへ転記される。ここに
  // secret の実値を書かれると、漏洩対応そのものが新しい漏洩を作る（レコードを履歴から除去しても
  // purge コミットのメッセージに残る）。レコード本文と同じ secret 検査を理由文にも適用する。
  // level を問わず全 hit を拒否する。レコード本文では inline-credential を warn に留めている
  // （教訓・制約レコードでの引用が偽陽性になりやすいため）が、--reason は「secret の種別を
  // 一言で書く」欄で引用の必要が無く、値はコミットメッセージに残る。偽陽性で書き換えを
  // 求める方が、汎用パスワードや独自 API キーの再漏洩より安全側。
  const reasonSecrets = detectSecrets({ reason });
  if (reasonSecrets.length) {
    throw new CliError(
      `--reason に secret らしきパターンが含まれます（${reasonSecrets.map((h) => h.name).join(', ')}）。` +
        '理由には種別だけを書いてください（例: AWS アクセスキー混入）。' +
        'この値は Memory-Purge trailer としてコミットメッセージに残るため、実値を書くと再漏洩になります',
    );
  }
  // 退役の明示承認は boolean フラグ。受理値が retire 一択になった時点で enum の器は不要
  // （減算レビュー指摘）。superseded → accepted の復活辺は持たない（endorse 記録のない昇格
  // 経路になり §6.0 の「記録の不在が機械的に見える」が条件付きになるため）。再有効化が必要な
  // 場合は add --replaces <retired-id> → promote（どちらも endorse が残る）。
  const retireOrphans = flags['retire-orphans'] === true;

  const rawRecords = loadRecords(dir);
  const target = rawRecords.find((r) => r.id === id);
  const targetPath = join(dir, `${id}.json`);
  const index = buildIndex(rawRecords);

  // purge は secret 混入専用（design §4 の削除例外 (1)）だが、CLI はレコード本文の secret 有無を
  // 検証しない（status ガード・所有者ガードも意図的に持たない。§10「用途の限定はレビューが担保
  // する」）。secret が実際には見つからない purge を無警告で成立させると、この可視化がレビューの
  // 唯一の手がかりになる場面で何も出ないため、検出可否を警告として明示する（敵対的レビュー指摘）。
  // 拒否はしない——未知の secret パターンや構造化されていない値を偽陰性で弾いて漏洩対応そのものを
  // 止めるコストの方が大きい（--reason の secret 検査を全 level 拒否にしているのとは非対称な判断）。
  if (target && detectSecrets(target).length === 0) {
    process.stderr.write(
      `warning: ${id} の本文から secret パターンが検出されませんでした（purge は secret 混入専用` +
        `です。secret 以外の理由（提案の取り下げ等）での使用は §10 が禁じています。既知パターン外の` +
        ` secret や誤検出の可能性もあるため、purge しない場合はレビューで確認してください）\n`,
    );
  }

  // 修復対象の分類。revisedFrom は対象外——指す先が実在しないことが正常な状態（訂正由来の
  // 系譜）で、purge 後の不在はむしろ整合する。
  //
  // purge は系譜の賢い再構成をしない。以前は「生存する別レコードがまだ supersedes していれば
  // supersededBy をそちらへ張り替える（rehome）」機構を持っていたが、張り替え先の status に
  // 依存する分岐が2度の P1（proposed への張り替え／accepted 限定による回復不能な片方向リンク）を
  // 生んだため全廃した。優先順位は (1) secret の除去 (2) corpus を必ず valid に戻す (3) 失われた
  // 系譜は warning と Git 履歴で追える、の順で、系譜の保存はその後（#531 レビューでの人間の裁定）。
  const orphans = []; // supersededBy が id を指すレコード（退役の明示承認が要る）
  for (const rec of Object.values(index)) {
    if (rec.id !== id && rec.supersededBy === id) orphans.push(rec);
  }
  // supersedes / replaces から取り除く id の集合: 削除対象 id ＋ 退役させる orphan の id。
  // orphan を retired にすると、それを supersedes に持つ生存側は status を問わず片方向リンクの
  // validate error になる（accepted / superseded / proposed のいずれでも。実測で確認）ため、
  // 生存側の supersedes からも orphan id を一律に除去する。replaces は除去しない——replaces は
  // rejected / retired を指すリンクで、orphan が retired になった後はむしろ整合する。
  const removeFromSupersedes = new Set([id, ...orphans.map((r) => r.id)]);
  const strips = []; // { rec, removed: [id...] }
  for (const rec of Object.values(index)) {
    if (rec.id === id) continue;
    const removed = rec.supersedes.filter((x) => removeFromSupersedes.has(x));
    if (rec.replaces.includes(id)) removed.push(id);
    if (removed.length > 0) strips.push({ rec, removed: [...new Set(removed)] });
  }

  if (!target && strips.length === 0 && orphans.length === 0) {
    // この分岐は区別できない複数の原因で起こる: (a) 既にこの purge を実行済みで、trailer 出力前に
    // 中断した（完遂済み・回復すべき状態） (b) id が最初から存在しない（タイプミス・未実行）
    // (c) 壊れた対象を手動 rm したあと完遂モードを再実行した（(a) と同じ扱い） (d) records/ 自体が
    // 不在・空（誤削除・partial clone・public tree 上での実行等。id の正誤とは無関係）。
    // id 形式・暦日は既に検証済みだが、それでも実在しない well-formed id は作れてしまうため、
    // CLI からは区別できない。(b) なのに trailer を確信付きで案内すると、起きていない purge の
    // 監査行を捏造できてしまう（運用性レビュー指摘）ため、必ず `git log --diff-filter=D -- <path>`
    // での確認を前置きしてから案内する。(d) は records/ の状態そのものが原因なので、まず
    // noteIfNoRecords の注意喚起で気づけるようにする（ラウンド3運用性10）。
    noteIfNoRecords(dir, rawRecords);
    process.stderr.write(
      `note: この記憶は corpus に存在しません。原因は4通りありえます:\n` +
        `  (a) 既にこの purge を実行済みで、trailer 出力前に中断した（回復対象）\n` +
        `  (b) id を打ち間違えている、またはまだ存在しない（この場合は trailer を貼らないこと）\n` +
        `  (c) 壊れた対象を手動 rm したあと完遂モードを再実行した（(a) と同じ扱い）\n` +
        `  (d) records/ 自体が存在しないか空（上の note を確認。id の正誤とは無関係）\n` +
        `  判別は2段: 中断はコミット前に起こるのが普通なので、まず worktree を確認する:\n` +
        `  git status --porcelain -- docs/agent-memory/records/ && git diff --stat\n` +
        `  （削除・修復が未コミットで残っていれば (a)/(c)）。worktree が clean なら、\n` +
        `  コミット済みの削除履歴を確認する:\n` +
        `  git log --diff-filter=D --oneline -- docs/agent-memory/records/${id}.json\n` +
        `  どちらにも痕跡が無ければ (b)。(a)/(c) の場合のみ、コミットメッセージ末尾に次の trailer を貼る:\n` +
        `Memory-Purge: ${id} (${reason})\n` +
        `Memory-Endorsement: purge ${id} by ${endorser}\n` +
        `（この purge で変更したレコード（retired へ退役・supersedes / replaces から id を除去）がある` +
        `場合は、その id を ${id} の後ろに空白区切り・昇順で並べてください。対象の確認は判別と同じ側で行う: ` +
        `worktree に未コミットの変更が残る (a)/(c) なら git diff、コミット済みなら git log で見つけた` +
        `削除コミットを git show <コミット> --stat で開いて同コミットの変更レコードを読む。` +
        `文法の正本は agent-memory-design.md §3）\n`,
    );
    throw new CliError(
      `記憶が見つからず、修復すべきリンクもありません: ${id}（既に purge 済みか、id が誤っている可能性があります。上記 note を確認してください）`,
    );
  }
  if (orphans.length > 0 && !retireOrphans) {
    throw new CliError(
      `${id} は ${orphans.map((r) => r.id).join(', ')} の置換先です。置換先が消えるため、旧側の退役と` +
        `旧側への生存リンクの除去を --retire-orphans で明示してください（暗黙の既定値は持ちません）。` +
        '旧側を再び有効にしたい場合は、退役後に add --replaces <retired-id> → promote で復帰させます',
    );
  }
  if (orphans.length === 0 && retireOrphans) {
    // 冪等な再実行で不要になった指定を fail-loud にすると完遂モードが使えなくなるため note に留める。
    process.stderr.write('note: --retire-orphans の対象レコードはありません（指定は無視されます）\n');
  }
  // 壊れたレコードを遷移させない（show / promote と同じ判断基準）。ただし secret 検出だけは除外する —
  // 同じ漏洩値が置換チェーンの複数レコードに含まれる場合、修復対象側の secret を error 扱いにすると
  // 「purge A は strip 対象の B で失敗、purge B は orphan の A で失敗」の相互待ちになり、漏洩対応
  // そのものが進まなくなる。purge はリンクを書き換えるだけで本文を運ばないため、構造検査（型・
  // 必須・リンク整合）が通れば安全に修復できる。
  const rawById = buildRawById(rawRecords);
  for (const rec of [...strips.map((s) => s.rec), ...orphans]) {
    const structural = validateFieldGrammar(rawById[rec.id], { checkSecrets: false }).errors;
    if (structural.length) {
      throw new CliError(
        `修復対象 ${rec.id} のレコードが不正です（validate で確認してください）:\n${structural.join('\n')}`,
      );
    }
  }

  // 変更をまずメモリ上で確定する（この時点ではファイルを書かない）。
  const changedById = new Map(); // rec.id -> rec（strip と retire の両方が当たるレコードは1件に集約）
  for (const { rec, removed } of strips) {
    rec.supersedes = rec.supersedes.filter((x) => !removed.includes(x));
    rec.replaces = rec.replaces.filter((x) => x !== id);
    changedById.set(rec.id, rec);
  }
  for (const rec of orphans) {
    rec.supersededBy = null;
    rec.status = 'retired';
    changedById.set(rec.id, rec);
  }
  // 事前 validate: 変更後の corpus 全体を書込前に検査し、purge が「exit 0 なのに直後の validate が
  // 失敗する」状態を構造的に防ぐ（rehome の status 分岐が2度これを起こした教訓）。判定は
  // 「purge 前に無かった error を新たに作らないこと」——purge 前から存在する無関係な error まで
  // 遷移条件にすると、壊れた corpus 上での漏洩対応（中断からの完遂モードを含む）が止まるため。
  const preErrors = new Set(validateAll(rawRecords).errors);
  const postRaw = [];
  for (const raw of rawRecords) {
    if (raw.id === id) continue;
    const changed = typeof raw.id === 'string' ? changedById.get(raw.id) : undefined;
    postRaw.push(changed ? JSON.parse(serializeRecord(changed)) : raw);
  }
  const newErrors = validateAll(postRaw).errors.filter((e) => !preErrors.has(e));
  if (newErrors.length) {
    throw new CliError(
      `purge 後の corpus が新たな不整合を持つため中止しました（未書込。レコードは無変更）:\n${newErrors.join('\n')}\n` +
        'corpus 側の状態を validate で確認し、先に解消してから再実行してください',
    );
  }

  // 書込順は削除が先（revise の「新が先」と逆）。secret を含むファイルの除去を最優先し、
  // 途中中断で残るのは dangling link ＝ validate の error として loud に出る側に倒す。
  // 逆順（修復が先）だと、中断時に「誰からも参照されない secret 入りレコード」が validate 全緑で
  // 残り、検出線が消える。
  if (target) {
    try {
      unlinkSync(targetPath);
    } catch (e) {
      throw new CliError(
        `レコードの削除に失敗しました（原因: ${e instanceof Error ? e.message : e}）。リンク修復は未実行です`,
      );
    }
  } else {
    // 完遂モード＝中断からの回復。前回の実行が既に書き込んだ変更（除去済みの supersedes 等）は
    // 今回の再計算では「変更なし」になり trailer の id 列に載らない。§3 の「変更した全レコード」
    // を満たすのは実行者の確認（運用性レビュー指摘）。
    process.stderr.write(
      `note: ${id}.json は既にありません（リンク修復のみ完遂します）。この実行は中断からの回復のため、` +
        `前回の実行が既に書き込んだ変更は今回の trailer の id 列に載りません。コミット前に git diff で` +
        `変更された全レコードを確認し、不足があれば id 列（削除 id の後ろ・昇順）に追記してください\n`,
    );
  }
  for (const rec of changedById.values()) {
    writeRecord(dir, rec);
  }

  // レコード側の被参照は strip で id を消した後では走査に出ない（cmdRevise は削除前に走査するので
  // 出る）。分類時点で掴んでいる情報から明示的に報告する——正当な secret purge でも、無関係な
  // レコードの由来主張（replaces の系譜等）が黙って消えるのを可視化するため。
  for (const { rec, removed } of strips) {
    process.stderr.write(
      `warning: ${rec.id} の supersedes / replaces から ${removed.join(', ')} を除去しました（系譜の主張が失われます。同一 PR で内容を確認してください）\n`,
    );
  }
  for (const rec of orphans) {
    process.stderr.write(
      `warning: ${rec.id} を retired へ退役させました（置換先 ${id} の削除に伴う復旧遷移。設計 §4）。` +
        `再び有効にする場合は add --replaces ${rec.id} → promote（どちらも endorse が残ります）\n`,
    );
  }
  if (!existsSync(DOCS_DIR)) {
    process.stderr.write(`note: 削除 id の参照走査をスキップしました（${DOCS_DIR} が見つかりません）\n`);
  } else {
    // revisedFrom に対象 id を持つレコードは、削除後こそが正常な状態（指す先が実在しないのが正常）
    // なので走査から除外する。含めると「同一 PR で更新してください」と案内してしまい、利用者に
    // 正当な監査系譜の削除を促して痕跡を失わせる。上の分類で修復対象外にしているのと同じ理由。
    // 除外するのは「revisedFrom の値としての一致」だけ。後継ファイルを丸ごと除外すると、同じ
    // ファイルの summary / sources / reviewChecks に残る自由文参照（更新が必要なもの）まで
    // 警告が消える。revisedFrom を取り除いた残りに id が出るなら、そのファイルは警告対象に戻す。
    const lineageOnly = [];
    for (const rec of Object.values(index)) {
      if (!rec.revisedFrom.includes(id)) continue;
      process.stderr.write(
        `note: ${rec.id} は revisedFrom に ${id} を保持します（訂正の系譜として正当。削除しないでください）\n`,
      );
      const withoutLineage = { ...rec, revisedFrom: rec.revisedFrom.filter((r) => r !== id) };
      if (!JSON.stringify(withoutLineage).includes(id)) {
        lineageOnly.push(join(dir, `${rec.id}.json`));
      }
    }
    for (const f of scanDocsReferences(id, [targetPath, ...lineageOnly])) {
      process.stderr.write(
        `warning: 削除した id ${id} を参照する in-repo ファイル: ${f}（同一 PR で更新してください）\n`,
      );
    }
  }
  process.stderr.write(
    'note: 作業ツリーから削除しただけです。Git 履歴からの除去は docs/security/public-release-checklist.md' +
      '「コミット済みファイルの Git 履歴からの除去」に従って人間が実施してください\n',
  );
  process.stdout.write(`${id}\n`);
  // 理由を trailer に載せる（stderr の echo だけだと、必須にした値がどこにも残らず
  // git log --grep='^Memory-Purge:' で転用を検出できない）。
  process.stdout.write(`Memory-Purge: ${id} (${reason})\n`);
  // id 列は「削除した id ＋ この purge で変更した全レコードの id」（§3 の文法）。退役だけでなく
  // supersedes / replaces の除去も対象に含める——1 回の endorse で N 件が変わるのに trailer が
  // 一部しか載せないと、trailer パーサの列挙から変更を追跡できないレコードが生まれる（rehome の
  // 未記載が敵対的レビューで実証した穴と同型）。削除 id を先頭に固定し、変更 id を重複除去のうえ
  // 昇順で続ける（§3 の文法と同一。全体を昇順にしない——先頭＝削除対象という位置の意味を保つ）。
  const endorsedIds = [id, ...[...changedById.keys()].sort()];
  // 削除対象自身を含める。孤立レコードの purge（最も多いケース）では変更レコードが
  // 空で、対象の author と同じ値を endorser に渡しても検査されないため。
  warnSelfEndorsement(endorser, [
    ...(target ? [normalizeRecord(target)] : []),
    ...changedById.values(),
  ]);
  // <op> は単一トークン `purge` に統一する（§3 の文法。直後はすべて mem-* id）。
  writeEndorsementTrailer('purge', endorsedIds, endorser);
}

// ---- digest（PR-b2。設計 §6。public 側同期・#437 レビュアーの検索元） ----

export function renderDigest(records, format = 'md') {
  if (format === 'jsonl') return records.map((r) => JSON.stringify(r)).join('\n');
  return formatResults(records, 'md');
}

function cmdDigest(positionals, flags, dir) {
  if (positionals.length > 0) {
    throw new CliError(`digest は位置引数を取りません: ${positionals.join(' ')}`);
  }
  const status = 'status' in flags ? flags.status : 'active';
  if (status !== 'active' && status !== 'all') {
    throw new CliError(`--status は active か all のみ指定できます: ${flags.status}`);
  }
  const format = 'format' in flags ? flags.format : 'md';
  if (format !== 'md' && format !== 'jsonl') {
    throw new CliError(`--format は md か jsonl のみ指定できます: ${flags.format}`);
  }
  if ('visibility' in flags && !VISIBILITIES.has(flags.visibility)) {
    throw new CliError(`--visibility に未知の値: ${flags.visibility}`);
  }
  if ('paths' in flags && (typeof flags.paths !== 'string' || flags.paths.trim() === '')) {
    throw new CliError('--paths には値（glob）が必要です');
  }
  const rawRecords = loadRecords(dir);
  noteIfNoRecords(dir, rawRecords);
  const filters = Object.create(null);
  if (typeof flags.visibility === 'string') filters.visibility = flags.visibility;
  if (typeof flags.paths === 'string') filters.path = flags.paths;
  let records = rawRecords.map(normalizeRecord);
  // 既定は active-only（accepted × supersededBy null。retired/rejected/superseded/proposed は自然に落ちる）。
  if (status === 'active') records = records.filter(isActive);
  records = records.filter((r) => applyFilters(r, filters));
  // digest は public 側同期・レビュー入力の生成元のため、出力に含まれるレコードは文法検査を通す
  // （search の per-hit 検査と同じ判断基準。含まれないレコードの破損は digest を止めない）。
  const rawById = Object.create(null);
  for (const raw of rawRecords) {
    if (typeof raw.id === 'string') rawById[raw.id] = raw;
  }
  const errors = [];
  for (const r of records) {
    const raw = rawById[r.id];
    if (raw) errors.push(...validateFieldGrammar(raw).errors);
  }
  if (errors.length) {
    throw new CliError(`digest 対象に不正なレコードが含まれます（validate で確認してください）:\n${errors.join('\n')}`);
  }
  const body = renderDigest(records, format);
  // jsonl は「各行が JSON 値」が契約。0 件のとき body は空文字列になるため、末尾改行だけを
  // 付けて 1 個の空行を出力してしまうと下流の行単位 JSON.parse が壊れる（md は既に非空文字列
  // '（該当なし）' を返すため対象外）。
  process.stdout.write(body === '' ? '' : `${body}\n`);
}

function cmdValidate(positionals, flags, dir) {
  if (positionals.length > 0) {
    throw new CliError(
      `validate は位置引数を取りません（対象は常に AGENT_MEMORY_DIR）: ${positionals.join(' ')}`,
    );
  }
  if ('format' in flags && flags.format !== 'json') {
    throw new CliError(`--format は json のみ指定できます: ${flags.format}`);
  }
  const rawRecords = loadRecords(dir);
  noteIfNoRecords(dir, rawRecords);
  const { errors, warnings, proposals } = validateAll(rawRecords);
  const proposalList = Object.entries(proposals).sort((a, b) => b[1] - a[1]);

  if (flags.format === 'json') {
    process.stdout.write(
      `${JSON.stringify({ ok: errors.length === 0, errors, warnings, proposals }, null, 2)}\n`,
    );
  }
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  for (const e of errors) process.stderr.write(`error: ${e}\n`);
  if (proposalList.length) {
    process.stderr.write(
      `scope 拡張需要（scope-proposal:*）: ${proposalList.map(([k, v]) => `${k}=${v}`).join(', ')}\n`,
    );
  }
  process.stderr.write(
    `validate: ${rawRecords.length} 件 / errors ${errors.length} / warnings ${warnings.length}\n`,
  );
  if (errors.length) process.exit(1);
}

const USAGE = `使い方: node scripts/agent-memory.js <command> [...]
  add --kind <k> --title <t> --summary <s> --author <a> --scope <v,...> [--visibility control|public] [--paths ..] [--rationale ..] [--sources ..] [--supersedes <id,..>] [--replaces <id,..>] [--tags ..] [--reviewChecks ..]
                            # --replaces は rejected / retired の差し替えとして add する場合の系譜リンク（片方向・旧側は不変）
  search "<query>" [--scope ..] [--kind ..] [--status ..] [--path <glob>] [--tag ..] [--visibility ..] [--all] [--any] [--format md|json]
  show <id>
  promote <id> --endorsed-by <human>   # proposed → accepted（supersedes 元があれば旧へのリンクも完遂。冪等）
  reject <id> --endorsed-by <human>    # proposed → rejected（却下理由はコミット / PR に記録）
  retire <id> --endorsed-by <human>    # accepted → retired（後継なし退役）
  supersede <new-id> <old-id> --endorsed-by <human>  # 既 accepted 同士の後付け置換リンク（冪等）
                            # 上4つは判断の主体が人間（設計 §6.0）。--endorsed-by は endorse をコミット trailer に残すための必須フラグ
  revise <old-id> --author <a> [--endorsed-by <human>] [--title ..] [--summary ..] [--kind ..] [--scope ..] [--visibility ..] [--paths ..] [--rationale ..] [--sources ..] [--tags ..] [--reviewChecks ..]
                            # コミット済み proposed の自己訂正（旧を削除し訂正後の内容で再 add。未指定フィールドは旧値を継承）
                            # --endorsed-by は作業ブランチ外のレコードを人間の endorse を得て訂正する場合に付ける
  purge <id> --reason <text> --endorsed-by <human> [--retire-orphans]
                            # secret 混入レコードの削除＋リンク整合の回復（作業ツリーのみ。Git 履歴の除去は public-release-checklist.md）
  validate [--format json]
  digest [--visibility control|public] [--paths <glob>] [--status active|all] [--format md|jsonl]`;

// コマンド別の許可フラグ（fail-loud: 未知フラグは黙って無視せずエラーにする）。
// add は 'status' を許可リストに含めるが cmdAdd 側の専用チェックで案内付きエラーにする。
const ALLOWED_FLAGS = {
  add: new Set([
    'kind', 'title', 'summary', 'author', 'scope', 'visibility', 'paths',
    'rationale', 'sources', 'supersedes', 'replaces', 'tags', 'reviewChecks', 'status',
  ]),
  search: new Set(['scope', 'kind', 'status', 'path', 'tag', 'visibility', 'all', 'any', 'format']),
  show: new Set([]),
  promote: new Set(['endorsed-by']),
  reject: new Set(['endorsed-by']),
  retire: new Set(['endorsed-by']),
  supersede: new Set(['endorsed-by']),
  // revise は 'status'/'supersedes'/'replaces' を許可リストに含めるが cmdRevise 側の専用チェックで案内付きエラーにする。
  revise: new Set([
    'kind', 'title', 'summary', 'author', 'scope', 'visibility', 'paths',
    'rationale', 'sources', 'tags', 'reviewChecks', 'status', 'supersedes', 'replaces', 'endorsed-by',
  ]),
  purge: new Set(['reason', 'endorsed-by', 'retire-orphans']),
  validate: new Set(['format']),
  digest: new Set(['visibility', 'paths', 'status', 'format']),
};

export function main(argv) {
  const { command, positionals, flags } = parseArgs(argv);
  const dir = RECORDS_DIR;
  const allowed = ALLOWED_FLAGS[command];
  if (allowed) {
    for (const k of Object.keys(flags)) {
      if (!allowed.has(k)) throw new CliError(`未知のオプション: --${k}（${command} コマンド）`);
    }
  }
  switch (command) {
    case 'add':
      cmdAdd(positionals, flags, dir);
      break;
    case 'search':
      cmdSearch(positionals, flags, dir);
      break;
    case 'show':
      cmdShow(positionals, dir);
      break;
    case 'promote':
      cmdPromote(positionals, flags, dir);
      break;
    case 'reject':
      cmdReject(positionals, flags, dir);
      break;
    case 'retire':
      cmdRetire(positionals, flags, dir);
      break;
    case 'supersede':
      cmdSupersede(positionals, flags, dir);
      break;
    case 'revise':
      cmdRevise(positionals, flags, dir);
      break;
    case 'purge':
      cmdPurge(positionals, flags, dir);
      break;
    case 'validate':
      cmdValidate(positionals, flags, dir);
      break;
    case 'digest':
      cmdDigest(positionals, flags, dir);
      break;
    default:
      process.stderr.write(`${USAGE}\n`);
      // command 欠落（未定義）は「入力ミス」であり成功ではない。help/--help のみ成功終了させる。
      if (command !== 'help' && command !== '--help') {
        if (command !== undefined) process.stderr.write(`未知のコマンド: ${command}\n`);
        process.exit(1);
      }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])agent-memory\.js$/.test(process.argv[1])
) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}

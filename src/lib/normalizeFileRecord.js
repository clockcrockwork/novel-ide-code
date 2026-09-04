import { sanitizeFileName } from './security/validateSafeFileName.js';

// IDB/localStorage 由来の UNTRUSTED な files レコードを安全な形に正規化する（INVARIANTS #9 / #11 / #14）。
// 各プロパティは Object.hasOwn で own 判定し1度だけローカルへ読み出す（proto 汚染・getter による
// TOCTOU 対策）。throw しない。fileMetadata は normalizeFileMetadata.js、annotations は
// normalizeAnnotations が同役割を担う。

const NAME_MAX = 100; // not-a-threshold（validatePulledContent.js と同値）
const VALID_DECISIONS = new Set(['allow', 'warn', 'deny']);
// worker/src/sync.ts の FILE_ID_RE と一致。改ざんで `../manifest` 等が id に入ると
// /sync/file/${id} の URL 解決でパストラバーサルになるため hydrate 境界でも弾く。
const FILE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

// #394 C-1 round2 (S2): sync.js の isValidCreatedAt・normalizeFolderRecord.js /
// normalizeFileMetadata.js の同名関数と同一定義。ここを正として export し、sync.js から
// 再利用する（残り2ファイルは対象外のまま。挙動が同一のため個別移行の効果が薄い）。
export function isValidTimestamp(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// github 参照は既知フィールドのみを allowlist 抽出する（プロトタイプ汚染・不要プロパティ混入を防ぐ）。
function normalizeGithubRef(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const owner = Object.hasOwn(raw, 'owner') ? raw.owner : undefined;
  const repo = Object.hasOwn(raw, 'repo') ? raw.repo : undefined;
  const path = Object.hasOwn(raw, 'path') ? raw.path : undefined;
  const sha = Object.hasOwn(raw, 'sha') ? raw.sha : undefined;
  const branch = Object.hasOwn(raw, 'branch') ? raw.branch : undefined;
  const ref = {
    ...(typeof owner === 'string' ? { owner } : {}),
    ...(typeof repo === 'string' ? { repo } : {}),
    ...(typeof path === 'string' ? { path } : {}),
    ...(typeof sha === 'string' ? { sha } : {}),
    ...(typeof branch === 'string' ? { branch } : {}),
  };
  return Object.keys(ref).length > 0 ? ref : null;
}

// raw は呼び出し側（normalizeFileRecord の hasSecurity ガード）で非 null オブジェクトが保証される。
function normalizeSecurityRecord(raw) {
  const decision = Object.hasOwn(raw, 'decision') ? raw.decision : undefined;
  const isBinary = Object.hasOwn(raw, 'isBinary') ? raw.isBinary : undefined;
  const tooLarge = Object.hasOwn(raw, 'tooLarge') ? raw.tooLarge : undefined;
  const oversizeWarn = Object.hasOwn(raw, 'oversizeWarn') ? raw.oversizeWarn : undefined;
  const hasDeny = Object.hasOwn(raw, 'hasDeny') ? raw.hasDeny : undefined;
  const denyReason = Object.hasOwn(raw, 'denyReason') ? raw.denyReason : undefined;
  return {
    decision: typeof decision === 'string' && VALID_DECISIONS.has(decision) ? decision : 'allow',
    isBinary: typeof isBinary === 'boolean' ? isBinary : false,
    tooLarge: typeof tooLarge === 'boolean' ? tooLarge : false,
    oversizeWarn: typeof oversizeWarn === 'boolean' ? oversizeWarn : false,
    hasDeny: typeof hasDeny === 'boolean' ? hasDeny : false,
    denyReason: typeof denyReason === 'string' ? denyReason : null,
  };
}

function normalizeScalars(raw, now, id) {
  const name = Object.hasOwn(raw, 'name') ? raw.name : undefined;
  const content = Object.hasOwn(raw, 'content') ? raw.content : undefined;
  const parentId = Object.hasOwn(raw, 'parentId') ? raw.parentId : undefined;
  const createdAt = Object.hasOwn(raw, 'createdAt') ? raw.createdAt : undefined;
  const updatedAt = Object.hasOwn(raw, 'updatedAt') ? raw.updatedAt : undefined;
  const isDirty = Object.hasOwn(raw, 'isDirty') ? raw.isDirty : undefined;
  return {
    name: sanitizeFileName(typeof name === 'string' ? name : '', NAME_MAX) || 'ファイル.md',
    content: typeof content === 'string' ? content : '',
    // parentId はフォルダ id（id と同形式）。FILE_ID_RE で検証し、自己参照（fileTree の
    // 再帰ループ要因）は null に倒す。
    parentId:
      typeof parentId === 'string' && FILE_ID_RE.test(parentId) && parentId !== id ? parentId : null,
    createdAt: isValidTimestamp(createdAt) ? createdAt : now,
    // 不明な updatedAt は now に倒さず 0（保守的）にする。sync の判定は canonical hash
    // （`resolveClassification` / `deriveSyncAction`）で updatedAt を読まないが、隔離
    // recovery と往復中の編集検出は updatedAt を等価比較に使うため、now にすると
    // 「往復中に編集された」等の判定を誤らせうる（#312 レビュー）。
    updatedAt: isValidTimestamp(updatedAt) ? updatedAt : 0,
    isDirty: typeof isDirty === 'boolean' ? isDirty : false,
  };
}

// 1 レコードを正規化する。id が FILE_ID_RE 不適合なら null（呼び出し側で除外）。
// now はバッチ処理での Date.now() 呼び出し削減・タイムスタンプ統一のため引数化。
export function normalizeFileRecord(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;

  // id は1度だけ読み出して検証・採用に同じ値を使う（getter による検証バイパス防止）。
  const id = Object.hasOwn(raw, 'id') ? raw.id : undefined;
  if (typeof id !== 'string' || !FILE_ID_RE.test(id)) return null;

  const security = Object.hasOwn(raw, 'security') ? raw.security : undefined;
  const hasSecurity = security && typeof security === 'object' && !Array.isArray(security);
  const github = Object.hasOwn(raw, 'github') ? raw.github : null;

  return {
    id,
    ...normalizeScalars(raw, now, id),
    github: normalizeGithubRef(github),
    // security を改ざんで削った場合に quarantine をすり抜ける問題は本文の再走査が必要なため
    // 範囲外（#285 系の責務）。ここでは存在する security の型のみを正規化する。
    ...(hasSecurity ? { security: normalizeSecurityRecord(security) } : {}),
  };
}

// 配列を正規化し、不正レコード（null）を除外する。
export function normalizeFileRecords(rows) {
  if (!Array.isArray(rows)) return [];
  const now = Date.now();
  const result = [];
  for (const row of rows) {
    const normalized = normalizeFileRecord(row, now);
    if (normalized) result.push(normalized);
  }
  return result;
}

import { sanitizeFileName } from './security/validateSafeFileName.js';

// IDB/localStorage 由来の UNTRUSTED な folders レコードを安全な形へ正規化する
// （INVARIANTS #9 / #11、LOCAL-STORAGE-PROTECTION §2、audit L1）。
// files 側の normalizeFileRecord.js と対称。各プロパティは Object.hasOwn で own 判定し
// 1 度だけローカルへ読み出す（proto 汚染・getter による検証バイパス対策）。throw しない。
//
// folder レコードの正のフィールドは createFolder（AppContext.jsx）が生成する
// { id, name, parentId, sortOrder, createdAt } の 5 つ。allowlist 抽出により
// 想定外プロパティ（改ざんで注入された __proto__ 等）を落とす。

const NAME_MAX = 100; // not-a-threshold（normalizeFileRecord.js / validatePulledContent.js と同値）
// worker/src/sync.ts の FILE_ID_RE・normalizeFileRecord.js と一致。
// folder id は UUID（crypto.randomUUID）またはフォールバック生成子で、いずれも本 RE に適合する。
const FOLDER_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function isValidTimestamp(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// 1 レコードを正規化する。id が FOLDER_ID_RE 不適合なら null（呼び出し側で除外）。
// now はバッチ処理での Date.now() 呼び出し削減・タイムスタンプ統一のため引数化。
export function normalizeFolderRecord(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  // id は 1 度だけ読み出して検証・採用に同じ値を使う（getter による検証バイパス防止）。
  const id = Object.hasOwn(raw, 'id') ? raw.id : undefined;
  if (typeof id !== 'string' || !FOLDER_ID_RE.test(id)) return null;

  const name = Object.hasOwn(raw, 'name') ? raw.name : undefined;
  const parentId = Object.hasOwn(raw, 'parentId') ? raw.parentId : undefined;
  const sortOrder = Object.hasOwn(raw, 'sortOrder') ? raw.sortOrder : undefined;
  const createdAt = Object.hasOwn(raw, 'createdAt') ? raw.createdAt : undefined;

  return {
    id,
    name: sanitizeFileName(typeof name === 'string' ? name : '', NAME_MAX) || 'フォルダ',
    // parentId は親フォルダ id（同形式）。自己参照（fileTree の循環要因）は null に倒す。
    parentId:
      typeof parentId === 'string' && FOLDER_ID_RE.test(parentId) && parentId !== id
        ? parentId
        : null,
    // 非数値・非有限は 0 に倒す（fileTree の cmp は数値前提）。
    sortOrder: typeof sortOrder === 'number' && Number.isFinite(sortOrder) ? sortOrder : 0,
    createdAt: isValidTimestamp(createdAt) ? createdAt : now,
  };
}

// 配列を正規化し、不正レコード（null）を除外する。
export function normalizeFolderRecords(rows) {
  if (!Array.isArray(rows)) return [];
  const now = Date.now();
  const result = [];
  for (const row of rows) {
    const normalized = normalizeFolderRecord(row, now);
    if (normalized) result.push(normalized);
  }
  return result;
}

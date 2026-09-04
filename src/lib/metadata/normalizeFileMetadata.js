// IndexedDB から読み込んだメタデータを安全な形に正規化する。
// DevTools による改ざんや不整合なデータを安全なデフォルトに差し替える。
// throw しない — 必ずフォールバック付きの結果を返す。

import { validateWorkId, validateWorkspaceRootPath } from './validateWorkspaceSettings.js';

const DEFAULT_KIND_ID = 20; // not-a-threshold — raw/未整理へのフォールバック
const DEFAULT_STATUS_ID = 10; // not-a-threshold — raw/未整理へのフォールバック

function isValidTimestamp(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function normalizeCustomFieldValue(value, fieldDef) {
  if (!fieldDef) return undefined;
  switch (fieldDef.type) {
    case 'text':
      return typeof value === 'string' ? value.slice(0, 2000) : '';
    case 'number': {
      if (value === '' || value === null || value === undefined) return undefined;
      if (typeof value !== 'number' && typeof value !== 'string') return undefined;
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      if (value === undefined || value === null) return undefined;
      return typeof value === 'boolean' ? value : false;
    case 'date':
      // フォーマット検証は export 時に行う。入力中のリセットを防ぐため文字列保持のみ。
      return typeof value === 'string' ? value.slice(0, 20) : '';
    case 'url':
      // スキーム検証は serializeMetadataForGit で行う。入力中のリセットを防ぐため文字列保持のみ。
      return typeof value === 'string' ? value.slice(0, 2000) : '';
    case 'select':
      if (
        typeof value === 'string' &&
        Array.isArray(fieldDef.options) &&
        fieldDef.options.includes(value)
      ) {
        return value;
      }
      return '';
    case 'multi-select':
      if (!Array.isArray(value)) return [];
      if (!Array.isArray(fieldDef.options)) return [];
      return value.filter((v) => typeof v === 'string' && fieldDef.options.includes(v));
    default:
      return undefined;
  }
}

function normalizeCustomFields(rawCustom, fieldDefs) {
  if (!rawCustom || typeof rawCustom !== 'object' || Array.isArray(rawCustom))
    return Object.create(null);
  if (!fieldDefs || !Array.isArray(fieldDefs)) return Object.create(null);
  const result = Object.create(null);
  const safeDefs = fieldDefs.filter((d) => d && typeof d === 'object' && typeof d.id === 'string');
  const defsById = Object.assign(
    Object.create(null),
    Object.fromEntries(safeDefs.map((d) => [d.id, d])),
  );
  for (const [fieldId, rawValue] of Object.entries(rawCustom)) {
    const def = defsById[fieldId];
    if (!def) continue;
    if (def.archived) {
      result[fieldId] = rawValue;
      continue;
    }
    const normalized = normalizeCustomFieldValue(rawValue, def);
    if (normalized !== undefined) result[fieldId] = normalized;
  }
  return result;
}

// 有効なkindIdセットとstatusIdセットを渡してメタデータを正規化する。
export function normalizeFileMetadata(raw, { kindIdSet, statusIdSet, fieldDefs = [] } = {}) {
  const now = Date.now();
  const safeKindIdSet = kindIdSet instanceof Set ? kindIdSet : new Set();
  const safeStatusIdSet = statusIdSet instanceof Set ? statusIdSet : new Set();

  const kindId =
    typeof raw?.kindId === 'number' && safeKindIdSet.has(raw.kindId) ? raw.kindId : DEFAULT_KIND_ID;
  const statusId =
    typeof raw?.statusId === 'number' && safeStatusIdSet.has(raw.statusId)
      ? raw.statusId
      : DEFAULT_STATUS_ID;

  return {
    fileId: typeof raw?.fileId === 'string' ? raw.fileId : '',
    workId: typeof raw?.workId === 'string' ? raw.workId : null,
    title: typeof raw?.title === 'string' ? raw.title.slice(0, 500) : '',
    kindId,
    statusId,
    tagIds: Array.isArray(raw?.tagIds)
      ? raw.tagIds.filter((id) => typeof id === 'number' && Number.isInteger(id))
      : [],
    custom: normalizeCustomFields(raw?.custom, fieldDefs),
    createdAt: isValidTimestamp(raw?.createdAt) ? raw.createdAt : now,
    updatedAt: isValidTimestamp(raw?.updatedAt) ? raw.updatedAt : now,
    isDirty: typeof raw?.isDirty === 'boolean' ? raw.isDirty : false,
  };
}

export function normalizeFolderMeta(raw, { kindIdSet } = {}) {
  const now = Date.now();
  const safeKindIdSet = kindIdSet instanceof Set ? kindIdSet : new Set();
  const kindId =
    typeof raw?.kindId === 'number' && safeKindIdSet.has(raw.kindId) ? raw.kindId : null;
  return {
    folderId: typeof raw?.folderId === 'string' ? raw.folderId : '',
    workId: typeof raw?.workId === 'string' ? raw.workId : null,
    kindId,
    title: typeof raw?.title === 'string' ? raw.title.slice(0, 500) : '',
    updatedAt: isValidTimestamp(raw?.updatedAt) ? raw.updatedAt : now,
  };
}

// WorkSettings（作品）レコードの正規化。不正レコードは null（呼び出し側で filter）。
// githubRepoPath はシステム境界（CLAUDE.md）: 検証を通らない値はフィールド単位で drop する（fail-closed）。
export function normalizeWorkSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!validateWorkId(raw.id).ok) return null;
  const now = Date.now();
  const record = {
    id: raw.id,
    // 上限は serializeWorkSettingsForGit の 200 文字に揃える
    label: typeof raw.label === 'string' ? raw.label.slice(0, 200) : '',
    createdAt: isValidTimestamp(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isValidTimestamp(raw.updatedAt) ? raw.updatedAt : now,
  };
  if (typeof raw.githubRepoPath === 'string' && validateWorkspaceRootPath(raw.githubRepoPath).ok) {
    record.githubRepoPath = raw.githubRepoPath;
  }
  return record;
}

// folder → 作品ラベルの解決 Map を作る（一覧レンダリングで行ごとに .find しない: O(N+M)）。
// workId が dangling（workSettings 側が無い）場合もエントリを作り、フォールバック表示に使う。
export function buildWorkLabelMap(folderMetaMap, workSettingsMap) {
  const result = new Map();
  if (!folderMetaMap || typeof folderMetaMap !== 'object') return result;
  for (const meta of Object.values(folderMetaMap)) {
    if (!meta || typeof meta.folderId !== 'string' || !meta.folderId) continue;
    if (typeof meta.workId !== 'string' || !meta.workId) continue;
    const work = workSettingsMap?.[meta.workId];
    const label = typeof work?.label === 'string' && work.label ? work.label : null;
    result.set(meta.folderId, { workId: meta.workId, label });
  }
  return result;
}

// folder 削除で不要になった workSettings の id を返す（#390）。
// deletedFolderIds が指す folderMeta の workId のうち、削除後も他の（削除対象外の）
// folderMeta から参照され続けるものは除外する（参照カウントで判断し、消しすぎない）。
export function collectOrphanedWorkIds(deletedFolderIds, folderMetaMap) {
  if (!(deletedFolderIds instanceof Set) || deletedFolderIds.size === 0) return new Set();
  if (!folderMetaMap || typeof folderMetaMap !== 'object') return new Set();

  const candidateWorkIds = new Set();
  for (const folderId of deletedFolderIds) {
    const workId = folderMetaMap[folderId]?.workId;
    if (typeof workId === 'string' && workId) candidateWorkIds.add(workId);
  }
  if (candidateWorkIds.size === 0) return candidateWorkIds;

  const stillReferenced = new Set();
  for (const [folderId, meta] of Object.entries(folderMetaMap)) {
    if (deletedFolderIds.has(folderId)) continue;
    if (typeof meta?.workId === 'string' && meta.workId) stillReferenced.add(meta.workId);
  }

  const orphaned = new Set();
  for (const workId of candidateWorkIds) {
    if (!stillReferenced.has(workId)) orphaned.add(workId);
  }
  return orphaned;
}

export function normalizeKindDefinition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'number' || !Number.isInteger(raw.id)) return null;
  if (typeof raw.key !== 'string' || raw.key.length === 0) return null;
  return {
    id: raw.id,
    key: raw.key.slice(0, 64),
    label: typeof raw.label === 'string' ? raw.label.slice(0, 100) : raw.key,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 500) : undefined,
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : 999,
    color: typeof raw.color === 'string' ? raw.color.slice(0, 20) : undefined,
    flags: Array.isArray(raw.flags) ? raw.flags.filter((f) => typeof f === 'string') : [],
    isSystem: typeof raw.isSystem === 'boolean' ? raw.isSystem : false,
    archived: typeof raw.archived === 'boolean' ? raw.archived : false,
  };
}

export function normalizeStatusDefinition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'number' || !Number.isInteger(raw.id)) return null;
  if (typeof raw.key !== 'string' || raw.key.length === 0) return null;
  return {
    id: raw.id,
    key: raw.key.slice(0, 64),
    label: typeof raw.label === 'string' ? raw.label.slice(0, 100) : raw.key,
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : 999,
    color: typeof raw.color === 'string' ? raw.color.slice(0, 20) : undefined,
    nextStatusIds: Array.isArray(raw.nextStatusIds)
      ? raw.nextStatusIds.filter((id) => typeof id === 'number' && Number.isInteger(id))
      : [],
    isTerminal: typeof raw.isTerminal === 'boolean' ? raw.isTerminal : false,
    archived: typeof raw.archived === 'boolean' ? raw.archived : false,
  };
}

// flags ベースの判定ユーティリティ（kind 名・kind id の直接比較禁止）
export function hasFlag(kindId, flag, kindDefinitions) {
  if (!Array.isArray(kindDefinitions)) return false;
  const def = kindDefinitions.find((d) => d.id === kindId);
  if (!def) return false;
  return Array.isArray(def.flags) && def.flags.includes(flag);
}

// Git / GitHub にエクスポートする際のメタデータシリアライズ。
// 内部専用フィールド（isDirty 等）を除外し、ID を string key に変換し、
// URL フィールドのスキームを検証する。

import { sanitizeUrlForExport } from '../security/validateUrl.js';
import { validateWorkspaceRootPath } from './validateWorkspaceSettings.js';

function sanitizeCustomFieldValueForExport(value, fieldDef) {
  if (!fieldDef) return undefined;
  switch (fieldDef.type) {
    case 'text': {
      if (typeof value !== 'string' || value.length === 0) return undefined;
      return value.slice(0, 2000);
    }
    case 'number': {
      if (value === '' || value === null || value === undefined) return undefined;
      if (typeof value !== 'number' && typeof value !== 'string') return undefined;
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : false;
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return undefined;
      // value は UTC で解釈した YYYY-MM-DD のラウンドトリップ検証であり UTC が正しい（表示用日付ではない）
      // eslint-disable-next-line local/no-utc-date-slice
      if (d.toISOString().slice(0, 10) !== value) return undefined;
      return value;
    }
    case 'url':
      return sanitizeUrlForExport(value);
    case 'select':
      return typeof value === 'string' &&
        Array.isArray(fieldDef.options) &&
        fieldDef.options.includes(value)
        ? value
        : undefined;
    case 'multi-select': {
      if (!Array.isArray(value) || !Array.isArray(fieldDef.options)) return undefined;
      const filtered = Array.from(
        new Set(value.filter((v) => typeof v === 'string' && fieldDef.options.includes(v))),
      );
      return filtered.length > 0 ? filtered : undefined;
    }
    default:
      return undefined;
  }
}

// FileMetadataRecord を Git export 用オブジェクトに変換する。
// kindDefs / statusDefs を渡して ID → string key に変換する。
export function serializeFileMetadataForGit(
  metadata,
  { kindDefs = [], statusDefs = [], fieldDefs = [] } = {},
) {
  const kindDef = kindDefs.find((d) => d.id === metadata.kindId);
  const statusDef = statusDefs.find((d) => d.id === metadata.statusId);

  const customExport = Object.create(null);
  if (metadata.custom && typeof metadata.custom === 'object' && !Array.isArray(metadata.custom)) {
    const defById = Object.assign(
      Object.create(null),
      Object.fromEntries(fieldDefs.map((d) => [d.id, d])),
    );
    for (const [fieldId, value] of Object.entries(metadata.custom)) {
      const def = defById[fieldId];
      if (!def || def.archived) continue;
      if (typeof def.key !== 'string' || def.key.length === 0) continue;
      const sanitized = sanitizeCustomFieldValueForExport(value, def);
      if (sanitized !== undefined) customExport[def.key] = sanitized;
    }
  }

  return {
    fileId: metadata.fileId,
    title: typeof metadata.title === 'string' ? metadata.title.slice(0, 500) : '',
    kindKey: kindDef?.key ?? 'raw',
    statusKey: statusDef?.key ?? 'raw',
    tagIds: Array.isArray(metadata.tagIds) ? metadata.tagIds : [],
    ...(Object.keys(customExport).length > 0 ? { custom: customExport } : {}),
    updatedAt: typeof metadata.updatedAt === 'number' ? metadata.updatedAt : Date.now(),
  };
}

// WorkSettings を Git export 用オブジェクトに変換する（githubRepoPath 検証含む）。
export function serializeWorkSettingsForGit(work) {
  return {
    id: work.id,
    label: typeof work.label === 'string' ? work.label.slice(0, 200) : '',
    ...(typeof work.githubRepoPath === 'string' && validateWorkspaceRootPath(work.githubRepoPath).ok
      ? { githubRepoPath: work.githubRepoPath }
      : {}),
  };
}

import {
  getDb,
  dbRestoreAllStores,
  DB_VERSION,
  DEFAULT_KIND_DEFINITIONS,
  DEFAULT_STATUS_DEFINITIONS,
} from './db';
import { BACKUP_FORMAT_VERSION, META_EXCLUDED_KEYS, validateBackupEnvelope } from './backup';
import { repairParentReferences } from './restoreReferenceIntegrity';
import { normalizeFileRecords } from './normalizeFileRecord';
import { normalizeFolderRecords } from './normalizeFolderRecord';
import {
  normalizeFileMetadata,
  normalizeFolderMeta,
  normalizeWorkSettings,
  normalizeKindDefinition,
  normalizeStatusDefinition,
} from './metadata/normalizeFileMetadata';
import { normalizeAnnotations } from './annotations';
import { FILE_CONTENT_MAX } from './security/validatePulledContent';

// JSON バックアップ（#216 / #219）からの全置換復元。外部 JSON は UNTRUSTED として扱い、
// 既存の normalize / validate 群（TRUST-BOUNDARY.md「IndexedDB」表）を必ず通す。
// 新規に書くのはトップレベル（エンベロープ）スキーマ検証（backup.js の validateBackupEnvelope）と、
// 専用スキーマ関数が存在しないストア（settings/meta/workspaceSettings）向けの
// 最小限の型ガード、および参照整合性リペア（restoreReferenceIntegrity.js）のみ。
// 各ストアの取り出しは byStore（Map）経由で行い、動的プロパティアクセス（stores[key] 等）は
// 作らない（normalizeFileRecord.js 等、既存 normalize 群と同じ方針）。
//
// 失敗コード（parse_error / db_error / invalid_shape / future_format_version /
// future_db_version / unsupported_db_version / unknown_store / missing_store / oversized /
// no_valid_records / tx_failed）は本番の消費者を持たない（RestoreDataModal.jsx は
// result.message を素通ししているだけ）。テストが失敗経路を識別する安定したハンドルとして維持する。

// 500万文字という表示は FILE_CONTENT_MAX（既存の1ファイル上限）から機械的に導出する
// （二重管理防止 B7）。FILE_CONTENT_MAX が 10000 の倍数であることを前提にした簡易フォーマット。
const FILE_CONTENT_MAX_LABEL = `${(FILE_CONTENT_MAX / 10000).toLocaleString('ja-JP')}万文字`;

// files[].content が FILE_CONTENT_MAX を超えるレコードを検出する。黙って切り詰めず
// 復元全体を失敗させるため、正規化(除外)より前に生データを走査する。
function findOversizedFileName(rawFiles) {
  for (const raw of rawFiles) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const content = Object.hasOwn(raw, 'content') ? raw.content : undefined;
    if (typeof content !== 'string' || content.length <= FILE_CONTENT_MAX) continue;
    const rawName = Object.hasOwn(raw, 'name') ? raw.name : undefined;
    if (typeof rawName === 'string' && rawName) return rawName;
    const rawId = Object.hasOwn(raw, 'id') ? raw.id : undefined;
    if (typeof rawId === 'string' && rawId) return rawId;
    return '(不明なファイル)';
  }
  return null;
}

// normalizeKeyedRecords（settings/meta/workspaceSettings）を通す前に、value が文字列で
// FILE_CONTENT_MAX を超えるレコードが無いか走査する。findOversizedFileName（files[].content）と
// 同じ理由・同じ上限で、settings[].value 等にも個別の上限を掛ける（A1: 全体サイズでの
// 上限は複数ファイルからなる正規のバックアップを丸ごと拒否するため撤去し、files[].content と
// 同じ「値単位」の受理集合に揃える）。
const KEYED_STORE_NAMES_WITH_VALUE_LIMIT = ['settings', 'meta', 'workspaceSettings'];

function findOversizedKeyedValue(byStore) {
  for (const storeName of KEYED_STORE_NAMES_WITH_VALUE_LIMIT) {
    const rawList = byStore.get(storeName) ?? [];
    for (const raw of rawList) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const value = Object.hasOwn(raw, 'value') ? raw.value : undefined;
      if (typeof value !== 'string' || value.length <= FILE_CONTENT_MAX) continue;
      const rawKey = Object.hasOwn(raw, 'key') ? raw.key : undefined;
      return { storeName, key: typeof rawKey === 'string' && rawKey ? rawKey : '(不明なキー)' };
    }
  }
  return null;
}

// customFieldDefs 用の正規化フィールド上限。file 単位の FILE_CONTENT_MAX ほどの大きさを
// 想定する必要はないため、独自の小さい上限を持つ。
const CUSTOM_FIELD_DEF_ID_MAX = 128; // not-a-threshold（バリデーション上限。性能調整値ではない）
const CUSTOM_FIELD_DEF_WORKID_MAX = 128; // not-a-threshold（同上）
const CUSTOM_FIELD_DEF_LABEL_MAX = 1000; // not-a-threshold（同上）

// id / label / workId の受理条件チェック（normalizeCustomFieldDefForRestore の複雑度分割。
// 受理条件の理由は normalizeCustomFieldDefForRestore のコメント〔A4〕を正本とする）。
function extractCustomFieldDefCore(raw) {
  const id = Object.hasOwn(raw, 'id') ? raw.id : undefined;
  if (typeof id !== 'string' || id.length === 0 || id.length > CUSTOM_FIELD_DEF_ID_MAX) return null;

  const label = Object.hasOwn(raw, 'label') ? raw.label : undefined;
  if (typeof label !== 'string' || label.length > CUSTOM_FIELD_DEF_LABEL_MAX) return null;

  const hasWorkId = Object.hasOwn(raw, 'workId');
  const workId = hasWorkId ? raw.workId : undefined;
  if (typeof workId === 'string' && workId.length > CUSTOM_FIELD_DEF_WORKID_MAX) return null;

  return { id, label, hasWorkId, workId };
}

// key/type/options/order/archived の allowlist 抽出（normalizeCustomFieldDefForRestore の
// 複雑度分割）。そのフィールドが raw に存在する場合のみ結果に含める（archived だけは
// setCustomFieldDefs と同じく常にブール正規化する）。
function extractCustomFieldDefOptionalFields(raw) {
  const hasKey = Object.hasOwn(raw, 'key');
  const key = hasKey ? raw.key : undefined;
  const hasType = Object.hasOwn(raw, 'type');
  const type = hasType ? raw.type : undefined;
  const hasOptions = Object.hasOwn(raw, 'options');
  const options = hasOptions ? raw.options : undefined;
  const hasOrder = Object.hasOwn(raw, 'order');
  const order = hasOrder ? raw.order : undefined;
  const archived = Object.hasOwn(raw, 'archived') ? raw.archived : undefined;

  return {
    ...(hasKey ? { key } : {}),
    ...(hasType ? { type } : {}),
    ...(hasOptions ? { options } : {}),
    ...(hasOrder ? { order } : {}),
    archived: archived === true,
  };
}

// customFieldDefs 用の正規化。setCustomFieldDefs（fileMetadataStore.js）の書き込み経路と
// 同じ受理条件（id が文字列・label が文字列）に揃える allowlist 抽出（A4）。書き込み経路が
// 受理する定義（key/type を持たない等）を復元だけが弾くと、バックアップ→復元の往復で定義が
// 消え、normalizeCustomFields が未知 fieldId の値を全部捨てるため fileMetadata の値も
// 連鎖的に消える。既定値（workId: '' / order: 999 等）は注入しない。
// フィールド名をリテラルで直接読む allowlist 抽出にすることで、{ ...raw } が __proto__ を
// own プロパティとして残したまま通してしまう問題（対策済みの外観だけで実際は塞げていなかった）
// も同時に解消される。
function normalizeCustomFieldDefForRestore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const core = extractCustomFieldDefCore(raw);
  if (!core) return null;

  return {
    id: core.id,
    label: core.label,
    ...(core.hasWorkId ? { workId: core.workId } : {}),
    ...extractCustomFieldDefOptionalFields(raw),
  };
}

function normalizeCustomFieldDefsForRestore(rawList) {
  const result = [];
  for (const raw of rawList) {
    const normalized = normalizeCustomFieldDefForRestore(raw);
    if (normalized) result.push(normalized);
  }
  return result;
}

// annotations レコード（{ fileId, list, updatedAt }）の envelope 部分を正規化する。
// list の中身自体は normalizeAnnotations に委ねる。docSize は復元時点で不明なので渡さない
// （実際の位置クランプはファイルを開いたときに useAnnotations.js が再度行う）。
// docSize 未指定でも normalize を通す理由: ユーザー提供ファイルに対する書き込み境界の防御であり、
// IDB 改ざんを想定した既存モデル（useAnnotations.js 側の防御）とは別の理由で必要になる。
function normalizeAnnotationRecordsForRestore(rawList) {
  const result = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const fileId = Object.hasOwn(raw, 'fileId') ? raw.fileId : undefined;
    if (typeof fileId !== 'string' || fileId.length === 0 || fileId.length > 128) continue;
    const list = Object.hasOwn(raw, 'list') ? raw.list : undefined;
    const updatedAt = Object.hasOwn(raw, 'updatedAt') ? raw.updatedAt : undefined;
    result.push({
      fileId,
      list: normalizeAnnotations(list, undefined),
      updatedAt:
        typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0
          ? updatedAt
          : Date.now(),
    });
  }
  return result;
}

// syncState レコード（{ id, adoptedHash, adoptedAt }）の正規化（#610）。adoptedHash が
// 文字列でないレコードは復元しない（不正値は「未同期」として扱う方が安全側 — 誤って
// 一致していない hash を「採用済み」として持ち込むと、実際には未転送の変更を skip
// してしまう）。
function normalizeSyncStateRecordsForRestore(rawList) {
  const result = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = Object.hasOwn(raw, 'id') ? raw.id : undefined;
    if (typeof id !== 'string' || id.length === 0) continue;
    const adoptedHash = Object.hasOwn(raw, 'adoptedHash') ? raw.adoptedHash : undefined;
    if (typeof adoptedHash !== 'string' || adoptedHash.length === 0) continue;
    const adoptedAt = Object.hasOwn(raw, 'adoptedAt') ? raw.adoptedAt : undefined;
    result.push({
      id,
      adoptedHash,
      adoptedAt:
        typeof adoptedAt === 'number' && Number.isFinite(adoptedAt) && adoptedAt > 0
          ? adoptedAt
          : Date.now(),
    });
  }
  return result;
}

// settings / workspaceSettings / meta 用: 専用スキーマ関数が無いため、
// レコードが object で key が文字列であることだけをガードする（過剰なスキーマを新規に書かない）。
function normalizeKeyedRecords(rawList) {
  const result = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const key = Object.hasOwn(raw, 'key') ? raw.key : undefined;
    if (typeof key !== 'string' || key.length === 0) continue;
    const value = Object.hasOwn(raw, 'value') ? raw.value : undefined;
    result.push({ key, value: value === undefined ? null : value });
  }
  return result;
}

// kindDefinitions / statusDefinitions を正規化し、生レコードが0件のときだけ既定辞書で補う
// （restoreFromBackup の複雑度分割）。
// A2: 辞書が空のまま復元すると、normalizeFileMetadata のフォールバック（kindId=20/statusId=10）が
// 全 fileMetadata に永続化され、辞書が無いため hasFlag が常に false になる
// （export/proofread 対象外が恒久化する）。生レコードが0件（バックアップが意図的に辞書を
// 持たない場合）は db.js の既定辞書（seedMetadataDefaults と同じ定義）で補う。
// 一方、生レコードが1件以上あるのに正規化後0件（全件不正）の場合は既定辞書へすり替えず
// fail-closed にする（files/folders の no_valid_records と同じ扱い）。すり替えると
// 「辞書が空」と「辞書が全件不正」を区別できず、後者が無警告で成功したことになる。
// 戻り値は { error } または { kindDefinitions, statusDefinitions } のどちらか一方。
function resolveDictionaryDefinitions(byStore) {
  const rawKindDefinitions = byStore.get('kindDefinitions') ?? [];
  let kindDefinitions = rawKindDefinitions.map(normalizeKindDefinition).filter(Boolean);
  if (rawKindDefinitions.length === 0) {
    kindDefinitions = DEFAULT_KIND_DEFINITIONS;
  } else if (kindDefinitions.length === 0) {
    return { error: { store: 'kindDefinitions' } };
  }

  const rawStatusDefinitions = byStore.get('statusDefinitions') ?? [];
  let statusDefinitions = rawStatusDefinitions.map(normalizeStatusDefinition).filter(Boolean);
  if (rawStatusDefinitions.length === 0) {
    statusDefinitions = DEFAULT_STATUS_DEFINITIONS;
  } else if (statusDefinitions.length === 0) {
    return { error: { store: 'statusDefinitions' } };
  }

  return { kindDefinitions, statusDefinitions };
}

// fileMetadata 以降（辞書系を除く）のストアをまとめて正規化する
// （restoreFromBackup の複雑度分割）。
function buildRemainingRecords(byStore, { kindIdSet, statusIdSet, customFieldDefs }) {
  const fileMetadata = (byStore.get('fileMetadata') ?? [])
    .map((raw) =>
      normalizeFileMetadata(raw, { kindIdSet, statusIdSet, fieldDefs: customFieldDefs }),
    )
    .filter((m) => m.fileId);
  const folderMeta = (byStore.get('folderMeta') ?? [])
    .map((raw) => normalizeFolderMeta(raw, { kindIdSet }))
    .filter((m) => m.folderId);
  const workSettings = (byStore.get('workSettings') ?? [])
    .map(normalizeWorkSettings)
    .filter(Boolean);
  const annotations = normalizeAnnotationRecordsForRestore(byStore.get('annotations') ?? []);
  const settings = normalizeKeyedRecords(byStore.get('settings') ?? []);
  const workspaceSettings = normalizeKeyedRecords(byStore.get('workspaceSettings') ?? []);
  // B8: meta の除外3キー（deviceId/ghUser/lastSyncedAt）の保持は dbRestoreAllStores の
  // preserveKeys が保証する（incoming からの除外は db.js 自身が行うため、ここでフィルタする
  // 必要はない）。読み出し→保持→書き込みは同一 readwrite トランザクション内で完結し、
  // 別タブ・同期処理との競合窓を作らない。
  const meta = normalizeKeyedRecords(byStore.get('meta') ?? []);
  // syncState は旧 dbVersion(3) バックアップに存在しない（backup.js の
  // SUPPORTED_PAST_DB_VERSIONS 経由で missing_store をすり抜ける）。欠落時は空配列のまま
  // 復元し、全 entity を未同期として扱う（#610 完了条件12）。
  const syncState = normalizeSyncStateRecordsForRestore(byStore.get('syncState') ?? []);
  return {
    fileMetadata,
    folderMeta,
    workSettings,
    annotations,
    settings,
    workspaceSettings,
    meta,
    syncState,
  };
}

/**
 * JSON バックアップ本文（文字列）から全ストアを全置換復元する。
 * 成功時は呼び出し側が必ずフルリロードすること（AppContext の filesRef 等メモリ状態が
 * 古いまま残ると、復元前のファイル一覧が GitHub へ push されうるため）。
 *
 * @param {string} text
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
 */
export async function restoreFromBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: 'parse_error',
      message: 'ファイルの形式が正しくありません（JSON として解析できませんでした）。',
    };
  }

  let db;
  try {
    db = await getDb();
  } catch {
    return { ok: false, code: 'db_error', message: 'データベースを開けませんでした。' };
  }
  const knownStoreNames = new Set(Array.from(db.objectStoreNames));

  const envelope = validateBackupEnvelope(parsed, {
    knownStoreNames,
    currentFormatVersion: BACKUP_FORMAT_VERSION,
    currentDbVersion: DB_VERSION,
  });
  if (!envelope.ok) return envelope;

  const { stores } = parsed;
  const byStore = new Map(Object.entries(stores));

  const rawFiles = byStore.get('files') ?? [];
  const oversizedName = findOversizedFileName(rawFiles);
  if (oversizedName) {
    return {
      ok: false,
      code: 'oversized',
      message: `ファイル「${oversizedName}」の内容が大きすぎるため復元を中止しました（上限: ${FILE_CONTENT_MAX_LABEL}）。ファイルを分割するか内容を減らしてから再度お試しください。`,
    };
  }

  const oversizedKeyed = findOversizedKeyedValue(byStore);
  if (oversizedKeyed) {
    return {
      ok: false,
      code: 'oversized',
      message: `ストア「${oversizedKeyed.storeName}」のキー「${oversizedKeyed.key}」の値が大きすぎるため復元を中止しました（上限: ${FILE_CONTENT_MAX_LABEL}）。`,
    };
  }

  const normalizedFiles = normalizeFileRecords(rawFiles);
  // A5: id 不正等で全件 drop されると復旧手段が無くなる（localStorage フォールバックの扱いは A3 参照）。
  if (rawFiles.length > 0 && normalizedFiles.length === 0) {
    return {
      ok: false,
      code: 'no_valid_records',
      message:
        'バックアップ内のファイルがすべて不正な形式のため復元を中止しました。データは復元前の状態のままです。',
    };
  }

  const rawFolders = byStore.get('folders') ?? [];
  const normalizedFolders = normalizeFolderRecords(rawFolders);
  if (rawFolders.length > 0 && normalizedFolders.length === 0) {
    return {
      ok: false,
      code: 'no_valid_records',
      message:
        'バックアップ内のフォルダがすべて不正な形式のため復元を中止しました。データは復元前の状態のままです。',
    };
  }

  const { files: fixedFiles, folders: fixedFolders } = repairParentReferences(
    normalizedFiles,
    normalizedFolders,
  );

  const dictionaryResult = resolveDictionaryDefinitions(byStore);
  if (dictionaryResult.error) {
    return {
      ok: false,
      code: 'no_valid_records',
      message: `バックアップ内の「${dictionaryResult.error.store}」がすべて不正な形式のため復元を中止しました。データは復元前の状態のままです。`,
    };
  }
  const {
    kindDefinitions: normalizedKindDefinitions,
    statusDefinitions: normalizedStatusDefinitions,
  } = dictionaryResult;

  const normalizedCustomFieldDefs = normalizeCustomFieldDefsForRestore(
    byStore.get('customFieldDefs') ?? [],
  );

  const kindIdSet = new Set(normalizedKindDefinitions.map((d) => d.id));
  const statusIdSet = new Set(normalizedStatusDefinitions.map((d) => d.id));

  const {
    fileMetadata: normalizedFileMetadata,
    folderMeta: normalizedFolderMeta,
    workSettings: normalizedWorkSettings,
    annotations: normalizedAnnotations,
    settings: normalizedSettings,
    workspaceSettings: normalizedWorkspaceSettings,
    meta: normalizedMeta,
    syncState: normalizedSyncState,
  } = buildRemainingRecords(byStore, {
    kindIdSet,
    statusIdSet,
    customFieldDefs: normalizedCustomFieldDefs,
  });

  // ストア追加時にここへの追記が必要（docs/data-model/INVARIANTS.md #8）。
  const recordsByStore = new Map([
    ['files', fixedFiles],
    ['folders', fixedFolders],
    ['fileMetadata', normalizedFileMetadata],
    ['folderMeta', normalizedFolderMeta],
    ['workSettings', normalizedWorkSettings],
    ['kindDefinitions', normalizedKindDefinitions],
    ['statusDefinitions', normalizedStatusDefinitions],
    ['customFieldDefs', normalizedCustomFieldDefs],
    ['annotations', normalizedAnnotations],
    ['settings', normalizedSettings],
    ['meta', normalizedMeta],
    ['workspaceSettings', normalizedWorkspaceSettings],
    ['syncState', normalizedSyncState],
  ]);

  try {
    await dbRestoreAllStores(recordsByStore, {
      preserveKeys: new Map([['meta', META_EXCLUDED_KEYS]]),
    });
  } catch {
    return {
      ok: false,
      code: 'tx_failed',
      message: '復元中にデータベースへの書き込みに失敗しました。データは復元前の状態のままです。',
    };
  }

  return { ok: true };
}

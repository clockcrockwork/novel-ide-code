import { DB_VERSION } from './db';

export const BACKUP_FORMAT_VERSION = 1; // not-a-threshold（バックアップ envelope の形式版）

// meta ストアから除外するキー。目的は秘匿ではなく、復元時に別端末で作られた値で
// 現在端末の同期アイデンティティを壊さないこと（ghUser と同じログイン名は
// files[].github.owner にそのまま残るため、除外しても情報は隠れない）。
// 復元側（PR-B）へ: dbClearAll と対称な「clear → bulk put」で復元する場合、
// この3キーは meta から一旦 clear してよい対象ではない。現在端末の値を保持すること
// （clear すると同期アイデンティティを喪失し、GitHub 再ログインが要求される）。
export const META_EXCLUDED_KEYS = new Set(['deviceId', 'ghUser', 'lastSyncedAt']);

// dbGetAllStores() が返す { <ストア名>: [...レコード] } からバックアップ用オブジェクトを
// 組み立てる純関数（IDB に触れない）。migrated_* マイグレーション済みフラグは意図的に
// 含める（復元後に落ちていると旧 localStorage 由来のマイグレーションが再実行され、
// 復元データが上書きされうるため）。
export function buildBackup(stores, { now = new Date() } = {}) {
  const entries = Object.entries(stores).map(([name, records]) => [
    name,
    name === 'meta' ? records.filter((r) => !META_EXCLUDED_KEYS.has(r.key)) : records,
  ]);
  return {
    // formatVersion（エンベロープ形状）と dbVersion（IDB スキーマ）は独立に変わりうるため
    // 両方を持つ。復元側は形状差分を formatVersion で、レコード互換性を dbVersion で判定する。
    formatVersion: BACKUP_FORMAT_VERSION,
    dbVersion: DB_VERSION,
    exportedAt: now.toISOString(),
    stores: Object.assign(Object.create(null), Object.fromEntries(entries)),
  };
}

// JSON バックアップ復元のトップレベル（エンベロープ）スキーマ検証（#216 / #219）。
// buildBackup が組み立てる { formatVersion, dbVersion, exportedAt, stores } の形状のみを見る
// （書き手 buildBackup と読み手 validateBackupEnvelope を同一ファイルに置き、形式の正本を1つにする）。
// 各ストアのレコード内容は既存の normalize / validate 群（normalizeFileRecord.js 等）に委ねる
// ため、ここでは新規のレコード単位スキーマを書かない（TRUST-BOUNDARY.md の方針）。
// 純関数（IDB に触れない）。knownStoreNames は呼び出し側が db.objectStoreNames から渡す
// （db.js のストア列挙を静的リストとして重複させない）。

// ストア追加時の DB_VERSION 対応表。key はそのストアが追加された DB_VERSION。
// 過去 dbVersion のバックアップ（下の SUPPORTED_PAST_DB_VERSIONS）を復元する際、
// この表にあるストアは「未対応時点のバックアップに含まれないのが正当」として
// missing_store 判定から除外する（docs/data-model/INVARIANTS.md #8）。
// テーブル駆動にしている理由: INVARIANTS #8 は新ストア追加のたびに同じ手順（過去 dbVersion
// migration の追加）を要求する。syncState 専用の分岐で書くと、次にストアが増えたときにこの
// 分岐をコピーして増やす形になり、条件の重複と食い違いが起きやすい。1 エントリを追加するだけ
// で済むテーブルに寄せておく。
const STORE_INTRODUCED_AT_DB_VERSION = { syncState: 4 };

// 復元を許可する過去 dbVersion（migration が定義されている場合のみ）。ここに無い過去
// dbVersion は checkDbVersion が従来どおり fail-closed で拒否する。
// dbVersion: 3 → 4（syncState 追加。#610）: 欠落した syncState は空のまま復元し、
// 全 entity を未同期として扱う（restore.js の recordsByStore が空配列を補う）。
const SUPPORTED_PAST_DB_VERSIONS = new Set([3]);

// dbVersion の時点で存在しなかった（＝バックアップに含まれないのが正当な）ストア名の集合。
function storesExemptFromMissingCheck(dbVersion) {
  return new Set(
    Object.entries(STORE_INTRODUCED_AT_DB_VERSION)
      .filter(([, introducedAt]) => introducedAt > dbVersion)
      .map(([name]) => name),
  );
}

function checkFormatVersion(parsed, currentFormatVersion) {
  const formatVersion = Object.hasOwn(parsed, 'formatVersion') ? parsed.formatVersion : undefined;
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
    return { ok: false, code: 'invalid_shape', message: 'formatVersion が不正です。' };
  }
  // formatVersion は 1 始まり（下限）。0 / 負値は「過去値の受理」対象ではなく不正形状（B5）。
  if (formatVersion < 1) {
    return { ok: false, code: 'invalid_shape', message: 'formatVersion が不正です。' };
  }
  if (formatVersion > currentFormatVersion) {
    return {
      ok: false,
      code: 'future_format_version',
      message: `このバックアップは新しいバージョンの novel-ide で作成されています（formatVersion: ${formatVersion}）。アプリを更新してから復元してください。`,
    };
  }
  // formatVersion は <= のまま受理する（dbVersion と非対称）。エンベロープ形状は本関数が
  // 現行契約で全数検証するので、通った時点で読めることが保証される。dbVersion はストア集合と
  // レコード形状を支配し、エンベロープ検証では覆えない（checkDbVersion 側のコメント参照）。
  return { ok: true };
}

function checkDbVersion(parsed, currentDbVersion) {
  const dbVersion = Object.hasOwn(parsed, 'dbVersion') ? parsed.dbVersion : undefined;
  if (typeof dbVersion !== 'number' || !Number.isInteger(dbVersion)) {
    return { ok: false, code: 'invalid_shape', message: 'dbVersion が不正です。' };
  }
  if (dbVersion > currentDbVersion) {
    return {
      ok: false,
      code: 'future_db_version',
      message: `このバックアップは新しいデータベース形式（dbVersion: ${dbVersion}）で作成されています。アプリを更新してから復元してください。`,
    };
  }
  // 過去の dbVersion は、明示的な migration（SUPPORTED_PAST_DB_VERSIONS）が定義されている
  // 場合だけ受理する（fail-closed）。旧 dbVersion の backup には現行 DB に存在するストアが
  // 欠けうるが、その欠落ストアを「空で復元してよいか」は STORE_INTRODUCED_AT_DB_VERSION に
  // 明示したストアに限る（新ストア追加時に必要な更新一覧は docs/data-model/INVARIANTS.md #8）。
  if (dbVersion < currentDbVersion) {
    if (!SUPPORTED_PAST_DB_VERSIONS.has(dbVersion)) {
      return {
        ok: false,
        code: 'unsupported_db_version',
        message: `このバックアップは古いデータベース形式（dbVersion: ${dbVersion}）で作成されています。現在の形式（dbVersion: ${currentDbVersion}）へ変換する仕組みがまだないため復元できません。このファイルは削除せず保管しておいてください（将来のアップデートで対応する可能性があります）。`,
      };
    }
    return { ok: true };
  }
  return { ok: true };
}

// Object.entries で [key, value] を分割代入して読み出す（stores[key] という動的プロパティ
// アクセス式を作らないことで security/detect-object-injection を誘発しない）。
function checkStoresShape(stores, knownStoreNames, exemptFromMissing = new Set()) {
  for (const [key, value] of Object.entries(stores)) {
    if (!knownStoreNames.has(key)) {
      return {
        ok: false,
        code: 'unknown_store',
        message: `未知のストア「${key}」が含まれているため復元できません。`,
      };
    }
    if (!Array.isArray(value)) {
      return {
        ok: false,
        code: 'invalid_shape',
        message: `ストア「${key}」の値が配列ではありません。`,
      };
    }
  }
  // 欠落ストアを「空で復元」すると、そのストアのデータが黙って全消去される。特に
  // kindDefinitions / statusDefinitions は seedMetadataDefaults が onupgradeneeded の
  // oldVersion < 3 でしか走らないため、消えると再シードされず全ファイルの kind 判定が
  // 恒久的に壊れる（A1）。knownStoreNames との完全一致を要求し fail-closed にする。
  // exemptFromMissing に含まれるストア（過去 dbVersion の時点でまだ存在しなかった）だけは
  // 欠落を許す（#610 の syncState 移行 migration）。
  const missing = Array.from(knownStoreNames).filter(
    (name) => !Object.hasOwn(stores, name) && !exemptFromMissing.has(name),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'missing_store',
      message: `バックアップに必要なストア「${missing.join(',')}」が含まれていないため復元できません。`,
    };
  }
  return { ok: true };
}

/**
 * @param {unknown} parsed - JSON.parse 済みのバックアップ本体
 * @param {{ knownStoreNames: Set<string>, currentFormatVersion: number, currentDbVersion: number }} opts
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function validateBackupEnvelope(
  parsed,
  { knownStoreNames, currentFormatVersion, currentDbVersion },
) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'invalid_shape',
      message: 'バックアップファイルの形式が正しくありません。',
    };
  }

  const formatCheck = checkFormatVersion(parsed, currentFormatVersion);
  if (!formatCheck.ok) return formatCheck;

  const dbCheck = checkDbVersion(parsed, currentDbVersion);
  if (!dbCheck.ok) return dbCheck;

  const stores = Object.hasOwn(parsed, 'stores') ? parsed.stores : undefined;
  if (!stores || typeof stores !== 'object' || Array.isArray(stores)) {
    return { ok: false, code: 'invalid_shape', message: 'stores の形式が正しくありません。' };
  }

  return checkStoresShape(stores, knownStoreNames, storesExemptFromMissingCheck(parsed.dbVersion));
}

// 作品・フォルダ構造（folders dict + files[id].parentId）の同期契約の実装（#394 C-1）。
// 正本: docs/data-model/sync-contract.md「manifest の formatVersion 契約」「§2 データ分類」。
//
// 純関数のみ（IDB / fetch に触れない）。IO（foldersStore / IDB への適用）は呼び出し側
// （src/lib/sync.js の runSyncCycle・src/context/AppContext.jsx の onApplyStructure）が担う。
//
// 用語:
//   base   — 前回この client が採用（push または適用）した structure の写し
//            （syncState の合成キー STRUCTURE_BASE_KEY に 1 レコードとして保持）。
//   local  — この pass 開始時点のローカル folders ストア + files の parentId。
//   remote — この pass で読んだ manifest の folders / files[id].parentId。
// missing ≠ empty（sync-contract.md §2）: base / remote が「不明」（v2 manifest・folders 非
// dict・syncState レコード欠落等）の場合は「空」として扱わず、削除判定に使わない。

import { normalizeFolderRecord } from '../normalizeFolderRecord';

// worker/src/sync.ts の FILE_ID_RE・normalizeFolderRecord.js の FOLDER_ID_RE と一致させる
// （同じ形式のコメント付き重複は既存コードベースの慣習）。folder id・file id は同じ形式
// （crypto.randomUUID 等）なので同一 RE でよい。
const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

// syncState の合成キー。FILE_ID_RE / FOLDER_ID_RE 不適合な文字（`#`）を含めることで、
// 実在の file/folder id と名前空間が衝突しない（D3）。restore.js の
// normalizeSyncStateRecordsForRestore は adoptedHash が文字列であることを要求するため、
// このレコード（adoptedHash を持たない）はバックアップ復元時に自然に drop される
// （D2: base は復元後 unknown になる。安全側の劣化として意図的に許容する）。
export const STRUCTURE_BASE_KEY = '#structure';

function isPlainDict(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// folders 配列 → id をキーにした辞書（Object.create(null)。INVARIANTS #11）。
export function foldersArrayToDict(folders) {
  const dict = Object.create(null);
  for (const f of Array.isArray(folders) ? folders : []) {
    if (f && typeof f.id === 'string') dict[f.id] = f;
  }
  return dict;
}

export function foldersDictToArray(dict) {
  return Object.keys(dict).map((id) => dict[id]);
}

// file record（live/local）の parentId を正規化する。文字列以外（undefined・null・不正値）は
// null に倒す。GitHub から開いた file（`createFileObject` 等）や競合「両方保持」の複製は
// parentId キー自体を持たず undefined になりうるため、null と undefined を区別しない。
// sync.js の buildLocalFileParentIds（merge の local 入力生成）と applyStructure.js
// （適用時のライブ値との比較。#394 C-1 round6 item21）が同じ定義を共有する。
export function normalizeLocalParentId(v) {
  return typeof v === 'string' ? v : null;
}

// remote / base 由来の folders 辞書を正規化する。**key を id の正とし、value.id は採用しない**
// （F3）: remote の entry は key と独立に `id` を名乗れるため、value.id を信用すると
// 無関係の folder の entry を名乗れてしまう。normalizeFolderRecord は自己参照 null 化・
// sortOrder/name/createdAt の型強制を担う（既存の再利用）。
//
// 戻り値の folders は「内容が読める」レコードのみ。key 自体が ID_RE 不適合、または value が
// オブジェクトでない（不正レコード）場合は folders には入れない（F2: 「不在」ではなく
// 「不明」。呼び出し側 mergeStructure はこれを「存在はするが内容不明」として扱い、既存の
// local/base 側の内容を garbage な既定値で上書きしない）。いずれも malformedIds へ積み、
// rawMalformed に生値を残す（#394 C-1 round2 item9: ID_RE 不適合な key は実在 id と衝突
// しないが、無視すると書き戻し時にバイトが失われる — 削除として伝搬させないため raw を
// carryOver する。呼び出し側 sync.js の pushManifest が使う）。
export function normalizeRemoteFolders(rawFolders) {
  const folders = Object.create(null);
  const malformedIds = new Set();
  const rawMalformed = Object.create(null);
  // 契約10: remote の createdAt は数値かつ>0以外は欠落扱い（Date.now() を発明しない）。
  // normalizeFolderRecord は既定値（呼び出し時点の Date.now()）へ倒すため、この既定値を
  // merge の 3-way 判定にそのまま使うと remote が毎 pass「変化した」ことになってしまう
  // （呼ぶたびに異なる値になる）。元の raw.createdAt が無効だった id を別途記録し、
  // mergeStructure 側で「remote は値を持たない」として扱う。
  const invalidCreatedAtIds = new Set();
  if (!isPlainDict(rawFolders)) return { folders, malformedIds, rawMalformed, invalidCreatedAtIds };
  for (const key of Object.keys(rawFolders)) {
    if (!Object.hasOwn(rawFolders, key)) continue;
    const raw = rawFolders[key];
    if (!ID_RE.test(key)) {
      malformedIds.add(key);
      rawMalformed[key] = raw;
      continue;
    }
    if (!isPlainDict(raw)) {
      malformedIds.add(key);
      rawMalformed[key] = raw;
      continue;
    }
    const normalized = normalizeFolderRecord({ ...raw, id: key });
    if (normalized) {
      folders[normalized.id] = normalized;
      const hasValidCreatedAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) && raw.createdAt > 0;
      if (!hasValidCreatedAt) invalidCreatedAtIds.add(key);
    } else {
      malformedIds.add(key);
      rawMalformed[key] = raw;
    }
  }
  return { folders, malformedIds, rawMalformed, invalidCreatedAtIds };
}

// manifest.files[id].parentId を読む。own property でない・型が不正なら undefined
// （「この file の parentId は不明」— 欠落と同じ扱い。missing ≠ empty）。
function parseFileParentId(entry) {
  if (!isPlainDict(entry) || !Object.hasOwn(entry, 'parentId')) return undefined;
  const v = entry.parentId;
  if (v === null) return null;
  return typeof v === 'string' && ID_RE.test(v) ? v : undefined;
}

// remote manifest から structure を読む。known=false のときは folders/fileParentIds を
// 使ってはならない（呼び出し側は unknown として local を保持する）。
//   formatVersion — buildRemoteMap が解釈済みの値
//   rawFolders    — manifest JSON の `folders` フィールド（生値）
//   remoteFiles   — buildRemoteMap が返す files 辞書（各 entry に parentId を含みうる）
export function parseRemoteStructure({ formatVersion, rawFolders, remoteFiles }) {
  // v≤2 は「folders / parentId を表現できない」ため、folders が偶然存在していても
  // 信用しない（v2 の契約は folders を持たない。#2）。
  const known = typeof formatVersion === 'number' && formatVersion >= 3 && isPlainDict(rawFolders);
  // #394 C-1 round3 (item13) → round5 (item20) で明確化: known=false になる経路は実運用
  // では「formatVersion<3 と解釈された」場合だけ —— v3（formatVersion>=3）を宣言しながら
  // folders が欠落/非 dict の manifest は、この関数の呼び出し元 sync.js の buildRemoteMap
  // が先に corrupt として fail-closed にする（worker PUT が v3 write で folders を dict
  // 必須にするため、この形状は破損でしか生じない。契約3）。「formatVersion<3」は素直な
  // v2（folders キー自体が無い）だけでなく、`version` が非整数（例: 文字列 `"3"`）で
  // legacy default（2）へ倒れたもの・v2 rollback で folders dict が残存しているものも
  // 含む（いずれも known=false のまま扱われ、folders の中身は信用しない）。この関数自体は
  // 純関数として v3+非dict の入力も受け付けるが、それは単体テスト用の防御的な形状であり、
  // 呼び出し元経路には現れない。formatVersion / rawFolders は known=false 時の呼び出し側
  // （sync.js の structureForUnknownRemote 等）が参照するため保持する。
  const remoteFormatVersion = typeof formatVersion === 'number' ? formatVersion : undefined;
  if (!known) {
    return {
      known: false,
      folders: Object.create(null),
      malformedFolderIds: new Set(),
      malformedFolderRaw: Object.create(null),
      invalidCreatedAtIds: new Set(),
      fileParentIds: Object.create(null),
      formatVersion: remoteFormatVersion,
      rawFolders,
    };
  }
  const { folders, malformedIds, rawMalformed, invalidCreatedAtIds } = normalizeRemoteFolders(rawFolders);
  const fileParentIds = Object.create(null);
  const files = isPlainDict(remoteFiles) ? remoteFiles : {};
  for (const id of Object.keys(files)) {
    if (!Object.hasOwn(files, id)) continue;
    const v = parseFileParentId(files[id]);
    if (v !== undefined) fileParentIds[id] = v;
  }
  return {
    known: true,
    folders,
    malformedFolderIds: malformedIds,
    malformedFolderRaw: rawMalformed,
    invalidCreatedAtIds,
    fileParentIds,
    formatVersion: remoteFormatVersion,
    rawFolders,
  };
}

// syncState(STRUCTURE_BASE_KEY) の生レコードから base structure を読む。base はこの client
// 自身が過去に書いた値なので malformed 分岐は使わず、読めないレコードは単純に除外する
// （自己書き込みの改ざん・破損は IDB 改ざん耐性の一般規則で扱う。INVARIANTS #9）。
export function readBaseStructure(record) {
  const empty = { known: false, folders: Object.create(null), fileParentIds: Object.create(null) };
  if (!record || typeof record !== 'object' || Array.isArray(record)) return empty;
  const rawFolders = Object.hasOwn(record, 'folders') ? record.folders : undefined;
  const rawFileParentIds = Object.hasOwn(record, 'fileParentIds') ? record.fileParentIds : undefined;
  if (!isPlainDict(rawFolders) || !isPlainDict(rawFileParentIds)) return empty;
  const { folders } = normalizeRemoteFolders(rawFolders);
  const fileParentIds = Object.create(null);
  for (const id of Object.keys(rawFileParentIds)) {
    if (!Object.hasOwn(rawFileParentIds, id)) continue;
    const v = rawFileParentIds[id];
    if (v === null || (typeof v === 'string' && ID_RE.test(v))) fileParentIds[id] = v;
  }
  return { known: true, folders, fileParentIds };
}

// 3 者の存在フラグから最終的な存在を決める（契約5: 作成/削除は3-way優先。削除が勝つ）。
// base が unknown なら削除は判定せず union（D1）。
function mergeExists(baseKnown, baseHas, localHas, remoteHas) {
  if (!baseKnown) return localHas || remoteHas;
  if (localHas === baseHas) return remoteHas;
  return localHas;
}

// スカラー値の 3-way 合成（契約5: 同一フィールド乖離は remote 優先）。
// hasBaseRecord=false（このレコードが base に存在しなかった/base 全体が unknown）の場合は
// 単純な「差異があれば remote 優先、無ければどちらでも同じ」に倒す。
function threeWayField(baseVal, localVal, remoteVal, hasBaseRecord) {
  if (!hasBaseRecord) return localVal === remoteVal ? localVal : remoteVal;
  const localChanged = localVal !== baseVal;
  const remoteChanged = remoteVal !== baseVal;
  if (!localChanged && !remoteChanged) return baseVal;
  if (localChanged && !remoteChanged) return localVal;
  if (!localChanged && remoteChanged) return remoteVal;
  return localVal === remoteVal ? localVal : remoteVal;
}

// 1 folder id の merge を決める（mergeStructure から抽出。複雑度を下げるための分割）。
// folders への書き込み・deletedFolderIds への追加は呼び出し側が行う（この関数は結果を返すだけ）。
function resolveFolderEntry(id, {
  baseKnown, baseFolders, localFolders, remoteFolders, remoteMalformedFolderIds, remoteInvalidCreatedAtIds,
}) {
  const baseHas = baseKnown && Object.hasOwn(baseFolders, id);
  const localHas = Object.hasOwn(localFolders, id);
  const remoteUsableHas = Object.hasOwn(remoteFolders, id);
  // F2: key は存在するが値が不正（読めない）レコードは「不在」ではなく「不明」として
  // 存在判定だけ present 扱いにする（既存 local/base の内容を garbage な既定値で
  // 上書きしないよう、内容は下で local を優先する）。
  const remoteHas = remoteUsableHas || remoteMalformedFolderIds.has(id);
  const exists = mergeExists(baseKnown, baseHas, localHas, remoteHas);
  if (!exists) return { deleted: baseHas };

  if (localHas && remoteUsableHas) {
    const hasBaseRecord = baseHas;
    const b = baseHas ? baseFolders[id] : undefined;
    const l = localFolders[id];
    const r = remoteFolders[id];
    // 契約10: remote の createdAt が無効だった id は、normalizeFolderRecord が発明した
    // 既定値（呼ぶたびに変わる Date.now()）を 3-way 判定に使わない。「remote は値を持たない」
    // として local（無ければ base）を保持する（R-3: 発明値を使うと毎 pass「変化」判定され
    // manifest write が churn する）。
    const createdAt = remoteInvalidCreatedAtIds?.has(id)
      ? (l.createdAt ?? b?.createdAt ?? r.createdAt)
      : threeWayField(b?.createdAt, l.createdAt, r.createdAt, hasBaseRecord);
    return {
      record: {
        id,
        name: threeWayField(b?.name, l.name, r.name, hasBaseRecord),
        parentId: threeWayField(b?.parentId ?? null, l.parentId ?? null, r.parentId ?? null, hasBaseRecord),
        sortOrder: threeWayField(b?.sortOrder ?? 0, l.sortOrder ?? 0, r.sortOrder ?? 0, hasBaseRecord),
        createdAt,
      },
    };
  }
  if (localHas) return { record: localFolders[id] }; // remote が unusable でも local を採用（F2）
  if (remoteUsableHas) return { record: remoteFolders[id] };
  // exists=true だが内容が無い（remote malformed のみで base/local も無い）。材料が無い。
  return {};
}

function mergeFolders({ baseKnown, baseFolders, localFolders, remote }) {
  const folders = Object.create(null);
  const deletedFolderIds = new Set();
  const remoteKnown = Boolean(remote?.known);

  if (!remoteKnown) {
    // remote が structure を表現できない（v2 missing・folders 非 dict）。missing ≠ empty
    // （#2）: remote に無いことを削除と解釈せず、local をそのまま維持する。
    for (const id of Object.keys(localFolders)) {
      if (Object.hasOwn(localFolders, id)) folders[id] = localFolders[id];
    }
    return { folders, deletedFolderIds };
  }

  const remoteFolders = remote.folders;
  const remoteMalformedFolderIds = remote.malformedFolderIds instanceof Set ? remote.malformedFolderIds : new Set();
  const remoteInvalidCreatedAtIds = remote.invalidCreatedAtIds instanceof Set ? remote.invalidCreatedAtIds : new Set();
  const ctx = {
    baseKnown, baseFolders, localFolders, remoteFolders, remoteMalformedFolderIds, remoteInvalidCreatedAtIds,
  };
  const folderIds = new Set([
    ...(baseKnown ? Object.keys(baseFolders) : []),
    ...Object.keys(localFolders),
    ...Object.keys(remoteFolders),
  ]);
  for (const id of folderIds) {
    const resolved = resolveFolderEntry(id, ctx);
    if (resolved.deleted) deletedFolderIds.add(id);
    else if (resolved.record) folders[id] = resolved.record;
  }
  return { folders, deletedFolderIds };
}

// folder の存在（create/delete）とは異なり、file 自体の存在は structure の管轄外
// （file 削除伝搬は非目的。L1）。ここでは「この file がどの folder に属するか」だけを 3-way で決める。
function mergeFileParentIds({ baseKnown, baseFileParentIds, localFileParentIds, localIds, remote }) {
  const remoteKnown = Boolean(remote?.known);
  const remoteFileParentIds = remoteKnown ? remote.fileParentIds : Object.create(null);
  const fileParentIds = Object.create(null);
  const fileIds = new Set([
    ...(baseKnown ? Object.keys(baseFileParentIds) : []),
    ...localIds,
    ...(remoteKnown ? Object.keys(remoteFileParentIds) : []),
  ]);
  for (const id of fileIds) {
    const inLocal = localIds.has(id);
    const inRemote = remoteKnown && Object.hasOwn(remoteFileParentIds, id);
    const inBase = baseKnown && Object.hasOwn(baseFileParentIds, id);
    if (inLocal && inRemote) {
      const b = inBase ? baseFileParentIds[id] : undefined;
      const l = Object.hasOwn(localFileParentIds, id) ? localFileParentIds[id] : null;
      const r = remoteFileParentIds[id];
      fileParentIds[id] = threeWayField(b ?? null, l, r, inBase);
    } else if (inLocal) {
      fileParentIds[id] = Object.hasOwn(localFileParentIds, id) ? localFileParentIds[id] : null;
    } else if (inRemote) {
      // B9: local に無い（未 pull・隔離）file の remote parentId は merge 対象外として
      // そのまま carry over する（落とさない）。
      fileParentIds[id] = remoteFileParentIds[id];
    } else if (inBase) {
      fileParentIds[id] = baseFileParentIds[id];
    }
  }
  return fileParentIds;
}

// structure の 3-way merge（純関数。契約1・2・4・5・6・8・11）。
//   base.known=false            — base 不明（D1: 初回 v3 化直後・syncState 消失・restore 後）
//   remote.known=false          — remote が structure を表現できない（v2 等）。この場合は
//                                  local をそのまま維持する（union/削除判定を一切行わない）。
//   localFileIds                — この pass のローカル file id 集合（quarantine は含めない。
//                                  B9: quarantine/未 pull の file は「local に無い」として扱い、
//                                  remote/base の値をそのまま carry over する）。
// 戻り値:
//   folders         — 辞書（Object.create(null)）。この pass で採用する最終 folders。
//   fileParentIds   — 辞書。file id → parentId（string|null）。union された全 id を含む。
//   deletedFolderIds — Set。base には存在したが最終的に削除された folder id
//                      （folderMeta / workSettings 掃除の入力。契約14）。
export function mergeStructure({ base, local, remote, localFileIds }) {
  const baseKnown = Boolean(base?.known);
  const baseFolders = baseKnown ? base.folders : Object.create(null);
  const baseFileParentIds = baseKnown ? base.fileParentIds : Object.create(null);
  const localFolders = local?.folders ?? Object.create(null);
  const localFileParentIds = local?.fileParentIds ?? Object.create(null);
  const localIds = localFileIds instanceof Set ? localFileIds : new Set(localFileIds ?? []);

  const { folders, deletedFolderIds } = mergeFolders({ baseKnown, baseFolders, localFolders, remote });
  const fileParentIds = mergeFileParentIds({
    baseKnown, baseFileParentIds, localFileParentIds, localIds, remote,
  });

  return { folders, fileParentIds, deletedFolderIds };
}

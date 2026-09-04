// structure（folders / files[id].parentId）の merge 結果をローカル（store / IDB）へ適用する
// 実装（#394 C-1 round2: Q1・R1・O1・S3。round5: F1 楽観的検証。round6: item21 —
// snapshot/live 双方の parentId を normalizeLocalParentId で揃えてから比較する）。
//
// 正本: docs/data-model/sync-contract.md「manifest の formatVersion 契約」§4 適用規則。
//
// 契約:
//   - store 更新は必ず関数形（id 単位の patch）。ライブ状態を全置換しない（Q1）。
//     同期パス開始後に作成された folder / file（merge 入力に無い id）は消さずに残す。
//   - 削除は merge が返した deletedFolderIds だけを正とする。ライブ store と merge 結果の
//     差分から再導出しない（O1: 同期パス中に作成された folder を誤って消さない）。
//   - レコード単位の楽観的検証（F1・round5）: upsert / 削除は「ライブの現在値が、merge の
//     入力に使った local snapshot と一致する場合のみ」行う。同期パス開始後（merge 計算〜
//     この適用までの窓）にユーザーが folder を rename・移動・削除した、または file を移動
//     した場合、live は snapshot と一致しないため、この pass では該当レコードに触れない
//     （次 pass の local として拾う。巻き戻し・上書き・復活を防ぐ）。snapshot が知らない id
//     （merge 計算後に作成された folder/file、または元々 local に無かった id）は素通しする。
//   - file entity は削除しない（C3）。parentId だけを変更し他フィールドは維持する。
//   - remote 由来の folder 削除でも folderMeta / orphan workSettings を掃除する（契約14）。
//   - IDB 書き込みの失敗は throw する（D5: 呼び出し側が snapshot を不成立にする）。
import { repairParentReferences } from '../restoreReferenceIntegrity';
import { normalizeLocalParentId } from './structure';

// folder record（id,name,parentId,sortOrder,createdAt）が snapshot 時点から変化していないか。
// 両方に無い id（merge 計算後に作成された新規）は「保護すべき既存値が無い」ので true
// （素通し）。片方だけに存在する（窓中に作成/削除された）場合は変化ありとして false。
function folderUnchangedSince(snapshotRecord, liveRecord) {
  if (!snapshotRecord && !liveRecord) return true;
  if (!snapshotRecord || !liveRecord) return false;
  return snapshotRecord.name === liveRecord.name
    && snapshotRecord.parentId === liveRecord.parentId
    && snapshotRecord.sortOrder === liveRecord.sortOrder
    && snapshotRecord.createdAt === liveRecord.createdAt;
}

// 契約14: deletedFolderIds に対応する folderMeta / orphan workSettings を掃除する。
// AppContext.jsx の deleteFolder（ユーザー起点の削除）と applyStructure（remote 由来の削除）
// の両方から呼べる共通 helper として、この 1 ファイルに置く（S3: 重複グルーの解消）。
export async function cleanupOrphanedFolderMeta(deletedFolderIds, {
  getFolderMetaMap, collectOrphanedWorkIds, deleteWorkSettings, deleteFolderMeta,
}) {
  const ids = deletedFolderIds instanceof Set ? deletedFolderIds : new Set(deletedFolderIds ?? []);
  if (ids.size === 0) return;
  const folderMetaMap = getFolderMetaMap();
  const orphanedWorkIds = collectOrphanedWorkIds(ids, folderMetaMap);
  await Promise.all([
    ...Array.from(orphanedWorkIds, (workId) => deleteWorkSettings(workId)),
    ...Array.from(ids, (folderId) => deleteFolderMeta(folderId)),
  ]);
}

// mergeStructure の出力（明示差分）をライブ状態へ適用する。
//   folders          — mergeStructure が返した最終 folders の配列（upsert 対象。呼び出し側
//                      〔sync.js の resolveStructureForPass〕が foldersDictToArray で配列化して渡す）
//   fileParentIds    — mergeStructure が返した最終 fileParentIds 辞書（id → parentId）
//   deletedFolderIds — mergeStructure が返した削除対象 folder id の Set
//   localSnapshot    — mergeStructure の local 入力に使った時点の { folders: dict, fileParentIds:
//                      dict }（sync.js の resolveStructureForPass が localStructure から渡す）。
//                      round5 (F1): 適用直前のライブ値と比較し、この pass の merge 計算後に
//                      ユーザーが変更したレコードを検出して保護する。省略時は保護なし
//                      （全レコードを無条件に適用する。既存呼び出し側との後方互換のための
//                      フォールバックであり、新規呼び出しは必ず渡すこと）。
//   io               — 注入された I/O（下記）
//
// io:
//   getFolders() / getFiles()        — 適用直前のライブ配列を読む
//   setFolders(fn) / setFiles(fn)    — 関数形 setter（prev => next）
//   dbPut(store, record) / dbDelete(store, id)
//   deleteFolderMeta(id) / deleteWorkSettings(id) / getFolderMetaMap() / collectOrphanedWorkIds(ids, map)
//   repairParentReferences(files, folders)（省略時は '../restoreReferenceIntegrity' の実装を使う）
//
// 戻り値: { folders, fileParentIds }（repair 後の最終値。sync.js が structure base /
// manifest 書き込みに使う。適用結果と書き込む値を一致させるため）。
export async function applyStructure({
  folders: mergedFolders, fileParentIds: mergedFileParentIds, deletedFolderIds, localSnapshot, io,
}) {
  const repair = io.repairParentReferences ?? repairParentReferences;
  const deletedIds = deletedFolderIds instanceof Set ? deletedFolderIds : new Set(deletedFolderIds ?? []);
  const mergedFolderList = Array.isArray(mergedFolders) ? mergedFolders : Object.values(mergedFolders ?? {});
  const snapshotFolders = localSnapshot?.folders ?? null;
  const snapshotFileParentIds = localSnapshot?.fileParentIds ?? null;

  const liveFolders = io.getFolders();
  const liveFiles = io.getFiles();
  const liveFolderById = new Map(liveFolders.map((f) => [f.id, f]));

  // round5 (F1): snapshot が渡されていれば「live が snapshot と一致する場合のみ」upsert /
  // 削除を行う（窓中の rename・移動・削除を保護する）。snapshot 省略時は常に true
  // （後方互換のフォールバック）。
  const isFolderUntouchedSinceSnapshot = (id) => {
    if (!snapshotFolders) return true;
    const snap = Object.hasOwn(snapshotFolders, id) ? snapshotFolders[id] : undefined;
    return folderUnchangedSince(snap, liveFolderById.get(id));
  };

  // O1: 削除は deletedIds だけを正とする。ライブ folders との差分では再導出しない
  // （同期パス中に作成された folder が merge 入力に含まれず、誤って消えるのを防ぐ）。
  const folderById = new Map(liveFolderById);
  for (const id of deletedIds) {
    // 削除対象 folder が live に無ければ no-op。live にあっても snapshot 時点から変化して
    // いれば（rename・移動）削除しない（F1: 窓中の変更を巻き戻さない）。
    if (folderById.has(id) && isFolderUntouchedSinceSnapshot(id)) folderById.delete(id);
  }
  for (const f of mergedFolderList) {
    if (deletedIds.has(f.id)) continue;
    // 窓中に rename・移動された folder は merge の（古い snapshot 由来の）値で
    // 上書きしない。live の値をそのまま残す（次 pass の local として拾う）。
    if (isFolderUntouchedSinceSnapshot(f.id)) folderById.set(f.id, f);
  }
  const patchedFolders = Array.from(folderById.values());

  // pull した entity には parentId が含まれない（parentId は manifest 側が管轄する。契約1）。
  // merge 済みの値を持つ id だけ parentId を上書きし、他フィールドは維持する。窓中に file が
  // 移動された（live.parentId が snapshot と不一致）場合は、この pass では触らない（F1）。
  // round6 (item21): snapshot 側（buildLocalFileParentIds）は文字列以外を null に正規化
  // 済みだが、live の生レコードは GitHub から開いた file・競合「両方保持」の複製等で
  // parentId キー自体を持たず undefined になりうる。null と undefined を同一視するため
  // live 側も normalizeLocalParentId を通してから比較する（そうしないと
  // `null !== undefined` で恒久的に不一致となり、remote 由来の parentId が二度と適用
  // されず、書き戻し側も live の undefined を null として manifest/base に確定してしまう）。
  const patchedFiles = liveFiles.map((f) => {
    if (!Object.hasOwn(mergedFileParentIds, f.id)) return f;
    const liveParentId = normalizeLocalParentId(f.parentId);
    if (snapshotFileParentIds && Object.hasOwn(snapshotFileParentIds, f.id)) {
      const snapParentId = snapshotFileParentIds[f.id];
      if (snapParentId !== liveParentId) return f;
    }
    const nextParentId = mergedFileParentIds[f.id];
    return nextParentId === liveParentId ? f : { ...f, parentId: nextParentId };
  });

  // dangling / 循環 parent を repair する（F1）。
  const { files: repairedFiles, folders: repairedFolders } = repair(patchedFiles, patchedFolders);

  // IDB へ書く差分だけを抽出する（id 単位。不要な書き込みを避ける）。
  const changedFolders = [];
  for (const f of repairedFolders) {
    const prev = liveFolderById.get(f.id);
    const changed = !prev || prev.name !== f.name || prev.parentId !== f.parentId
      || prev.sortOrder !== f.sortOrder || prev.createdAt !== f.createdAt;
    if (changed) changedFolders.push(f);
  }
  // F1: 実際に削除された id だけを IDB からも消す。live にあったが「窓中に変化していた」
  // ため folderById に残した（削除しなかった）id は dbDelete しない。
  const folderDeletes = Array.from(deletedIds).filter((id) => liveFolderById.has(id) && !folderById.has(id));

  const liveFileById = new Map(liveFiles.map((f) => [f.id, f]));
  const changedFiles = [];
  for (const f of repairedFiles) {
    const prev = liveFileById.get(f.id);
    if (prev && prev.parentId !== f.parentId) changedFiles.push(f);
  }

  // D5: IDB 書き込みの失敗は throw する（呼び出し側 resolveStructureForPass が failure に積む。
  // snapshot / base は進めない）。
  await Promise.all([
    ...folderDeletes.map((id) => io.dbDelete('folders', id)),
    ...changedFolders.map((f) => io.dbPut('folders', f)),
    ...changedFiles.map((f) => io.dbPut('files', f)),
  ]);

  // store は id 単位の関数形 patch。ライブ状態（prev）を全置換しない（Q1）。往復中に
  // ユーザーが編集・作成した folder / file は、merge / 削除の対象でない限りそのまま残る。
  // 削除は folderDeletes（F1 で実際に削除が確定した id）だけを対象にする（deletedIds を
  // 直接使うと、rename/移動で保護され削除しなかった folder まで store から消してしまう）。
  const folderDeleteIds = new Set(folderDeletes);
  const changedFolderById = new Map(changedFolders.map((f) => [f.id, f]));
  io.setFolders((prev) => {
    let changed = false;
    let next = prev;
    if (folderDeleteIds.size > 0) {
      const filtered = next.filter((f) => !folderDeleteIds.has(f.id));
      if (filtered.length !== next.length) { changed = true; next = filtered; }
    }
    if (changedFolderById.size > 0) {
      const seen = new Set();
      next = next.map((f) => {
        const upserted = changedFolderById.get(f.id);
        if (!upserted) return f;
        seen.add(f.id);
        changed = true;
        return upserted;
      });
      for (const [id, f] of changedFolderById) {
        if (!seen.has(id)) { next = [...next, f]; changed = true; }
      }
    }
    return changed ? next : prev;
  });

  const parentIdById = new Map(changedFiles.map((f) => [f.id, f.parentId]));
  io.setFiles((prev) => {
    if (parentIdById.size === 0) return prev;
    let changed = false;
    const next = prev.map((f) => {
      if (!parentIdById.has(f.id)) return f;
      const nextParentId = parentIdById.get(f.id);
      if (nextParentId === f.parentId) return f;
      changed = true;
      return { ...f, parentId: nextParentId };
    });
    return changed ? next : prev;
  });

  // 契約14: remote 由来 folder 削除でも folderMeta / orphan workSettings を掃除する。
  // file entity は削除しない（C3）。F1 で削除を見送った folder（rename/移動で保護）の
  // メタデータは掃除しない（folderDeleteIds＝実際に削除した id のみを対象にする）。
  await cleanupOrphanedFolderMeta(folderDeleteIds, io);

  // sync.js の base / manifest 書き込みは repair 後の最終値を正とする（適用結果と書き込む
  // 値を一致させるため）。repair 対象に無かった id は入力 fileParentIds の値をそのまま
  // carry over する。
  const finalFileParentIds = Object.assign(Object.create(null), mergedFileParentIds);
  for (const f of repairedFiles) finalFileParentIds[f.id] = f.parentId ?? null;

  return { ok: true, folders: repairedFolders, fileParentIds: finalFileParentIds };
}

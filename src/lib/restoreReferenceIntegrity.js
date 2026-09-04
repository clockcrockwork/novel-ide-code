// JSON バックアップ復元専用の参照整合性リペア（#216 / #219）。
// normalizeFileRecord.js / normalizeFolderRecord.js は自己参照の parentId は null に倒すが、
// 「別の（復元後の folders に存在しない）id を指す dangling parentId」と
// 「folder 同士の循環（A→B→A 等）」は形式検証だけでは検出できない。両者を放置すると
// fileTree.js の flattenTree（ルートからの DFS）が到達できないサブツリーを作り、
// 本文は IDB に残るのにサイドバーへ二度と現れない（ユーザー体感は「本文が消えた」）。
// 純関数（IDB に触れない）としてテストしやすくする。

/**
 * files / folders の parentId 参照整合性を復元する。
 * 1. folders の中で、存在しない folder id を指す parentId（dangling）を null へ倒す。
 * 2. folder 同士の循環を、ルートへ到達できないエッジを1本切って断ち切る。
 * 3. files の中で、（1・2 適用後の）folders に存在しない parentId を null へ倒す。
 *
 * @param {object[]} files
 * @param {object[]} folders
 * @returns {{ files: object[], folders: object[] }}
 */
export function repairParentReferences(files, folders) {
  const folderList = Array.isArray(folders) ? folders : [];
  const fileList = Array.isArray(files) ? files : [];
  const folderIds = new Set(folderList.map((f) => f.id));

  const isDangling = (record) => record.parentId != null && !folderIds.has(record.parentId);

  // 1) dangling な folder.parentId を null へ倒しつつ parentOf を1パスで構築する。
  const parentOf = new Map(folderList.map((f) => [f.id, isDangling(f) ? null : f.parentId]));

  // 2) 循環の切断: 各 folder は parentId という高々1本の外向き辺しか持たないため、
  // 「そのノードから辺をたどって null に到達できるか」を1回の探索あたり O(訪問数) で判定できる。
  // 既に安全と判定済み（resolved）のノードに到達したら安全確定、訪問中の経路内で同じ id を
  // 再訪したら循環なので直前の辺を切って断ち切る。
  const resolved = new Set();
  for (const start of folderList) {
    if (resolved.has(start.id)) continue;
    const path = [];
    const pathSet = new Set();
    let current = start.id;
    while (current != null && !resolved.has(current)) {
      if (pathSet.has(current)) {
        // 経路内で再訪 = 循環。経路の最後のノードの辺を切って断ち切る。
        const cutNode = path[path.length - 1];
        parentOf.set(cutNode, null);
        break;
      }
      pathSet.add(current);
      path.push(current);
      current = parentOf.get(current) ?? null;
    }
    for (const id of path) resolved.add(id);
  }
  // fixedFolders は folderList を1回 map するだけ（dangling・循環の両方を parentOf に反映済み）。
  const fixedFolders = folderList.map((f) => ({ ...f, parentId: parentOf.get(f.id) ?? null }));

  // 3) files 側の dangling parentId（folders には触れていないので folderIds は 1) の時点のまま有効）
  const fixedFiles = fileList.map((f) => (isDangling(f) ? { ...f, parentId: null } : f));

  return { files: fixedFiles, folders: fixedFolders };
}

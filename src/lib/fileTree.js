/**
 * @typedef {{
 *   id: string, kind: 'file'|'folder', name: string, parentId: string|null,
 *   depth: number, isExpanded?: boolean, hasChildren?: boolean,
 *   sortOrder?: number, createdAt?: number, [key: string]: any
 * }} FlatNode
 */

function sortKey(item) {
  const order = item.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const created = item.createdAt ?? 0;
  return [order, created];
}

function cmp(a, b) {
  const [ao, ac] = sortKey(a);
  const [bo, bc] = sortKey(b);
  if (ao !== bo) return ao - bo;
  return ac - bc;
}

/**
 * Build a map from parentId → sorted children array.
 * Folders come before files within each group.
 */
function buildChildMap(files, folders) {
  /** @type {Map<string|null, Array<{kind:'file'|'folder', item: object}>>} */
  const map = new Map();

  const add = (parentId, kind, item) => {
    const key = parentId ?? null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ kind, item });
  };

  for (const f of folders) add(f.parentId ?? null, 'folder', f);
  for (const f of files) add(f.parentId ?? null, 'file', f);

  for (const children of map.values()) {
    children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return cmp(a.item, b.item);
    });
  }

  return map;
}

/**
 * Flatten the tree into a visible-only ordered list.
 * Only expanded folders' children are included.
 *
 * @param {object[]} files
 * @param {object[]} folders
 * @param {Set<string>} expandedIds
 * @returns {FlatNode[]}
 */
export function flattenTree(files, folders, expandedIds) {
  const childMap = buildChildMap(files, folders);
  const result = [];
  const seen = new Set();

  // Iterative DFS: push children in reverse order so they pop in correct order.
  const stack = [];
  const rootChildren = childMap.get(null) ?? [];
  for (let i = rootChildren.length - 1; i >= 0; i--) {
    stack.push({ ...rootChildren[i], depth: 0 });
  }

  while (stack.length) {
    const { kind, item, depth } = stack.pop();

    if (seen.has(item.id)) continue; // guard against cycles
    seen.add(item.id);

    if (kind === 'folder') {
      const isExpanded = expandedIds.has(item.id);
      const hasChildren = (childMap.get(item.id)?.length ?? 0) > 0;
      result.push({ ...item, kind: 'folder', depth, isExpanded, hasChildren });
      if (isExpanded) {
        const children = childMap.get(item.id) ?? [];
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({ ...children[i], depth: depth + 1 });
        }
      }
    } else {
      result.push({ ...item, kind: 'file', depth });
    }
  }

  return result;
}

/**
 * Return all folder IDs in the subtree rooted at folderId (BFS, cycle-safe).
 * The returned Set always includes folderId itself.
 *
 * @param {string} folderId
 * @param {object[]} folders
 * @returns {Set<string>}
 */
export function getDescendantFolderIds(folderId, folders) {
  const childFolderMap = new Map();
  for (const f of folders) {
    const pid = f.parentId ?? null;
    if (!childFolderMap.has(pid)) childFolderMap.set(pid, []);
    childFolderMap.get(pid).push(f.id);
  }
  const allFolderIds = new Set([folderId]);
  let frontier = [folderId];
  while (frontier.length) {
    const next = [];
    for (const pid of frontier) {
      for (const childId of childFolderMap.get(pid) ?? []) {
        if (!allFolderIds.has(childId)) {
          allFolderIds.add(childId);
          next.push(childId);
        }
      }
    }
    frontier = next;
  }
  return allFolderIds;
}

/**
 * Count files that are direct or indirect children of a folder (BFS, cycle-safe).
 *
 * @param {string} folderId
 * @param {object[]} files
 * @param {object[]} folders
 * @returns {number}
 */
export function countDescendantFiles(folderId, files, folders) {
  const allFolderIds = getDescendantFolderIds(folderId, folders);
  return files.filter((f) => allFolderIds.has(f.parentId)).length;
}

/**
 * Return ancestor folder ids for a file (given the file's parentId).
 *
 * @param {string|null} parentId  — file.parentId
 * @param {object[]} folders
 * @returns {string[]}
 */
export function findFileAncestorIds(parentId, folders) {
  if (!parentId) return [];
  const folderMap = new Map(folders.map((f) => [f.id, f]));
  const ancestors = [];
  const visited = new Set();
  let current = folderMap.get(parentId) ?? null;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    ancestors.unshift(current.id);
    current = current.parentId ? (folderMap.get(current.parentId) ?? null) : null;
  }
  return ancestors;
}

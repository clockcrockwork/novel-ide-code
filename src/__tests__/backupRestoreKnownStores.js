// backup.test.js / restore.test.js が共有するテスト用ストア名一覧・ヘルパー
// （#216 / #219 B3: 既知ストア名の一覧を両スイートでローカルに複製すると、新ストア追加時に
// 片方だけ更新され、もう片方が missing_store を誤検出／見逃す）。
//
// 正本は db.js の実ストア作成であり、その固定は db.test.js の「getDb() が作成するストア集合の
// 固定」テストが担う（docs/data-model/INVARIANTS.md #8）。この KNOWN_STORES はテスト用の複製
// であり、正本を増やすものではない。新ストア追加時は db.test.js の固定テストとあわせてここも
// 更新すること。
export const KNOWN_STORES = [
  'files',
  'folders',
  'fileMetadata',
  'folderMeta',
  'workSettings',
  'kindDefinitions',
  'statusDefinitions',
  'customFieldDefs',
  'annotations',
  'settings',
  'meta',
  'workspaceSettings',
  'syncState',
];

// A1: stores は knownStoreNames と完全一致していないと missing_store で拒否されるため、
// 「受理される」ことを検証するテストは既知ストアを全て埋めた形（未指定は空配列）を既定にする。
export function fullStores(overrides = {}) {
  return Object.assign(
    Object.create(null),
    Object.fromEntries(KNOWN_STORES.map((name) => [name, []])),
    overrides,
  );
}

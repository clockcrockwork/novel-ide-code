import { describe, it, expect } from 'vitest';
import { repairParentReferences } from './restoreReferenceIntegrity';

describe('repairParentReferences（JSON バックアップ復元 #216 / #219）', () => {
  it('存在しない folder id を指す file.parentId を null へ倒す', () => {
    const files = [{ id: 'f1', parentId: 'missing-folder' }];
    const folders = [{ id: 'd1', parentId: null }];

    const result = repairParentReferences(files, folders);

    expect(result.files).toEqual([{ id: 'f1', parentId: null }]);
    expect(result.folders).toEqual(folders);
  });

  it('存在しない folder id を指す folder.parentId を null へ倒す', () => {
    const files = [];
    const folders = [{ id: 'd1', parentId: 'missing-folder' }];

    const result = repairParentReferences(files, folders);

    expect(result.folders).toEqual([{ id: 'd1', parentId: null }]);
  });

  it('自己参照の folder.parentId を null へ倒す', () => {
    const folders = [{ id: 'd1', parentId: 'd1' }];

    const result = repairParentReferences([], folders);

    expect(result.folders).toEqual([{ id: 'd1', parentId: null }]);
  });

  it('2階層の循環（A→B→A）を断ち切る', () => {
    const folders = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];

    const { folders: fixed } = repairParentReferences([], folders);
    const byId = new Map(fixed.map((f) => [f.id, f]));

    // 循環しているうちのどちらか一方の辺だけが切られ、もう一方は残る
    const cutCount = fixed.filter((f) => f.parentId === null).length;
    expect(cutCount).toBe(1);
    // 残った辺は既存の folder を指しており、ルート（null）へ到達できる
    if (byId.get('a').parentId === 'b') expect(byId.get('b').parentId).toBeNull();
    if (byId.get('b').parentId === 'a') expect(byId.get('a').parentId).toBeNull();
  });

  it('3階層以上の循環（A→B→C→A）を断ち切り、ルートへ到達可能にする', () => {
    const folders = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'c' },
      { id: 'c', parentId: 'a' },
    ];

    const { folders: fixed } = repairParentReferences([], folders);
    const byId = new Map(fixed.map((f) => [f.id, f]));

    // 全ノードがルート（null）へ到達できることを検証する（無限ループガード付き）
    for (const f of fixed) {
      let current = f.id;
      let steps = 0;
      while (current != null) {
        current = byId.get(current)?.parentId ?? null;
        steps++;
        expect(steps).toBeLessThanOrEqual(fixed.length + 1);
      }
    }
  });

  it('循環の外から循環を指す folder（D→A, A⇄B循環）は自身の辺を保つ', () => {
    const folders = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
      { id: 'd', parentId: 'a' },
    ];

    const { folders: fixed } = repairParentReferences([], folders);
    const byId = new Map(fixed.map((f) => [f.id, f]));

    expect(byId.get('d').parentId).toBe('a');
  });

  it('循環していない通常のツリーは変更しない', () => {
    const folders = [
      { id: 'root', parentId: null },
      { id: 'child', parentId: 'root' },
    ];
    const files = [{ id: 'f1', parentId: 'child' }];

    const result = repairParentReferences(files, folders);

    expect(result.folders).toEqual(folders);
    expect(result.files).toEqual(files);
  });

  it('files/folders が配列でない場合は空配列として扱う', () => {
    const result = repairParentReferences(undefined, undefined);
    expect(result).toEqual({ files: [], folders: [] });
  });
});

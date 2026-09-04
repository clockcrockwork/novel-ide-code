import { describe, it, expect, vi, beforeEach } from 'vitest';

// 保存 → リロード（hydrate）復元のラウンドトリップ（#215）。db をインメモリ Map でモックし、
// saveFileRecord が書いたものを filesStore.hydrate が dbGetAll で読み戻すことを確認する。
const store = new Map();

vi.mock('./db', () => ({
  getDb: vi.fn().mockResolvedValue(undefined),
  dbPut: vi.fn(async (_store, rec) => {
    store.set(rec.id, rec);
  }),
  dbGetAll: vi.fn(async () => [...store.values()]),
  dbDelete: vi.fn(async (_store, key) => {
    store.delete(key);
  }),
}));
vi.mock('./lsCache', () => ({ getStorage: vi.fn(() => []), scheduleWrite: vi.fn() }));
vi.mock('../stores/uiStore', () => ({ uiActions: { addToast: vi.fn() } }));

let saveStatus, db, useFilesStore;

beforeEach(async () => {
  vi.resetModules();
  store.clear();
  db = await import('./db');
  saveStatus = await import('./saveStatus');
  ({ useFilesStore } = await import('../stores/filesStore'));
  useFilesStore.setState({ files: [], isLoaded: false, quarantinedIds: new Set() });
});

describe('saveStatus × filesStore — 保存・復元ラウンドトリップ', () => {
  it('保存した本文はリロード（hydrate）で復元される', async () => {
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md', content: '本文テキスト', createdAt: 1 });
    expect(saveStatus.getSaveStatus().state).toBe('saved');

    await useFilesStore.getState().hydrate([]);

    const restored = useFilesStore.getState().files.find((f) => f.id === 'a');
    expect(restored?.content).toBe('本文テキスト');
  });

  it('保存に失敗した編集は永続化されず、hydrate で復元されない', async () => {
    db.dbPut.mockRejectedValueOnce(new Error('boom')); // 最初の書き込みだけ失敗
    await saveStatus.saveFileRecord({ id: 'b', name: 'b.md', content: '失われる', createdAt: 2 });
    expect(saveStatus.getSaveStatus().state).toBe('error');

    await useFilesStore.getState().hydrate([]);

    expect(useFilesStore.getState().files.find((f) => f.id === 'b')).toBeUndefined();
  });
});

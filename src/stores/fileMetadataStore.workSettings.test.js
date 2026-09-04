import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db', () => ({
  dbGetAll: vi.fn(),
  dbPut: vi.fn().mockResolvedValue(undefined),
  dbDelete: vi.fn().mockResolvedValue(undefined),
}));

import { dbGetAll, dbPut, dbDelete } from '../lib/db';
import { useFileMetadataStore } from './fileMetadataStore';

function resetStore() {
  useFileMetadataStore.setState({
    kindDefinitions: [],
    statusDefinitions: [],
    customFieldDefs: [],
    fileMetadataMap: Object.create(null),
    folderMetaMap: Object.create(null),
    workSettingsMap: Object.create(null),
    isLoaded: false,
  });
}

describe('fileMetadataStore workSettings（#214）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbPut.mockResolvedValue(undefined);
    resetStore();
  });

  it('createWorkSettings: 正常系で state と IDB に保存される', async () => {
    const res = await useFileMetadataStore.getState().createWorkSettings({ id: 'w1', label: '長編A' });
    expect(res.ok).toBe(true);
    expect(useFileMetadataStore.getState().workSettingsMap.w1.label).toBe('長編A');
    expect(dbPut).toHaveBeenCalledWith('workSettings', expect.objectContaining({ id: 'w1' }));
  });

  it('createWorkSettings: dbPut 失敗時は state をロールバックし ok:false（成功扱いにしない）', async () => {
    dbPut.mockRejectedValueOnce(new Error('quota'));
    const res = await useFileMetadataStore.getState().createWorkSettings({ id: 'w1', label: 'x' });
    expect(res.ok).toBe(false);
    expect(useFileMetadataStore.getState().workSettingsMap.w1).toBeUndefined();
  });

  it('createWorkSettings: 不正 id は保存前に拒否する', async () => {
    const res = await useFileMetadataStore.getState().createWorkSettings({ id: '', label: 'x' });
    expect(res.ok).toBe(false);
    expect(dbPut).not.toHaveBeenCalled();
  });

  it('updateFolderMeta: 正常系で { ok:true } を返し state と IDB に保存する', async () => {
    const res = await useFileMetadataStore.getState().updateFolderMeta('f1', { workId: 'w1' });
    expect(res.ok).toBe(true);
    expect(useFileMetadataStore.getState().folderMetaMap.f1.workId).toBe('w1');
    expect(dbPut).toHaveBeenCalledWith('folderMeta', expect.objectContaining({ folderId: 'f1' }));
  });

  it('updateFolderMeta: dbPut 失敗時は { ok:false } を返し state を直前へ戻す（握りつぶさない）', async () => {
    dbPut.mockRejectedValueOnce(new Error('quota'));
    const res = await useFileMetadataStore.getState().updateFolderMeta('f1', { workId: 'w1' });
    expect(res.ok).toBe(false);
    // 既存が無かった folderId なので削除されて残らない
    expect(useFileMetadataStore.getState().folderMetaMap.f1).toBeUndefined();
  });

  it('deleteWorkSettings: state と IDB から削除する', async () => {
    await useFileMetadataStore.getState().createWorkSettings({ id: 'w1', label: 'x' });
    await useFileMetadataStore.getState().deleteWorkSettings('w1');
    expect(useFileMetadataStore.getState().workSettingsMap.w1).toBeUndefined();
    expect(dbDelete).toHaveBeenCalledWith('workSettings', 'w1');
  });

  it('hydrate: workSettings の読み込み失敗が kind/status 辞書の hydrate を巻き込まない', async () => {
    dbGetAll.mockImplementation((store) => {
      if (store === 'workSettings') return Promise.reject(new Error('corrupt'));
      if (store === 'kindDefinitions')
        return Promise.resolve([{ id: 1, key: 'body', label: '本文' }]);
      return Promise.resolve([]);
    });
    await useFileMetadataStore.getState().hydrate();
    const s = useFileMetadataStore.getState();
    expect(s.isLoaded).toBe(true);
    expect(s.kindDefinitions).toHaveLength(1);
    expect(Object.keys(s.workSettingsMap)).toHaveLength(0);
  });

  it('hydrate: malformed workSettings レコードは filter され正常レコードのみ残る', async () => {
    dbGetAll.mockImplementation((store) => {
      if (store === 'workSettings')
        return Promise.resolve([
          { id: 'w1', label: 'ok' },
          null,
          { id: 42, label: 'bad-id' },
          { label: 'no-id' },
        ]);
      return Promise.resolve([]);
    });
    await useFileMetadataStore.getState().hydrate();
    expect(Object.keys(useFileMetadataStore.getState().workSettingsMap)).toEqual(['w1']);
  });

  it('hydrate: id が __proto__ のレコードで Map が汚染されない（INVARIANTS #11）', async () => {
    dbGetAll.mockImplementation((store) => {
      if (store === 'workSettings')
        return Promise.resolve([{ id: '__proto__', label: 'evil' }]);
      return Promise.resolve([]);
    });
    await useFileMetadataStore.getState().hydrate();
    const map = useFileMetadataStore.getState().workSettingsMap;
    expect({}.label).toBeUndefined();
    expect(Object.getPrototypeOf(map)).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db', () => ({
  getDb: vi.fn().mockResolvedValue(undefined),
  dbGetAll: vi.fn(),
  dbPut: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/lsCache', () => ({
  getStorage: vi.fn(() => []),
  scheduleWrite: vi.fn(),
}));

import { dbGetAll } from '../lib/db';
import { useFilesStore } from './filesStore';

describe('filesStore.hydrate — quarantine 隔離 (#291)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFilesStore.setState({ files: [], isLoaded: false, quarantinedIds: new Set() });
  });

  it('deny 行を active files から除外し quarantinedIds に退避する', async () => {
    dbGetAll.mockResolvedValue([
      { id: 'a', name: 'clean.md', content: 'ok', createdAt: 1 },
      { id: 'b', name: 'warn.md', content: 'x', createdAt: 2, security: { decision: 'warn' } },
      { id: 'c', name: 'binary.md', content: '\x00', createdAt: 3, security: { decision: 'deny' } },
    ]);

    await useFilesStore.getState().hydrate([]);

    const { files, quarantinedIds } = useFilesStore.getState();
    expect(files.map((f) => f.id)).toEqual(['a', 'b']);
    expect(quarantinedIds.has('c')).toBe(true);
    expect(quarantinedIds.size).toBe(1);
  });

  it('deny 行が無ければ quarantinedIds は空', async () => {
    dbGetAll.mockResolvedValue([{ id: 'a', name: 'clean.md', content: 'ok', createdAt: 1 }]);

    await useFilesStore.getState().hydrate([]);

    const { files, quarantinedIds } = useFilesStore.getState();
    expect(files.map((f) => f.id)).toEqual(['a']);
    expect(quarantinedIds.size).toBe(0);
  });

  it('改ざん row を正規化し id 不正は除外・型は安全化する (#282)', async () => {
    dbGetAll.mockResolvedValue([
      { id: 'a', name: 123, content: 456, parentId: 'folder-1', createdAt: 'bad', isDirty: 'true' },
      { id: 789 }, // id 非文字列 → 除外
      { id: 'c', name: 'c.md', content: 'x', security: { decision: 'deny' } },
    ]);

    await useFilesStore.getState().hydrate([]);

    const { files, quarantinedIds } = useFilesStore.getState();
    expect(files.map((f) => f.id)).toEqual(['a']);
    const a = files.find((f) => f.id === 'a');
    expect(a.name).toBe('ファイル.md');
    expect(a.content).toBe('');
    expect(a.parentId).toBe('folder-1'); // フォルダ階層を維持する (#312 レビュー対応)
    expect(typeof a.createdAt).toBe('number');
    expect(a.isDirty).toBe(false);
    expect(quarantinedIds.has('c')).toBe(true);
  });
});

describe('filesStore — quarantineFile / unquarantineFile (#291)', () => {
  beforeEach(() => {
    useFilesStore.setState({ files: [], isLoaded: false, quarantinedIds: new Set() });
  });

  it('quarantineFile は active files から外し quarantinedIds に追加する', () => {
    useFilesStore.setState({
      files: [
        { id: 'a', name: 'a.md' },
        { id: 'b', name: 'b.md' },
      ],
    });

    useFilesStore.getState().quarantineFile('b');

    const { files, quarantinedIds } = useFilesStore.getState();
    expect(files.map((f) => f.id)).toEqual(['a']);
    expect(quarantinedIds.has('b')).toBe(true);
  });

  it('unquarantineFile は quarantinedIds から取り除く', () => {
    useFilesStore.setState({ quarantinedIds: new Set(['b', 'c']) });

    useFilesStore.getState().unquarantineFile('b');

    const { quarantinedIds } = useFilesStore.getState();
    expect(quarantinedIds.has('b')).toBe(false);
    expect(quarantinedIds.has('c')).toBe(true);
  });

  it('unquarantineFile は未隔離 id では state を変えない', () => {
    const before = new Set(['c']);
    useFilesStore.setState({ quarantinedIds: before });

    useFilesStore.getState().unquarantineFile('zzz');

    expect(useFilesStore.getState().quarantinedIds).toBe(before);
  });
});

import { describe, it, expect } from 'vitest';
import {
  normalizeWorkSettings,
  buildWorkLabelMap,
  collectOrphanedWorkIds,
} from './normalizeFileMetadata';

describe('normalizeWorkSettings — malformed IDB レコードの防御（#214）', () => {
  it('正常なレコードを保持する', () => {
    const r = normalizeWorkSettings({ id: 'w1', label: '長編A', createdAt: 100, updatedAt: 200 });
    expect(r).toEqual({ id: 'w1', label: '長編A', createdAt: 100, updatedAt: 200 });
  });

  it('null / 非オブジェクト / id 非文字列 / 空 id は null を返す', () => {
    expect(normalizeWorkSettings(null)).toBeNull();
    expect(normalizeWorkSettings('str')).toBeNull();
    expect(normalizeWorkSettings({ id: 42, label: 'x' })).toBeNull();
    expect(normalizeWorkSettings({ id: '', label: 'x' })).toBeNull();
    expect(normalizeWorkSettings({ id: 'a'.repeat(129), label: 'x' })).toBeNull();
  });

  it('label がオブジェクト・欠落なら空文字にフォールバックし、200 文字で切り詰める', () => {
    expect(normalizeWorkSettings({ id: 'w1', label: { evil: 1 } }).label).toBe('');
    expect(normalizeWorkSettings({ id: 'w1' }).label).toBe('');
    expect(normalizeWorkSettings({ id: 'w1', label: 'あ'.repeat(300) }).label).toHaveLength(200);
  });

  it('不正な githubRepoPath はフィールド単位で drop する（fail-closed）', () => {
    for (const bad of ['../secrets', '/leading', 'trailing/', 'a%2Fb', 'a?b', '.github/x']) {
      const r = normalizeWorkSettings({ id: 'w1', label: 'x', githubRepoPath: bad });
      expect(r).not.toBeNull();
      expect(r.githubRepoPath).toBeUndefined();
    }
  });

  it('正当な githubRepoPath は保持する', () => {
    const r = normalizeWorkSettings({ id: 'w1', label: 'x', githubRepoPath: 'works/novel-a' });
    expect(r.githubRepoPath).toBe('works/novel-a');
  });

  it('不正な timestamp は現在時刻にフォールバックする', () => {
    const r = normalizeWorkSettings({ id: 'w1', label: 'x', createdAt: 'bad', updatedAt: -1 });
    expect(r.createdAt).toBeGreaterThan(0);
    expect(r.updatedAt).toBeGreaterThan(0);
  });
});

describe('buildWorkLabelMap — folder → 作品ラベル解決（#214）', () => {
  it('workId 付き folderMeta のみを Map に載せる', () => {
    const map = buildWorkLabelMap(
      {
        f1: { folderId: 'f1', workId: 'w1' },
        f2: { folderId: 'f2', workId: null },
        f3: { folderId: 'f3' },
      },
      { w1: { id: 'w1', label: '長編A' } },
    );
    expect(map.get('f1')).toEqual({ workId: 'w1', label: '長編A' });
    expect(map.has('f2')).toBe(false);
    expect(map.has('f3')).toBe(false);
  });

  it('dangling workId（workSettings 側が無い）は label:null でフォールバックできる', () => {
    const map = buildWorkLabelMap({ f1: { folderId: 'f1', workId: 'gone' } }, {});
    expect(map.get('f1')).toEqual({ workId: 'gone', label: null });
  });

  it('folderMetaMap が不正でもクラッシュせず空 Map を返す（旧データ互換）', () => {
    expect(buildWorkLabelMap(null, {}).size).toBe(0);
    expect(buildWorkLabelMap(undefined, undefined).size).toBe(0);
    expect(buildWorkLabelMap({ bad: null }, {}).size).toBe(0);
  });
});

describe('collectOrphanedWorkIds — deleteFolder が参照カウント判定に使う（#390）', () => {
  it('deleteAll: 子孫を含む複数 folder を削除し、他に参照する folder が無ければ orphan になる', () => {
    // deleteAll では root と子孫の folderId 全体が deletedFolderIds として渡される
    const folderMetaMap = {
      root: { folderId: 'root', workId: 'w1' },
      child: { folderId: 'child', workId: null },
    };
    const orphaned = collectOrphanedWorkIds(new Set(['root', 'child']), folderMetaMap);
    expect(orphaned).toEqual(new Set(['w1']));
  });

  it('moveToParent: 削除される単一 folder の workId が他に参照されなければ orphan になる', () => {
    const folderMetaMap = {
      work: { folderId: 'work', workId: 'w1' },
      other: { folderId: 'other', workId: null },
    };
    const orphaned = collectOrphanedWorkIds(new Set(['work']), folderMetaMap);
    expect(orphaned).toEqual(new Set(['w1']));
  });

  it('同じ workId を別 folder も参照している場合は orphan にしない（消しすぎ防止）', () => {
    const folderMetaMap = {
      work: { folderId: 'work', workId: 'w1' },
      workCopy: { folderId: 'workCopy', workId: 'w1' },
    };
    const orphaned = collectOrphanedWorkIds(new Set(['work']), folderMetaMap);
    expect(orphaned.size).toBe(0);
  });

  it('workId を持たない folder の削除では workSettings に一切触れない', () => {
    const folderMetaMap = {
      plain: { folderId: 'plain', workId: null },
    };
    const orphaned = collectOrphanedWorkIds(new Set(['plain']), folderMetaMap);
    expect(orphaned.size).toBe(0);
  });

  it('deletedFolderIds が空・folderMetaMap が不正でもクラッシュせず空 Set を返す', () => {
    expect(collectOrphanedWorkIds(new Set(), { f1: { workId: 'w1' } }).size).toBe(0);
    expect(collectOrphanedWorkIds(new Set(['f1']), null).size).toBe(0);
    expect(collectOrphanedWorkIds(['f1'], { f1: { workId: 'w1' } }).size).toBe(0);
  });
});

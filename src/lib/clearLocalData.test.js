import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./db', () => ({
  dbClearAll: vi.fn().mockResolvedValue(undefined),
}));

import { dbClearAll } from './db';
import { clearAllLocalData, clearIdePrefixedStorage } from './clearLocalData';
import { scheduleWrite } from './lsCache';

describe('clearAllLocalData (#279)', () => {
  let reloadSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // jsdom の location.reload を差し替え
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('IDB 全ストアを clear しリロードする', async () => {
    await clearAllLocalData();
    expect(dbClearAll).toHaveBeenCalledTimes(1);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('ide_ プレフィックスのキーのみ削除し、他は残す', async () => {
    localStorage.setItem('ide_theme', 'dark');
    localStorage.setItem('ide_files', '[]');
    localStorage.setItem('ide_rules', 'x'); // 旧 migration キーも削除対象
    localStorage.setItem('other_key', 'keep');
    localStorage.setItem('unrelated', 'keep');

    await clearAllLocalData();

    expect(localStorage.getItem('ide_theme')).toBeNull();
    expect(localStorage.getItem('ide_files')).toBeNull();
    expect(localStorage.getItem('ide_rules')).toBeNull();
    expect(localStorage.getItem('other_key')).toBe('keep');
    expect(localStorage.getItem('unrelated')).toBe('keep');
  });

  it('IDB clear が先に行われてから localStorage を消す', async () => {
    const order = [];
    dbClearAll.mockImplementationOnce(() => {
      order.push('db');
      return Promise.resolve();
    });
    localStorage.setItem('ide_theme', 'dark');
    const origRemove = Storage.prototype.removeItem;
    const removeSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(function (k) {
        order.push('ls');
        return origRemove.call(this, k);
      });

    await clearAllLocalData();

    expect(order[0]).toBe('db');
    expect(order).toContain('ls');
    removeSpy.mockRestore();
  });
});

// 理由: src/lib/clearLocalData.js の clearIdePrefixedStorage コメントを正本とする。
describe('clearIdePrefixedStorage（#216 / #219 A3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('ide_ プレフィックスのキーのみ削除し、他は残す（IDB には触れない）', () => {
    localStorage.setItem('ide_theme', 'dark');
    localStorage.setItem('other_key', 'keep');

    clearIdePrefixedStorage();

    expect(localStorage.getItem('ide_theme')).toBeNull();
    expect(localStorage.getItem('other_key')).toBe('keep');
    expect(dbClearAll).not.toHaveBeenCalled();
  });

  it('全キー削除に成功すると { ok: true, failedKeys: [] } を返す', () => {
    localStorage.setItem('ide_a', '1');
    localStorage.setItem('ide_b', '2');

    const result = clearIdePrefixedStorage();

    expect(result).toEqual({ ok: true, failedKeys: [] });
  });

  it('特定キーの removeItem が失敗しても後続の削除を続行し、失敗キーを failedKeys で返す', () => {
    localStorage.setItem('ide_a', '1');
    localStorage.setItem('ide_b', '2');
    localStorage.setItem('ide_c', '3');
    const origRemove = Storage.prototype.removeItem;
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (k) {
      if (k === 'ide_b') throw new Error('simulated removeItem failure');
      return origRemove.call(this, k);
    });

    const result = clearIdePrefixedStorage();

    expect(result.ok).toBe(false);
    expect(result.failedKeys).toEqual(['ide_b']);
    expect(localStorage.getItem('ide_a')).toBeNull();
    expect(localStorage.getItem('ide_c')).toBeNull();
    removeSpy.mockRestore();
  });

  // A3: lsCache の pending（debounce 書き込みキュー）を破棄しないと、削除直後の
  // beforeunload で flush() が走り ide_* が復活する（jsdom で再現）。
  it('保留中の ide_* 書き込みがある状態で clearIdePrefixedStorage() を呼び、その後 beforeunload を発火させても ide_* が復活しない', () => {
    localStorage.setItem('ide_files', JSON.stringify(['old-file']));
    scheduleWrite('ide_files', ['stale-pending-write']);

    clearIdePrefixedStorage();
    window.dispatchEvent(new Event('beforeunload'));

    expect(localStorage.getItem('ide_files')).toBeNull();
  });
});

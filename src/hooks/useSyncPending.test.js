import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSyncPending } from './useSyncPending';
import { useFilesStore } from '../stores/filesStore';
import { computeCanonicalHash } from '../lib/sync/identity';

vi.mock('../lib/db', () => ({
  dbGetAll: vi.fn(),
}));
vi.mock('../lib/sync', () => ({
  getSnapshotRemoteHashes: vi.fn(),
  onSyncStatusChange: vi.fn(() => () => {}),
}));

import { dbGetAll } from '../lib/db';
import { getSnapshotRemoteHashes, onSyncStatusChange } from '../lib/sync';

function setFiles(files) {
  useFilesStore.setState({ files });
}

// onSyncStatusChange の購読者を記録し、テストから status を発火できるフェイク
// （#610 round2 F3 の検証用）。
let statusListeners = [];
function emitStatus(status) {
  for (const fn of [...statusListeners]) fn(status);
}

describe('useSyncPending（#610。badge と sync.js の resolveClassification が共有する deriveSyncAction を使う）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbGetAll.mockResolvedValue([]);
    getSnapshotRemoteHashes.mockReturnValue(null);
    statusListeners = [];
    onSyncStatusChange.mockImplementation((fn) => {
      statusListeners.push(fn);
      return () => {
        statusListeners = statusListeners.filter((l) => l !== fn);
      };
    });
    setFiles([]);
  });

  afterEach(() => {
    setFiles([]);
  });

  it('新規作成ファイル（remote map 未取得・adoptedHash 無し）は同期待ちに出る（完了条件8）', async () => {
    setFiles([{ id: 'a', name: 'a.md', content: 'x', github: null, updatedAt: 1 }]);
    const { result } = renderHook(() => useSyncPending());

    await waitFor(() => expect(result.current).toBe(true), { timeout: 1000 });
  });

  it('remote hash・adoptedHash とも一致していれば同期待ちに出ない（skip）', async () => {
    const file = { id: 'a', name: 'a.md', content: 'x', github: null, updatedAt: 1 };
    const hash = await computeCanonicalHash(file);
    getSnapshotRemoteHashes.mockReturnValue({ a: hash });
    dbGetAll.mockResolvedValue([{ id: 'a', adoptedHash: hash }]);
    setFiles([file]);

    const { result } = renderHook(() => useSyncPending());

    await waitFor(() => expect(result.current).toBe(false), { timeout: 1000 });
  });

  // timestamp だけが変化しても canonical hash は不変（identity.js の除外規則）。
  // 同期待ちが timestamp だけで誤って立たないことを固定する。
  it('timestamp だけが変化しても同期待ちに出ない', async () => {
    const file = { id: 'a', name: 'a.md', content: 'x', github: null, updatedAt: 1 };
    const hash = await computeCanonicalHash(file);
    getSnapshotRemoteHashes.mockReturnValue({ a: hash });
    dbGetAll.mockResolvedValue([{ id: 'a', adoptedHash: hash }]);
    setFiles([file]);

    const { result, rerender } = renderHook(() => useSyncPending());
    await waitFor(() => expect(result.current).toBe(false), { timeout: 1000 });

    setFiles([{ ...file, updatedAt: 999999999 }]);
    rerender();

    // debounce（300ms）を待っても pending にならないことを確認する。
    await new Promise((r) => setTimeout(r, 400));
    expect(result.current).toBe(false);
  });

  it('content が変わり remote/adoptedHash と不一致になれば同期待ちに出る', async () => {
    const file = { id: 'a', name: 'a.md', content: 'x', github: null, updatedAt: 1 };
    const hash = await computeCanonicalHash(file);
    getSnapshotRemoteHashes.mockReturnValue({ a: hash });
    dbGetAll.mockResolvedValue([{ id: 'a', adoptedHash: hash }]);
    setFiles([file]);

    const { result, rerender } = renderHook(() => useSyncPending());
    await waitFor(() => expect(result.current).toBe(false), { timeout: 1000 });

    setFiles([{ ...file, content: '変更後' }]);
    rerender();

    await waitFor(() => expect(result.current).toBe(true), { timeout: 1000 });
  });

  // #610 round2 F3: 転送なし採用（skip で adoptedHash だけ書き換える）だけの同期成功後は
  // files が変化しないため、files の変化だけに依存する再計算では pending が古いまま残る。
  // isSyncing の true→false 遷移でも再計算することを検証する。
  it('転送なし採用（skip で A := R）だけの同期成功後、files が変わらなくても pending が false になる（F3）', async () => {
    const file = { id: 'a', name: 'a.md', content: 'x', github: null, updatedAt: 1 };
    const hash = await computeCanonicalHash(file);
    // 同期前: remote map 未取得・adoptedHash 無し → pending=true（新規/未確認扱い）。
    getSnapshotRemoteHashes.mockReturnValue(null);
    dbGetAll.mockResolvedValue([]);
    setFiles([file]);

    const { result } = renderHook(() => useSyncPending());
    await waitFor(() => expect(result.current).toBe(true), { timeout: 1000 });

    // 同期が完了し、remote map・adoptedHash とも一致するようになった（skip で採用）。
    // files 自体は変化しない。
    getSnapshotRemoteHashes.mockReturnValue({ a: hash });
    dbGetAll.mockResolvedValue([{ id: 'a', adoptedHash: hash }]);
    emitStatus({ isSyncing: true });
    emitStatus({ isSyncing: false });

    await waitFor(() => expect(result.current).toBe(false), { timeout: 1000 });
  });

  // risk-model 補足: hash 計算失敗（crypto.subtle 不在）は fail-closed で pending=true にする。
  it('crypto.subtle が使えない環境では pending=true になる（fail-closed）', async () => {
    const file = { id: 'a', name: 'a.md', content: 'x', github: null, updatedAt: 1 };
    const hash = await computeCanonicalHash(file);
    // remote/adoptedHash は一致（本来なら skip=pending false になるはずの状態）。
    getSnapshotRemoteHashes.mockReturnValue({ a: hash });
    dbGetAll.mockResolvedValue([{ id: 'a', adoptedHash: hash }]);
    setFiles([file]);

    const originalCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
      const { result } = renderHook(() => useSyncPending());
      await waitFor(() => expect(result.current).toBe(true), { timeout: 1000 });
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: originalCrypto, configurable: true });
    }
  });
});

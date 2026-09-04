import { useCallback, useEffect, useRef, useState } from 'react';
import { useFilesStore } from '../stores/filesStore';
import { dbGetAll } from '../lib/db';
import { computeCanonicalHash, deriveSyncAction } from '../lib/sync/identity';
import { getSnapshotRemoteHashes, onSyncStatusChange } from '../lib/sync';

const DEBOUNCE_MS = 300; // not-a-threshold（UI debounce。性能チューニング値ではない）

// files の変化を debounce して canonical hash を再計算し、直近の同期が確認した remote hash
// （sync.js の _snapshotRef 由来）と syncState の adoptedHash から、sync.js の
// resolveClassification と同じ導出関数（deriveSyncAction）で「同期待ちのファイルがあるか」を
// 判定する（#610 完了条件7。badge と sync.js の判定を単一の導出関数に揃える）。
//
// files の変化だけでは不十分（#610 round2 F3）: 転送を伴わない採用（skip で adoptedHash を
// 書き換えるだけの同期）は files を一切変更しないため、files の変化に依存する再計算だけでは
// 同期完了後も pending が古い値のまま残る。syncAll の isSyncing が true→false になった
// タイミング（同期完了）でも再計算する。
export function useSyncPending() {
  const files = useFilesStore((s) => s.files);
  const [pending, setPending] = useState(false);
  const timerRef = useRef(null);
  const cancelRef = useRef(() => {});
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  const scheduleRecompute = useCallback(() => {
    clearTimeout(timerRef.current);
    cancelRef.current();
    let cancelled = false;
    cancelRef.current = () => {
      cancelled = true;
    };
    timerRef.current = setTimeout(() => {
      (async () => {
        const currentFiles = filesRef.current;
        const remoteHashes = getSnapshotRemoteHashes();
        const adoptedRecords = await dbGetAll('syncState').catch(() => []);
        const adoptedById = new Map(adoptedRecords.map((r) => [r.id, r.adoptedHash]));

        let isPending = false;
        for (const file of currentFiles) {
          if (cancelled) return;
          let localHash;
          try {
            localHash = await computeCanonicalHash(file);
          } catch {
            // hash 計算に失敗した file は fail-closed で「同期待ち」側に倒す。
            isPending = true;
            break;
          }
          const adoptedHash = adoptedById.get(file.id);
          if (remoteHashes === null) {
            // 起動直後・remote map 未取得。保守的に localHash と adoptedHash の不一致だけで
            // 判定する（#610）。
            if (localHash !== adoptedHash) {
              isPending = true;
              break;
            }
            continue;
          }
          const remoteHash = Object.hasOwn(remoteHashes, file.id) ? remoteHashes[file.id] : undefined;
          const action = deriveSyncAction({ localHash, remoteHash, adoptedHash }).action;
          if (action !== 'skip') {
            isPending = true;
            break;
          }
        }
        if (!cancelled) setPending(isPending);
      })();
    }, DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    scheduleRecompute();
  }, [files, scheduleRecompute]);

  useEffect(() => {
    let wasSyncing = false;
    const unsubscribe = onSyncStatusChange((status) => {
      if (wasSyncing && !status.isSyncing) {
        // 同期完了（isSyncing: true→false）。転送を伴わない採用だけの回でも
        // files が変化しないため、この遷移でも明示的に再計算する（#610 round2 F3）。
        scheduleRecompute();
      }
      wasSyncing = status.isSyncing;
    });
    return unsubscribe;
  }, [scheduleRecompute]);

  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      cancelRef.current();
    },
    [],
  );

  return pending;
}

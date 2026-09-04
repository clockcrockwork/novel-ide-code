import { create } from 'zustand';
import { getDb, dbGetAll, dbPut } from '../lib/db';
import { getStorage, scheduleWrite } from '../lib/lsCache';
import { isQuarantined } from '../lib/security/validatePulledContent';
import { normalizeFileRecords } from '../lib/normalizeFileRecord';

function orderFiles(files, orderSource) {
  const order = new Map((orderSource || []).map((f, i) => [f.id, i]));
  return [...files].sort((a, b) => {
    const ai = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

// deny ファイルは active な編集リストへ載せず id だけ隔離集合に退避する（#291）。
// records は IDB に残す（監査・将来の復元 UI 用）。
function partitionQuarantine(rows) {
  const active = [];
  const quarantinedIds = new Set();
  for (const f of rows) {
    if (isQuarantined(f)) quarantinedIds.add(f.id);
    else active.push(f);
  }
  return { active, quarantinedIds };
}

export const useFilesStore = create((set, get) => ({
  files: [],
  isLoaded: false,
  quarantinedIds: new Set(),

  setFiles: (next) => {
    const v = typeof next === 'function' ? next(get().files) : next;
    set({ files: v });
    scheduleWrite('ide_files', v);
  },

  // deny コンテンツを active 編集リストから外し id を隔離集合へ退避する（#291）。
  // 本文の IDB record は呼び出し側が保持する（監査・復帰用）。
  quarantineFile: (id) =>
    set((s) => {
      const files = s.files.filter((f) => f.id !== id);
      scheduleWrite('ide_files', files);
      const quarantinedIds = new Set(s.quarantinedIds);
      quarantinedIds.add(id);
      return { files, quarantinedIds };
    }),

  // remote 側で安全な内容に修正され再取得された場合に隔離を解除する（#291 復帰経路）。
  unquarantineFile: (id) =>
    set((s) => {
      if (!s.quarantinedIds.has(id)) return s;
      const quarantinedIds = new Set(s.quarantinedIds);
      quarantinedIds.delete(id);
      return { quarantinedIds };
    }),

  hydrate: async (initialMock = []) => {
    try {
      await getDb();
      const rows = normalizeFileRecords(await dbGetAll('files'));
      const initialLsFiles = normalizeFileRecords(getStorage('ide_files', initialMock));

      if (rows.length) {
        const { active, quarantinedIds } = partitionQuarantine(rows);
        set({ files: orderFiles(active, initialLsFiles), quarantinedIds, isLoaded: true });
      } else {
        const { active, quarantinedIds } = partitionQuarantine(initialLsFiles);
        for (const f of initialLsFiles) {
          await dbPut('files', f).catch(console.warn);
        }
        set({ files: active, quarantinedIds, isLoaded: true });
      }
    } catch (err) {
      console.error('Failed to hydrate filesStore:', err);
      set({ isLoaded: true });
    }
  },
}));

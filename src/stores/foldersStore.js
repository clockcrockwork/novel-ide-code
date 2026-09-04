import { create } from 'zustand';
import { getDb, dbGetAll, dbPut } from '../lib/db';
import { getStorage, scheduleWrite } from '../lib/lsCache';
import { normalizeFolderRecords } from '../lib/normalizeFolderRecord';

export const useFoldersStore = create((set, get) => ({
  folders: [],
  isLoaded: false,

  setFolders: (next) => {
    const v = typeof next === 'function' ? next(get().folders) : next;
    set({ folders: v });
    scheduleWrite('ide_folders', v);
  },

  hydrate: async () => {
    try {
      await getDb();
      // IDB / localStorage の folder レコードは UNTRUSTED（DevTools 改ざん・schema 破損想定）。
      // files 側（filesStore.hydrate）と対称に、利用前へ正規化を挟む（audit L1）。
      const rows = normalizeFolderRecords(await dbGetAll('folders'));
      const initialLsFolders = normalizeFolderRecords(getStorage('ide_folders', []));

      if (rows.length) {
        set({ folders: rows, isLoaded: true });
      } else {
        for (const f of initialLsFolders) {
          await dbPut('folders', f).catch(console.warn);
        }
        set({ folders: initialLsFolders, isLoaded: true });
      }
    } catch (err) {
      console.error('Failed to hydrate foldersStore:', err);
      set({ isLoaded: true });
    }
  },
}));

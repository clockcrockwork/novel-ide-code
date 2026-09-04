import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { makeMultiKeyStorage } from './lsStorage';
import { PERSIST_KEY_MAP } from './persistKeys';
import { DEFAULT_SETTINGS } from '../constants/settings';

// Persisted UI preferences keep their original localStorage keys (defined in
// persistKeys.js) so that existing user data is preserved across the
// AppContext → store migration.

const VALID_THEMES = new Set(['dark', 'light']);

const DEFAULT_COLORS = { bodyText: '', comment: '', memo: '' };

// IMPORTANT: always subscribe with a selector — `useUIStore(s => s.theme)` —
// so the component only re-renders on changes to the slice it cares about.
// Calling `useUIStore()` without a selector will subscribe to the entire
// store and defeat the purpose of this migration.
export const useUIStore = create()(
  persist(
    (set) => ({
      // Persisted preferences
      theme: 'dark',
      sidebarSide: 'left',
      showLineNumbers: false,
      colors: DEFAULT_COLORS,
      splitSwapped: false,
      fid: '1',
      secondaryFid: null,
      splitOpen: false,
      activePane: 'primary',
      settings: DEFAULT_SETTINGS,
      ghUser: null,
      ghOpenTarget: 'primary',
      wordCountMode: 'offline',

      // Ephemeral UI
      sidebarOpen: false,
      mode: 'write',
      editorSelectionText: '',
      explorerExpanded: [],
      toasts: [],
      lastEditorActivityAt: null,

      // Modal flags
      showSettings: false,
      showGithub: false,
      showExport: false,
      isExportingPdf: false,
      isExportingBackup: false,
      ghView: 'repos',
      authError: false,
      deleteFolderModal: null, // null | { folderId, folderName, folderParentId, fileCount }
      nameInputModal: null, // null | { mode: 'work' } | { mode: 'rename', fileId, initial }（#214）
      clearDataModal: null, // null | {} — ローカルデータ全削除の確認 (#279)
      restoreDataModal: null, // null | {} — JSON バックアップからの復元の確認 (#216 / #219)
      rubyEditPopup: null, // null | { pos: number, base: string, reading: string, x: number, y: number }
      pasteConfirmModal: null, // null | { text, warnSummary: string|null, onConfirm: ()=>void, onCancel: ()=>void }
      prePushModal: null, // null | { file, commitMessage, onConfirm: async ()=>string, onCancel: ()=>void }

      setTheme: (t) => {
        if (!VALID_THEMES.has(t)) {
          if (import.meta.env.DEV) {
            console.warn(
              `Invalid theme: "${t}". Must be one of [${[...VALID_THEMES].join(', ')}].`,
            );
          }
          return;
        }
        set({ theme: t });
      },
      setSidebarSide: (v) =>
        set((s) => ({
          sidebarSide: typeof v === 'function' ? v(s.sidebarSide) : v,
        })),
      setShowLineNumbers: (v) =>
        set((s) => ({
          showLineNumbers: typeof v === 'function' ? v(s.showLineNumbers) : v,
        })),
      setColors: (v) => set((s) => ({ colors: typeof v === 'function' ? v(s.colors) : v })),
      setSplitSwapped: (v) =>
        set((s) => ({
          splitSwapped: Boolean(typeof v === 'function' ? v(s.splitSwapped) : v),
        })),

      setFid: (v) => set((s) => ({ fid: typeof v === 'function' ? v(s.fid) : v })),
      setSecondaryFid: (v) =>
        set((s) => ({
          secondaryFid: typeof v === 'function' ? v(s.secondaryFid) : v,
        })),
      setSplitOpen: (v) =>
        set((s) => ({
          splitOpen: typeof v === 'function' ? v(s.splitOpen) : v,
        })),
      setActivePane: (v) =>
        set((s) => ({
          activePane: typeof v === 'function' ? v(s.activePane) : v,
        })),
      setSettings: (v) => set((s) => ({ settings: typeof v === 'function' ? v(s.settings) : v })),
      setGhUser: (v) => set((s) => ({ ghUser: typeof v === 'function' ? v(s.ghUser) : v })),
      setGhOpenTarget: (v) =>
        set((s) => ({
          ghOpenTarget: typeof v === 'function' ? v(s.ghOpenTarget) : v,
        })),
      setWordCountMode: (v) =>
        set((s) => ({
          wordCountMode: typeof v === 'function' ? v(s.wordCountMode) : v,
        })),

      setSidebarOpen: (v) =>
        set((s) => ({
          sidebarOpen: typeof v === 'function' ? v(s.sidebarOpen) : v,
        })),
      toggleExplorerFolder: (id) =>
        set((s) => ({
          explorerExpanded: s.explorerExpanded.includes(id)
            ? s.explorerExpanded.filter((x) => x !== id)
            : [...s.explorerExpanded, id],
        })),
      ensureExplorerExpanded: (ids) =>
        set((s) => {
          const toAdd = ids.filter((id) => !s.explorerExpanded.includes(id));
          if (!toAdd.length) return s;
          return { explorerExpanded: [...s.explorerExpanded, ...toAdd] };
        }),
      setMode: (v) => set((s) => ({ mode: typeof v === 'function' ? v(s.mode) : v })),
      setEditorSelectionText: (v) =>
        set((s) => ({
          editorSelectionText: typeof v === 'function' ? v(s.editorSelectionText) : v,
        })),
      clearEditorSelectionText: () => set({ editorSelectionText: '' }),

      setShowSettings: (v) =>
        set((s) => ({
          showSettings: typeof v === 'function' ? v(s.showSettings) : v,
        })),
      setShowGithub: (v) =>
        set((s) => ({
          showGithub: typeof v === 'function' ? v(s.showGithub) : v,
        })),
      setShowExport: (v) =>
        set((s) => ({
          showExport: typeof v === 'function' ? v(s.showExport) : v,
        })),
      setIsExportingPdf: (v) =>
        set((s) => ({
          isExportingPdf: typeof v === 'function' ? v(s.isExportingPdf) : v,
        })),
      setIsExportingBackup: (v) =>
        set((s) => ({
          isExportingBackup: typeof v === 'function' ? v(s.isExportingBackup) : v,
        })),
      setGhView: (v) => set((s) => ({ ghView: typeof v === 'function' ? v(s.ghView) : v })),
      setAuthError: (v) =>
        set((s) => ({
          authError: Boolean(typeof v === 'function' ? v(s.authError) : v),
        })),
      clearAuthError: () => set({ authError: false }),
      setDeleteFolderModal: (v) => set({ deleteFolderModal: v }),
      setNameInputModal: (v) => set({ nameInputModal: v }),
      setClearDataModal: (v) => set({ clearDataModal: v }),
      setRestoreDataModal: (v) => set({ restoreDataModal: v }),
      setRubyEditPopup: (v) => set({ rubyEditPopup: v }),
      setPasteConfirmModal: (v) => set({ pasteConfirmModal: v }),
      setPrePushModal: (v) => set({ prePushModal: v }),

      addToast: (message, duration = 3000) =>
        set((s) => {
          if (s.toasts.some((t) => t.message === message)) return s;
          const id =
            typeof crypto !== 'undefined' && crypto.randomUUID
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          return { toasts: [...s.toasts, { id, message, duration }] };
        }),
      removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      setLastEditorActivityAt: (ts) => set({ lastEditorActivityAt: ts }),
    }),
    {
      name: 'ide_ui',
      storage: createJSONStorage(() => makeMultiKeyStorage(PERSIST_KEY_MAP)),
      partialize: (state) => ({
        theme: state.theme,
        sidebarSide: state.sidebarSide,
        showLineNumbers: state.showLineNumbers,
        colors: state.colors,
        splitSwapped: state.splitSwapped,
        fid: state.fid,
        secondaryFid: state.secondaryFid,
        splitOpen: state.splitOpen,
        activePane: state.activePane,
        settings: state.settings,
        ghUser: state.ghUser,
        ghOpenTarget: state.ghOpenTarget,
        wordCountMode: state.wordCountMode,
      }),
    },
  ),
);

export const uiActions = {
  setTheme: (t) => useUIStore.getState().setTheme(t),
  setMode: (m) => useUIStore.getState().setMode(m),
  setEditorSelectionText: (t) => useUIStore.getState().setEditorSelectionText(t),
  clearEditorSelectionText: () => useUIStore.getState().clearEditorSelectionText(),
  setShowGithub: (v) => useUIStore.getState().setShowGithub(v),
  setGhView: (v) => useUIStore.getState().setGhView(v),
  setAuthError: (v) => useUIStore.getState().setAuthError(v),
  setFid: (v) => useUIStore.getState().setFid(v),
  addToast: (message, duration) => useUIStore.getState().addToast(message, duration),
  setPrePushModal: (v) => useUIStore.getState().setPrePushModal(v),
};

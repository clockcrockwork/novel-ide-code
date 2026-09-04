import { create } from 'zustand';
import { ALL_RULES } from '../lib/styleRules';

export const useStyleCheckStore = create((set) => ({
  results: [],
  // チェックを実行したエディタ（pane）の editorId。分割表示で結果を所有する pane のみが
  // 自身の docChanged で結果をクリアできるようにするための識別子（#330）。
  ownerId: null,
  isRunning: false,
  enabledRuleIds: ALL_RULES.filter((r) => r.defaultEnabled).map((r) => r.id),
  setResults: (results, ownerId = null) => set({ results, ownerId }),
  setRunning: (v) => set({ isRunning: v }),
  toggleRule: (id) =>
    set((s) => ({
      enabledRuleIds: s.enabledRuleIds.includes(id)
        ? s.enabledRuleIds.filter((x) => x !== id)
        : [...s.enabledRuleIds, id],
    })),
}));

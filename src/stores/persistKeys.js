// localStorage 書き込みキーの単一情報源（INVARIANTS #14 / LOCAL-STORAGE-PROTECTION.md）。

// uiStore の zustand persist がストアのフィールド → localStorage キーへ展開するマップ。
// 旧 useLs ベース AppContext が書いていたキー名との後方互換を維持する。
export const PERSIST_KEY_MAP = {
  theme: 'ide_theme',
  sidebarSide: 'ide_sb_side',
  showLineNumbers: 'ide_linenos',
  colors: 'ide_colors',
  splitSwapped: 'ide_split_swapped',
  fid: 'ide_fid',
  secondaryFid: 'ide_secondary_fid',
  splitOpen: 'ide_split_open',
  activePane: 'ide_active_pane',
  settings: 'ide_settings_v2',
  ghUser: 'ide_gh_user',
  ghOpenTarget: 'ide_gh_open_target',
  wordCountMode: 'ide_word_count_mode',
};

// filesStore / foldersStore が zustand persist を経由せず直接 scheduleWrite するキー。
export const FILES_STORAGE_KEY = 'ide_files';
export const FOLDERS_STORAGE_KEY = 'ide_folders';

// アプリが localStorage に書き込みうる全キーのカタログ（監査・テスト用）。
export const LOCAL_STORAGE_KEYS = Object.freeze([
  ...Object.values(PERSIST_KEY_MAP),
  FILES_STORAGE_KEY,
  FOLDERS_STORAGE_KEY,
]);

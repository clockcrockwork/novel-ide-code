import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import {
  commitFile,
  listBranches,
  listPRs,
  createPR,
  mergePR,
  getFileContent,
  authorizeRepo,
  clearAuthorizedRepos,
} from '../lib/github';
import { getDescendantFolderIds } from '../lib/fileTree';
import { applyStructure, cleanupOrphanedFolderMeta } from '../lib/sync/applyStructure';
import { getDb, dbGet, dbPut, dbDelete } from '../lib/db';
import {
  noteDirty,
  noteOversize,
  noteRemoved,
  noteRenamed,
  noteReset,
  deferReset,
  saveFileRecord,
} from '../lib/saveStatus';
import { workerFetch, setUnauthorizedHandler, clearCSRFToken } from '../lib/workerClient';
import {
  syncAll as doSyncAll,
  syncFileSilent,
  resolveConflictKeepLocal,
  getSyncStatus,
  resolvePushedFileIdbAction,
  markAdopted,
  applyLocalParentId,
} from '../lib/sync';
import { resolveAuthRefreshOutcome } from '../lib/authSessionOutcome';
import { appEvents, APP_EVENTS } from '../lib/appEvents';
import { useFilesStore } from '../stores/filesStore';
import { useFoldersStore } from '../stores/foldersStore';
import { useUIStore, uiActions } from '../stores/uiStore';
import { DEFAULT_SETTINGS } from '../constants/settings';
import { normalizePomodoroNotification } from '../lib/pomodoroNotification';
import { sanitizeFileName } from '../lib/security/validateSafeFileName';
import { validateCommitMessage } from '../lib/security/validateCommitMessage';
import {
  validatePulledContent,
  toSecurityRecord,
  pullDenyReason,
  pullWarnMessage,
  isQuarantined,
} from '../lib/security/validatePulledContent';
import { metadataActions, useFileMetadataStore } from '../stores/fileMetadataStore';
import { collectOrphanedWorkIds } from '../lib/metadata/normalizeFileMetadata';
import { useStyleCheckStore } from '../stores/styleCheckStore';

const FILE_CONTENT_MAX = 5_000_000;
const NAME_MAX = 100;

const genId = () =>
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const MOCK = [
  {
    id: '1',
    name: '第一章.md',
    content: `# 第一章　夜の始まり\n\n　夜が街に降りてきた。路地の奥から、かすかな声が聞こえる。\n\n　主人公の田中 悠は、コートの襟を立てながら歩いた。今夜は特別な夜のはずだった。\n\n// TODO: この段落の描写をもっと詳しく\n\n## 出会い\n\n　交差点の角に、見知らぬ女性が立っていた。彼女の表情には、何か複雑な感情が漂っていた。\n\n---\n\n　これが始まりだった。すべての——終わりの始まりが。\n\n%%この段落は後で改稿する%%\n\n　**運命**という言葉を、悠はこれほど強く意識したことはなかった。`,
  },
  {
    id: '2',
    name: '第二章.md',
    content: `# 第二章　謎の手紙\n\n　翌朝、ドアの下に白い封筒が差し込まれていた。\n\n// 手紙の内容は謎めかせておく\n\n　差出人の名前はなかった。ただ、一行だけ書かれていた。\n\n## 封筒の中身\n\n　「**真実を知りたければ、図書館へ来い。**」\n\n　悠は何度もその文字を読み返した。`,
  },
  {
    id: '3',
    name: '登場人物.md',
    content: `# 登場人物\n\n## 田中 悠（たなか ゆう）\n\n主人公。30歳。フリーライター。\n\n## 謎の{女性|じょせい}\n\n名前不明。長い黒髪。青いコート。\n\n---\n\n## サブキャラクター\n\n- 山田巡査\n- 図書館司書 鈴木さん`,
  },
  {
    id: '4',
    name: '設定メモ.md',
    content: `# 世界観・設定\n\n舞台：現代日本、架空の地方都市「深見市」\n\n## テーマ\n\n**記憶と真実**。人は見たいものを見る。`,
  },
];

// eslint-disable-next-line react-refresh/only-export-components
export const AppCtx = createContext(null);

export function AppProvider({ children }) {
  const files = useFilesStore((s) => s.files);
  const setFilesRaw = useFilesStore((s) => s.setFiles);
  const isFilesLoaded = useFilesStore((s) => s.isLoaded);
  const hydrateFiles = useFilesStore((s) => s.hydrate);

  const folders = useFoldersStore((s) => s.folders);
  const setFoldersRaw = useFoldersStore((s) => s.setFolders);
  const isFoldersLoaded = useFoldersStore((s) => s.isLoaded);
  const hydrateFolders = useFoldersStore((s) => s.hydrate);

  useEffect(() => {
    hydrateFiles(MOCK);
    hydrateFolders();
    metadataActions.hydrate();
  }, [hydrateFiles, hydrateFolders]);

  const fid = useUIStore((s) => s.fid);
  const setFidRaw = useUIStore((s) => s.setFid);
  const secondaryFid = useUIStore((s) => s.secondaryFid);
  const setSecondaryFidRaw = useUIStore((s) => s.setSecondaryFid);
  const splitOpenRaw = useUIStore((s) => s.splitOpen);
  const setSplitOpenRaw = useUIStore((s) => s.setSplitOpen);
  const activePane = useUIStore((s) => s.activePane);
  const setActivePaneRaw = useUIStore((s) => s.setActivePane);
  const settings = useUIStore((s) => s.settings);
  const setSettingsRaw = useUIStore((s) => s.setSettings);
  const ghUser = useUIStore((s) => s.ghUser);
  const setGhUserRaw = useUIStore((s) => s.setGhUser);
  const ghOpenTarget = useUIStore((s) => s.ghOpenTarget);
  const setGhOpenTarget = useUIStore((s) => s.setGhOpenTarget);
  const [diffBase, setDiffBase] = useState('');
  const [conflictData, setConflictData] = useState(null);
  const isLoaded = isFilesLoaded && isFoldersLoaded;
  const isMetadataLoaded = useFileMetadataStore((s) => s.isLoaded);
  const editorRef = useRef(null);
  const annosRef = useRef([]);
  const saveAnnosRef = useRef(null);
  const setSharedAnnosRef = useRef(null);
  const ensuredFileIdsRef = useRef(new Set());

  const setFid = useCallback(
    (id) => {
      uiActions.clearEditorSelectionText();
      setFidRaw(id);
      if (id === secondaryFid) {
        setSecondaryFidRaw(null);
        setSplitOpenRaw(false);
        setActivePaneRaw('primary');
      }
    },
    [secondaryFid, setFidRaw, setSecondaryFidRaw, setSplitOpenRaw, setActivePaneRaw],
  );
  const setSettings = setSettingsRaw;
  const setGhUser = setGhUserRaw;

  const filesRef = useRef(files);
  const fidRef = useRef(fid);
  const activePaneRef = useRef(activePane);
  const ghUserRef = useRef(ghUser);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  useEffect(() => {
    fidRef.current = fid;
  }, [fid]);
  useEffect(() => {
    activePaneRef.current = activePane;
  }, [activePane]);
  useEffect(() => {
    ghUserRef.current = ghUser;
  }, [ghUser]);

  const syncTimers = useRef({});
  const idbFlushTimers = useRef({});
  const idbPendingContent = useRef({});
  const syncBranchRef = useRef(null);

  // IDB sync effects (file-related state only; UI prefs are persisted by UIPersistence)
  useEffect(() => {
    getDb().catch(console.warn);
  }, []);

  // ページ離脱時にファイル内容の pending IDB 書き込みを即時 flush（クラッシュ対策）
  useEffect(() => {
    const flush = () => {
      Object.entries(idbFlushTimers.current).forEach(([fid, timer]) => {
        clearTimeout(timer);
        delete idbFlushTimers.current[fid];
        const pending = idbPendingContent.current[fid];
        delete idbPendingContent.current[fid];
        if (pending) saveFileRecord(pending);
      });
      metadataActions.flushPendingWrites();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      flush();
    };
  }, []);
  const fileIdsStr = files.map((f) => f.id).join(',');
  useEffect(() => {
    if (!isLoaded || !isMetadataLoaded) return;
    const newFiles = filesRef.current.filter((f) => !ensuredFileIdsRef.current.has(f.id));
    if (newFiles.length === 0) return;
    newFiles.forEach((f) => {
      ensuredFileIdsRef.current.add(f.id);
      metadataActions.ensureFileMetadata(f.id, { title: f.name || '' });
    });
  }, [isLoaded, isMetadataLoaded, fileIdsStr]);

  useEffect(() => {
    dbPut('meta', { key: 'fid', value: fid }).catch(console.warn);
  }, [fid]);
  useEffect(() => {
    dbPut('meta', { key: 'secondaryFid', value: secondaryFid }).catch(console.warn);
  }, [secondaryFid]);
  useEffect(() => {
    dbPut('meta', { key: 'splitOpen', value: splitOpenRaw }).catch(console.warn);
  }, [splitOpenRaw]);
  useEffect(() => {
    dbPut('meta', { key: 'activePane', value: activePane }).catch(console.warn);
  }, [activePane]);
  useEffect(() => {
    dbPut('settings', { key: 'settings', value: settings }).catch(console.warn);
  }, [settings]);
  useEffect(() => {
    dbPut('meta', { key: 'ghUser', value: ghUser }).catch(console.warn);
  }, [ghUser]);

  // Migrate old flat settings + fill missing sections
  useEffect(() => {
    if (settings && !settings.write) {
      setSettings({
        write: {
          font: settings.font || 'noto-serif',
          fontSize: settings.fontSize || 16,
          lineHeight: settings.lineHeight || 2,
          letterSpacing: settings.letterSpacing || 5,
          width: settings.width || 680,
        },
        preview: DEFAULT_SETTINGS.preview,
        github: DEFAULT_SETTINGS.github,
        notifications: DEFAULT_SETTINGS.notifications,
        replacementProfiles: DEFAULT_SETTINGS.replacementProfiles,
      });
    } else if (settings) {
      setSettings((s) => {
        if (!s) return s;
        const next = {
          ...s,
          github: s.github || DEFAULT_SETTINGS.github,
          notifications: {
            ...DEFAULT_SETTINGS.notifications,
            ...(s.notifications || {}),
            pomodoro: normalizePomodoroNotification({
              ...DEFAULT_SETTINGS.notifications.pomodoro,
              ...(s.notifications?.pomodoro || {}),
            }),
          },
          replacementProfiles: {
            sites: Array.isArray(s.replacementProfiles?.sites)
              ? s.replacementProfiles.sites
              : DEFAULT_SETTINGS.replacementProfiles.sites,
            rows: Array.isArray(s.replacementProfiles?.rows)
              ? s.replacementProfiles.rows
              : DEFAULT_SETTINGS.replacementProfiles.rows,
          },
        };
        return JSON.stringify(next) === JSON.stringify(s) ? s : next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sync helpers ─────────────────────────────────────────────────────────

  // push 成功を isDirty:false として files store へ反映する。id と updatedAt の両方が
  // 一致する場合のみ適用し、同期の往復中にユーザーが同じファイルを編集していた場合は
  // 新しい編集を巻き戻さない（onQuarantine の pushed 分岐と同じ不変条件）。
  //
  // syncFile()（sync.js）は戻りを待たず { ...original, isDirty:false } を無条件に dbPut 済みのため、
  // 往復中に編集・削除されていた場合は IDB 側もその古い/誤った書き込みを訂正する必要がある
  // （store 側のガードだけでは IDB は無防備）。
  const markPushedFileClean = useCallback(
    (original) => {
      const currentFile = useFilesStore.getState().files.find((f) => f.id === original.id);
      const decision = resolvePushedFileIdbAction(original, currentFile);
      if (decision.action === 'delete') {
        // 往復中に削除された。syncFile の dbPut が復活させたレコードを消して整合させる。
        dbDelete('files', original.id).catch(console.warn);
        return;
      }
      if (decision.action === 'restore') {
        // 往復中に編集された。syncFile の dbPut が上書きした古い本文を最新版で書き戻す
        // （store 側は isDirty:true のまま。次回同期で再 push される）。
        dbPut('files', decision.file).catch(console.warn);
        return;
      }
      // 判定（resolvePushedFileIdbAction）はデバウンス個別同期の完了処理と共有するが、
      // 副作用は意図的に異なる：ここは syncAll 内の onPushFile として呼ばれ、IDB は syncFile が
      // 既に書き込み済み・全体完了は syncAll 側の setStatus が担うため、isDirty を落とすだけで
      // IDB 再書き込みや SYNC_COMPLETE の発火はしない。
      setFilesRaw((prev) => {
        const hasTarget = prev.some(
          (f) => f.id === original.id && f.updatedAt === original.updatedAt,
        );
        if (!hasTarget) return prev;
        const next = prev.map((f) =>
          f.id === original.id && f.updatedAt === original.updatedAt
            ? { ...f, isDirty: false }
            : f,
        );
        filesRef.current = next;
        return next;
      });
    },
    [setFilesRaw],
  );

  // syncAll（#394 C-1）が structure（folders / files[id].parentId）の merge 結果を
  // ローカルへ適用するコールバック。sync.js は純関数の merge だけを行い、IDB / store への
  // 書き込みは applyStructure（src/lib/sync/applyStructure.js）が担う。ここは I/O を注入する
  // 薄い wrapper（#394 C-1 round2: Q1・R1・O1 — 適用は merge の明示差分だけを関数形 patch で
  // 当て、ライブ store との差分で削除を再導出しない）。戻り値 { ok, folders, fileParentIds }
  // は sync.js が structure base（syncState）と manifest 書き込みの両方に使う（契約4）。
  const applyStructureFromSync = useCallback(async ({
    folders: nextFolders, fileParentIds, deletedFolderIds, localSnapshot,
  }) => {
    try {
      return await applyStructure({
        folders: nextFolders,
        fileParentIds,
        deletedFolderIds,
        localSnapshot,
        io: {
          getFolders: () => useFoldersStore.getState().folders,
          setFolders: setFoldersRaw,
          getFiles: () => useFilesStore.getState().files,
          setFiles: (fn) => {
            setFilesRaw(fn);
            filesRef.current = useFilesStore.getState().files;
          },
          dbPut,
          dbDelete,
          getFolderMetaMap: () => useFileMetadataStore.getState().folderMetaMap,
          collectOrphanedWorkIds,
          deleteWorkSettings: metadataActions.deleteWorkSettings,
          deleteFolderMeta: metadataActions.deleteFolderMeta,
        },
      });
    } catch (e) {
      console.warn('[syncAll] structure 適用に失敗', e);
      return { ok: false };
    }
  }, [setFoldersRaw, setFilesRaw]);

  // fromUser: ユーザーがボタン等で明示的に起動した場合のみ true。実行できなかった場合に
  // トースト通知するかどうかをこれで区別する（自動同期のたびにトーストを出さないため）。
  const triggerSync = useCallback((opts = {}) => {
    const { fromUser = false } = opts;
    dbGet('meta', 'deviceId')
      .then((r) => {
        const deviceId = r?.value;
        if (!deviceId) {
          // clearAllLocalData 後はリロードしても deviceId が再生成されない（onupgradeneeded 専用）。
          // ユーザー起点の呼び出しでは無反応にせず理由を伝える。
          if (fromUser) {
            uiActions.addToast(
              'デバイス情報が見つからないため同期できませんでした。ページを再読み込みしてください',
              6000,
            );
          }
          return;
        }
        if (fromUser && getSyncStatus().isSyncing) {
          // 別経路（起動時・online・rename・競合解決）で同期中の場合、syncAll は無言で
          // 即 return する。ボタンは有効なままなので、押した本人には理由を伝える。
          uiActions.addToast('同期処理を実行中です。完了までお待ちください', 4000);
          return;
        }
        doSyncAll({
          files: filesRef.current,
          deviceId,
          branch: syncBranchRef.current,
          quarantinedIds: Array.from(useFilesStore.getState().quarantinedIds),
          // structure（folders / files[id].parentId）の hydrate ゲート（契約7・H1）。
          // store から直接読む（このコールバックは deps を空にしているため、クロージャの
          // isFilesLoaded/isFoldersLoaded/folders は stale になりうる）。
          folders: useFoldersStore.getState().folders,
          filesLoaded: useFilesStore.getState().isLoaded,
          foldersLoaded: useFoldersStore.getState().isLoaded,
          onApplyStructure: applyStructureFromSync,
          onBranch: (b) => {
            syncBranchRef.current = b;
          },
          // push 成功時に React/Zustand の isDirty を落とし、往復中の編集・削除に対する
          // IDB 側の後処理も行う（#245。詳細は markPushedFileClean 定義側のコメント）。
          onPushFile: markPushedFileClean,
          onPullFile: (pulled, validation) => {
            if (isQuarantined(pulled)) {
              // deny コンテンツは active 編集リストへ載せず id だけ隔離集合に退避する（#291）。
              // 本文は processPull で IDB へ書込済み（監査・将来の復元 UI 用に保持）。
              useFilesStore.getState().quarantineFile(pulled.id);
              noteRemoved(pulled.id); // 隔離で active から外れたエントリの状態を掃除する
              const nextFiles = useFilesStore.getState().files;
              filesRef.current = nextFiles;
              // 選択中ファイルが隔離されたら別の active file へ選択を移す。残さないと fid が
              // active リスト外を指し続け、表示は files[0] のまま編集が stale fid に吸われて失われる。
              if (pulled.id === fidRef.current) setFidRaw(nextFiles[0]?.id ?? null);
            } else {
              // 保留 debounce フラッシュの掃除（belt-and-suspenders）。straight pull は
              // sync.js の pull⟺!isDirty 不変条件により通常 pending を持たないが、他の content
              // 置換経路と対称にして、routing が変わっても採用内容の clobber を防ぐ。
              clearTimeout(idbFlushTimers.current[pulled.id]);
              delete idbFlushTimers.current[pulled.id];
              delete idbPendingContent.current[pulled.id];
              setFilesRaw((prev) => {
                const idx = prev.findIndex((f) => f.id === pulled.id);
                const next =
                  idx >= 0
                    ? prev.map((f, i) => (i === idx ? { ...f, ...pulled } : f))
                    : [...prev, pulled];
                filesRef.current = next;
                return next;
              });
              // 以前隔離されていたファイルが安全な内容で再取得されたら隔離を解除する（#291 復帰経路）。
              useFilesStore.getState().unquarantineFile(pulled.id);
              // pull で content が置換されたため、直前のローカル未保存状態（oversize/error/dirty）を掃除する。
              // 本文は上流 processPull で永続済みのため即時 noteReset で一貫。
              noteReset(pulled.id);
            }
            // pull した EXTERNAL データに危険/警告があれば通知する（#285）
            if (validation && validation.decision !== 'allow') {
              const detail =
                validation.decision === 'deny'
                  ? pullDenyReason(validation)
                  : pullWarnMessage(validation);
              if (detail) uiActions.addToast(`「${pulled.name}」: ${detail}`, 6000);
            }
          },
          onConflict: ({ local, remote }) => {
            // deny remote は sync.js 側で隔離済み（onQuarantine 経由）。ここへは非 deny のみ到達する。
            setConflictData({ local, remote, fileName: local.name });
            if (local.id === fidRef.current) uiActions.setMode('diff');
          },
          onQuarantine: (local, validation, pushed) => {
            // 競合 remote が deny。ローカル版を保持し、危険な remote は diff/採用に渡さない（#291）。
            const reason = pullDenyReason(validation);
            const msg = pushed
              ? `「${local.name}」: リモートの競合は隔離されました（${reason}）。ローカル版を保持しました`
              : `「${local.name}」: リモートの競合を隔離しました（${reason}）が、ローカル版の同期に失敗しました。次回の同期で再試行します`;
            uiActions.addToast(msg, 8000);
            // push 成功時は store の isDirty も落として再 push の churn を防ぐ。
            // sync 中にユーザーが編集していれば updatedAt が進むので、その場合は落とさない
            // （新しい編集を isDirty:false で巻き戻さない）。
            if (pushed) markPushedFileClean(local);
          },
        });
      })
      .catch(console.warn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      if (!ghUserRef.current) return;
      triggerSync();
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [triggerSync]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const authResult = url.searchParams.get('auth');
    if (authResult) {
      url.searchParams.delete('auth');
      window.history.replaceState({}, '', url.toString());
    }

    if (authResult === 'error') {
      // OAuth 失敗＝未ログイン。ghUser が persist から同期復元されていても、失敗した認可フローの
      // 結果として「ログイン済み」表示を続けさせない（refresh は呼ばないためここで明示的に落とす）。
      setGhUser(null);
      queueMicrotask(() => {
        uiActions.setAuthError(true);
        uiActions.setShowGithub(true);
      });
      return;
    }

    // ghUser は persist から同期復元されるため、refresh 結果を待つ前に「ログイン済み」として
    // 描画され得る。復元済み ghUser の有無を refresh 結果と掛け合わせて判定する。
    const hadGhUser = Boolean(ghUserRef.current);
    workerFetch('/auth/refresh', { method: 'POST' })
      .then(async (r) => ({ refreshOk: r.ok, user: r.ok ? await r.json() : null }))
      .then(({ refreshOk, user }) => {
        const outcome = resolveAuthRefreshOutcome({ refreshOk, user, hadGhUser, authResult });
        if (outcome.setUser) {
          setGhUser(outcome.setUser);
        } else if (outcome.clearSession) {
          // セッション失効：偽の「ログイン済み」表示のまま 401 を握り潰し続けるのを止める。
          // ログインモーダルは自動で開かない（人間裁定）。
          clearAuthorizedRepos();
          clearCSRFToken();
          setGhUser(null);
        }
        if (outcome.triggerSync) triggerSync();
        if (outcome.registerHandler) {
          // ハンドラは「持っていたセッションを失った」ことの通知であり、一度もログイン
          // していない状態の 401 は正常系（未接続＝退避モード）。セッション確認が
          // 取れた後にだけ登録する。登録前の 401 は誰も拾わないので何も起きない。
          setUnauthorizedHandler(() => {
            clearAuthorizedRepos();
            clearCSRFToken();
            setGhUser(null);
            uiActions.setShowGithub(true);
          });
        }
        if (outcome.showAuthError) {
          uiActions.setAuthError(true);
          uiActions.setShowGithub(true);
        }
      })
      .catch(console.warn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── File operations ──────────────────────────────────────────────────────

  const primaryFile = files.find((f) => f.id === fid) || files[0];
  const secondaryFile = files.find((f) => f.id === secondaryFid) || null;
  const splitOpen = Boolean(splitOpenRaw && secondaryFile && secondaryFid !== fid);
  const activeFile = activePane === 'secondary' && splitOpen ? secondaryFile : primaryFile;
  const currentFile = activeFile;

  useEffect(() => {
    if (!isLoaded) return;
    const secondaryStillExists = secondaryFid && files.some((f) => f.id === secondaryFid);
    if (!splitOpenRaw && activePane === 'secondary') {
      setActivePaneRaw('primary');
      return;
    }
    if (splitOpenRaw && (!secondaryStillExists || secondaryFid === fid)) {
      setSecondaryFidRaw(null);
      setSplitOpenRaw(false);
      setActivePaneRaw('primary');
    }
  }, [
    files,
    fid,
    secondaryFid,
    splitOpenRaw,
    activePane,
    isLoaded,
    setSecondaryFidRaw,
    setSplitOpenRaw,
    setActivePaneRaw,
  ]);

  useEffect(() => {
    // 参照(secondary) pane でチェックした結果は、その pane が閉じる/別ファイルへ切り替わると
    // 座標の根拠を失う。secondary の EditorBox は unmount され docChanged を発火しないため、
    // ここで secondary 所有のスタイルチェック結果を明示的にクリアする（#331）。
    const sc = useStyleCheckStore.getState();
    if (sc.ownerId === 'secondary') sc.setResults([], null);
  }, [splitOpen, secondaryFid]);

  const updateFileContent = useCallback((targetFid, c) => {
    if (!targetFid) return;
    const tooLarge = typeof c === 'string' && c.length > FILE_CONTENT_MAX;
    const updatedAt = Date.now();
    const capturedFid = targetFid;
    // 名前は content 編集で不変。updater 内で副作用的に代入すると batch 更新時に stale/undefined に
    // なりうるため先読みする。filesRef は useEffect 経由で遅延するため、新規作成直後でも取りこぼさない
    // よう権威的な store から読む（getState は setFilesRaw を同期反映する）。
    const changedName = useFilesStore.getState().files.find((f) => f.id === capturedFid)?.name;
    setFilesRaw((p) => {
      const next = p.map((f) =>
        f.id === capturedFid ? { ...f, content: c, updatedAt, isDirty: true } : f,
      );
      const changed = next.find((f) => f.id === capturedFid);
      if (tooLarge)
        console.warn(
          'updateFileContent: ファイルサイズが上限を超えています。IDB/sync をスキップします',
          c.length,
        );
      if (changed) {
        // サイズ超過に転じたら、直前の上限内編集で予約済みの保存を破棄する。残すと古い（上限内）
        // 本文が発火時点の dirtySeq（oversize 世代）を savedSeq に前進させ oversize を誤解除し、
        // 「保存済み」表示に戻したうえリロードで巨大編集を失う（Codex P1）。
        clearTimeout(idbFlushTimers.current[capturedFid]);
        if (tooLarge) {
          delete idbFlushTimers.current[capturedFid];
          delete idbPendingContent.current[capturedFid];
        } else {
          idbPendingContent.current[capturedFid] = changed;
          idbFlushTimers.current[capturedFid] = setTimeout(() => {
            delete idbFlushTimers.current[capturedFid];
            const pending = idbPendingContent.current[capturedFid];
            delete idbPendingContent.current[capturedFid];
            if (pending) saveFileRecord(pending);
          }, 500);
        }
      }
      return next;
    });
    // 保存状態表示（#215）。
    if (tooLarge) noteOversize(capturedFid, changedName);
    else noteDirty(capturedFid, changedName);
    clearTimeout(syncTimers.current[capturedFid]);
    if (!tooLarge && ghUserRef.current && syncBranchRef.current) {
      syncTimers.current[capturedFid] = setTimeout(async () => {
        const file = filesRef.current?.find((f) => f.id === capturedFid);
        if (!file || !ghUserRef.current || !syncBranchRef.current) return;
        const startUpdatedAt = file.updatedAt;
        const synced = await syncFileSilent(file, syncBranchRef.current);
        // 同期開始〜完了の間にファイルが更新されていたら synced は古い本文に基づくため適用しない。
        // （大ドキュメントの serialize throttle で updateFileContent が遅延する間に、旧タイマーが
        //   stale な filesRef 本文で発火し、新しい編集を isDirty:false で巻き戻すのを防ぐ。
        //   新たに予約された同期タイマーも温存する。）
        const latest = filesRef.current?.find((f) => f.id === capturedFid);
        const decision = resolvePushedFileIdbAction({ updatedAt: startUpdatedAt }, latest);
        if (decision.action === 'delete') {
          // 同期中にファイルが削除された。syncFile は return 前に dbPut で IDB へ synced を書き込み
          // 済みのため、ここで書かないだけでは helper の書き込みで復活が残る。明示的に削除して整合させる。
          delete syncTimers.current[capturedFid];
          dbDelete('files', capturedFid).catch(console.warn);
          return;
        }
        if (decision.action === 'restore') {
          // syncFile は return 前に IDB に古い本文を書き込むため、stale と判定した場合は
          // 最新版で上書きし直す（React state は更新済みなので IDB の復旧のみ）。
          delete syncTimers.current[capturedFid];
          dbPut('files', decision.file).catch(console.warn);
          return;
        }
        delete syncTimers.current[capturedFid];
        // 判定（resolvePushedFileIdbAction）は markPushedFileClean と共有するが、副作用は意図的に
        // 異なる：この経路は syncAll の外で単独に動くため、IDB 書き込みと完了通知（SYNC_COMPLETE）を
        // 自分で担う必要があり、synced を store・IDB の両方へ適用してからイベントを発火する。
        if (synced) {
          setFilesRaw((prev) => prev.map((f) => (f.id === capturedFid ? { ...f, ...synced } : f)));
          dbPut('files', synced).catch(console.warn);
          appEvents.dispatchEvent(new CustomEvent(APP_EVENTS.SYNC_COMPLETE));
        }
      }, 3000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updatePrimaryContent = useCallback(
    (c) => {
      updateFileContent(fidRef.current, c);
    },
    [updateFileContent],
  );

  // 編集後の security メタデータを更新する（#291 Task 3）。
  // 本文の dirty フラグを立てない（content 変更ではなく security 再計算のみ）。
  const updateFileSecurity = useCallback((targetFid, newSecurity) => {
    if (!targetFid || !newSecurity) return;
    // 関数型更新で最新の content/updatedAt を保全（filesRef.current は useEffect 経由で遅延更新の
    // ため事前取得すると stale content で上書きしうる）。IDB 書込用は setFilesRaw 後に同期反映される
    // store から取得する。
    setFilesRaw((p) => p.map((f) => (f.id === targetFid ? { ...f, security: newSecurity } : f)));
    const latestFile = useFilesStore.getState().files.find((f) => f.id === targetFid);
    if (!latestFile) return;
    if (idbPendingContent.current[targetFid]) {
      idbPendingContent.current[targetFid] = {
        ...idbPendingContent.current[targetFid],
        security: newSecurity,
      };
    }
    dbPut('files', latestFile).catch(console.warn);
  }, []);

  const updatePrimarySecurity = useCallback(
    (ns) => updateFileSecurity(fidRef.current, ns),
    [updateFileSecurity],
  );

  // pagehide 時に AppContext 自身の IDB flush（beforeunload/pagehide で先行登録済み）より後に
  // EditorBox の onChange が呼ばれても 500ms debounce が間に合わない問題を回避するため、
  // EditorBox から直接 IDB に書き込む際に使う関数。debounce をバイパスして即時 dbPut する。
  // visibilitychange(hidden) で呼ばれる場合はページが生存したまま復帰するため、React state も
  // 同時に更新する（IDB だけ更新すると Zustand files が stale になり、再フォーカス後の操作で
  // IDB 上書きが起きうる）。
  const flushFileContentNow = useCallback(
    (fid, content) => {
      if (!fid || typeof content !== 'string') return;
      // active に存在しないファイルへはファントムエントリ（oversize 固着）を作らない。
      // 存在チェックを oversize 判定より前に置く（Gemini high）。
      const file = filesRef.current?.find((f) => f.id === fid);
      if (!file) return;
      if (content.length > FILE_CONTENT_MAX) {
        noteOversize(fid, file.name);
        return;
      }
      if (idbFlushTimers.current[fid]) {
        clearTimeout(idbFlushTimers.current[fid]);
        delete idbFlushTimers.current[fid];
        delete idbPendingContent.current[fid];
      }
      const updatedAt = Date.now();
      // 直接 flush は（updateFileContent を経ない大文書 serialize 経路で）新しい本文の保存。
      // noteDirty で世代を進めないと seq===savedSeq となり、書込失敗が stale 扱いで無視され
      // 未永続なのに「保存済み」のままになる（Codex P2）。
      noteDirty(fid, file.name);
      // updateFileContent と同様に isDirty:true を立てる。pagehide 時は setFilesRaw が未反映で
      // filesRef の file が isDirty:false（GitHub から pull 直後など）のことがあり、これを落とすと
      // 次回起動時に dirty でないと判定され未 push の編集が同期対象外になる/上書きされうるため。
      // setFilesRaw も同時に更新し、visibilitychange 復帰後の操作が stale content を使わないようにする。
      setFilesRaw((p) =>
        p.map((f) => (f.id === fid ? { ...f, content, isDirty: true, updatedAt } : f)),
      );
      saveFileRecord({ ...file, content, isDirty: true, updatedAt });
    },
    [setFilesRaw],
  );

  const updateContent = useCallback(
    (c) => {
      if (activePaneRef.current !== 'primary') return;
      updateFileContent(fidRef.current, c);
    },
    [updateFileContent],
  );

  const setActivePane = useCallback(
    (pane) => {
      uiActions.clearEditorSelectionText();
      setActivePaneRaw(pane === 'secondary' && splitOpenRaw ? 'secondary' : 'primary');
    },
    [splitOpenRaw, setActivePaneRaw],
  );

  const openSplitFile = useCallback(
    (id) => {
      if (!id || id === fidRef.current || !filesRef.current.some((f) => f.id === id)) return;
      setSecondaryFidRaw(id);
      setSplitOpenRaw(true);
      setActivePaneRaw('secondary');
    },
    [setSecondaryFidRaw, setSplitOpenRaw, setActivePaneRaw],
  );

  const closeSplit = useCallback(() => {
    setSecondaryFidRaw(null);
    setSplitOpenRaw(false);
    setActivePaneRaw('primary');
  }, [setSecondaryFidRaw, setSplitOpenRaw, setActivePaneRaw]);

  const swapPaneFiles = useCallback(() => {
    const nextPrimary = secondaryFid;
    const nextSecondary = fidRef.current;
    if (!nextPrimary || !filesRef.current.some((f) => f.id === nextPrimary)) return;
    setFidRaw(nextPrimary);
    setSecondaryFidRaw(nextSecondary);
    setSplitOpenRaw(true);
    setActivePaneRaw('primary');
  }, [secondaryFid, setFidRaw, setSecondaryFidRaw, setSplitOpenRaw, setActivePaneRaw]);

  const createFileObject = (name, content, github = null, security = null) => {
    const id = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    return {
      id,
      name,
      content,
      github,
      createdAt: now,
      updatedAt: now,
      isDirty: false,
      security,
    };
  };

  const newFile = (parentId = null) => {
    const existingNames = new Set(files.map((f) => f.name));
    let name = '新規ファイル.md';
    let n = 2;
    while (existingNames.has(name)) {
      name = `新規ファイル (${n++}).md`;
    }
    const f = { ...createFileObject(name, '# 新しい章\n\n'), parentId };
    setFilesRaw((p) => [...p, f]);
    setFid(f.id);
    setActivePaneRaw('primary');
    dbPut('files', f).catch(console.warn);
    metadataActions.ensureFileMetadata(f.id, { title: name });
  };

  const createFolder = (name, parentId = null) => {
    const safeName = sanitizeFileName(name, NAME_MAX);
    if (!safeName) return;
    const id = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const createdAt = Date.now();
    // Compute maxOrder from current render-time state (outside updater) so dbPut
    // always receives a defined object. Race condition is not a concern in this
    // single-user app where folder creation is sequential (gated by window.prompt).
    const maxOrder = folders.reduce((m, f) => Math.max(m, f.sortOrder ?? 0), -1);
    const newFolder = {
      id,
      name: safeName,
      parentId,
      sortOrder: maxOrder + 1,
      createdAt,
    };
    setFoldersRaw((p) => [...p, newFolder]);
    dbPut('folders', newFolder).catch(console.warn);
  };

  // 作品を作成する: workSettings レコード → トップレベル folder → folderMeta.workId 紐付けの順
  // （参照先を先に作る）。途中失敗は { ok: false } で返し、呼び出し元モーダルは閉じない。
  const createWork = useCallback(async (name) => {
    const safeName = sanitizeFileName(name, NAME_MAX);
    if (!safeName) return { ok: false, reason: '作品名を入力してください' };
    const workId = genId();
    const created = await metadataActions.createWorkSettings({ id: workId, label: safeName });
    if (!created.ok) return created;

    const folderId = genId();
    // クロージャの folders は stale になりうるため store から最新を取得する
    const currentFolders = useFoldersStore.getState().folders;
    const maxOrder = currentFolders.reduce((m, f) => Math.max(m, f.sortOrder ?? 0), -1);
    const newFolder = {
      id: folderId,
      name: safeName,
      parentId: null,
      sortOrder: maxOrder + 1,
      createdAt: Date.now(),
    };
    setFoldersRaw((p) => [...p, newFolder]);
    try {
      await dbPut('folders', newFolder);
    } catch (e) {
      console.warn('[createWork] folder の保存に失敗', e);
      setFoldersRaw((p) => p.filter((f) => f.id !== folderId));
      await metadataActions.deleteWorkSettings(workId);
      return { ok: false, reason: '作品フォルダの保存に失敗しました' };
    }
    // folderMeta（folder ↔ 作品の紐付け）の保存失敗は「バッジは見えるがリロードで消える」= 作品作成の
    // 部分成功になるため、作品全体をロールバックして失敗を伝播する（成功扱いにしない）。
    // 想定外 throw でもロールバック経路に入るよう {ok:false} へ畳む（診断のため warn は残す）。
    const metaResult = await metadataActions
      .updateFolderMeta(folderId, { workId, title: safeName })
      .catch((e) => {
        console.warn('[createWork] updateFolderMeta で想定外の例外', e);
        return { ok: false, reason: '作品とフォルダの紐付けに失敗しました' };
      });
    if (!metaResult?.ok) {
      setFoldersRaw((p) => p.filter((f) => f.id !== folderId));
      await dbDelete('folders', folderId).catch(console.warn);
      await metadataActions.deleteWorkSettings(workId);
      return { ok: false, reason: '作品とフォルダの紐付けに失敗しました' };
    }
    return { ok: true, workId, folderId };
  }, [setFoldersRaw]);

  // チャプター（ファイル）名を変更する。files.name を正とし fileMetadata.title は触らない。
  // rename は canonical hash（name を含む）の変化として同期判定に反映される。
  // updatedAt / isDirty の更新は saveStatus / switchBranch 側の未保存表示のため（rename 巻き戻り防止）。
  const renameFile = useCallback(async (fileId, newName) => {
    const safeName = sanitizeFileName(newName, NAME_MAX);
    if (!safeName) return { ok: false, reason: 'ファイル名を入力してください' };
    const original = useFilesStore.getState().files.find((f) => f.id === fileId);
    if (!original) return { ok: false, reason: 'ファイルが見つかりません' };
    const now = Date.now();

    // 関数型更新（純粋）。IDB 書込用は setFilesRaw 後の store から取得し、stale closure を避ける
    // （updateFileSecurity と同じパターン）。
    setFilesRaw((p) =>
      p.map((f) => (f.id === fileId ? { ...f, name: safeName, updatedAt: now, isDirty: true } : f)),
    );
    const renamed = useFilesStore.getState().files.find((f) => f.id === fileId);
    if (!renamed) return { ok: false, reason: 'ファイルが見つかりません' };
    // filesRef は useEffect 経由の遅延更新のため、直後の triggerSync が旧 name を送らないよう
    // 他の mutation 経路と同様にここで同期させる。
    filesRef.current = useFilesStore.getState().files;

    // 本文編集 debounce 中の pending レコードにも rename を反映する。
    // これをしないと後続の content 保存タイマーが旧 name で put し名前が巻き戻る。
    if (idbPendingContent.current[fileId]) {
      idbPendingContent.current[fileId] = {
        ...idbPendingContent.current[fileId],
        name: safeName,
        updatedAt: now,
        isDirty: true,
      };
    }

    try {
      // IDB へは既存レコードの read-modify-write で name 系フィールドのみ patch する。
      // store のスナップショット全体を書くと、tooLarge で意図的に IDB 未永続の本文まで
      // 書き込んでしまう（本文の永続化は updateFileContent の pending 経路が正）。
      const stored = await dbGet('files', fileId);
      // IDB 未存在時のフォールバックでも tooLarge 本文は書かない（不変条件の維持）
      const base =
        stored ??
        (typeof renamed.content === 'string' && renamed.content.length > FILE_CONTENT_MAX
          ? { ...renamed, content: '' }
          : renamed);
      await dbPut('files', {
        ...base,
        name: safeName,
        updatedAt: now,
        isDirty: true,
      });
      noteRenamed(fileId, safeName); // error/oversize バッジの detail 名を追従させる

      // GitHub 連携ファイルは name 変更が GitHub 側のパスへ反映されない（パス追従は #394 系）。
      // 旧パスへサイレント保存され続けることに気づけるよう明示する（addToast は同一文言を
      // 重複抑止するため、連続 rename でも警告が出るようファイル名を含める）。
      if (renamed.github) {
        useUIStore
          .getState()
          .addToast(
            `「${safeName}」のGitHub側パスは変更されません（保存先は従来のパスのまま）`,
            6000,
          );
      }
      // 名前だけの変更は本文編集の同期タイマーに乗らないため、ここで同期を起動して他端末へ伝播させる
      triggerSync();
      return { ok: true };
    } catch (e) {
      console.warn('[renameFile] 保存に失敗', e);
      // 楽観的更新をロールバック。ただし dbPut 待機中にユーザー編集が入り updatedAt が進んでいる
      // 場合、updatedAt/isDirty まで戻すと新しい編集が sync 対象から漏れる（先祖返り）ため、
      // その場合は name のみ戻し同期フラグは維持する。さらに連続リネームで name が既に
      // 別の値へ変わっている場合は、最新の名前を上書きしない（この失敗分のみ戻す）。
      const rollback = (f) => {
        if (f.name !== safeName) return f;
        const rolledBack = { ...f, name: original.name };
        if (f.updatedAt === now) {
          rolledBack.updatedAt = original.updatedAt;
          rolledBack.isDirty = original.isDirty;
        }
        return rolledBack;
      };
      setFilesRaw((p) => p.map((f) => (f.id === fileId ? rollback(f) : f)));
      if (idbPendingContent.current[fileId]) {
        idbPendingContent.current[fileId] = rollback(idbPendingContent.current[fileId]);
      }
      // 本文 flush が先に新名を IDB へ書いた後で上の dbPut が失敗した場合、IDB だけ新名が
      // 残り store と乖離する。IDB 側は name のみ戻す（updatedAt/isDirty を触ると、flush 済みの
      // 本文編集の同期フラグまで消して push 漏れを起こすため）。best-effort、失敗は warn のみ。
      dbGet('files', fileId)
        .then((s) =>
          s && s.name === safeName ? dbPut('files', { ...s, name: original.name }) : undefined,
        )
        .catch(console.warn);
      return { ok: false, reason: '名前の保存に失敗しました' };
    }
  }, [setFilesRaw, triggerSync]);

  const deleteFolder = (id, strategy = 'moveToParent') => {
    const folder = folders.find((f) => f.id === id);
    const targetParentId = folder?.parentId ?? null;
    // 削除に伴う folderMeta / orphan workSettings の掃除は applyStructure.js の
    // cleanupOrphanedFolderMeta を再利用する（#394 C-1 round2 S3: remote 由来削除
    // 〔applyStructureFromSync〕と同じグルーを共有し重複させない。#390）。
    const cleanupIo = {
      getFolderMetaMap: () => useFileMetadataStore.getState().folderMetaMap,
      collectOrphanedWorkIds,
      deleteWorkSettings: metadataActions.deleteWorkSettings,
      deleteFolderMeta: metadataActions.deleteFolderMeta,
    };

    if (strategy === 'deleteAll') {
      const allFolderIds = getDescendantFolderIds(id, folders);
      const affectedFiles = files.filter((f) => allFolderIds.has(f.parentId));
      const deletedIds = new Set(affectedFiles.map((f) => f.id));
      if (deletedIds.has(fid)) {
        const remaining = files.find((f) => !deletedIds.has(f.id));
        if (remaining) setFidRaw(remaining.id);
        else newFile();
      }
      setFilesRaw((p) => p.filter((f) => !deletedIds.has(f.id)));
      affectedFiles.forEach((f) => {
        // 保留中の debounce flush を止める。残すと削除後にタイマーが発火して IDB へ
        // 再書き込みし、ファイルが復活する（deleteFile と同じ後始末）。
        clearTimeout(idbFlushTimers.current[f.id]);
        delete idbFlushTimers.current[f.id];
        delete idbPendingContent.current[f.id];
        dbDelete('files', f.id).catch(console.warn);
        metadataActions.deleteFileMetadata(f.id);
        ensuredFileIdsRef.current.delete(f.id);
        noteRemoved(f.id);
      });
      setFoldersRaw((p) => p.filter((f) => !allFolderIds.has(f.id)));
      for (const folderId of allFolderIds) {
        dbDelete('folders', folderId).catch(console.warn);
      }
      cleanupOrphanedFolderMeta(allFolderIds, cleanupIo).catch(console.warn);
    } else {
      // moveToParent: promote only direct children; nested subfolders keep their contents intact
      const directFiles = files.filter((f) => f.parentId === id);
      const directSubfolders = folders.filter((f) => f.parentId === id);
      setFilesRaw((p) =>
        p.map((f) => (f.parentId === id ? { ...f, parentId: targetParentId } : f)),
      );
      directFiles.forEach((f) =>
        dbPut('files', { ...f, parentId: targetParentId }).catch(console.warn),
      );
      setFoldersRaw((p) =>
        p
          .filter((f) => f.id !== id)
          .map((f) => (f.parentId === id ? { ...f, parentId: targetParentId } : f)),
      );
      directSubfolders.forEach((f) =>
        dbPut('folders', { ...f, parentId: targetParentId }).catch(console.warn),
      );
      dbDelete('folders', id).catch(console.warn);
      cleanupOrphanedFolderMeta(new Set([id]), cleanupIo).catch(console.warn);
    }
  };

  const moveFile = (fileId, newParentId) => {
    const f = files.find((f) => f.id === fileId);
    if (!f) return;
    setFilesRaw((p) => p.map((x) => (x.id === fileId ? { ...x, parentId: newParentId } : x)));
    dbPut('files', { ...f, parentId: newParentId }).catch(console.warn);
  };

  const deleteFile = (id) => {
    clearTimeout(idbFlushTimers.current[id]);
    delete idbFlushTimers.current[id];
    delete idbPendingContent.current[id];
    if (files.length <= 1) return;
    setFilesRaw((p) => p.filter((f) => f.id !== id));
    dbDelete('files', id).catch(console.warn);
    metadataActions.deleteFileMetadata(id);
    ensuredFileIdsRef.current.delete(id);
    noteRemoved(id);
    if (secondaryFid === id) closeSplit();
    if (fid === id) {
      const next = files.find((f) => f.id !== id)?.id || files[0].id;
      setFidRaw(next);
      if (next === secondaryFid) closeSplit();
    }
  };

  const switchMode = (m) => {
    uiActions.clearEditorSelectionText();
    if (m === 'diff' && diffBase === '') setDiffBase(primaryFile?.content || '');
    uiActions.setMode(m);
  };

  // ── Conflict resolution ──────────────────────────────────────────────────

  const resolveConflictLocal = useCallback(async () => {
    if (!conflictData) return;
    const { local } = conflictData;
    const updated = { ...local, updatedAt: Date.now(), isDirty: true };
    // 採用書き込みの前に保留中の debounce フラッシュを破棄する（switchBranch/deleteFile と同型）。
    // 残すと採用後にタイマーが発火し、旧 local 本文で saveFileRecord→dbPut が走って採用内容を
    // clobber し、削除済みの saveStatus エントリを再生成する。
    clearTimeout(idbFlushTimers.current[updated.id]);
    delete idbFlushTimers.current[updated.id];
    delete idbPendingContent.current[updated.id];
    setFilesRaw((prev) => {
      const next = prev.map((f) => (f.id === updated.id ? { ...f, ...updated } : f));
      filesRef.current = next;
      return next;
    });
    // content 置換後の未保存状態掃除は永続成功後に行う（dbPut 失敗時に clean を先取りして
    // サイレント欠落＋誤「保存済み」表示になるのを防ぐ）。永続待ちの窓で入った新編集は
    // deferReset の世代ガードで残す（oversize の取りこぼし防止）。
    const commitReset = deferReset(updated.id);
    dbPut('files', updated).then(commitReset).catch(console.warn);
    if (syncBranchRef.current) {
      const synced = await resolveConflictKeepLocal(updated, syncBranchRef.current).catch(() => null);
      if (synced) {
        setFilesRaw((prev) => {
          const next = prev.map((f) => (f.id === synced.id ? { ...f, ...synced } : f));
          filesRef.current = next;
          return next;
        });
        dbPut('files', synced).catch(console.warn);
        queueMicrotask(() => triggerSync());
      }
    }
    setConflictData(null);
    uiActions.setMode('write');
  }, [conflictData, setFilesRaw, triggerSync]);

  const resolveConflictRemote = useCallback(() => {
    if (!conflictData) return;
    const { remote } = conflictData;
    // deny remote は sync.js で隔離済みのため通常ここへは来ないが、belt-and-suspenders で採用を拒否する（#291）。
    if (isQuarantined(remote)) {
      uiActions.addToast('リモート版は隔離対象のため採用できません', 6000);
      setConflictData(null);
      uiActions.setMode('write');
      return;
    }
    const updated = {
      ...remote,
      updatedAt: new Date(remote.updatedAt).getTime(),
      isDirty: false,
    };
    // SP1: remote（parseRemoteFile 出力）は parentId を持たない（契約1）。この record を
    // そのまま dbPut すると全置換になり、既存の parentId が IDB から消える。round5 (F1):
    // conflictData.local は conflict 検出時点のスナップショットで、モーダル表示中に
    // ユーザーが file を移動していると古い parentId へ差し戻してしまう。解決時点の live
    // レコードを読んで渡す。
    applyLocalParentId(updated, useFilesStore.getState().files.find((f) => f.id === remote.id));
    // 保留中の debounce フラッシュを破棄（採用 remote を旧 local で clobber するのを防ぐ）。
    clearTimeout(idbFlushTimers.current[updated.id]);
    delete idbFlushTimers.current[updated.id];
    delete idbPendingContent.current[updated.id];
    setFilesRaw((prev) => {
      const next = prev.map((f) => (f.id === updated.id ? { ...f, ...updated } : f));
      filesRef.current = next;
      return next;
    });
    // 未保存状態掃除は永続成功後（dbPut 失敗時の誤「保存済み」表示を防ぐ）。世代ガードで
    // 永続待ちの窓に入った新編集（oversize 等）を残す。
    const commitReset = deferReset(updated.id);
    dbPut('files', updated).then(commitReset).catch(console.warn);
    // remote を採用したので syncState の adoptedHash も更新する（#610。sync.js の markAdopted
    // に寄せる — この端末はもう remote と一致しているため次回同期を conflict にしない）。
    markAdopted(updated);
    setConflictData(null);
    uiActions.setMode('write');
    queueMicrotask(() => triggerSync());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflictData, triggerSync]);

  const resolveConflictBoth = useCallback(() => {
    if (!conflictData) return;
    const { local, remote } = conflictData;
    // deny remote は隔離済み（#291）。belt-and-suspenders で採用を拒否する。
    if (isQuarantined(remote)) {
      uiActions.addToast('リモート版は隔離対象のため採用できません', 6000);
      setConflictData(null);
      uiActions.setMode('write');
      return;
    }
    const now = Date.now();
    const date = new Intl.DateTimeFormat('sv-SE').format(now);
    const conflictFile = {
      id: now + '',
      name: local.name.replace(/\.md$/, '') + ` (競合 ${date}).md`,
      content: local.content,
      github: null,
      createdAt: now,
      updatedAt: now,
      isDirty: false,
    };
    const updated = {
      ...remote,
      updatedAt: new Date(remote.updatedAt).getTime(),
      isDirty: false,
    };
    // SP1: remote（parseRemoteFile 出力）は parentId を持たない（契約1）。この record を
    // そのまま dbPut すると全置換になり、既存の parentId が IDB から消える。round5 (F1):
    // conflictData.local は conflict 検出時点のスナップショットで、モーダル表示中に
    // ユーザーが file を移動していると古い parentId へ差し戻してしまう。解決時点の live
    // レコードを読んで渡す（conflictFile の name/content は診断表示と一致させるため
    // conflictData.local のままでよい — parentId のみ live を使う）。
    applyLocalParentId(updated, useFilesStore.getState().files.find((f) => f.id === remote.id));
    // 原本 id の保留 debounce フラッシュを破棄（採用 remote を旧 local で clobber するのを防ぐ）。
    clearTimeout(idbFlushTimers.current[updated.id]);
    delete idbFlushTimers.current[updated.id];
    delete idbPendingContent.current[updated.id];
    setFilesRaw((prev) => {
      const next = [
        ...prev.map((f) => (f.id === updated.id ? { ...f, ...updated } : f)),
        conflictFile,
      ];
      filesRef.current = next;
      return next;
    });
    // 原本 id の未保存状態掃除は永続成功後・世代ガード付き（conflictFile は新規 id で未登録）。
    const commitReset = deferReset(updated.id);
    dbPut('files', updated).then(commitReset).catch(console.warn);
    dbPut('files', conflictFile).catch(console.warn);
    // 原本 id は remote を採用したので syncState の adoptedHash も更新する（#610）。
    // conflictFile は新規 id（remote に entry が無い）なので push 対象のまま素通しでよい。
    markAdopted(updated);
    setConflictData(null);
    uiActions.setMode('write');
    queueMicrotask(() => triggerSync());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflictData, triggerSync]);

  // ── GitHub operations ────────────────────────────────────────────────────

  const loginWithGithub = () => {
    window.location.href = '/auth/github/start';
  };

  const disconnectGithub = async () => {
    await workerFetch('/auth/logout', { method: 'POST' }).catch(console.warn);
    clearAuthorizedRepos();
    clearCSRFToken();
    setGhUser(null);
    // 明示ログアウト後にハンドラが残ると、その後の 401（例: リネーム → triggerSync →
    // /sync/manifest 401）でログインモーダルが本文を覆う。未接続状態に戻すため解除する。
    setUnauthorizedHandler(null);
  };

  const openGithubModal = (view = 'repos', target = 'primary') => {
    uiActions.setGhView(view);
    setGhOpenTarget(target);
    uiActions.setShowGithub(true);
  };

  const openFileFromGithub = ({ name, content, owner, repo, path, sha, branch, security = null }) => {
    if (typeof content === 'string' && content.length > FILE_CONTENT_MAX) {
      console.warn('openFileFromGithub: ファイルサイズが上限を超えています', content.length);
      return false;
    }
    const safeName = sanitizeFileName(name, NAME_MAX) || 'ファイル.md';
    const f = createFileObject(safeName, content, { owner, repo, path, sha, branch }, security);
    setFilesRaw((p) => [...p, f]);
    setFid(f.id);
    setActivePaneRaw('primary');
    dbPut('files', f).catch(console.warn);
    metadataActions.ensureFileMetadata(f.id, { title: safeName });
  };

  const openSplitFileFromGithub = ({
    name,
    content,
    owner,
    repo,
    path,
    sha,
    branch,
    security = null,
  }) => {
    if (typeof content === 'string' && content.length > FILE_CONTENT_MAX) {
      console.warn('openSplitFileFromGithub: ファイルサイズが上限を超えています', content.length);
      return false;
    }
    const safeName = sanitizeFileName(name, NAME_MAX) || 'ファイル.md';
    const f = createFileObject(safeName, content, { owner, repo, path, sha, branch }, security);
    setFilesRaw((p) => [...p, f]);
    setSecondaryFidRaw(f.id);
    setSplitOpenRaw(true);
    setActivePaneRaw('secondary');
    dbPut('files', f).catch(console.warn);
    metadataActions.ensureFileMetadata(f.id, { title: safeName });
  };

  const buildCommitMessage = (file) => {
    const rawTpl = settings?.github?.commitMessage || '原稿を更新';
    const tpl = validateCommitMessage(rawTpl) === null ? rawTpl : '原稿を更新';
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const expanded = tpl
      .replace(/\{filename\}/g, String(file.name ?? ''))
      .replace(/\{date\}/g, date)
      .replace(/\{time\}/g, time);
    return validateCommitMessage(expanded) === null && expanded.trim().length > 0
      ? expanded
      : '原稿を更新';
  };

  const commitCurrentFile = async (file = currentFile, message, overrideSha) => {
    const f = file;
    if (!f?.github) throw new Error('このファイルは GitHub に連携されていません。');
    const { github } = f;
    // 復元セッションでは authorizedRepos が空の場合がある。操作前に冪等に再認可する（#283）。
    await authorizeRepo(github.owner, github.repo);
    const resolvedMessage = message ?? buildCommitMessage(f);
    const sha = overrideSha !== undefined ? overrideSha : github.sha;
    const result = await commitFile(
      github.owner,
      github.repo,
      github.path,
      resolvedMessage,
      f.content,
      sha,
      github.branch,
    );
    const newSha = result.content.sha;
    // github.sha に加えて isDirty: false も store/IDB 双方へ書く（#610 round2 品質）。
    // sync は canonical hash ベースで isDirty を読まないため無害だが、switchBranch の
    // 未保存警告等、他の isDirty 消費者にとっての意味（GitHub へ commit 済み）を保つ。
    setFilesRaw((p) =>
      p.map((x) =>
        x.id === f.id ? { ...x, github: { ...x.github, sha: newSha }, isDirty: false } : x,
      ),
    );
    dbPut('files', {
      ...f,
      github: { ...github, sha: newSha },
      isDirty: false,
    }).catch(console.warn);
    return result.commit.html_url;
  };

  const openPrePushModal = () => {
    const f = currentFile;
    if (!f?.github) { openGithubModal('commit'); return; }
    const message = buildCommitMessage(f);
    const setPrePushModal = uiActions.setPrePushModal;
    setPrePushModal({
      file: f,
      commitMessage: message,
      onConfirm: (overrideSha) => commitCurrentFile(f, message, overrideSha),
      onCancel: () => setPrePushModal(null),
    });
  };

  const switchBranch = async (newBranch) => {
    const f = currentFile;
    if (!f?.github) throw new Error('このファイルは GitHub に連携されていません。');
    if (
      f.isDirty &&
      !window.confirm(
        `未保存の変更があります。ブランチ「${newBranch}」に切り替えると変更が失われます。続けますか？`,
      )
    )
      return false;
    const { owner, repo, path } = f.github;
    await authorizeRepo(owner, repo);
    const { content, sha } = await getFileContent(owner, repo, path, newBranch);
    // ブランチ切替も remote pull 経路。検証して security を付与する（#285）
    const validation = validatePulledContent(content, f.name);
    const updated = {
      ...f,
      content,
      github: { ...f.github, branch: newBranch, sha },
      isDirty: false,
      updatedAt: Date.now(),
      security: toSecurityRecord(validation),
    };
    clearTimeout(idbFlushTimers.current[f.id]);
    delete idbFlushTimers.current[f.id];
    delete idbPendingContent.current[f.id];
    const quarantined = isQuarantined(updated);
    // 本文は deny / 非 deny を問わず IDB へ書く（監査・将来の復元 UI 用）。非隔離採用の未保存状態
    // 掃除は永続成功後・世代ガード付きで行う（dbPut 失敗時の誤「保存済み」表示と、永続待ちの窓に
    // 入った新編集の取りこぼしを防ぐ）。隔離側は active から外れるため書込成否に依らず noteRemoved。
    const commitReset = deferReset(f.id);
    dbPut('files', updated)
      .then(() => {
        if (!quarantined) commitReset();
      })
      .catch(console.warn);
    if (quarantined) {
      // ブランチ切替も remote pull 経路。deny コンテンツは active 編集リストへ載せず id だけ
      // 隔離集合へ退避する（#291、onPullFile の deny 分岐と同型）。
      useFilesStore.getState().quarantineFile(f.id);
      noteRemoved(f.id); // 隔離で active から外れたエントリの状態を掃除する
      const nextFiles = useFilesStore.getState().files;
      filesRef.current = nextFiles;
      // await 後のクロージャ陳腐化対策: getState() で最新値を取得（deleteFile は sync のため不要）。
      const currentSecondaryFid = useUIStore.getState().secondaryFid;
      // secondary pane が隔離対象を参照している場合は split を閉じる（deleteFile と同型）。
      if (f.id === currentSecondaryFid) closeSplit();
      // 切替対象が選択中なら別の active file へ選択を移す（隔離で active 外を指し続けるのを防ぐ）。
      // active が空になる場合は新規ファイルを作成（deleteFolder と同型、null fid はクラッシュリスク）。
      if (f.id === fidRef.current) {
        if (nextFiles.length > 0) {
          const nextId = nextFiles[0].id;
          setFidRaw(nextId);
          if (nextId === currentSecondaryFid) closeSplit();
        } else {
          newFile();
        }
      }
    } else {
      setFilesRaw((p) => p.map((x) => (x.id === f.id ? updated : x)));
      // 非隔離採用の noteReset は上の dbPut.then（永続成功後）で実行する。
    }
    if (validation.decision !== 'allow') {
      const detail =
        validation.decision === 'deny' ? pullDenyReason(validation) : pullWarnMessage(validation);
      if (detail) uiActions.addToast(detail, 6000);
    }
    return true;
  };

  const listBranchesForCurrent = async () => {
    if (!currentFile?.github) throw new Error('このファイルは GitHub に連携されていません。');
    return listBranches(currentFile.github.owner, currentFile.github.repo);
  };

  const listPRsForCurrent = async (state = 'open') => {
    if (!currentFile?.github) throw new Error('このファイルは GitHub に連携されていません。');
    return listPRs(currentFile.github.owner, currentFile.github.repo, state);
  };

  const createPRFromCurrent = async ({ title, body, head, base }) => {
    if (!currentFile?.github) throw new Error('このファイルは GitHub に連携されていません。');
    await authorizeRepo(currentFile.github.owner, currentFile.github.repo);
    return createPR(currentFile.github.owner, currentFile.github.repo, { title, body, head, base });
  };

  const mergePRForCurrent = async (pullNumber) => {
    if (!currentFile?.github) throw new Error('このファイルは GitHub に連携されていません。');
    await authorizeRepo(currentFile.github.owner, currentFile.github.repo);
    return mergePR(currentFile.github.owner, currentFile.github.repo, pullNumber);
  };

  const updateFileMetadata = useCallback((fileId, updates) => {
    metadataActions.updateFileMetadata(fileId, updates);
  }, []);

  const setFiles = useCallback((fnOrVal) => {
    setFilesRaw((prev) => {
      const next = typeof fnOrVal === 'function' ? fnOrVal(prev) : fnOrVal;
      for (const f of next) dbPut('files', f).catch(console.warn);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppCtx.Provider
      value={{
        files,
        setFiles,
        currentFile,
        fid,
        setFid,
        isLoaded,
        primaryFile,
        secondaryFile,
        activeFile,
        secondaryFid,
        splitOpen,
        activePane,
        setActivePane,
        openSplitFile,
        closeSplit,
        swapPaneFiles,
        settings,
        setSettings,
        switchMode,
        editorRef,
        annosRef,
        saveAnnosRef,
        setSharedAnnosRef,
        diffBase,
        setDiffBase,
        updateContent,
        updatePrimaryContent,
        updateFileContent,
        updateFileSecurity,
        updatePrimarySecurity,
        flushFileContentNow,
        newFile,
        deleteFile,
        updateFileMetadata,
        folders,
        createFolder,
        createWork,
        renameFile,
        deleteFolder,
        moveFile,
        ghUser,
        ghOpenTarget,
        loginWithGithub,
        disconnectGithub,
        openGithubModal,
        openPrePushModal,
        openFileFromGithub,
        openSplitFileFromGithub,
        commitCurrentFile,
        conflictData,
        setConflictData,
        resolveConflictLocal,
        resolveConflictRemote,
        resolveConflictBoth,
        triggerSync,
        DEFAULT_SETTINGS,
        switchBranch,
        listBranchesForCurrent,
        listPRsForCurrent,
        createPRFromCurrent,
        mergePRForCurrent,
      }}
    >
      {children}
    </AppCtx.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useApp() {
  return useContext(AppCtx);
}
export { DEFAULT_SETTINGS };

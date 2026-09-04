import { useState, useEffect, useRef } from 'react';
import { useApp, DEFAULT_SETTINGS } from './context/AppContext';
import { useUIStore } from './stores/uiStore';
import HeaderBox from './components/header/HeaderBox';
import FooterBox from './components/footer/FooterBox';
import SidebarBox from './components/sidebar/SidebarBox';
import EditorBox from './components/editor/EditorBox';
import SettingsModal from './components/modals/SettingsModal';
import ExportModal from './components/modals/ExportModal';
import GithubModal from './components/modals/GithubModal';
import DeleteFolderModal from './components/modals/DeleteFolderModal';
import NameInputModalHost from './components/modals/NameInputModalHost';
import PasteConfirmModal from './components/modals/PasteConfirmModal';
import ClearDataModal from './components/modals/ClearDataModal';
import RestoreDataModal from './components/modals/RestoreDataModal';
import PrePushModal from './components/modals/PrePushModal';
import UIPersistence from './components/system/UIPersistence';
import ToastContainer from './components/common/Toast';
import { appEvents, APP_EVENTS } from './lib/appEvents';
import {
  ensureNotificationPermission,
  checkNotificationPermission,
  createLocalPomodoroNotifier,
  createNotifier,
} from './lib/notify';
import { normalizeSyncNotification, buildSyncCompletePayload } from './lib/syncNotification';
import {
  normalizeDeadlineNotification,
  isThresholdReached,
  buildDeadlinePayload,
} from './lib/deadlineNotification';

const FSTACK = {
  'noto-serif': "'Noto Serif JP',serif",
  'noto-sans': "'Noto Sans JP',sans-serif",
  monospace: "'Courier New',monospace",
};

function EditorLoadingSkeleton() {
  return (
    <div className="loading-overlay app-editor-loading" role="status" aria-live="polite">
      <span className="sr-only">ファイルを読み込んでいます</span>
      <div className="loading-overlay-inner" aria-hidden="true">
        <div className="skeleton-block" style={{ width: '55%', height: 20, marginBottom: 24 }} />
        <div className="skeleton-block" style={{ width: '92%' }} />
        <div className="skeleton-block" style={{ width: '85%' }} />
        <div className="skeleton-block" style={{ width: '88%' }} />
        <div className="skeleton-block" style={{ width: '60%', marginBottom: 24 }} />
        <div className="skeleton-block" style={{ width: '78%' }} />
        <div className="skeleton-block" style={{ width: '90%' }} />
        <div className="skeleton-block" style={{ width: '72%' }} />
      </div>
    </div>
  );
}

export default function App() {
  const {
    settings,
    primaryFile,
    secondaryFile,
    splitOpen,
    activePane,
    setActivePane,
    updatePrimaryContent,
    updatePrimarySecurity,
    flushFileContentNow,
    editorRef,
    closeSplit,
    swapPaneFiles,
    diffBase,
    fid,
    isLoaded,
    annosRef,
    saveAnnosRef,
    setSharedAnnosRef,
  } = useApp();
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const showSettings = useUIStore((s) => s.showSettings);
  const showGithub = useUIStore((s) => s.showGithub);
  const showExport = useUIStore((s) => s.showExport);
  const mode = useUIStore((s) => s.mode);
  const splitSwapped = useUIStore((s) => s.splitSwapped);
  const sidebarSide = useUIStore((s) => s.sidebarSide);
  const showLineNumbers = useUIStore((s) => s.showLineNumbers);
  const colors = useUIStore((s) => s.colors);

  const s = settings || DEFAULT_SETTINGS;
  const ws = s.write || DEFAULT_SETTINGS.write;
  const ps = s.preview || DEFAULT_SETTINGS.preview;

  const MOBILE_BP = 768;
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BP);
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < MOBILE_BP);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  // サイドバーが開いた瞬間のフォーカス要素を記録し、閉じたとき（トグル / × / モバイル backdrop
  // いずれの経路でも）その要素へ戻す。ユーザーが既に別の場所へ意図的にフォーカスを移していた場合は奪わない
  // （閉じた時点で focus が body に落ちている、または inert 化するサイドバー内に残っている場合のみ復帰させる）。
  const sidebarRef = useRef(null);
  const sidebarPreviousFocusRef = useRef(null);
  useEffect(() => {
    if (!sidebarOpen) return;
    sidebarPreviousFocusRef.current = document.activeElement;
    const sidebarEl = sidebarRef.current;
    return () => {
      const opener = sidebarPreviousFocusRef.current;
      if (!opener || !opener.isConnected) return;
      if (sidebarEl?.contains(opener)) return;
      const activeEl = document.activeElement;
      const focusLost = activeEl === document.body || sidebarEl?.contains(activeEl);
      if (!focusLost) return;
      if (typeof opener.focus === 'function') opener.focus();
    };
  }, [sidebarOpen]);

  const addToast = useUIStore((st) => st.addToast);
  const setSettings = useUIStore((st) => st.setSettings);
  const notifSettings = s.notifications || {};

  const syncEnabled = notifSettings.sync?.enabled ?? false;
  const syncDelivery = normalizeSyncNotification(notifSettings.sync).delivery;

  // 同期完了通知
  useEffect(() => {
    if (!syncEnabled) return;
    const notify = createNotifier({
      localSender: createLocalPomodoroNotifier(),
      toastSender: (payload) => addToast(payload.message),
    });
    const handler = async () => {
      if (syncDelivery === 'browser') {
        const granted = await ensureNotificationPermission();
        if (!granted) return;
      }
      await notify('sync', 'complete', buildSyncCompletePayload(syncDelivery));
    };
    appEvents.addEventListener(APP_EVENTS.SYNC_COMPLETE, handler);
    return () => appEvents.removeEventListener(APP_EVENTS.SYNC_COMPLETE, handler);
  }, [syncEnabled, syncDelivery, addToast]);

  const dlEnabled = notifSettings.deadline?.enabled ?? false;
  const dlDeadlineAt = notifSettings.deadline?.deadlineAt ?? null;
  const dlCheckIntervalMin = notifSettings.deadline?.checkIntervalMin ?? 1;
  const dlCfgNorm = normalizeDeadlineNotification(notifSettings.deadline);
  const dlDelivery = dlCfgNorm.delivery;
  const dlThresholdsStr = JSON.stringify(dlCfgNorm.thresholds);

  // 締め切り通知
  useEffect(() => {
    if (!dlEnabled || !dlDeadlineAt) return;

    const dlThresholds = JSON.parse(dlThresholdsStr);

    const notify = createNotifier({
      localSender: createLocalPomodoroNotifier(),
      toastSender: (p) => addToast(p.body || p.title),
    });
    const check = async () => {
      const now = Date.now();
      const current = normalizeDeadlineNotification(
        useUIStore.getState().settings?.notifications?.deadline,
      ).notifiedThresholds;
      const pending = dlThresholds.filter(
        (t) => !current.includes(t) && isThresholdReached(dlDeadlineAt, t, now),
      );
      if (!pending.length) return;

      if (dlDelivery === 'browser') {
        if (!checkNotificationPermission()) return;
      }
      for (const t of pending) {
        const payload = buildDeadlinePayload(dlDeadlineAt, t, dlDelivery);
        await notify('deadline', 'threshold', payload);
      }

      setSettings((prev) => {
        const currentInSetter = normalizeDeadlineNotification(
          prev.notifications?.deadline,
        ).notifiedThresholds;
        const stillPending = pending.filter((t) => !currentInSetter.includes(t));
        if (!stillPending.length) return prev;
        return {
          ...prev,
          notifications: {
            ...prev.notifications,
            deadline: {
              ...prev.notifications?.deadline,
              notifiedThresholds: [...currentInSetter, ...stillPending],
            },
          },
        };
      });
    };

    check();
    const id = setInterval(check, dlCheckIntervalMin * 60 * 1000);
    return () => clearInterval(id);
  }, [
    dlEnabled,
    dlDeadlineAt,
    dlCheckIntervalMin,
    dlDelivery,
    dlThresholdsStr,
    addToast,
    setSettings,
  ]);
  const css = {
    '--ef': FSTACK[ws.font] || FSTACK['noto-serif'],
    '--es': ws.fontSize + 'px',
    '--el': ws.lineHeight,
    '--elt': ws.letterSpacing / 100 + 'em',
    '--ew': typeof ws.width === 'number' ? ws.width + 'px' : ws.width,
    '--pef': FSTACK[ps.font] || FSTACK['noto-serif'],
    '--pes': ps.fontSize + 'px',
    '--pel': ps.lineHeight,
    '--pelt': ps.letterSpacing / 100 + 'em',
    ...(colors?.bodyText ? { '--editor-tx': colors.bodyText } : {}),
    ...(colors?.comment ? { '--hl-comment': colors.comment } : {}),
    ...(colors?.memo ? { '--hl-memo': colors.memo } : {}),
  };

  const isRight = sidebarSide === 'right';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', ...css }}>
      {!isLoaded && (
        <div className="app-progress-bar" role="status" aria-live="polite">
          <span className="sr-only">アプリを読み込んでいます</span>
        </div>
      )}
      <HeaderBox />
      <div className="app-body" style={{ flexDirection: isRight ? 'row-reverse' : 'row' }}>
        {sidebarOpen && isMobile && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 140,
              background: 'rgba(0,0,0,.45)',
              backdropFilter: 'blur(2px)',
            }}
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <div
          id="app-sidebar"
          ref={sidebarRef}
          inert={!sidebarOpen}
          className={`sidebar${sidebarOpen ? '' : ' closed'}${isRight ? ' sb-right' : ''}`}
          style={
            isMobile
              ? {
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  [isRight ? 'right' : 'left']: 0,
                  zIndex: 150,
                }
              : {}
          }
        >
          <div
            style={{
              width: 'var(--sbw)',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <SidebarBox />
          </div>
        </div>

        <main
          className={`main-area${splitOpen ? ' split-main' : ''}${!splitOpen && mode === 'diff' ? ' diff-active' : ''}${!splitOpen && mode === 'structure' ? ' structure-active' : ''}`}
        >
          {splitOpen ? (
            <div className={`split-layout${splitSwapped ? ' swapped' : ''}`}>
              <section
                className={`split-pane${activePane === 'primary' ? ' active' : ''}`}
                onMouseDown={() => setActivePane('primary')}
              >
                <div
                  className="pane-head"
                  tabIndex={activePane !== 'primary' ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setActivePane('primary');
                    }
                  }}
                >
                  <span className="pane-role">主</span>
                  <span className="pane-file">{primaryFile?.name || '—'}</span>
                </div>
                <div className="editor-container split-editor-container">
                  {!isLoaded ? (
                    <EditorLoadingSkeleton />
                  ) : (
                    <EditorBox
                      content={primaryFile?.content || ''}
                      onChange={updatePrimaryContent}
                      onUnloadFlush={flushFileContentNow}
                      mode={mode}
                      editorRef={editorRef}
                      diffBase={diffBase}
                      showLineNumbers={showLineNumbers}
                      fileId={fid}
                      pane="primary"
                      isActive={activePane === 'primary'}
                      onFocusPane={setActivePane}
                      annosRef={annosRef}
                      saveAnnosRef={saveAnnosRef}
                      setSharedAnnosRef={setSharedAnnosRef}
                      security={primaryFile?.security}
                      onSecurityChange={updatePrimarySecurity}
                    />
                  )}
                </div>
              </section>

              <section
                className={`split-pane readonly${activePane === 'secondary' ? ' active' : ''}`}
                onMouseDown={() => setActivePane('secondary')}
              >
                <div className="pane-head">
                  <span className="pane-role">参照</span>
                  <span className="pane-file">{secondaryFile?.name || '—'}</span>
                  <button type="button" className="pane-action" onClick={swapPaneFiles}>
                    主にする
                  </button>
                  <button type="button" className="pane-action" onClick={closeSplit}>
                    閉じる
                  </button>
                </div>
                <div className="editor-container split-editor-container">
                  {!isLoaded ? (
                    <EditorLoadingSkeleton />
                  ) : (
                    <EditorBox
                      content={secondaryFile?.content || ''}
                      onChange={() => {}}
                      mode="write"
                      editorRef={editorRef}
                      diffBase=""
                      showLineNumbers={showLineNumbers}
                      fileId={secondaryFile?.id || 'secondary'}
                      readOnly
                      pane="secondary"
                      isActive={activePane === 'secondary'}
                      onFocusPane={setActivePane}
                      annosRef={annosRef}
                      saveAnnosRef={saveAnnosRef}
                      setSharedAnnosRef={setSharedAnnosRef}
                      security={secondaryFile?.security}
                    />
                  )}
                </div>
              </section>
            </div>
          ) : (
            <div className="editor-container">
              {!isLoaded ? (
                <EditorLoadingSkeleton />
              ) : (
                <EditorBox
                  content={primaryFile?.content || ''}
                  onChange={updatePrimaryContent}
                  onUnloadFlush={flushFileContentNow}
                  mode={mode}
                  editorRef={editorRef}
                  diffBase={diffBase}
                  showLineNumbers={showLineNumbers}
                  fileId={fid}
                  pane="primary"
                  isActive
                  onFocusPane={setActivePane}
                  annosRef={annosRef}
                  saveAnnosRef={saveAnnosRef}
                  setSharedAnnosRef={setSharedAnnosRef}
                  security={primaryFile?.security}
                  onSecurityChange={updatePrimarySecurity}
                />
              )}
            </div>
          )}
        </main>
      </div>

      <FooterBox />
      {showSettings && <SettingsModal />}
      {showGithub && <GithubModal />}
      {showExport && <ExportModal />}
      <DeleteFolderModal />
      <NameInputModalHost />
      <PasteConfirmModal />
      <ClearDataModal />
      <RestoreDataModal />
      <PrePushModal />
      <UIPersistence />
      <ToastContainer />
    </div>
  );
}

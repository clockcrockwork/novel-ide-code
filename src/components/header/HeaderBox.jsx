import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { useUIStore } from '../../stores/uiStore';
import { useFileMetadataStore } from '../../stores/fileMetadataStore';
import { GhIcon, MenuIcon, FileIcon, GearIcon, ExportIcon, SyncIcon } from '../Icons';
import { useSyncStatus } from '../../hooks/useSyncStatus';
import { useSyncPending } from '../../hooks/useSyncPending';
import { useSaveStatus } from '../../hooks/useSaveStatus';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import SyncBadge from './SyncBadge';
import SaveBadge from './SaveBadge';
import FileDropdown from './FileDropdown';
import { findFileAncestorIds } from '../../lib/fileTree';
import { buildWorkLabelMap } from '../../lib/metadata/normalizeFileMetadata';
import { MODES, MODE_LABELS } from '../../constants/modes';

export default function HeaderBox() {
  const {
    currentFile,
    folders,
    switchMode,
    ghUser,
    openGithubModal,
    openPrePushModal,
    triggerSync,
    conflictData,
    setFid,
  } = useApp();
  const folderMetaMap = useFileMetadataStore((s) => s.folderMetaMap);
  const workSettingsMap = useFileMetadataStore((s) => s.workSettingsMap);
  const workLabelMap = useMemo(
    () => buildWorkLabelMap(folderMetaMap, workSettingsMap),
    [folderMetaMap, workSettingsMap],
  );

  // 現在編集中のファイルが属する作品名。FileDropdown のバッジと同じ buildWorkLabelMap を正とし、
  // 祖先のうち直近の作品 folder を採用する（入れ子時にバッジと表示が食い違わないように）。
  let currentWorkLabel = null;
  if (currentFile?.parentId) {
    const ancestorIds = findFileAncestorIds(currentFile.parentId, folders);
    for (let i = ancestorIds.length - 1; i >= 0; i--) {
      const info = workLabelMap.get(ancestorIds[i]);
      if (info) {
        currentWorkLabel = info.label ?? '作品名不明';
        break;
      }
    }
  }
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const mode = useUIStore((s) => s.mode);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const setShowSettings = useUIStore((s) => s.setShowSettings);
  const setShowExport = useUIStore((s) => s.setShowExport);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const syncStatus = useSyncStatus();
  const saveStatus = useSaveStatus();
  const isOnline = useOnlineStatus();
  // 同期待ち判定は sync.js の resolveClassification と単一の導出関数（deriveSyncAction）を
  // 共有する useSyncPending が担う（#610。isDirty ではなく canonical hash ベース）。
  const hasPendingChanges = useSyncPending();

  const handleSave = useCallback(() => {
    openPrePushModal();
  }, [openPrePushModal]);

  useEffect(() => {
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  return (
    <header className="header">
      <button
        type="button"
        className="nb nb-i"
        onClick={() => setSidebarOpen((v) => !v)}
        title="サイドバー"
        aria-expanded={sidebarOpen}
        aria-controls="app-sidebar"
      >
        <MenuIcon />
      </button>

      <div className="hdr-center" ref={ref}>
        <button type="button" className="fpbtn" onClick={() => setOpen((v) => !v)}>
          <FileIcon s={11} />
          <span className="fpname">
            {currentWorkLabel ? `${currentWorkLabel} › ` : ''}
            {currentFile?.name || '—'}
          </span>
          <svg
            width="7"
            height="4"
            viewBox="0 0 7 4"
            fill="currentColor"
            style={{ opacity: 0.4, flexShrink: 0 }}
          >
            <path d="M0 0l3.5 4L7 0z" />
          </svg>
        </button>
        {open && <FileDropdown onClose={() => setOpen(false)} />}
      </div>

      <div className="mgrp hide-m">
        {MODES.map((m) => (
          <button
            type="button"
            key={m}
            className={`mbtn${mode === m ? ' on' : ''}`}
            onClick={() => switchMode(m)}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      <div className="hdr-right">
        <button
          type="button"
          className="nb nb-i"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title="テーマ"
          style={{ fontSize: 13 }}
        >
          {theme === 'dark' ? '☀' : '🌙'}
        </button>
        {currentFile?.github && (
          <button type="button" className="nb nb-i" title="GitHubに保存" onClick={handleSave}>
            <GhIcon s={12} />↑
          </button>
        )}
        <SaveBadge status={saveStatus} />
        {ghUser && (
          <>
            <button
              type="button"
              className="nb nb-i"
              onClick={() => triggerSync({ fromUser: true })}
              disabled={syncStatus.isSyncing}
              aria-busy={syncStatus.isSyncing || undefined}
              title="今すぐ同期"
            >
              <SyncIcon />
            </button>
            <SyncBadge
              status={syncStatus}
              isOnline={isOnline}
              conflictData={conflictData}
              onConflictClick={() => {
                if (conflictData?.local?.id) setFid(conflictData.local.id);
                switchMode('diff');
              }}
              hasPendingChanges={hasPendingChanges}
            />
          </>
        )}
        <button
          type="button"
          className="nb nb-i"
          onClick={() => setShowExport(true)}
          title="エクスポート"
        >
          <ExportIcon />
        </button>
        <button
          type="button"
          className="nb nb-i"
          onClick={() => setShowSettings(true)}
          title="設定"
        >
          <GearIcon />
        </button>
        <button
          type="button"
          className="ghbtn hide-m"
          onClick={() => openGithubModal(ghUser ? 'repos' : 'auth')}
        >
          <GhIcon s={13} />
          {ghUser ? `@${ghUser.login}` : 'ログイン'}
        </button>
      </div>
    </header>
  );
}

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { FileIcon, GhIcon } from '../Icons';
import { useApp } from '../../context/AppContext';
import { useUIStore } from '../../stores/uiStore';
import { useFileMetadataStore } from '../../stores/fileMetadataStore';
import { buildWorkLabelMap } from '../../lib/metadata/normalizeFileMetadata';
import VirtualList from '../common/VirtualList';
import { flattenTree, findFileAncestorIds, countDescendantFiles } from '../../lib/fileTree';

function ChevronIcon({ expanded }) {
  return (
    <span className={`fdi-chevron${expanded ? ' open' : ''}`} aria-hidden="true">
      ›
    </span>
  );
}

function FolderRow({
  node,
  workInfo,
  onNewFile,
  onNewSubfolder,
  onDelete,
  isDragOver,
  onDragOver,
  onDragLeave,
  onDrop,
}) {
  const indent = node.depth * 14;
  return (
    <div
      data-nodeid={node.id}
      className={`fdi fdi--folder${isDragOver ? ' fdi--dragover' : ''}`}
      style={{ paddingLeft: 14 + indent }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {node.hasChildren ? (
        <ChevronIcon expanded={node.isExpanded} />
      ) : (
        <span style={{ width: 10, flexShrink: 0 }} />
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.name}
      </span>
      {workInfo && (
        <span
          title={workInfo.label ?? '作品名不明'}
          style={{
            fontSize: 10,
            color: 'var(--ac)',
            border: '1px solid var(--ac)',
            borderRadius: 4,
            padding: '0 4px',
            marginRight: 4,
            flexShrink: 0,
          }}
        >
          作品
        </span>
      )}
      <div className="fdi-actions">
        <button
          type="button"
          className="fdi-act-btn"
          title="ここにファイルを作成"
          onClick={(e) => {
            e.stopPropagation();
            onNewFile(node.id);
          }}
        >
          ＋
        </button>
        <button
          type="button"
          className="fdi-act-btn"
          title="サブフォルダを作成"
          onClick={(e) => {
            e.stopPropagation();
            onNewSubfolder(node.id);
          }}
        >
          📁
        </button>
        <button
          type="button"
          className="fdi-act-btn"
          title="削除"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(node);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function FileRow({
  node,
  fid,
  secondaryFid,
  splitOpen,
  filesCount,
  onSplitClick,
  onDelete,
  onMove,
  onRename,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}) {
  const indent = node.depth * 14;
  const isActive = node.id === fid || node.id === secondaryFid;
  return (
    <div
      className={`fdi${isActive ? ' active' : ''}`}
      style={{ padding: 0 }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Main name area: click handled by VirtualList onItemActivate (no onClick here) */}
      <span
        draggable
        onDragStart={(e) => onDragStart(e, node.id, node.parentId)}
        onDragEnd={onDragEnd}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'grab',
          padding: `8px 14px 8px ${14 + indent}px`,
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        <FileIcon s={11} />
        <span
          style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {node.name}
        </span>
      </span>
      <button
        type="button"
        title="名前を変更"
        aria-label={`「${node.name}」の名前を変更`}
        style={{
          fontSize: 10,
          color: 'var(--tx3)',
          marginRight: 4,
          padding: '1px 5px',
          border: '1px solid var(--bd)',
          borderRadius: 4,
          background: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          flexShrink: 0,
        }}
        onClick={(e) => {
          e.stopPropagation();
          onRename(node.id, node.name);
        }}
      >
        ✎
      </button>
      <button
        type="button"
        title="フォルダに移動"
        style={{
          fontSize: 10,
          color: 'var(--tx3)',
          marginRight: 4,
          padding: '1px 5px',
          border: '1px solid var(--bd)',
          borderRadius: 4,
          background: 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          flexShrink: 0,
        }}
        onClick={(e) => {
          e.stopPropagation();
          onMove(node.id);
        }}
      >
        移動
      </button>
      {node.id !== fid && (
        <button
          type="button"
          title="分割で開く"
          style={{
            fontSize: 10,
            color: node.id === secondaryFid ? 'var(--ac)' : 'var(--tx3)',
            marginRight: 4,
            padding: '1px 5px',
            border: '1px solid var(--bd)',
            borderRadius: 4,
            background: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            flexShrink: 0,
          }}
          onClick={(e) => {
            e.stopPropagation();
            onSplitClick(node.id);
          }}
        >
          {node.id === secondaryFid && splitOpen ? '参照中' : '分割'}
        </button>
      )}
      {filesCount > 1 && (
        <button
          type="button"
          title="削除"
          style={{
            fontSize: 11,
            color: 'var(--tx3)',
            marginRight: 4,
            padding: '0 3px',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            flexShrink: 0,
          }}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(node.id, node.name);
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export default function FileDropdown({ onClose }) {
  const {
    files,
    folders,
    fid,
    setFid,
    setActivePane,
    secondaryFid,
    splitOpen,
    openSplitFile,
    deleteFile,
    deleteFolder,
    moveFile,
    newFile,
    createFolder,
    isLoaded,
    ghUser,
    openGithubModal,
  } = useApp();

  const folderMetaMap = useFileMetadataStore((s) => s.folderMetaMap);
  const workSettingsMap = useFileMetadataStore((s) => s.workSettingsMap);
  const isMetadataLoaded = useFileMetadataStore((s) => s.isLoaded);

  const workLabelMap = useMemo(
    () => buildWorkLabelMap(folderMetaMap, workSettingsMap),
    [folderMetaMap, workSettingsMap],
  );

  const setNameInputModal = useUIStore((s) => s.setNameInputModal);

  const explorerExpanded = useUIStore((s) => s.explorerExpanded);
  const toggleExplorerFolder = useUIStore((s) => s.toggleExplorerFolder);
  const ensureExplorerExpanded = useUIStore((s) => s.ensureExplorerExpanded);
  const setDeleteFolderModal = useUIStore((s) => s.setDeleteFolderModal);

  const [movingFileId, setMovingFileId] = useState(null);
  const [dragFileId, setDragFileId] = useState(null);
  const [dragFileParentId, setDragFileParentId] = useState(null);
  const [rootDragOver, setRootDragOver] = useState(false);
  const dragOverTargetRef = useRef(null);

  const flatNodes = useMemo(
    () => flattenTree(files, folders, new Set(explorerExpanded)),
    [files, folders, explorerExpanded],
  );

  // All folders (fully expanded) for the move picker
  const allFolders = useMemo(
    () =>
      flattenTree([], folders, new Set(folders.map((f) => f.id))).filter(
        (n) => n.kind === 'folder',
      ),
    [folders],
  );

  // Auto-expand path to the currently open file when fid or data changes
  useEffect(() => {
    const currentFile = files.find((f) => f.id === fid);
    if (currentFile?.parentId) {
      const ancestorIds = findFileAncestorIds(currentFile.parentId, folders);
      if (ancestorIds.length) ensureExplorerExpanded(ancestorIds);
    }
  }, [fid, files, folders, ensureExplorerExpanded]);

  const handleFileClick = useCallback(
    (id) => {
      setFid(id);
      setActivePane('primary');
      onClose();
    },
    [setFid, setActivePane, onClose],
  );
  const handleSplitClick = useCallback(
    (id) => {
      openSplitFile(id);
      onClose();
    },
    [openSplitFile, onClose],
  );
  const handleDelete = useCallback(
    (id, name) => {
      if (window.confirm(`「${name}」を削除しますか？`)) {
        deleteFile(id);
        onClose();
      }
    },
    [deleteFile, onClose],
  );
  const handleMove = useCallback((fileId) => {
    setMovingFileId(fileId);
  }, []);

  const handleRename = useCallback(
    (fileId, currentName) => {
      setNameInputModal({ mode: 'rename', fileId, initial: currentName });
    },
    [setNameInputModal],
  );

  const handleNewFileInFolder = useCallback(
    (parentId) => {
      newFile(parentId);
      onClose();
    },
    [newFile, onClose],
  );

  const handleNewSubfolder = useCallback(
    (parentId) => {
      const name = window.prompt('フォルダ名を入力してください');
      if (name?.trim()) {
        createFolder(name.trim(), parentId);
        ensureExplorerExpanded([parentId]);
      }
    },
    [createFolder, ensureExplorerExpanded],
  );

  const handleDeleteFolder = useCallback(
    (node) => {
      const count = countDescendantFiles(node.id, files, folders);
      if (count === 0) {
        if (window.confirm(`「${node.name}」を削除しますか？`)) deleteFolder(node.id);
      } else {
        setDeleteFolderModal({
          folderId: node.id,
          folderName: node.name,
          folderParentId: node.parentId ?? null,
          fileCount: count,
        });
      }
    },
    [files, folders, deleteFolder, setDeleteFolderModal],
  );

  const handleNewFolder = useCallback(() => {
    const name = window.prompt('フォルダ名を入力してください');
    if (name?.trim()) {
      createFolder(name.trim());
      onClose();
    }
  }, [createFolder, onClose]);

  const clearDragOverHighlight = useCallback(() => {
    const prev = dragOverTargetRef.current;
    if (prev && prev !== 'root') {
      document
        .querySelector(`[data-nodeid="${CSS.escape(prev)}"]`)
        ?.classList.remove('fdi--dragover');
    }
    dragOverTargetRef.current = null;
    setRootDragOver(false);
  }, []);

  const handleDragStart = useCallback((e, fileId, parentId) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', fileId);
    setDragFileParentId(parentId ?? null);
    setDragFileId(fileId);
  }, []);
  const handleDragEnd = useCallback(() => {
    clearDragOverHighlight();
    setDragFileId(null);
    setDragFileParentId(null);
  }, [clearDragOverHighlight]);
  const handleDragOver = useCallback(
    (e, targetId) => {
      if (!dragFileId) return;
      if (targetId === (dragFileParentId ?? 'root')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const prev = dragOverTargetRef.current;
      if (prev === targetId) return;
      if (prev && prev !== 'root') {
        document
          .querySelector(`[data-nodeid="${CSS.escape(prev)}"]`)
          ?.classList.remove('fdi--dragover');
      }
      if (targetId !== 'root') {
        document
          .querySelector(`[data-nodeid="${CSS.escape(targetId)}"]`)
          ?.classList.add('fdi--dragover');
      }
      dragOverTargetRef.current = targetId;
      setRootDragOver(targetId === 'root');
    },
    [dragFileId, dragFileParentId],
  );
  const handleDragLeave = useCallback((targetId) => {
    if (dragOverTargetRef.current !== targetId) return;
    if (targetId !== 'root') {
      document
        .querySelector(`[data-nodeid="${CSS.escape(targetId)}"]`)
        ?.classList.remove('fdi--dragover');
    }
    dragOverTargetRef.current = null;
    setRootDragOver(false);
  }, []);
  const handleDrop = useCallback(
    (e, targetFolderId) => {
      e.preventDefault();
      if (dragFileId && dragFileParentId !== targetFolderId) moveFile(dragFileId, targetFolderId);
      clearDragOverHighlight();
      setDragFileId(null);
      setDragFileParentId(null);
    },
    [dragFileId, dragFileParentId, moveFile, clearDragOverHighlight],
  );

  const renderItem = useCallback(
    (node) => {
      if (node.kind === 'folder') {
        return (
          <FolderRow
            node={node}
            workInfo={workLabelMap.get(node.id) ?? null}
            isDragOver={dragOverTargetRef.current === node.id}
            onNewFile={handleNewFileInFolder}
            onNewSubfolder={handleNewSubfolder}
            onDelete={handleDeleteFolder}
            onDragOver={(e) => handleDragOver(e, node.id)}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) handleDragLeave(node.id);
            }}
            onDrop={(e) => handleDrop(e, node.id)}
          />
        );
      }
      return (
        <FileRow
          node={node}
          fid={fid}
          secondaryFid={secondaryFid}
          splitOpen={splitOpen}
          filesCount={files.length}
          onSplitClick={handleSplitClick}
          onDelete={handleDelete}
          onMove={handleMove}
          onRename={handleRename}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => handleDragOver(e, node.parentId ?? 'root')}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget))
              handleDragLeave(node.parentId ?? 'root');
          }}
          onDrop={(e) => handleDrop(e, node.parentId ?? null)}
        />
      );
    },
    [
      fid,
      secondaryFid,
      splitOpen,
      files.length,
      workLabelMap,
      handleSplitClick,
      handleDelete,
      handleMove,
      handleRename,
      handleNewFileInFolder,
      handleNewSubfolder,
      handleDeleteFolder,
      handleDragOver,
      handleDragLeave,
      handleDrop,
      handleDragStart,
      handleDragEnd,
    ],
  );

  return (
    <div className="fdrop">
      <div className="fdhead">ローカル</div>
      <div
        className={`fd-root-drop${!dragFileId || dragFileParentId === null ? ' fd-root-drop--hidden' : ''}${rootDragOver ? ' dragover' : ''}`}
        onDragOver={(e) => handleDragOver(e, 'root')}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) handleDragLeave('root');
        }}
        onDrop={(e) => handleDrop(e, null)}
      >
        ここにドロップでルートへ移動
      </div>
      <div className="fdrop-list" style={{ position: 'relative' }}>
        <VirtualList
          items={flatNodes}
          renderItem={renderItem}
          getItemKey={(node) => node.id}
          height="100%"
          overscan={5}
          onItemActivate={(node) => {
            if (node.kind === 'folder') toggleExplorerFolder(node.id);
            else handleFileClick(node.id);
          }}
          ariaLabel="ファイル一覧"
        />
        {movingFileId && (
          <div className="fd-move-picker">
            <div className="fd-move-header">
              <span>移動先を選択</span>
              <button type="button" className="fdi-act-btn" onClick={() => setMovingFileId(null)}>
                ×
              </button>
            </div>
            <button
              type="button"
              className="fd-move-item"
              onClick={() => {
                moveFile(movingFileId, null);
                setMovingFileId(null);
              }}
            >
              ルート（未分類）
            </button>
            {allFolders.map((n) => (
              <button
                type="button"
                key={n.id}
                className="fd-move-item"
                style={{ paddingLeft: 14 + n.depth * 14 }}
                onClick={() => {
                  moveFile(movingFileId, n.id);
                  setMovingFileId(null);
                }}
              >
                {n.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="fdrop-actions">
        <button
          type="button"
          className="btn-ghost"
          style={{ flex: 1, padding: '5px 0', fontSize: 11 }}
          onClick={() => {
            const currentFile = files.find((f) => f.id === fid);
            newFile(currentFile?.parentId ?? null);
            onClose();
          }}
        >
          ＋ 新規
        </button>
        <button
          type="button"
          className="btn-ghost"
          style={{ padding: '5px 6px', fontSize: 11 }}
          onClick={() => setNameInputModal({ mode: 'work' })}
          disabled={!isLoaded || !isMetadataLoaded}
          title="新規作品"
          aria-label="新規作品"
        >
          ＋ 作品
        </button>
        <button
          type="button"
          className="btn-ghost"
          style={{ padding: '5px 6px', fontSize: 11 }}
          onClick={handleNewFolder}
          title="新規フォルダ"
          aria-label="新規フォルダ"
        >
          📁
        </button>
        <button
          type="button"
          className="ghbtn"
          onClick={() => {
            openGithubModal(ghUser ? 'repos' : 'auth');
            onClose();
          }}
        >
          <GhIcon s={12} />
          {ghUser ? 'GitHubから開く' : 'GitHub接続'}
        </button>
        <button
          type="button"
          className="ghbtn"
          onClick={() => {
            openGithubModal(ghUser ? 'repos' : 'auth', 'secondary');
            onClose();
          }}
        >
          <GhIcon s={12} />
          GitHub分割
        </button>
      </div>
    </div>
  );
}

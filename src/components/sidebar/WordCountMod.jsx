import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useUIStore } from '../../stores/uiStore';
import ModuleWrapper from '../common/ModuleWrapper';
import {
  dbGet,
  dbPut,
  migrateWordCountSettingsFromLocalStorageOnce,
  WORD_COUNT_SETTINGS_KEYS,
} from '../../lib/db';
import { useApp } from '../../context/AppContext';
import { toWordCountText, toSiteWordCountText } from '../../lib/plainText';

const PRESETS = [1000, 2000, 5000, 10000];
const DEFAULT_GOAL = 2000;

function toPositiveInt(value) {
  const n = Number(String(value).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function getFolderKey(file) {
  if (!file?.github) return null;
  const { owner, repo, path } = file.github;
  if (!owner || !repo || !path) return null;
  const idx = path.lastIndexOf('/');
  const parent = idx >= 0 ? path.slice(0, idx) : '';
  return `${owner}/${repo}/${parent}`;
}

const COUNT_MODES = [
  { id: 'offline', label: '本文' },
  { id: 'site', label: '投稿' },
];

function WordCountBody({ onLoadingChange }) {
  const { currentFile } = useApp();
  const selectedText = useUIStore((s) => s.editorSelectionText) || '';
  const wordCountMode = useUIStore((s) => s.wordCountMode) || 'offline';
  const setWordCountMode = useUIStore((s) => s.setWordCountMode);
  const content = currentFile?.content || '';
  const plain = useMemo(() => {
    const countFn = wordCountMode === 'site' ? toSiteWordCountText : toWordCountText;
    return countFn(content);
  }, [wordCountMode, content]);
  const chars = plain.replace(/\s/g, '').length;
  const all = plain.length;
  // selectedText は TipTap の textBetween() でプレーンテキスト取得済み。二重処理を避ける
  const selectedChars = selectedText.replace(/\s/g, '').length;
  const selectedAll = selectedText.length;
  const hasSelection = selectedAll > 0;

  const [scope, setScope] = useState('global');
  const [globalGoal, setGlobalGoal] = useState(DEFAULT_GOAL);
  const [fileGoals, setFileGoals] = useState({});
  const [folderGoals, setFolderGoals] = useState({});
  const writeQueueRef = useRef(Promise.resolve());
  // Refで最新のmap値を追跡してsetState updater内のsideEffectを避ける
  const fileGoalsRef = useRef({});
  const folderGoalsRef = useRef({});
  const fileId = currentFile?.id || null;
  const folderKey = useMemo(() => getFolderKey(currentFile), [currentFile]);
  const effectiveScope = scope === 'folder' && !folderKey ? 'global' : scope;

  useLayoutEffect(() => {
    onLoadingChange?.(true);
  }, [onLoadingChange]);

  useEffect(() => {
    let alive = true;
    (async () => {
      await migrateWordCountSettingsFromLocalStorageOnce();
      const [globalRec, fileRec, folderRec] = await Promise.all([
        dbGet('settings', WORD_COUNT_SETTINGS_KEYS.globalGoal),
        dbGet('settings', WORD_COUNT_SETTINGS_KEYS.fileGoals),
        dbGet('settings', WORD_COUNT_SETTINGS_KEYS.folderGoals),
      ]);
      if (!alive) return;
      const loadedFile =
        fileRec?.value && typeof fileRec.value === 'object' && !Array.isArray(fileRec.value)
          ? fileRec.value
          : {};
      const loadedFolder =
        folderRec?.value && typeof folderRec.value === 'object' && !Array.isArray(folderRec.value)
          ? folderRec.value
          : {};
      setGlobalGoal(toPositiveInt(globalRec?.value) || DEFAULT_GOAL);
      fileGoalsRef.current = loadedFile;
      folderGoalsRef.current = loadedFolder;
      setFileGoals(loadedFile);
      setFolderGoals(loadedFolder);
      onLoadingChange?.(false);
    })().catch(() => {
      if (!alive) return;
      onLoadingChange?.(false);
    });
    return () => {
      alive = false;
    };
  }, [onLoadingChange]);

  useEffect(() => {
    fileGoalsRef.current = fileGoals;
  }, [fileGoals]);
  useEffect(() => {
    folderGoalsRef.current = folderGoals;
  }, [folderGoals]);

  const enqueueWrite = useCallback((task) => {
    writeQueueRef.current = writeQueueRef.current.then(task, task);
    return writeQueueRef.current;
  }, []);

  const addToast = useUIStore((s) => s.addToast);
  const goalReachedRef = useRef(false);

  const fileGoal = fileId ? toPositiveInt(fileGoals[fileId]) : null;
  const folderGoal = folderKey ? toPositiveInt(folderGoals[folderKey]) : null;
  const goal = fileGoal || folderGoal || globalGoal;

  useEffect(() => {
    if (goal && chars >= goal && !goalReachedRef.current) {
      goalReachedRef.current = true;
      addToast(`目標 ${goal.toLocaleString()} 字 達成！`);
    } else if (goal && chars < goal * 0.99) {
      goalReachedRef.current = false;
    }
  }, [chars, goal, addToast]);
  const goalSource = fileGoal ? 'このファイル' : folderGoal ? 'フォルダ' : '全体';

  const selectedValue =
    effectiveScope === 'file' ? fileGoal : effectiveScope === 'folder' ? folderGoal : globalGoal;

  const saveGlobalGoal = async (next) => {
    setGlobalGoal(next);
    await enqueueWrite(() =>
      dbPut('settings', {
        key: WORD_COUNT_SETTINGS_KEYS.globalGoal,
        value: next,
      }),
    );
  };

  const saveMapGoal = async (dbKey, setMap, mapRef, key, next) => {
    if (!key) return;
    const updated = { ...mapRef.current, [key]: next };
    mapRef.current = updated;
    setMap(updated);
    await enqueueWrite(() => dbPut('settings', { key: dbKey, value: updated }));
  };

  const saveGoal = async (value) => {
    const next = toPositiveInt(value);
    if (!next) return false;
    if (effectiveScope === 'file') {
      if (!fileId) return false;
      await saveMapGoal(
        WORD_COUNT_SETTINGS_KEYS.fileGoals,
        setFileGoals,
        fileGoalsRef,
        fileId,
        next,
      );
    } else if (effectiveScope === 'folder') {
      if (!folderKey) return false;
      await saveMapGoal(
        WORD_COUNT_SETTINGS_KEYS.folderGoals,
        setFolderGoals,
        folderGoalsRef,
        folderKey,
        next,
      );
    } else {
      await saveGlobalGoal(next);
    }
    addToast('保存しました');
    return true;
  };

  const clearScopedGoal = async () => {
    if (effectiveScope === 'file' && fileId) {
      const updated = { ...fileGoalsRef.current };
      delete updated[fileId];
      fileGoalsRef.current = updated;
      setFileGoals(updated);
      await enqueueWrite(() =>
        dbPut('settings', {
          key: WORD_COUNT_SETTINGS_KEYS.fileGoals,
          value: updated,
        }),
      );
    } else if (effectiveScope === 'folder' && folderKey) {
      const updated = { ...folderGoalsRef.current };
      delete updated[folderKey];
      folderGoalsRef.current = updated;
      setFolderGoals(updated);
      await enqueueWrite(() =>
        dbPut('settings', {
          key: WORD_COUNT_SETTINGS_KEYS.folderGoals,
          value: updated,
        }),
      );
    } else {
      return;
    }
    addToast('削除しました');
  };

  const canClear =
    effectiveScope === 'file'
      ? Boolean(fileGoal)
      : effectiveScope === 'folder'
        ? Boolean(folderGoal)
        : false;
  const pct = Math.min(100, Math.round((chars / goal) * 100));
  const scopes = [
    { id: 'global', label: '全体' },
    { id: 'file', label: 'このファイル' },
    ...(folderKey ? [{ id: 'folder', label: 'このフォルダ' }] : []),
  ];

  return (
    <>
      <div style={{ display: 'flex', gap: 3, marginBottom: 8 }}>
        {COUNT_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setWordCountMode(m.id)}
            style={{
              flex: 1,
              padding: '3px 0',
              fontSize: 10,
              fontFamily: 'inherit',
              cursor: 'pointer',
              borderRadius: 'var(--rs)',
              background: wordCountMode === m.id ? 'var(--ac-bg)' : 'transparent',
              border: `1px solid ${wordCountMode === m.id ? 'var(--ac)' : 'var(--bd)'}`,
              color: wordCountMode === m.id ? 'var(--ac)' : 'var(--tx3)',
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div style={{ textAlign: 'center', marginBottom: 10 }}>
        <div
          style={{
            fontSize: 30,
            fontWeight: 300,
            letterSpacing: '0.04em',
            color: 'var(--tx)',
            lineHeight: 1,
          }}
        >
          {chars.toLocaleString()}
        </div>
        <div style={{ fontSize: 10, color: 'var(--tx3)', marginTop: 3 }}>
          空白除外 / 全 {all.toLocaleString()} 字
        </div>
      </div>
      {hasSelection && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            margin: '-2px 0 10px',
            padding: '6px 8px',
            border: '1px solid var(--bd)',
            borderRadius: 'var(--rs)',
            background: 'var(--sf2)',
            color: 'var(--tx2)',
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--tx3)',
              whiteSpace: 'nowrap',
            }}
          >
            選択中
          </span>
          <span style={{ fontSize: 11, textAlign: 'right', lineHeight: 1.45 }}>
            <strong style={{ color: 'var(--tx)', fontWeight: 600 }}>
              {selectedChars.toLocaleString()}
            </strong>
            <span style={{ color: 'var(--tx3)' }}>
              {' '}
              空白除外 / 全 {selectedAll.toLocaleString()} 字
            </span>
          </span>
        </div>
      )}
      <div className="progress-bar" style={{ marginBottom: 5 }}>
        <div className="progress-fill" style={{ width: pct + '%' }} />
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 10,
          color: 'var(--tx3)',
          marginBottom: 8,
        }}
      >
        <span>{pct}%</span>
        <span>
          目標 {goal.toLocaleString()} 字（{goalSource}）
        </span>
      </div>
      <div style={{ display: 'flex', gap: 3, marginBottom: 6 }}>
        {scopes.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setScope(s.id)}
            style={{
              flex: 1,
              padding: '4px 3px',
              fontSize: 10,
              fontFamily: 'inherit',
              cursor: 'pointer',
              borderRadius: 'var(--rs)',
              background: effectiveScope === s.id ? 'var(--ac-bg)' : 'transparent',
              border: `1px solid ${effectiveScope === s.id ? 'var(--ac)' : 'var(--bd)'}`,
              color: effectiveScope === s.id ? 'var(--ac)' : 'var(--tx3)',
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        <input
          className="text-input"
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          key={`${effectiveScope}:${fileId || ''}:${folderKey || ''}:${selectedValue || goal}`}
          defaultValue={String(selectedValue || goal)}
          onBlur={async (e) => {
            try {
              if (!(await saveGoal(e.target.value))) e.target.value = String(selectedValue || goal);
            } catch {
              e.target.value = String(selectedValue || goal);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          aria-label="目標文字数"
          style={{ flex: 1, fontSize: 11, padding: '5px 7px' }}
        />
        {canClear && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              clearScopedGoal().catch(console.warn);
            }}
            style={{ padding: '4px 7px', fontSize: 10 }}
          >
            解除
          </button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 3 }}>
        {PRESETS.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => {
              saveGoal(g).catch(console.warn);
            }}
            style={{
              flex: 1,
              padding: '4px 0',
              fontSize: 10,
              fontFamily: 'inherit',
              cursor: 'pointer',
              borderRadius: 'var(--rs)',
              background: selectedValue === g ? 'var(--ac-bg)' : 'var(--sf2)',
              border: `1px solid ${selectedValue === g ? 'var(--ac)' : 'var(--bd)'}`,
              color: selectedValue === g ? 'var(--ac)' : 'var(--tx3)',
            }}
          >
            {g >= 1000 ? g / 1000 + 'k' : g}
          </button>
        ))}
      </div>
    </>
  );
}

export default function WordCountMod() {
  const [isLoading, setIsLoading] = useState(true);

  return (
    <ModuleWrapper title="文字数カウント" icon="✍" defaultOpen={true} loading={isLoading}>
      <WordCountBody onLoadingChange={setIsLoading} />
    </ModuleWrapper>
  );
}

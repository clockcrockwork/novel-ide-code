import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import ModuleWrapper from '../common/ModuleWrapper';
import {
  dbGet,
  dbPut,
  migrateWordCountSettingsFromLocalStorageOnce,
  WORD_COUNT_SETTINGS_KEYS,
} from '../../lib/db';
import { useApp } from '../../context/AppContext';
import { toWordCountText } from '../../lib/plainText';

const DEFAULT_TEMPLATE =
  '「{タイトル}」を執筆中！\n文字数：{文字数}字 / 目標{目標文字数}字（{達成率}%）';
const TEMPLATE_KEY = 'share_template';
const INSTANCE_KEY = 'share_misskey_instance';
const X_LIMIT = 280;
const DEFAULT_GOAL = 2000;

function toPositiveInt(value) {
  const n = Number(String(value ?? '').trim());
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

// X は全角を 2pt、半角・ASCII を 1pt でカウントする（最大 280pt）
// for...of + codePointAt でサロゲートペア（絵文字等）を 1 コードポイント = 2pt に正しく扱う
function calcXPoints(text) {
  let pts = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    pts += (code >= 0x0000 && code <= 0x007f) || (code >= 0xff61 && code <= 0xff9f) ? 1 : 2;
  }
  return pts;
}

function ShareBody({ onLoadingChange }) {
  const { currentFile } = useApp();
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [misskeyInstance, setMisskeyInstance] = useState('');
  const [globalGoal, setGlobalGoal] = useState(DEFAULT_GOAL);
  const [fileGoals, setFileGoals] = useState({});
  const [folderGoals, setFolderGoals] = useState({});
  const [hydrated, setHydrated] = useState(false);

  useLayoutEffect(() => {
    onLoadingChange?.(true);
  }, [onLoadingChange]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await migrateWordCountSettingsFromLocalStorageOnce();
        const [tmpl, inst, global, file, folder] = await Promise.all([
          dbGet('settings', TEMPLATE_KEY).catch(() => null),
          dbGet('settings', INSTANCE_KEY).catch(() => null),
          dbGet('settings', WORD_COUNT_SETTINGS_KEYS.globalGoal).catch(() => null),
          dbGet('settings', WORD_COUNT_SETTINGS_KEYS.fileGoals).catch(() => null),
          dbGet('settings', WORD_COUNT_SETTINGS_KEYS.folderGoals).catch(() => null),
        ]);
        if (!alive) return;
        if (tmpl?.value != null) setTemplate(tmpl.value);
        if (inst?.value != null) setMisskeyInstance(inst.value);
        setGlobalGoal(toPositiveInt(global?.value) ?? DEFAULT_GOAL);
        setFileGoals(file?.value && typeof file.value === 'object' ? file.value : {});
        setFolderGoals(folder?.value && typeof folder.value === 'object' ? folder.value : {});
      } catch (err) {
        console.warn(err);
      } finally {
        if (alive) {
          setHydrated(true);
          onLoadingChange?.(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [onLoadingChange]);

  const saveTemplate = useCallback((val) => {
    dbPut('settings', { key: TEMPLATE_KEY, value: val }).catch(console.warn);
  }, []);

  const saveInstance = useCallback((val) => {
    const cleaned = val
      .trim()
      .replace(/^https?:\/\//i, '')
      .split('/')[0];
    setMisskeyInstance(cleaned);
    dbPut('settings', { key: INSTANCE_KEY, value: cleaned }).catch(console.warn);
  }, []);

  const resolved = useMemo(() => {
    const name = currentFile?.name ?? '';
    const title = name.replace(/\.[^.]+$/, '');
    const content = currentFile?.content ?? '';
    const chars = toWordCountText(content).replace(/\s/g, '').length;

    const fileId = currentFile?.id ?? null;
    const folderKey = getFolderKey(currentFile);
    const fileGoal = fileId ? toPositiveInt(fileGoals[fileId]) : null;
    const folderGoal = folderKey ? toPositiveInt(folderGoals[folderKey]) : null;
    const goal = fileGoal ?? folderGoal ?? globalGoal;

    const goalStr = goal != null ? goal.toLocaleString() : '未設定';
    const rateStr = goal != null ? String(Math.floor((chars / goal) * 100)) : '--';

    return (typeof template === 'string' ? template : '')
      .replaceAll('{タイトル}', title)
      .replaceAll('{文字数}', chars.toLocaleString())
      .replaceAll('{目標文字数}', goalStr)
      .replaceAll('{達成率}', rateStr);
  }, [template, currentFile, globalGoal, fileGoals, folderGoals]);

  const openX = () => {
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(resolved)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const openMisskey = () => {
    let url = `https://misskey-hub.net/share/?text=${encodeURIComponent(resolved)}`;
    const inst = misskeyInstance.trim();
    if (inst) url += `&manualInstance=${encodeURIComponent(inst)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const xPoints = useMemo(() => calcXPoints(resolved), [resolved]);
  const xOver = xPoints > X_LIMIT;

  return (
    <>
      <label
        htmlFor="share-template"
        style={{ display: 'block', fontSize: 11, color: 'var(--tx3)', marginBottom: 4 }}
      >
        テンプレート
        <span style={{ marginLeft: 6, fontFamily: 'monospace', fontSize: 10, color: 'var(--tx3)' }}>
          {'{タイトル}'} {'{文字数}'} {'{目標文字数}'} {'{達成率}'}
        </span>
      </label>
      <textarea
        id="share-template"
        className="text-input"
        style={{
          width: '100%',
          minHeight: 72,
          resize: 'vertical',
          fontSize: 12,
          lineHeight: 1.5,
          boxSizing: 'border-box',
        }}
        value={template}
        disabled={!hydrated}
        onChange={(e) => setTemplate(e.target.value)}
        onBlur={(e) => saveTemplate(e.target.value)}
      />

      <div style={{ marginTop: 8, marginBottom: 4, fontSize: 11, color: 'var(--tx3)' }}>
        プレビュー
      </div>
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.6,
          padding: '6px 8px',
          background: 'var(--sf2)',
          borderRadius: 'var(--rs)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          color: 'var(--tx)',
          border: '1px solid var(--bd)',
        }}
      >
        {resolved || <span style={{ color: 'var(--tx3)' }}>（空）</span>}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 11,
          textAlign: 'right',
          color: xOver ? 'var(--red, #e05)' : 'var(--tx3)',
        }}
      >
        {xPoints} / {X_LIMIT} pt{xOver ? '（X の上限を超えています）' : ''}
      </div>

      <label
        htmlFor="share-misskey-instance"
        style={{
          display: 'block',
          marginTop: 10,
          fontSize: 11,
          color: 'var(--tx3)',
          marginBottom: 4,
        }}
      >
        Misskey サーバー（任意）
      </label>
      <input
        id="share-misskey-instance"
        className="text-input"
        style={{ width: '100%', fontSize: 12, boxSizing: 'border-box' }}
        placeholder="例: misskey.io"
        value={misskeyInstance}
        disabled={!hydrated}
        onChange={(e) => setMisskeyInstance(e.target.value)}
        onBlur={(e) => saveInstance(e.target.value)}
      />

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button
          type="button"
          className="btn-ghost"
          style={{ flex: 1, fontSize: 11 }}
          onClick={openX}
          disabled={!hydrated}
          aria-label="Xでシェア"
        >
          𝕏 でシェア
        </button>
        <button
          type="button"
          className="btn-ghost"
          style={{ flex: 1, fontSize: 11 }}
          onClick={openMisskey}
          disabled={!hydrated}
        >
          Misskey でシェア
        </button>
      </div>
    </>
  );
}

export default function ShareMod() {
  const [loading, setLoading] = useState(true);
  return (
    <ModuleWrapper title="シェア" icon="📤" loading={loading}>
      <ShareBody onLoadingChange={setLoading} />
    </ModuleWrapper>
  );
}

import { useMemo, useState } from 'react';
import ModuleWrapper from '../common/ModuleWrapper';
import { useApp } from '../../context/AppContext';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function FindReplaceBody({ find, rep, cs, setFind, setRep, setCs }) {
  const { currentFile, updateContent: onChange, activePane } = useApp();
  const content = currentFile?.content || '';
  const disabled = activePane === 'secondary';

  const count = useMemo(() => {
    if (!find) return 0;
    try {
      const regex = new RegExp(escapeRegExp(find), cs ? 'g' : 'gi');
      let count = 0;
      while (regex.exec(content)) count++;
      return count;
    } catch {
      return 0;
    }
  }, [find, content, cs]);

  const doReplace = (all) => {
    if (!find || disabled) return;
    try {
      const flags = cs ? (all ? 'g' : '') : all ? 'gi' : 'i';
      onChange(content.replace(new RegExp(escapeRegExp(find), flags), () => rep));
    } catch {}
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ position: 'relative' }}>
        <input
          className="text-input"
          placeholder="検索…"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
        {find && (
          <span
            data-testid="find-count"
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 10,
              color: 'var(--tx3)',
              pointerEvents: 'none',
            }}
          >
            {count}件
          </span>
        )}
      </div>
      <input
        className="text-input"
        placeholder="置換後…"
        value={rep}
        disabled={disabled}
        onChange={(e) => setRep(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && doReplace(false)}
      />
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            color: 'var(--tx3)',
            cursor: 'pointer',
            flex: 1,
          }}
        >
          <input
            type="checkbox"
            checked={cs}
            onChange={(e) => setCs(e.target.checked)}
            style={{ accentColor: 'var(--ac)' }}
          />
          大文字小文字
        </label>
        <button
          type="button"
          className="btn-ghost"
          style={{ padding: '4px 8px', fontSize: 11 }}
          disabled={disabled}
          onClick={() => doReplace(false)}
        >
          1件
        </button>
        <button
          type="button"
          className="btn-ghost"
          style={{ padding: '4px 8px', fontSize: 11 }}
          disabled={disabled}
          onClick={() => doReplace(true)}
        >
          すべて
        </button>
      </div>
      {disabled && (
        <div style={{ fontSize: 10, color: 'var(--tx3)' }}>参照ペインでは置換できません</div>
      )}
    </div>
  );
}

export default function FindReplaceMod() {
  const [find, setFind] = useState('');
  const [rep, setRep] = useState('');
  const [cs, setCs] = useState(false);

  return (
    <ModuleWrapper title="検索 & 置換" icon="🔍">
      <FindReplaceBody
        find={find}
        rep={rep}
        cs={cs}
        setFind={setFind}
        setRep={setRep}
        setCs={setCs}
      />
    </ModuleWrapper>
  );
}

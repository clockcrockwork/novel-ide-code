import { useState } from 'react';
import ModuleWrapper from '../common/ModuleWrapper';
import { useWritingPrefs } from '../../hooks/useWritingPrefs';

function TagsBody() {
  const { tags, setTags, hydrated } = useWritingPrefs();
  const [input, setInput] = useState('');

  const add = () => {
    if (!hydrated) return;
    const next = input.trim();
    if (!next || tags.includes(next)) return;
    setTags([...tags, next]);
    setInput('');
  };

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8, minHeight: 24 }}>
        {tags.map((t, i) => (
          <span
            key={`${t}-${i}`}
            className="tag"
            style={{
              cursor: hydrated ? 'pointer' : 'default',
              userSelect: 'none',
              opacity: hydrated ? 1 : 0.5,
            }}
            onClick={() => {
              if (hydrated) setTags((prev) => prev.filter((_, idx) => idx !== i));
            }}
            title={hydrated ? 'クリックで削除' : undefined}
          >
            {t} ×
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          className="text-input"
          style={{ flex: 1 }}
          placeholder={hydrated ? '新しいタグ…' : '読み込み中…'}
          value={input}
          disabled={!hydrated}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button
          type="button"
          className="nb nb-icon"
          style={{ width: 32, height: 32, fontSize: 16, flexShrink: 0 }}
          disabled={!hydrated}
          onClick={add}
        >
          ＋
        </button>
      </div>
    </>
  );
}

export default function TagsMod() {
  return (
    <ModuleWrapper title="タグ管理" icon="🏷">
      <TagsBody />
    </ModuleWrapper>
  );
}

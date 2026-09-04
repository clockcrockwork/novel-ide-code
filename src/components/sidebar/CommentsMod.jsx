import { useMemo } from 'react';
import ModuleWrapper from '../common/ModuleWrapper';
import { useApp } from '../../context/AppContext';

function CommentsBody() {
  const { currentFile } = useApp();
  const content = currentFile?.content || '';
  const comments = useMemo(() => {
    const re = /\/\*([^*\n]+)\*\//g;
    const res = [];
    let m;
    while ((m = re.exec(content || '')) !== null) res.push({ text: m[1], pos: m.index });
    return res;
  }, [content]);

  return (
    <>
      {comments.length === 0 && (
        <div style={{ color: 'var(--tx3)', fontSize: 12, textAlign: 'center', padding: '6px 0' }}>
          /*コメント*/ なし
        </div>
      )}
      {comments.map((c, i) => (
        <div
          key={`${c.pos}:${i}`}
          style={{
            padding: '6px 8px',
            marginBottom: 4,
            background: 'var(--sf2)',
            borderRadius: 'var(--rs)',
            borderLeft: '2px solid var(--ac)',
            fontSize: 12,
            color: 'var(--tx2)',
            lineHeight: 1.5,
          }}
        >
          {c.text}
        </div>
      ))}
    </>
  );
}

export default function CommentsMod() {
  return (
    <ModuleWrapper title="コメント一覧" icon="💬">
      <CommentsBody />
    </ModuleWrapper>
  );
}

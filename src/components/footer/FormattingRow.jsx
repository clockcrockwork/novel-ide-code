export default function FormattingRow({
  canEdit,
  ins,
  wrapBold,
  insHeading,
  insRuby,
  insSplitParagraph,
}) {
  const ROW1 = [
    { l: '「」', a: () => ins(['「', '」']), sym: true, title: 'カギ括弧' },
    { l: '（）', a: () => ins(['（', '）']), sym: true, title: '丸括弧' },
    { l: '、', a: () => ins('、'), sym: true, title: '読点' },
    { l: '。', a: () => ins('。'), sym: true, title: '句点' },
    { l: '！', a: () => ins('！'), sym: true, title: '感嘆符' },
    { l: '？', a: () => ins('？'), sym: true, title: '疑問符' },
    { l: '…', a: () => ins('…'), sym: true, title: '三点リーダー' },
    { l: '―', a: () => ins('―'), sym: true, title: 'ダッシュ' },
    { l: '・', a: () => ins('・'), sym: true, title: '中黒' },
    null,
    { l: '太字', a: wrapBold, title: '太字' },
    { l: 'H1', a: () => insHeading(1), title: '見出し1' },
    { l: 'H2', a: () => insHeading(2), title: '見出し2' },
    { l: 'H3', a: () => insHeading(3), title: '見出し3' },
    { l: 'HR', a: () => ins('\n\n---\n\n'), title: '区切り線' },
    { l: 'ルビ', a: insRuby, title: 'ルビ（ふりがな）' },
    { sep: true, mobile: true },
    { l: '新規段落', a: insSplitParagraph, title: '新しい段落を作成', mobile: true },
  ];

  return (
    <div className="frow">
      {ROW1.map((b, i) => {
        if (!b || b.sep) return <div key={i} className={`fsep${b?.mobile ? ' fb-mobile' : ''}`} />;
        return (
          <button
            type="button"
            key={i}
            className={`fb${b.sym ? ' sym' : ''}${b.mobile ? ' fb-mobile' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={b.a}
            title={b.title}
            disabled={!canEdit}
          >
            {b.l}
          </button>
        );
      })}
    </div>
  );
}

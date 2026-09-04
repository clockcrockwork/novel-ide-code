import { useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { useUIStore } from '../../stores/uiStore';
import { useEditorCommands } from '../../hooks/useEditorCommands';
import { useViewportFooter } from '../../hooks/useViewportFooter';
import FormattingRow from './FormattingRow';
import NavigationRow from './NavigationRow';
import { MODES, MODE_LABELS } from '../../constants/modes';

export default function FooterBox() {
  const { editorRef, switchMode, activePane } = useApp();
  const mode = useUIStore((s) => s.mode);
  const footerRef = useRef(null);
  const canEdit = activePane !== 'secondary';

  useViewportFooter(footerRef);

  const { ins, mv, moveLine, insHeading, wrapBold, insRuby, insSplitParagraph } = useEditorCommands(
    editorRef,
    canEdit,
  );

  return (
    <div ref={footerRef} className="footer">
      <div
        className="frow footer-modes hide-p"
        style={{ borderBottom: '1px solid var(--bd)', paddingBottom: 3 }}
      >
        <div className="mgrp">
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
      </div>
      {mode === 'write' && (
        <>
          <FormattingRow
            canEdit={canEdit}
            ins={ins}
            wrapBold={wrapBold}
            insHeading={insHeading}
            insRuby={insRuby}
            insSplitParagraph={insSplitParagraph}
          />
          <NavigationRow canEdit={canEdit} mv={mv} moveLine={moveLine} editorRef={editorRef} />
        </>
      )}
    </div>
  );
}

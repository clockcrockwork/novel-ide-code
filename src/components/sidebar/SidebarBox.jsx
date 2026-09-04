import { useUIStore } from '../../stores/uiStore';
import WordCountMod from './WordCountMod';
import PomodoroMod from './PomodoroMod';
import FlowTimeMod from './FlowTimeMod';
import HeadingJumpMod from './HeadingJumpMod';
import FindReplaceMod from './FindReplaceMod';
import MultiReplaceMod from './MultiReplaceMod';
import CommentsMod from './CommentsMod';
import AnnotationListMod from './AnnotationListMod';
import ProofreadMod from './ProofreadMod';
import StyleCheckMod from './StyleCheckMod';
import InvisibleCharMod from './InvisibleCharMod';
import TagsMod from './TagsMod';
import RulesMod from './RulesMod';
import GithubMod from './GithubMod';
import DevicesMod from './DevicesMod';
import FileMetadataMod from './FileMetadataMod';
import ShareMod from './ShareMod';

export default function SidebarBox() {
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);

  return (
    <>
      <div
        style={{
          height: 46,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          borderBottom: '1px solid var(--bd)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '.08em',
            textTransform: 'uppercase',
            color: 'var(--tx3)',
          }}
        >
          パネル
        </span>
        <button
          type="button"
          className="nb nb-icon"
          style={{ width: 26, height: 26, fontSize: 14 }}
          onClick={() => setSidebarOpen(false)}
          aria-label="サイドバーを閉じる"
          data-testid="sidebar-close-btn"
        >
          ×
        </button>
      </div>
      <div className="sidebar-scroll">
        <RulesMod />
        <GithubMod />
        <FileMetadataMod />
        <DevicesMod />
        <ShareMod />
        <WordCountMod />
        <PomodoroMod />
        <FlowTimeMod />
        <HeadingJumpMod />
        <FindReplaceMod />
        <MultiReplaceMod />
        <CommentsMod />
        <AnnotationListMod />
        <StyleCheckMod />
        <ProofreadMod />
        <InvisibleCharMod />
        <TagsMod />
      </div>
    </>
  );
}

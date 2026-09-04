import { useApp } from '../../context/AppContext';
import { useUIStore } from '../../stores/uiStore';
import { ExportIcon, ChevronRight } from '../Icons';
import { parseMarkdown } from '../../lib/markdown';
import { toPlainText } from '../../lib/plainText';
import { downloadFile } from '../../lib/download';
import { dbGetAllStores, migrateWordCountSettingsFromLocalStorageOnce } from '../../lib/db';
import { buildBackup } from '../../lib/backup';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function backupFileName() {
  const now = new Date();
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  // 分までだと同一分内の連続出力が同名になり、モバイル/PWA では上書きになりうるため秒まで含める
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `novel-ide-backup-${date}-${time}.json`;
}

// 同一タスク内の連続 click に同期的に効く再入ガード。isExportingBackup (state) は
// 再レンダー後にしか disabled に反映されないため、state だけだと素早い連打で
// すり抜ける（実測: 同一タスクで click 5連発 → ダウンロード5回）。モジュールスコープの
// フラグにするのは、useRef の .current を render 中に構築される EXPORTS 配列へ
// 埋め込むと react-hooks/refs（refs は render 中に読まない）に抵触するため
// （db.js の _db / saveStatus.js の _pending と同型のモジュールスコープガード）。
let isExportingBackupGuard = false;

export default function ExportModal() {
  const { currentFile, settings, DEFAULT_SETTINGS } = useApp();
  const setShowExport = useUIStore((s) => s.setShowExport);
  const isExportingPdf = useUIStore((s) => s.isExportingPdf);
  const setIsExportingPdf = useUIStore((s) => s.setIsExportingPdf);
  const isExportingBackup = useUIStore((s) => s.isExportingBackup);
  const setIsExportingBackup = useUIStore((s) => s.setIsExportingBackup);
  const addToast = useUIStore((s) => s.addToast);

  // 生成中はキャンセルのつもりの操作で閉じさせない（PrePushModal の committing/loading
  // ガードと同じ考え方）。閉じた直後にダウンロードだけ始まる／文脈のないトーストが
  // 残る、を避けるため。
  const closeExportModal = () => {
    if (isExportingBackup) return;
    setShowExport(false);
  };

  const exportMd = () => {
    downloadFile(currentFile.content, currentFile.name || 'novel.md', 'text/markdown');
    setShowExport(false);
  };

  const exportTxt = () => {
    downloadFile(
      toPlainText(currentFile.content),
      (currentFile.name || 'novel').replace(/\.md$/, '') + '.txt',
      'text/plain',
    );
    setShowExport(false);
  };

  const exportBackup = async () => {
    if (isExportingBackupGuard) return;
    isExportingBackupGuard = true;
    setIsExportingBackup(true);
    try {
      // サイドバーの文字数カウント/共有モジュールを一度も開いていないと、この遅延
      // マイグレーションが未実行のまま ide_wgoal 等が localStorage に残り、IDB だけを
      // 読むバックアップから警告なく欠落するため、読み出し前に必ず呼ぶ。
      await migrateWordCountSettingsFromLocalStorageOnce();
      const stores = await dbGetAllStores();
      const backup = buildBackup(stores);
      downloadFile(JSON.stringify(backup, null, 2), backupFileName(), 'application/json');
      setShowExport(false);
    } catch (e) {
      console.error('バックアップの生成に失敗しました', e);
      if (e?.name === 'QuotaExceededError') {
        addToast('保存容量が不足しているため、バックアップを生成できませんでした。');
      } else {
        addToast(`バックアップの生成に失敗しました（${e?.name || 'エラー'}）。`);
      }
    } finally {
      isExportingBackupGuard = false;
      setIsExportingBackup(false);
    }
  };

  const exportPdf = () => {
    if (isExportingPdf) return;
    if (!currentFile) return;
    setIsExportingPdf(true);
    setShowExport(false);

    const s = settings?.preview || DEFAULT_SETTINGS.preview;
    const FSTACK = {
      'noto-serif': "'Noto Serif JP','Hiragino Mincho ProN','Yu Mincho','MS PMincho',serif",
      'noto-sans': "'Noto Sans JP','Hiragino Kaku Gothic ProN','Yu Gothic','Meiryo',sans-serif",
      monospace: "'Noto Sans Mono CJK JP','SFMono-Regular','Consolas','Menlo',monospace",
    };
    const fontFace = FSTACK[s.font] || FSTACK['noto-serif'];
    const pickNum = (value, fallback) => {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : fallback;
    };
    const fontSize = pickNum(s.fontSize, DEFAULT_SETTINGS.preview.fontSize);
    const lineHeight = pickNum(s.lineHeight, DEFAULT_SETTINGS.preview.lineHeight);
    const letterSpacing = pickNum(s.letterSpacing, DEFAULT_SETTINGS.preview.letterSpacing);

    const stripped = (currentFile.content || '').replace(/%%[^%\n]*%%/g, '');
    const html = parseMarkdown(stripped, true);

    const fullHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;700&family=Noto+Sans+JP:wght@300;400&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:${fontFace};font-size:${fontSize}px;line-height:${lineHeight};
  letter-spacing:${(letterSpacing / 100).toFixed(3)}em;
  max-width:680px;margin:0 auto;padding:40px 32px;color:#1a1916;background:#fff}
h1{font-size:1.55em;font-weight:700;margin:1.2em 0 .5em;border-bottom:1px solid #ddd;padding-bottom:.3em}
h2{font-size:1.25em;font-weight:600;margin:.9em 0 .4em}
h3{font-size:1.05em;font-weight:600;margin:.7em 0 .3em;color:#555}
hr{border:none;border-top:1px solid #ddd;margin:1.5em 0}
p{margin-bottom:.9em}strong{font-weight:700}
ruby{ruby-align:center}rt{font-size:.5em}
@media print{body{padding:20px}@page{margin:20mm}}
</style></head><body>${html}
</body></html>`;

    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.position = 'absolute';
    iframe.style.width = '800px';
    iframe.style.height = '600px';
    iframe.style.border = '0';
    iframe.style.left = '-9999px';
    iframe.style.top = '0';
    document.body.appendChild(iframe);

    let finalized = false;
    const cleanup = () => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      setIsExportingPdf(false);
      clearTimeout(printTimeout);
      cleanup();
    };
    const notifyPrintError = (e) => {
      finalize();
      console.warn('印刷準備に失敗しました。', e);
      alert('印刷の準備中にエラーが発生しました。しばらくしてから再度お試しください。');
    };

    const printTimeout = setTimeout(finalize, 300000);
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) throw new Error('印刷ドキュメントを作成できませんでした');

      const runPrint = () => {
        const win = iframe.contentWindow;
        if (!win) {
          finalize();
          return;
        }
        win.onafterprint = finalize;
        win.focus();
        win.print();
      };

      doc.open();
      doc.write(fullHtml);
      doc.close();

      const frameFonts = doc.fonts;
      if (!frameFonts?.ready) {
        runPrint();
        return;
      }
      Promise.race([frameFonts.ready, new Promise((resolve) => setTimeout(resolve, 15000))])
        .then(runPrint)
        .catch(notifyPrintError);
    } catch (e) {
      notifyPrintError(e);
    }
  };

  const noFile = !currentFile;
  const fileRequiredDesc = (desc) => (noFile ? 'ファイルを選択すると利用できます' : desc);

  // disabled は busy（実行中）か requiresCurrentFile（ファイル未選択）から導出する。
  // aria-busy は busy 由来のみとし、ファイル未選択を busy 扱いにしない。
  const EXPORTS = [
    {
      icon: '📄',
      name: 'Markdown (.md)',
      desc: fileRequiredDesc('書式付きテキスト — GitHub等で利用可'),
      a: exportMd,
      requiresCurrentFile: true,
    },
    {
      icon: '📃',
      name: 'プレーンテキスト (.txt)',
      desc: fileRequiredDesc('コメント・書式を除去したテキスト'),
      a: exportTxt,
      requiresCurrentFile: true,
    },
    {
      icon: '🖨',
      name: 'PDF (印刷)',
      desc: fileRequiredDesc('別タブを開かず、プレビュー書式で印刷する'),
      a: exportPdf,
      requiresCurrentFile: true,
      busy: isExportingPdf,
    },
    {
      icon: '💾',
      name: '全データバックアップ (.json)',
      // 本文・フォルダ・設定などを1ファイルに出力する。fid/secondaryFid/splitOpen/
      // activePane/wordCountMode/ghOpenTarget など persistKeys.js の localStorage
      // 専用キー（表示中のタブ等、端末ごとの状態）は対象外（C1）。
      desc: isExportingBackup
        ? '生成中…しばらくお待ちください'
        : '本文・フォルダ・設定などを1ファイルに出力（表示状態など端末ごとの設定は含みません）',
      a: exportBackup,
      busy: isExportingBackup,
    },
  ].map((e) => ({ ...e, disabled: Boolean(e.busy || (e.requiresCurrentFile && noFile)) }));

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && closeExportModal()}>
      <div className="modal">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 18 }}>
          <span className="mtitle">
            <ExportIcon s={16} />
            エクスポート
          </span>
          <button type="button" className="mclose" onClick={closeExportModal}>
            ×
          </button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--tx3)', marginBottom: 14 }}>
          現在のファイル：<span style={{ color: 'var(--tx2)' }}>{currentFile?.name}</span>
        </div>
        {EXPORTS.map((e, i) => (
          <button
            key={i}
            type="button"
            className="exp-card"
            onClick={e.a}
            disabled={e.disabled}
            aria-busy={e.busy || undefined}
          >
            <div className="exp-icon">{e.icon}</div>
            <div className="exp-info">
              <div className="exp-name">{e.name}</div>
              <div className="exp-desc">{e.desc}</div>
            </div>
            <ChevronRight />
          </button>
        ))}
        <button
          type="button"
          className="btn-ghost"
          style={{ width: '100%', marginTop: 6 }}
          onClick={closeExportModal}
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}

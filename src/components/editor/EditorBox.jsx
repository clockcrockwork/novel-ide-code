import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useEditor } from '@tiptap/react';
import { NodeSelection } from '@tiptap/pm/state';
import { useUIStore } from '../../stores/uiStore';
import StarterKit from '@tiptap/starter-kit';
import { useAnnotations } from '../../hooks/useAnnotations';
import {
  SlashCommentExtension,
  CommentParagraphExtension,
  InlineCommentMark,
  RubyNode,
  AnnotationExtension,
  UnicodeSafetyExtension,
  WritingRulesExtension,
  StyleCheckExtension,
  serializeToText,
  plainTextToPmJson,
  rawTextToPmJson,
} from '../../lib/tiptap';
import { CustomHardBreak } from '../../lib/tiptap/CustomHardBreak';
import { sanitizeClipboardEvent } from '../../lib/security/sanitizeClipboard';
import { unicodeSafetyPluginKey } from '../../lib/tiptap/UnicodeSafetyExtension';
import { deriveEditedSecurity } from '../../lib/security/validatePulledContent';
import { openRubyEditPopup } from '../../lib/rubyUtils';
import { viewportBottomLimit } from '../../lib/viewportMetrics';
import { useWritingPrefs } from '../../hooks/useWritingPrefs';
import { usePopoverClose } from '../../hooks/usePopoverClose';
import WriteMode from './WriteMode';
import PreviewMode from './PreviewMode';
import DiffMode from './DiffMode';
import StructureMode from './StructureMode';
import RubyEditPopup from './RubyEditPopup';

// 大きなドキュメントでは毎キーストロークの全文 serialize（O(n)）が入力レイテンシの主因になる。
// 一定サイズを超えたときだけ短時間コアレッシングし、通常サイズは従来どおり即時反映で挙動を変えない。
const LARGE_DOC_SERIALIZE_THRESHOLD = 50000; // ProseMirror position size（おおよそ数万文字相当）
const SERIALIZE_THROTTLE_MS = 64;
// security メタデータの再計算は入力停止後に遅延実行する（毎キーストロークのスロットリング）。
const SECURITY_SYNC_DEBOUNCE_MS = 2000;

function hasPasteConvertibleNotation(text) {
  if (!text) return false;
  return [
    /(^|\n)#{1,3}\s+\S/,
    /(^|\n)-{3,}\s*(?=\n|$)/,
    /(^|\n)\/\/[^\n]*/,
    /\*\*[^\n]+\*\*/,
    /\/\*[^\n]*\*\//,
    /%%[^%\n]*?%%/,
    /\{[^|}\n]+\|[^}\n]*\}/,
  ].some((pattern) => pattern.test(text));
}

function buildWarnSummary(findings) {
  if (!findings.length) return null;
  return findings.map((f) => `${f.label} ×${f.count}`).join('、');
}

function LoadingStatus({ className, label, children }) {
  return (
    <div className={className} role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

export default function EditorBox({
  content,
  onChange,
  onUnloadFlush,
  mode,
  editorRef,
  diffBase,
  showLineNumbers = false,
  fileId,
  readOnly = false,
  pane = 'primary',
  isActive = true,
  onFocusPane,
  annosRef,
  saveAnnosRef,
  setSharedAnnosRef,
  security = null,
  onSecurityChange = null,
}) {
  const setEditorSelectionText = useUIStore((s) => s.setEditorSelectionText);
  const clearEditorSelectionText = useUIStore((s) => s.clearEditorSelectionText);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [isModeTransitioning, setIsModeTransitioning] = useState(false);
  const prevFileIdRef = useRef(fileId);
  const pendingFileLoadRef = useRef(null);
  const prevModeRef = useRef(mode);
  const securitySyncTimerRef = useRef(null);
  const securityRef = useRef(security);
  const onSecurityChangeRef = useRef(onSecurityChange);
  // pull した EXTERNAL データの deny（バイナリ/巨大/不正な型）はエディタで開かず拒否する（#285）。
  // 拒否対象は EXTERNAL データのみ（security.decision='deny'）。全 pull/sync 経路は pull 時に
  // file.security を付与済みなので EXTERNAL バイナリはここで捕捉される。ローカル編集中の content は
  // binary 風でも拒否しない（拒否パネルで TipTap を空にすると undo 復旧できなくなるため）。
  // typeof チェックは非文字列由来の content.length / setContent クラッシュを防ぐ crash-guard。
  const isDenyContent = useMemo(
    () => security?.decision === 'deny' || typeof content !== 'string',
    [security, content],
  );
  // structure モードの段落分割も deny 時は走らせない（巨大/不正本文での全文 split を回避）。
  const paras = useMemo(
    () =>
      mode !== 'structure' || isDenyContent
        ? []
        : content.split(/\n\n+/).filter((p) => p.trim()),
    [content, mode, isDenyContent],
  );
  const denyMessage =
    security?.denyReason ||
    (typeof content !== 'string'
      ? '不正な形式のファイルのため開けません（テキストではありません）'
      : 'バイナリファイルのため開けません（テキストファイルのみ対応）');
  const lastEditorContent = useRef('');
  const readOnlyRef = useRef(readOnly);
  const isActiveRef = useRef(isActive);
  const modeRef = useRef(mode);
  const isComposingRef = useRef(false);
  const flushCompositionRef = useRef(null);
  const serializeFlushTimerRef = useRef(null);
  // 保留中の serialize（大ドキュメント throttle）を即時に確定させる。blur / 離脱 / ファイル切替で呼ぶ。
  const flushPendingSerialize = useRef(null);
  // onUnloadFlush prop の最新値を保持する ref。pagehide/visibilitychange ハンドラが古い prop を参照しないよう。
  const onUnloadFlushRef = useRef(onUnloadFlush);
  const justFocusedRef = useRef(false);
  const focusRafRef = useRef(null);
  const caretScrollRafRef = useRef(null);

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);
  usePopoverClose(ctxMenu ? closeCtxMenu : null);

  useEffect(() => {
    return () => {
      if (focusRafRef.current) cancelAnimationFrame(focusRafRef.current);
      if (caretScrollRafRef.current) cancelAnimationFrame(caretScrollRafRef.current);
      clearTimeout(securitySyncTimerRef.current);
    };
  }, []);

  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    flushCompositionRef.current = (view) => {
      if (readOnlyRef.current) return;
      const text = serializeToText(view.state.doc);
      if (text === lastEditorContent.current) return;
      lastEditorContent.current = text;
      onChange(text);
      useUIStore.getState().setLastEditorActivityAt(Date.now());
    };
    flushPendingSerialize.current = (view) => {
      if (serializeFlushTimerRef.current === null) return;
      clearTimeout(serializeFlushTimerRef.current);
      serializeFlushTimerRef.current = null;
      if (view) flushCompositionRef.current?.(view);
    };
  }, [onChange]);

  useEffect(() => {
    onUnloadFlushRef.current = onUnloadFlush;
  }, [onUnloadFlush]);

  useEffect(() => {
    securityRef.current = security;
  }, [security]);

  useEffect(() => {
    onSecurityChangeRef.current = onSecurityChange;
  }, [onSecurityChange]);

  // ファイル切替スケルトン
  useEffect(() => {
    if (prevFileIdRef.current === fileId) return;
    prevFileIdRef.current = fileId;
    // 保留中の serialize は旧ファイルのものなので、新ファイルへ誤って書き込まないよう破棄する。
    // 実運用ではファイル切替前にエディタが blur され flush 済みのため通常は no-op。
    if (serializeFlushTimerRef.current !== null) {
      clearTimeout(serializeFlushTimerRef.current);
      serializeFlushTimerRef.current = null;
    }
    // security 再計算タイマーも旧ファイル向けのものは破棄する。
    clearTimeout(securitySyncTimerRef.current);
    securitySyncTimerRef.current = null;
    pendingFileLoadRef.current = fileId;
    setIsFileLoading(true);
  }, [fileId]);

  // ファイル切り替えまたはアンマウント時にモーダルを閉じる。
  // onConfirm/onCancel が古い EditorView を参照したまま残るとクラッシュするため。
  useEffect(() => {
    return () => {
      useUIStore.getState().setPasteConfirmModal(null);
    };
  }, [fileId]);

  // モード切替スピナー（diff は自前のスケルトンがあるため除外）
  useEffect(() => {
    if (prevModeRef.current === mode) return;
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    if (prev === 'diff' || mode === 'diff') return;
    setIsModeTransitioning(true);
    let raf2;
    let raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setIsModeTransitioning(false));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [mode]);

  const updateEditorSelectionText = useCallback(
    (editorInstance) => {
      if (readOnlyRef.current || !isActiveRef.current || modeRef.current !== 'write') {
        clearEditorSelectionText();
        return;
      }
      const { from, to } = editorInstance.state.selection;
      if (from === to) {
        clearEditorSelectionText();
        return;
      }
      const selected = editorInstance.state.doc.textBetween(from, to, '\n');
      setEditorSelectionText(selected || '');
    },
    [clearEditorSelectionText, setEditorSelectionText],
  );

  const editor = useEditor({
    editable: !readOnly,
    extensions: [
      StarterKit.configure({ undoRedo: {}, hardBreak: false }),
      CustomHardBreak,
      SlashCommentExtension,
      CommentParagraphExtension,
      InlineCommentMark,
      RubyNode,
      AnnotationExtension,
      UnicodeSafetyExtension,
      WritingRulesExtension,
      StyleCheckExtension.configure({ editorId: pane }),
    ],
    content: '',
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'テキストエディタ',
        spellcheck: 'false',
        autocomplete: 'off',
        autocorrect: 'off',
        autocapitalize: 'off',
      },
      handleDOMEvents: {
        compositionstart: () => {
          isComposingRef.current = true;
          return false;
        },
        compositionend: (view) => {
          isComposingRef.current = false;
          flushCompositionRef.current?.(view);
          return false;
        },
        blur: (view) => {
          if (isComposingRef.current) {
            isComposingRef.current = false;
            flushCompositionRef.current?.(view);
          } else {
            flushPendingSerialize.current?.(view);
          }
          return false;
        },
      },
      // focus 直後 2フレームは scrollIntoView を抑制（タッチデバイスのみ。iOS Safari の focus-scroll 競合対策）
      handleScrollToSelection: () => {
        if (justFocusedRef.current && window.matchMedia('(pointer: coarse)').matches) return true;
        return false;
      },
      handlePaste: (view, event) => {
        if (readOnlyRef.current) return false;

        // テキスト系データのないクリップボード（画像のみ等）はデフォルト処理に委ねる
        const hasHtml = event.clipboardData?.types?.includes('text/html');
        const hasPlain = event.clipboardData?.types?.includes('text/plain');
        if (!hasHtml && !hasPlain) return false;

        const result = sanitizeClipboardEvent(event);

        if (result.htmlStripped)
          useUIStore.getState().addToast('貼り付けたHTMLから危険なコードを除去しました');
        if (result.denyCharsRemoved > 0)
          useUIStore
            .getState()
            .addToast(`危険な制御文字 ${result.denyCharsRemoved} 件を除去しました`);
        if (result.warnFindings.length > 0)
          useUIStore
            .getState()
            .addToast(`不可視文字が含まれています: ${buildWarnSummary(result.warnFindings)}`);

        // sanitize 後にテキストが空になった場合（<script>のみ等）は貼り付けを完全ブロックする。
        // return false だと event.preventDefault() が呼ばれずデフォルト貼り付けが走るため
        // event.preventDefault() + return true でブラウザのデフォルトも阻止する。
        if (!result.text) {
          event.preventDefault();
          return true;
        }

        // 記法がない場合もサニタイズ済みテキストを挿入し、元のクリップボードデータが
        // ProseMirrorのデフォルト処理で使われないようにする。
        // plainTextToPmJson ではなく rawTextToPmJson を使用する：ディテクターが false を返した
        // テキストは記法変換すべきでない。parseNormalText が pendingLines.join('\n') で
        // 改行入りテキストを parseInline に渡すため **line1\nline2** 等がサイレント変換される
        // 可能性があり、rawTextToPmJson（改行のみ処理）で一貫性を保つ。
        if (!hasPasteConvertibleNotation(result.text)) {
          event.preventDefault();
          const doc = view.state.schema.nodeFromJSON(rawTextToPmJson(result.text));
          view.dispatch(
            view.state.tr.replaceSelection(doc.slice(0, doc.content.size)).scrollIntoView(),
          );
          return true;
        }

        event.preventDefault();

        const capturedView = view;
        const capturedText = result.text;

        useUIStore.getState().setPasteConfirmModal({
          text: capturedText,
          warnSummary: buildWarnSummary(result.warnFindings),
          onConfirm: () => {
            const pastedDoc = capturedView.state.schema.nodeFromJSON(
              plainTextToPmJson(capturedText),
            );
            capturedView.dispatch(
              capturedView.state.tr
                .replaceSelection(pastedDoc.slice(0, pastedDoc.content.size))
                .scrollIntoView(),
            );
            useUIStore.getState().setPasteConfirmModal(null);
          },
          onCancel: () => {
            // rawTextToPmJson で記法変換せずに段落/hardBreak 構造のみ生成する
            const doc = capturedView.state.schema.nodeFromJSON(rawTextToPmJson(capturedText));
            capturedView.dispatch(
              capturedView.state.tr
                .replaceSelection(doc.slice(0, doc.content.size))
                .scrollIntoView(),
            );
            useUIStore.getState().setPasteConfirmModal(null);
          },
        });

        return true;
      },
    },
    onUpdate: ({ editor }) => {
      if (readOnlyRef.current) return;
      clearEditorSelectionText();
      if (isComposingRef.current) return;
      // UnicodeSafetyExtension が同じ docChanged で既に計算した findings を再利用して
      // security メタデータを debounced 更新する（独立した O(n) 再走査を追加しない）。
      // LARGE_DOC 早期 return の前に置くことで大ドキュメント編集でも security が更新される。
      // 2000ms デバウンスにより発火時には SERIALIZE_THROTTLE_MS（最大 64ms）が完了し
      // lastEditorContent.current.length は最新値を返す。
      if (onSecurityChangeRef.current) {
        clearTimeout(securitySyncTimerRef.current);
        securitySyncTimerRef.current = setTimeout(() => {
          if (editor.isDestroyed) return;
          const editorState = editor.state;
          const pluginState = unicodeSafetyPluginKey.getState(editorState);
          const ranges = pluginState?.ranges ?? [];
          const newSecurity = deriveEditedSecurity(
            ranges,
            securityRef.current,
            lastEditorContent.current.length,
          );
          if (newSecurity && newSecurity !== securityRef.current)
            onSecurityChangeRef.current(newSecurity);
        }, SECURITY_SYNC_DEBOUNCE_MS);
      }
      // 大ドキュメントは全文 serialize（O(n)）を SERIALIZE_THROTTLE_MS で leading+trailing コアレッシング。
      // 窓の先頭で即時 serialize して content/dirty/IDB/sync を確定するため、stale な filesRef 窓を作らない
      // （online/auth 復帰の同期や別タブ操作が古い本文を見ない）。窓中の追加編集は trailing で確定する。
      // 通常サイズのファイルは閾値ゲートにより従来どおり即時反映で挙動不変。
      if (editor.state.doc.content.size > LARGE_DOC_SERIALIZE_THRESHOLD) {
        const view = editor.view;
        if (serializeFlushTimerRef.current === null) {
          flushCompositionRef.current?.(view);
          serializeFlushTimerRef.current = setTimeout(() => {
            serializeFlushTimerRef.current = null;
            flushCompositionRef.current?.(view);
          }, SERIALIZE_THROTTLE_MS);
        }
        return;
      }
      const text = serializeToText(editor.state.doc);
      lastEditorContent.current = text;
      onChange(text);
      useUIStore.getState().setLastEditorActivityAt(Date.now());
    },
    onSelectionUpdate: ({ editor }) => {
      updateEditorSelectionText(editor);
    },
    onFocus: () => {
      // focus 直後 2フレームは ProseMirror の scrollIntoView を抑制し Safari focus-scroll を優先する
      justFocusedRef.current = true;
      if (focusRafRef.current) cancelAnimationFrame(focusRafRef.current);
      focusRafRef.current = requestAnimationFrame(() => {
        focusRafRef.current = requestAnimationFrame(() => {
          justFocusedRef.current = false;
          focusRafRef.current = null;
        });
      });
    },
  });

  const [lineNumbers, setLineNumbers] = useState([1]);

  // ページ離脱・タブ非表示・アンマウント時に保留中の serialize を確定させる（取りこぼし防止）
  useEffect(() => {
    if (!editor) return;
    const flush = () => {
      // 保留中の throttle タイマーは必ず止める（破棄済み view での発火・タイマーリークを防ぐ）。
      const hadPending = serializeFlushTimerRef.current !== null;
      if (hadPending) {
        clearTimeout(serializeFlushTimerRef.current);
        serializeFlushTimerRef.current = null;
      }
      if (editor.isDestroyed || !editor.view) return;
      // 保留がなければ最新は既に onChange 済み（小ドキュメント or flush 後）。
      // AppContext の pagehide/beforeunload IDB flush が拾うため、ここでは何もしない。
      if (!hadPending) return;
      // onChange は現在の active fid（fidRef）へ書くため、ファイル切替 cleanup では誤ったファイルへ
      // 書き込む恐れがある。ここでは serialize し、closure が束縛する fileId 宛に IDB へ直接書く
      // （AppContext の 500ms debounce をバイパス）。
      const text = serializeToText(editor.view.state.doc);
      if (text !== lastEditorContent.current) {
        lastEditorContent.current = text;
        onUnloadFlushRef.current?.(fileId, text);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [editor, fileId]);

  const { annos, saveAnnos } = useAnnotations(fileId, editor);

  useEffect(() => {
    if (!isActive) return;
    if (annosRef) annosRef.current = annos;
    if (setSharedAnnosRef) setSharedAnnosRef.current?.(annos);
  }, [annos, isActive, annosRef, setSharedAnnosRef]);

  useEffect(() => {
    if (!isActive) return;
    if (saveAnnosRef) saveAnnosRef.current = saveAnnos;
  }, [saveAnnos, isActive, saveAnnosRef]);

  const { rules } = useWritingPrefs();
  useEffect(() => {
    if (editor) editor.commands.setWritingRules(rules);
  }, [editor, rules]);

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!isActive || mode !== 'write' || readOnly) clearEditorSelectionText();
  }, [clearEditorSelectionText, fileId, isActive, mode, readOnly]);

  useEffect(() => {
    if (editorRef && isActive) editorRef.current = editor;
  }, [editor, editorRef, isActive]);

  useEffect(() => {
    if (!editor) return;
    // deny content（バイナリ/巨大/Bidi 等）は TipTap/ProseMirror に渡さない（#285）。通知パネルのみ表示。
    // エディタ内部状態もクリアし、別ファイルへ切替後に再表示したとき stale な本文が残らないようにする。
    if (isDenyContent) {
      if (lastEditorContent.current !== '') {
        editor.commands.setContent(plainTextToPmJson(''), false);
        lastEditorContent.current = '';
      }
      if (pendingFileLoadRef.current === fileId) {
        pendingFileLoadRef.current = null;
        queueMicrotask(() => setIsFileLoading(false));
      }
      return;
    }
    if (content !== lastEditorContent.current) {
      editor.commands.setContent(plainTextToPmJson(content), false);
      const serialized = serializeToText(editor.state.doc);
      lastEditorContent.current = serialized;
      if (!readOnly && serialized !== content) onChange(serialized);
    }
    if (pendingFileLoadRef.current === fileId) {
      pendingFileLoadRef.current = null;
      queueMicrotask(() => setIsFileLoading(false));
    }
  }, [content, fileId, editor, onChange, readOnly, isDenyContent]);

  const computeLineNumbersRef = useRef(null);
  useEffect(() => {
    if (!editor) return;
    const compute = () => {
      const nodes = [];
      editor.state.doc.forEach((node) => nodes.push(node));
      let count = 0;
      for (const node of nodes) {
        let brCount = 0;
        node.content.forEach((child) => {
          if (child.type.name === 'hardBreak') brCount++;
        });
        count += brCount + 1;
      }
      const newCount = count === 0 ? 1 : count > 2000 ? 0 : count;
      setLineNumbers((prev) => {
        if (prev.length === newCount) return prev;
        return newCount === 0 ? [] : Array.from({ length: newCount }, (_, i) => i + 1);
      });
    };
    computeLineNumbersRef.current = compute;
    editor.on('update', compute);
    compute();
    return () => {
      editor.off('update', compute);
      computeLineNumbersRef.current = null;
    };
  }, [editor]);
  // setContent(..., false) 後に update が発火しないケースを補完
  useEffect(() => {
    computeLineNumbersRef.current?.();
  }, [content]);

  /* ── Context menu ── */
  const clampCtxPoint = useCallback(
    (x, y) => ({
      x: Math.min(Math.max(x, 8), Math.max(8, window.innerWidth - 228)),
      // 下端はフッター/キーボードに被らないよう viewportBottomLimit を使う（メニュー高ぶん控える）
      y: Math.min(Math.max(y - 36, 54), Math.max(54, viewportBottomLimit() - 144)),
    }),
    [],
  );

  const eventPoint = (e) => {
    const touch = e.changedTouches?.[0] || e.touches?.[0];
    return {
      x: touch?.clientX ?? e.clientX ?? window.innerWidth / 2,
      y: touch?.clientY ?? e.clientY ?? window.innerHeight - 96,
    };
  };

  const focusEditorAtPoint = useCallback(
    (e) => {
      if (readOnly || !editor?.view) return;
      if (e.button != null && e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : e.target.parentElement;
      if (target?.closest('.ctx-menu')) return;
      const editorDom = editor.view.dom;
      const clickedEditor = e.target === editorDom;
      const clickedInsideText = target?.closest('.ProseMirror') === editorDom && !clickedEditor;
      if (clickedInsideText) return;
      const { x, y } = eventPoint(e);
      const rect = editorDom.getBoundingClientRect();
      const coords = {
        left: Math.min(Math.max(x, rect.left + 1), rect.right - 1),
        top: Math.min(Math.max(y, rect.top + 1), rect.bottom - 1),
      };
      const endPos = editor.state.doc.content.size;
      // 本文が空・短いときに最終ブロックより下の余白をタップしたら、確実に末尾へカーソルを置く
      // （手の小さいユーザーが画面下部をタップしても末尾に入るように）。それ以外は座標解決を尊重。
      // 末尾の bottom は ProseMirror の coordsAtPos を優先（拡張機能等が挿入する PM 管理外の
      // lastElementChild に依存しない）。失敗時のみ DOM 参照にフォールバック。
      let belowContent = true;
      try {
        const endCoords = editor.view.coordsAtPos(endPos);
        if (endCoords) belowContent = y > endCoords.bottom;
      } catch {
        const lastBlock = editorDom.lastElementChild;
        belowContent = lastBlock ? y > lastBlock.getBoundingClientRect().bottom : true;
      }
      const found = belowContent ? null : editor.view.posAtCoords(coords);
      const pos = found?.pos ?? endPos;
      e.preventDefault();
      onFocusPane?.(pane);
      editor
        .chain()
        .setTextSelection(Math.min(Math.max(pos, 0), endPos))
        .focus()
        .run();
      // focus 直後 2フレームは handleScrollToSelection を抑制している（iOS focus-scroll 優先）ため、
      // 余白タップで末尾へ送った場合はその後にキャレットをキーボード直上へ明示スクロールする。
      if (belowContent) {
        if (caretScrollRafRef.current) cancelAnimationFrame(caretScrollRafRef.current);
        caretScrollRafRef.current = requestAnimationFrame(() => {
          caretScrollRafRef.current = requestAnimationFrame(() => {
            caretScrollRafRef.current = null;
            if (!editor.isDestroyed) editor.commands.scrollIntoView();
          });
        });
      }
    },
    [editor, onFocusPane, pane, readOnly],
  );

  const showCtx = (e) => {
    if (readOnly) return;
    if (e.type === 'mouseup' && e.button !== 0) return;
    onFocusPane?.(pane);
    if (!editor) return;
    const { x, y } = eventPoint(e);
    setTimeout(() => {
      const sel = editor.state.selection;
      if (sel instanceof NodeSelection) {
        setCtxMenu(null);
        return;
      }
      const { from, to } = sel;
      if (from === to) {
        setCtxMenu(null);
        return;
      }
      setCtxMenu(clampCtxPoint(x, y));
    }, 20);
  };

  const handleContextMenu = (e) => {
    if (readOnly || !editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    e.preventDefault();
    showCtx(e);
  };

  useEffect(() => {
    const fn = () => setCtxMenu(null);
    document.addEventListener('pointerdown', fn);
    return () => document.removeEventListener('pointerdown', fn);
  }, []);

  const ctxAction = (action) => {
    if (!editor) return;
    if (action === 'bold') editor.chain().focus().toggleBold().run();
    else if (action === 'h1') editor.chain().focus().toggleHeading({ level: 1 }).run();
    else if (action === 'h2') editor.chain().focus().toggleHeading({ level: 2 }).run();
    else if (action === 'comment') {
      const { from, to } = editor.state.selection;
      if (from !== to) {
        const sel = editor.state.doc.textBetween(from, to);
        editor.chain().focus().insertContent(`/*${sel}*/`).run();
      }
    } else if (action === 'slashcmt') {
      editor.chain().focus().setNode('slashComment').run();
    } else if (action === 'ruby') {
      const { from, to } = editor.state.selection;
      const base = from !== to ? editor.state.doc.textBetween(from, to) : '漢字';
      editor
        .chain()
        .focus()
        .insertContent({ type: 'ruby', attrs: { base, reading: '' } })
        .run();
      const insertedPos = editor.state.selection.from - 1;
      openRubyEditPopup(editor, insertedPos);
    } else if (action === 'quote') {
      const { from, to } = editor.state.selection;
      if (from !== to) {
        const sel = editor.state.doc.textBetween(from, to);
        editor.chain().focus().insertContent(`「${sel}」`).run();
      }
    } else if (action === 'copy') {
      const { from, to } = editor.state.selection;
      navigator.clipboard?.writeText(editor.state.doc.textBetween(from, to));
    }
    setCtxMenu(null);
  };

  /* ── Structure reorder ── */
  const reorder = useCallback(
    (from, to) => {
      if (from === to) return;
      const arr = [...paras];
      const [item] = arr.splice(from, 1);
      arr.splice(to, 0, item);
      onChange(arr.join('\n\n'));
    },
    [paras, onChange],
  );

  const rubyEditPopup = useUIStore((s) => s.rubyEditPopup);
  const setRubyEditPopup = useUIStore((s) => s.setRubyEditPopup);

  /* ── Mode routing ── */
  // deny content（バイナリ/巨大/Bidi 等）は preview / write / structure / diff いずれのモードでも
  // エディタに渡さず、拒否理由を表示する（#285）
  if (isDenyContent)
    return (
      <div className="binary-file-notice" role="alert">
        <p className="binary-file-notice-title">このファイルは表示できません</p>
        <p className="binary-file-notice-body">{denyMessage}</p>
      </div>
    );

  if (mode === 'preview')
    return (
      <div style={{ position: 'relative', minHeight: '100%' }}>
        {isModeTransitioning && (
          <LoadingStatus className="mode-spinner-overlay" label="表示を切り替えています">
            <div className="mode-spinner" />
          </LoadingStatus>
        )}
        <PreviewMode
          content={content}
          annos={annos}
          saveAnnos={saveAnnos}
          editorInstance={editor}
          onFocusPane={onFocusPane}
          pane={pane}
        />
      </div>
    );

  if (mode === 'diff') return <DiffMode content={content} diffBase={diffBase} />;

  if (mode === 'structure')
    return (
      <div style={{ position: 'relative', minHeight: '100%' }}>
        {isModeTransitioning && (
          <LoadingStatus className="mode-spinner-overlay" label="表示を切り替えています">
            <div className="mode-spinner" />
          </LoadingStatus>
        )}
        <StructureMode paras={paras} onReorder={reorder} />
      </div>
    );

  return (
    <div style={{ position: 'relative', minHeight: '100%' }}>
      {isModeTransitioning && (
        <LoadingStatus className="mode-spinner-overlay" label="表示を切り替えています">
          <div className="mode-spinner" />
        </LoadingStatus>
      )}
      {isFileLoading && (
        <LoadingStatus className="loading-overlay" label="ファイルを読み込んでいます">
          <div className="loading-overlay-inner">
            <div
              className="skeleton-block"
              style={{ width: '55%', height: 20, marginBottom: 24 }}
            />
            <div className="skeleton-block" style={{ width: '92%' }} />
            <div className="skeleton-block" style={{ width: '85%' }} />
            <div className="skeleton-block" style={{ width: '88%' }} />
            <div className="skeleton-block" style={{ width: '60%', marginBottom: 24 }} />
            <div className="skeleton-block" style={{ width: '78%' }} />
            <div className="skeleton-block" style={{ width: '90%' }} />
            <div className="skeleton-block" style={{ width: '72%' }} />
          </div>
        </LoadingStatus>
      )}
      <WriteMode
        editor={editor}
        content={content}
        showLineNumbers={showLineNumbers}
        readOnly={readOnly}
        lineNumbers={lineNumbers}
        ctxMenu={ctxMenu}
        ctxAction={ctxAction}
        focusEditorAtPoint={focusEditorAtPoint}
        showCtx={showCtx}
        handleContextMenu={handleContextMenu}
        onFocusPane={onFocusPane}
        pane={pane}
      />
      {rubyEditPopup && (
        <RubyEditPopup
          key={rubyEditPopup.pos}
          editor={editor}
          popup={rubyEditPopup}
          onClose={() => setRubyEditPopup(null)}
        />
      )}
    </div>
  );
}

import { useState, useRef, useEffect, useId } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { restoreFromBackup } from '../../lib/restore';
import { clearIdePrefixedStorage } from '../../lib/clearLocalData';

// JSON バックアップからの全置換復元（#216 / #219）の確認モーダル。
// ClearDataModal（取り消せない旨・キャンセル可・busy 中は二重実行不可）と
// PrePushModal（フォーカストラップ・previousFocus 復帰）の慣習に倣う。
// ファイル選択 UI（<input type="file"> + file.text()）はこのリポジトリで前例が無いため新規。
export default function RestoreDataModal() {
  const restoreDataModal = useUIStore((s) => s.restoreDataModal);
  const setRestoreDataModal = useUIStore((s) => s.setRestoreDataModal);

  const [fileName, setFileName] = useState('');
  const [fileText, setFileText] = useState(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 復元は成功したが、この端末の ide_* localStorage の削除に失敗した状態（A4）。
  // true の間は自動リロードせず、ユーザーが明示的に押せる再読み込みボタンを表示する。
  const [restoreCleanupFailed, setRestoreCleanupFailed] = useState(false);

  const dialogRef = useRef(null);
  const openerRef = useRef(null);
  const titleId = useId();
  const errorId = useId();
  // 世代カウンタ: 選び直した直後に前の file.text() が後から解決すると、表示中の
  // ファイル名と実際に復元される内容がずれる（復元は不可逆なので黙って許容しない）。
  const fileGenRef = useRef(0);

  const resetLocalState = () => {
    // 世代を進める: 読み込み中に閉じて開き直した場合、前回の file.text() が後から解決しても
    // 破棄される（B1: 進めないと fileName が空のまま fileText だけ埋まり得た）。
    fileGenRef.current += 1;
    setFileName('');
    setFileText(null);
    setReading(false);
    setError('');
    setBusy(false);
    setRestoreCleanupFailed(false);
  };

  useEffect(() => {
    if (!restoreDataModal) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- モーダルを開いた瞬間に前回の選択・エラー状態を即クリアする正当な副作用
    resetLocalState();
    openerRef.current = document.activeElement;
    const opener = openerRef.current;
    return () => {
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, [restoreDataModal]);

  if (!restoreDataModal) return null;

  const close = () => {
    // restoreCleanupFailed 中は IDB が復元後の内容に置換済みだが、filesRef 等のメモリ状態は
    // 復元前のまま。閉じて使い続けると復元前のレコードが復元後の DB へ書き戻され、同期経由で
    // push されうる（stale push）。安全な出口はリロードのみのため busy 中と同様に閉じさせない。
    if (busy || restoreCleanupFailed) return;
    setRestoreDataModal(null);
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    const gen = ++fileGenRef.current;
    setError('');
    setFileText(null);
    if (!file) {
      setFileName('');
      setReading(false);
      return;
    }
    setFileName(file.name);
    setReading(true);
    try {
      const text = await file.text();
      if (gen !== fileGenRef.current) return; // 選び直された後なら破棄する
      setFileText(text);
    } catch {
      if (gen !== fileGenRef.current) return;
      setError(`ファイル「${file.name}」の読み込みに失敗しました。`);
      setFileText(null);
    } finally {
      if (gen === fileGenRef.current) setReading(false);
    }
  };

  const handleRestore = async () => {
    if (busy || !fileText) return;
    setBusy(true);
    setError('');

    let result;
    try {
      result = await restoreFromBackup(fileText);
    } catch {
      setError('復元中に予期しないエラーが発生しました。');
      setBusy(false);
      return;
    }
    if (!result.ok) {
      setError(result.message || '復元に失敗しました。');
      setBusy(false);
      return;
    }

    // localStorage 削除の理由は clearLocalData.js の clearIdePrefixedStorage コメントを正本と
    // する。削除に失敗した場合は自動リロードしない（A4）: 削除できなかった ide_* が残ったまま
    // リロードすると、次回起動時の hydrate フォールバックで復元前のデータが復活しうるため。
    const cleanup = clearIdePrefixedStorage();
    if (!cleanup.ok) {
      setError(
        '復元は完了しました。ただし、この端末に残っていた古い設定・ファイル一覧を削除できませんでした。このまま再読み込みすると、削除できなかった古いデータが復活する可能性があります。内容を確認のうえ「再読み込み」を押してください。',
      );
      setBusy(false);
      setRestoreCleanupFailed(true);
      return;
    }

    try {
      window.location.reload(); // 成功後は必ずフルリロードする（filesRef 等のメモリ状態を残さない）
      // busy はここで false に戻さない（B2: reload 完了までの窓で ×・キャンセル・復元ボタンを
      // 再有効化しない）。
    } catch {
      // reload() 自体が失敗する環境向け（B3）。復元は既に完了しているため失敗扱いにしない。
      setError('復元は完了しています。ページを再読み込みしてください。');
      setBusy(false);
    }
  };

  const handleManualReload = () => {
    window.location.reload();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!busy) close();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = dialogRef.current?.querySelectorAll(
        'input:not([disabled]), button:not([disabled])',
      );
      if (!focusables?.length) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeIdx = Array.from(focusables).indexOf(document.activeElement);
      if (activeIdx === -1) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && activeIdx === 0) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeIdx === focusables.length - 1) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="overlay" onClick={() => !busy && !restoreCleanupFailed && close()}>
      <div
        ref={dialogRef}
        className="modal"
        style={{ maxWidth: 440 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="mtitle">
          <span id={titleId}>バックアップから復元</span>
          <button
            type="button"
            className="mclose"
            onClick={close}
            disabled={busy || restoreCleanupFailed}
          >
            ×
          </button>
        </div>
        <p style={{ margin: '16px 0 8px', fontSize: 13, color: 'var(--tx2)', lineHeight: 1.7 }}>
          選択した JSON バックアップの内容で、この端末の
          <strong> 本文・ファイル・フォルダ・設定・連携情報 </strong>
          をすべて置き換えます。
          <br />
          テーマ・配色・サイドバー位置・エディタ表示設定などの UI 設定はバックアップの対象外のため、
          復元後は既定値に戻ります。
          <br />
          <strong style={{ color: 'var(--err, #e74c3c)' }}>
            現在のデータは上書きされ、元に戻せません。
          </strong>
          GitHub に push 済みの内容は影響を受けません。
        </p>

        <input
          type="file"
          accept="application/json,.json"
          onChange={handleFileChange}
          disabled={busy || restoreCleanupFailed}
          aria-label="バックアップファイル (.json) を選択"
          aria-describedby={error ? errorId : undefined}
          style={{ marginTop: 12, fontSize: 12, color: 'var(--tx)', width: '100%' }}
        />
        {fileName && !error && (
          <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--tx3)' }}>
            {reading ? `読み込み中: ${fileName}` : `選択中: ${fileName}`}
          </p>
        )}

        {error && (
          <p
            id={errorId}
            role="alert"
            style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--danger, #e5534b)' }}
          >
            {error}
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
          {restoreCleanupFailed ? (
            <button
              type="button"
              style={{
                padding: '8px 14px',
                background: 'var(--ac, #4a9eff)',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                color: '#fff',
                fontFamily: 'inherit',
              }}
              onClick={handleManualReload}
            >
              再読み込み
            </button>
          ) : (
            <button
              type="button"
              style={{
                padding: '8px 14px',
                background: 'var(--err, #e74c3c)',
                border: 'none',
                borderRadius: 6,
                cursor: busy || !fileText ? 'default' : 'pointer',
                fontSize: 13,
                color: '#fff',
                fontFamily: 'inherit',
                opacity: busy || !fileText ? 0.6 : 1,
              }}
              onClick={handleRestore}
              disabled={busy || !fileText}
            >
              {busy ? '復元中…' : 'このバックアップで復元する'}
            </button>
          )}
          {!restoreCleanupFailed && (
            <button
              type="button"
              style={{
                padding: '7px 14px',
                background: 'none',
                border: 'none',
                cursor: busy ? 'default' : 'pointer',
                fontSize: 13,
                color: 'var(--tx3)',
                fontFamily: 'inherit',
              }}
              onClick={close}
              disabled={busy}
            >
              キャンセル
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState, useRef, useEffect, useCallback, useId } from 'react';

// 名前入力用の汎用モーダル。onSubmit は { ok, reason } を返す非同期関数。
// 失敗時はモーダルを閉じずエラーを表示する（失敗を成功扱いにしない）。
export default function NameInputModal({
  title,
  initialValue = '',
  submitLabel,
  onSubmit,
  onClose,
  // 入力段階の目安上限（UTF-16 単位）。厳密な上限は保存時の sanitizeFileName（コードポイント単位、
  // NAME_MAX=100）が正で、サロゲートペアを含む名前では両者の 100 の意味がずれる
  maxLength = 100,
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const openerRef = useRef(null);
  // setState は非同期バッチのため、連打・ダブルクリックの同一ティック内二重送信は ref で同期ガードする
  const submittingRef = useRef(false);
  const titleId = useId();
  const errorId = useId();

  useEffect(() => {
    openerRef.current = document.activeElement;
    inputRef.current?.focus();
    inputRef.current?.select();
    const opener = openerRef.current;
    return () => {
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  // pending 中は全 focusable が disabled になりフォーカスが body へ落ちるため、
  // dialog 自体（tabIndex=-1）へ退避させて Tab/Escape がダイアログ外へ漏れないようにする。
  // pending 解除後（失敗時）は input へ戻す。
  useEffect(() => {
    if (pending) dialogRef.current?.focus();
    else if (error) inputRef.current?.focus();
  }, [error, pending]);

  const submit = useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setPending(true);
    setError('');
    try {
      const result = await onSubmit(value);
      if (result?.ok) {
        onClose();
      } else {
        setError(result?.reason || '保存に失敗しました');
      }
    } catch {
      setError('保存に失敗しました');
    } finally {
      setPending(false);
      submittingRef.current = false;
    }
  }, [value, onSubmit, onClose]);

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!pending) onClose();
      return;
    }
    if (e.key === 'Tab') {
      // フォーカストラップ: 自ダイアログ内の有効な focusable のみを循環する。
      // pending 中に全要素が disabled ならフォーカスをダイアログ外へ逃さない。
      const focusables = dialogRef.current?.querySelectorAll(
        'input:not([disabled]), button:not([disabled])',
      );
      if (!focusables?.length) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      // dialog 自体（tabIndex=-1 退避先）にフォーカスがある場合も外へ漏らさず先頭/末尾へ入れる
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
    <div className="overlay" onClick={() => !pending && onClose()}>
      <div
        ref={dialogRef}
        className="modal"
        style={{ maxWidth: 360 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="mtitle">
          <span id={titleId}>{title}</span>
          <button type="button" className="mclose" onClick={onClose} disabled={pending}>
            ×
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // IME 変換確定の Enter で暗黙送信しない（isComposing は KeyboardEvent にのみ載る）
              if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault();
            }}
            disabled={pending}
            maxLength={maxLength}
            aria-label={title}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? errorId : undefined}
            style={{
              width: '100%',
              marginTop: 14,
              padding: '8px 10px',
              fontSize: 13,
              fontFamily: 'inherit',
              color: 'var(--tx)',
              background: 'var(--bg)',
              border: '1px solid var(--bd)',
              borderRadius: 6,
              boxSizing: 'border-box',
            }}
          />
          {error && (
            <p
              id={errorId}
              role="alert"
              style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--danger, #e5534b)' }}
            >
              {error}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              style={{
                padding: '7px 14px',
                background: 'none',
                border: '1px solid var(--bd)',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--tx)',
                fontFamily: 'inherit',
              }}
            >
              キャンセル
            </button>
            <button type="submit" className="btn-primary" disabled={pending}>
              {pending ? '保存中…' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

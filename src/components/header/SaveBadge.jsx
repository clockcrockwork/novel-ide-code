// ローカル（IndexedDB）保存状態の常時表示バッジ（#215, MVP_PLAN 通知レベル Level 0）。
// SyncBadge の dot + .hide-m ラベル構造を mirror する。GitHub 未接続でも表示する
// （ローカルファースト: ログイン状態で gate しない）。
//
// アクセシビリティ: role="status" + aria-live="polite" で保存状態の変化を読み上げる
// （modern-web-guidance「accessibility」§8: "Saved" ステータスは polite が適切）。

const DOT = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  display: 'inline-block',
};

function labelTime(ts) {
  return new Date(ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

export default function SaveBadge({ status }) {
  const { state, lastSavedAt, error, detail } = status;

  let color;
  let label;
  let title;
  let pulse = false;

  if (state === 'saving') {
    color = 'var(--ac)';
    label = '保存中';
    title = '保存中';
    pulse = true;
  } else if (state === 'oversize') {
    color = 'var(--ac-red, #e74c3c)';
    label = 'サイズ超過';
    title = `ファイルサイズ超過のため未保存${detail ? `: ${detail}` : ''}`;
  } else if (state === 'error') {
    color = 'var(--ac-red, #e74c3c)';
    label = '保存失敗';
    title = `保存に失敗しました${detail ? `: ${detail}` : ''}${error?.message ? `（${error.message}）` : ''}`;
  } else if (state === 'dirty') {
    color = 'var(--tx2)';
    label = '未保存';
    title = '未保存の変更があります';
  } else if (state === 'saved' && lastSavedAt) {
    const t = labelTime(lastSavedAt);
    color = 'var(--ac-green)';
    label = t;
    title = `保存済み: ${t}`;
  } else {
    return null;
  }

  // 警告（保存失敗・サイズ超過）はモバイルでも視覚表示する（`.hide-m` で隠さない）。
  const isWarning = state === 'error' || state === 'oversize';
  // 読み上げは意味のある状態（警告・保存完了）のみ。saving/dirty の interstitial を live region
  // に載せると執筆中の打鍵ごとに読み上げノイズになる（modern-web-guidance §8: interstitial な
  // "Updating…" 系は live region に載せない）。視覚ラベルは全状態で出す（aria-hidden）。
  const announce = isWarning || state === 'saved';

  return (
    <span
      role="status"
      aria-live="polite"
      title={title}
      style={{ fontSize: 11, color, display: 'flex', alignItems: 'center', gap: 3 }}
    >
      <span
        aria-hidden="true"
        style={{
          ...DOT,
          background: 'currentColor',
          animation: pulse ? 'pulse 1s ease-in-out infinite' : undefined,
        }}
      />
      {/* SR 用: 意味のある状態のみ a11y ツリーに残し、polite live region がモバイル（.hide-m で
          視覚ラベルが display:none になる幅）でも読み上げる。routine 状態は空にしてノイズを避ける。 */}
      <span className="sr-only">{announce ? title : ''}</span>
      {/* 視覚用: 読み上げは上の sr-only が担うため aria-hidden で二重読み上げを防ぐ。
          警告状態はモバイルでも表示、日常状態（saving/dirty/saved）は従来どおり .hide-m で省略。 */}
      <span className={isWarning ? undefined : 'hide-m'} aria-hidden="true">
        {label}
      </span>
    </span>
  );
}

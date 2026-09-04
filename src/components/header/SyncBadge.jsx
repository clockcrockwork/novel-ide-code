import { syncFailureMessage } from '../../lib/syncErrors';
import { ERROR_LABEL } from './syncBadgeLabels';

// 優先順位: オフライン > 競合あり > 同期中 > 失敗（category 別ラベル）> 同期待ち > 最終同期時刻。
// 上から順に early return する。新しい分岐を足す場合はこの順位に沿って挿入位置を決めること。
//
// 「競合あり」と「再同期が必要」は別概念:
//   競合あり     — ファイル本文が local / remote で食い違い、利用者の解決操作が要る（押せる）
//   再同期が必要 — remote 側が先に進んでいて push が弾かれた（errorCategory === 'conflict'）。
//                  解決操作は不要で、読み込み直して同期し直せばよい
// どちらも「競合」と呼ぶと利用者もサポートも毎回どちらか確認することになるため、語を分ける。
export default function SyncBadge({
  status,
  isOnline,
  conflictData,
  onConflictClick,
  hasPendingChanges,
}) {
  if (!isOnline) {
    return (
      <span
        title="オフライン"
        style={{ fontSize: 11, color: 'var(--tx3)', display: 'flex', alignItems: 'center', gap: 3 }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--tx3)',
            display: 'inline-block',
          }}
        />
        <span className="hide-m">オフライン</span>
      </span>
    );
  }
  if (conflictData) {
    return (
      <button
        type="button"
        title={`競合あり: ${conflictData.fileName || conflictData.local?.name || ''}`}
        onClick={onConflictClick || (() => {})}
        style={{
          fontSize: 11,
          color: 'var(--ac-red, #e74c3c)',
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'currentColor',
            display: 'inline-block',
            animation: 'pulse 1s ease-in-out infinite',
          }}
        />
        <span className="hide-m">競合あり</span>
      </button>
    );
  }
  if (status.isSyncing) {
    const label = status.progress
      ? `同期中 ${status.progress.current}/${status.progress.total}`
      : '同期中';
    return (
      <span
        title={label}
        style={{ fontSize: 11, color: 'var(--tx2)', display: 'flex', alignItems: 'center', gap: 3 }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--ac)',
            display: 'inline-block',
            animation: 'pulse 1s ease-in-out infinite',
          }}
        />
        <span className="hide-m">{label}</span>
      </span>
    );
  }
  if (status.error) {
    // 種別はラベル、行動指示は title。status.error（件数等の具体）と category 文言
    // （行動指示）は別物なので、重複しないときだけ両方出す。
    const label = ERROR_LABEL[status.errorCategory] ?? '同期失敗';
    const guidance = status.errorCategory ? syncFailureMessage(status.errorCategory) : null;
    const detail =
      guidance && status.error !== guidance
        ? [status.error, guidance].filter(Boolean).join(' — ')
        : status.error || guidance;
    const title = `${label}: ${detail}`;
    return (
      <span
        role="status"
        aria-live="polite"
        title={title}
        style={{
          fontSize: 11,
          color: 'var(--ac-red, #e74c3c)',
          display: 'flex',
          alignItems: 'center',
          gap: 3,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'currentColor',
            display: 'inline-block',
          }}
        />
        <span className="sr-only">{title}</span>
        <span aria-hidden="true">{label}</span>
      </span>
    );
  }
  // 未同期の変更がある（canonical hash が remote/adopted と不一致な file が存在する。
  // useSyncPending が判定。#610）。最終同期時刻を先に見せると「同期済み」と誤解させるため、
  // 時刻表示より優先する（#245）。
  // SaveBadge の「未保存」（state === 'dirty'、ghUser 非ゲート・隣接表示）とは役割が異なる:
  // こちらは IDB 保存が完了した後に残る「GitHub へ未同期」を表す。重複表示ではないので、
  // 片方の削除でもう片方を代替できると誤認しないこと。
  if (hasPendingChanges) {
    return (
      <span
        title="同期待ち"
        style={{ fontSize: 11, color: 'var(--tx2)', display: 'flex', alignItems: 'center', gap: 3 }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'currentColor',
            display: 'inline-block',
          }}
        />
        <span className="hide-m">同期待ち</span>
      </span>
    );
  }
  if (status.lastSyncedAt) {
    const t = new Date(status.lastSyncedAt).toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return (
      <span
        title={`最終同期: ${t}`}
        style={{ fontSize: 11, color: 'var(--tx3)', display: 'flex', alignItems: 'center', gap: 3 }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'oklch(.6 .15 145)',
            display: 'inline-block',
          }}
        />
        <span className="hide-m">{t}</span>
      </span>
    );
  }
  return null;
}

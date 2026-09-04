import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import SyncBadge from './SyncBadge';
import { ERROR_LABEL } from './syncBadgeLabels';

const HERE = dirname(fileURLToPath(import.meta.url));

const IDLE_STATUS = { isSyncing: false, lastSyncedAt: null, error: null, progress: null };

describe('SyncBadge', () => {
  it('hasPendingChanges が true なら「同期待ち」を表示する', () => {
    render(
      <SyncBadge status={IDLE_STATUS} isOnline={true} conflictData={null} hasPendingChanges />,
    );
    expect(screen.getByText('同期待ち')).toBeInTheDocument();
  });

  it('hasPendingChanges が false なら「同期待ち」を表示しない', () => {
    const { container } = render(
      <SyncBadge
        status={IDLE_STATUS}
        isOnline={true}
        conflictData={null}
        hasPendingChanges={false}
      />,
    );
    expect(screen.queryByText('同期待ち')).toBeNull();
    // lastSyncedAt も無いため何も描画しない
    expect(container.firstChild).toBeNull();
  });

  it('同期中は hasPendingChanges が true でも「同期中」を優先する', () => {
    render(
      <SyncBadge
        status={{ ...IDLE_STATUS, isSyncing: true }}
        isOnline={true}
        conflictData={null}
        hasPendingChanges
      />,
    );
    expect(screen.getByText('同期中')).toBeInTheDocument();
    expect(screen.queryByText('同期待ち')).toBeNull();
  });

  it('同期失敗時は hasPendingChanges が true でも「同期失敗」を優先する', () => {
    render(
      <SyncBadge
        status={{ ...IDLE_STATUS, error: 'network error' }}
        isOnline={true}
        conflictData={null}
        hasPendingChanges
      />,
    );
    expect(screen.getByText('同期失敗')).toBeInTheDocument();
    expect(screen.queryByText('同期待ち')).toBeNull();
  });

  it('同期失敗はモバイルでもラベルを隠さず polite status として通知する', () => {
    render(
      <SyncBadge
        status={{ ...IDLE_STATUS, error: 'network error', errorCategory: 'network' }}
        isOnline={true}
        conflictData={null}
        hasPendingChanges={false}
      />,
    );
    const label = screen.getByText('通信エラー');
    expect(label).not.toHaveClass('hide-m');
    expect(label).toHaveAttribute('aria-hidden', 'true');
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('通信エラー');
    expect(status).toHaveTextContent('通信に失敗しました');
  });

  it('hasPendingChanges が false かつ lastSyncedAt があれば最終同期時刻を表示する', () => {
    const ts = new Date('2026-07-14T05:30:00Z').getTime();
    render(
      <SyncBadge
        status={{ ...IDLE_STATUS, lastSyncedAt: ts }}
        isOnline={true}
        conflictData={null}
        hasPendingChanges={false}
      />,
    );
    const expected = new Date(ts).toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(screen.getByText(expected)).toBeInTheDocument();
    expect(screen.queryByText('同期待ち')).toBeNull();
  });

  it('hasPendingChanges が true なら lastSyncedAt があっても「同期待ち」を優先する', () => {
    const ts = new Date('2026-07-14T05:30:00Z').getTime();
    render(
      <SyncBadge
        status={{ ...IDLE_STATUS, lastSyncedAt: ts }}
        isOnline={true}
        conflictData={null}
        hasPendingChanges
      />,
    );
    expect(screen.getByText('同期待ち')).toBeInTheDocument();
  });

  // 競合と障害は次の行動が違う（再読み込みして再同期 / 権限や上流の回復待ち）。
  // 同じ「同期失敗」に見えると、利用者はどちらか判断できない（#608）。
  it('errorCategory が conflict なら「再同期が必要」を表示する', () => {
    render(
      <SyncBadge
        status={{
          ...IDLE_STATUS,
          error: '他の端末の変更と競合しました',
          errorCategory: 'conflict',
        }}
        isOnline={true}
        conflictData={null}
        hasPendingChanges={false}
      />,
    );
    expect(screen.getByText('再同期が必要')).toBeInTheDocument();
    expect(screen.queryByText('同期失敗')).toBeNull();
  });

  it.each([['server'], [null]])(
    'errorCategory が %s なら「同期失敗」を表示する',
    (errorCategory) => {
      render(
        <SyncBadge
          status={{ ...IDLE_STATUS, error: '同期に失敗しました', errorCategory }}
          isOnline={true}
          conflictData={null}
          hasPendingChanges={false}
        />,
      );
      expect(screen.getByText('同期失敗')).toBeInTheDocument();
      expect(screen.queryByText('再同期が必要')).toBeNull();
    },
  );

  // 件数だけの文言では 422 / 5xx / 403 が同一表示になり、「待てば直る」「権限を直す」
  // 「データが受け付けられない」の区別が利用者に届かない。
  it.each([
    ['upstream', '時間をおいて再試行'],
    ['forbidden', '権限・制限エラー'],
    ['unprocessable', '同期データエラー'],
    ['auth', '再ログインが必要'],
    ['network', '通信エラー'],
    ['corrupt', '同期データ破損'],
    ['workspace_inconsistent', '同期を中止'],
    ['too_large', 'サイズ超過'],
    ['internal', '同期を中止'],
  ])('errorCategory が %s なら「%s」を表示する', (errorCategory, label) => {
    render(
      <SyncBadge
        status={{ ...IDLE_STATUS, error: '1 件のファイルを同期できませんでした', errorCategory }}
        isOnline={true}
        conflictData={null}
        hasPendingChanges={false}
      />,
    );
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('件数の文言と行動指示の両方を title に出す', () => {
    render(
      <SyncBadge
        status={{
          ...IDLE_STATUS,
          error: '2 件のファイルを同期できませんでした',
          errorCategory: 'conflict',
        }}
        isOnline={true}
        conflictData={null}
        hasPendingChanges={false}
      />,
    );
    const title = screen.getByText('再同期が必要').closest('span[title]').getAttribute('title');
    expect(title).toContain('2 件');
    expect(title).toContain('再読み込み');
  });

  // ラベル一覧は利用者向け docs と e2e の否定リストにも書かれており、手で 3 箇所を
  // 同期させると必ずずれる（実際に 2 回ずれた）。実装を正として機械検査する。
  it('利用者向け docs と e2e の一覧が ERROR_LABEL と一致する', () => {
    const labels = [...new Set(Object.values(ERROR_LABEL))];
    const guide = readFileSync(join(HERE, '../../../docs/MVP_GETTING_STARTED.md'), 'utf8');
    const spec = readFileSync(join(HERE, '../../../e2e/core/github-disconnected.spec.js'), 'utf8');

    for (const label of labels) {
      expect(guide, `docs に ${label} が無い`).toContain(label);
      expect(spec, `e2e の否定リストに ${label} が無い`).toContain(label);
    }
  });
});

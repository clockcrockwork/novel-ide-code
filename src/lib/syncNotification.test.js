import { describe, it, expect } from 'vitest';
import {
  normalizeSyncNotification,
  buildSyncCompletePayload,
  DEFAULT_SYNC_NOTIFICATION,
} from './syncNotification';

describe('normalizeSyncNotification', () => {
  it('デフォルト値を返す（undefined）', () => {
    expect(normalizeSyncNotification(undefined)).toEqual({
      enabled: false,
      delivery: 'toast',
    });
  });

  it('enabled: true を保持する', () => {
    expect(normalizeSyncNotification({ enabled: true }).enabled).toBe(true);
  });

  it('delivery "browser" を許容する', () => {
    expect(normalizeSyncNotification({ delivery: 'browser' }).delivery).toBe('browser');
  });

  it('不明な delivery は "toast" にフォールバック', () => {
    expect(normalizeSyncNotification({ delivery: 'local' }).delivery).toBe('toast');
  });
});

describe('buildSyncCompletePayload', () => {
  it('必要なフィールドを含む', () => {
    const p = buildSyncCompletePayload('toast');
    expect(p.delivery).toBe('toast');
    expect(p.tag).toBe('sync-complete');
    expect(typeof p.message).toBe('string');
  });

  it('デフォルト delivery は "toast"', () => {
    expect(buildSyncCompletePayload().delivery).toBe('toast');
  });
});

describe('DEFAULT_SYNC_NOTIFICATION', () => {
  it('フリーズされている', () => {
    expect(Object.isFrozen(DEFAULT_SYNC_NOTIFICATION)).toBe(true);
  });
});

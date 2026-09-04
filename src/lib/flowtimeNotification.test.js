import { describe, it, expect } from 'vitest';
import {
  normalizeFlowtimeNotification,
  buildDistractedNotificationPayload,
  DEFAULT_FLOWTIME_NOTIFICATION,
} from './flowtimeNotification';

describe('normalizeFlowtimeNotification', () => {
  it('デフォルト値を返す（null）', () => {
    expect(normalizeFlowtimeNotification(null)).toEqual({
      enabled: false,
      delivery: 'browser',
      distractionThresholdMin: 5,
    });
  });

  it('enabled: true を保持する', () => {
    const result = normalizeFlowtimeNotification({
      enabled: true,
      delivery: 'browser',
      distractionThresholdMin: 10,
    });
    expect(result.enabled).toBe(true);
    expect(result.distractionThresholdMin).toBe(10);
  });

  it('不正な thresholdMin はデフォルト 5 になる', () => {
    expect(
      normalizeFlowtimeNotification({ distractionThresholdMin: -1 }).distractionThresholdMin,
    ).toBe(5);
    expect(
      normalizeFlowtimeNotification({ distractionThresholdMin: 'x' }).distractionThresholdMin,
    ).toBe(5);
    expect(
      normalizeFlowtimeNotification({ distractionThresholdMin: 0 }).distractionThresholdMin,
    ).toBe(5);
  });

  it('delivery "local" を許容する', () => {
    expect(normalizeFlowtimeNotification({ delivery: 'local' }).delivery).toBe('local');
  });

  it('不明な delivery は "browser" にフォールバック', () => {
    expect(normalizeFlowtimeNotification({ delivery: 'toast' }).delivery).toBe('browser');
  });
});

describe('buildDistractedNotificationPayload', () => {
  it('必要なフィールドを含む', () => {
    const payload = buildDistractedNotificationPayload(7.5, 'browser');
    expect(payload.delivery).toBe('browser');
    expect(payload.tag).toBe('flowtime-distracted');
    expect(payload.body).toContain('8');
  });

  it('デフォルト delivery は "browser"', () => {
    expect(buildDistractedNotificationPayload(3).delivery).toBe('browser');
  });
});

describe('DEFAULT_FLOWTIME_NOTIFICATION', () => {
  it('フリーズされている', () => {
    expect(Object.isFrozen(DEFAULT_FLOWTIME_NOTIFICATION)).toBe(true);
  });
});

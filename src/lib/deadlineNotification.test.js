import { describe, it, expect } from 'vitest';
import {
  normalizeDeadlineNotification,
  isThresholdReached,
  buildDeadlinePayload,
  DEFAULT_DEADLINE_NOTIFICATION,
} from './deadlineNotification';

describe('normalizeDeadlineNotification', () => {
  it('デフォルト値を返す（null）', () => {
    const result = normalizeDeadlineNotification(null);
    expect(result.enabled).toBe(false);
    expect(result.thresholds).toEqual([1440, 60, 0]);
    expect(result.checkIntervalMin).toBe(1);
    expect(result.notifiedThresholds).toEqual([]);
    expect(result.deadlineAt).toBeNull();
  });

  it('thresholds を降順ソートする', () => {
    const result = normalizeDeadlineNotification({ thresholds: [0, 1440, 60] });
    expect(result.thresholds).toEqual([1440, 60, 0]);
  });

  it('不正な threshold 値を除外する', () => {
    const result = normalizeDeadlineNotification({ thresholds: [60, -1, 'x', 0] });
    expect(result.thresholds).toEqual([60, 0]);
  });

  it('checkIntervalMin が 1 未満のときはデフォルト 1', () => {
    expect(normalizeDeadlineNotification({ checkIntervalMin: 0 }).checkIntervalMin).toBe(1);
    expect(normalizeDeadlineNotification({ checkIntervalMin: -5 }).checkIntervalMin).toBe(1);
  });

  it('deadlineAt が文字列のとき保持する', () => {
    const d = '2026-05-20T12:00:00';
    expect(normalizeDeadlineNotification({ deadlineAt: d }).deadlineAt).toBe(d);
  });

  it('deadlineAt が null 以外の非文字列は null', () => {
    expect(normalizeDeadlineNotification({ deadlineAt: 12345 }).deadlineAt).toBeNull();
  });
});

describe('isThresholdReached', () => {
  const deadline = '2026-05-20T12:00:00';
  const deadlineMs = new Date(deadline).getTime();

  it('現在時刻がトリガー時刻を過ぎていたら true', () => {
    const now = deadlineMs - 30 * 60 * 1000; // 30分前
    expect(isThresholdReached(deadline, 60, now)).toBe(true); // 60分前トリガー
  });

  it('現在時刻がトリガー時刻より前なら false', () => {
    const now = deadlineMs - 90 * 60 * 1000; // 90分前
    expect(isThresholdReached(deadline, 60, now)).toBe(false); // 60分前トリガーにはまだ
  });

  it('thresholdMin が 0 のとき、締め切り時刻を過ぎたら true', () => {
    const now = deadlineMs + 1000;
    expect(isThresholdReached(deadline, 0, now)).toBe(true);
  });

  it('deadlineAt が null のとき false', () => {
    expect(isThresholdReached(null, 60)).toBe(false);
  });

  it('deadlineAt が不正な文字列のとき false', () => {
    expect(isThresholdReached('not-a-date', 60)).toBe(false);
  });
});

describe('buildDeadlinePayload', () => {
  it('既知の threshold に対してラベルを返す', () => {
    const p1440 = buildDeadlinePayload('2026-05-20T12:00:00', 1440, 'browser');
    expect(p1440.title).toContain('24時間前');
    expect(p1440.tag).toBe('deadline-1440');

    const p0 = buildDeadlinePayload('2026-05-20T12:00:00', 0, 'browser');
    expect(p0.title).toContain('締め切り到来');
  });

  it('未知の threshold は「N分前」ラベルを使う', () => {
    const p = buildDeadlinePayload('2026-05-20T12:00:00', 30, 'browser');
    expect(p.title).toContain('30分前');
  });

  it('delivery フィールドを含む', () => {
    expect(buildDeadlinePayload('2026-05-20T12:00:00', 60, 'toast').delivery).toBe('toast');
  });
});

describe('DEFAULT_DEADLINE_NOTIFICATION', () => {
  it('フリーズされている', () => {
    expect(Object.isFrozen(DEFAULT_DEADLINE_NOTIFICATION)).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createNotifier,
  createLocalPomodoroNotifier,
  ensureNotificationPermission,
  checkNotificationPermission,
} from './notify';

const stubNotification = (ctorOrObject) => {
  vi.stubGlobal('Notification', ctorOrObject);
};

const stubWindowForNotification = (dispatchEvent = vi.fn()) => {
  vi.stubGlobal('window', { focus: vi.fn(), dispatchEvent });
  vi.stubGlobal(
    'CustomEvent',
    class {
      constructor(type) {
        this.type = type;
      }
    },
  );
};

describe('createNotifier', () => {
  it('delivery local のとき local sender を呼ぶ', async () => {
    const localSender = vi.fn().mockResolvedValue(true);
    const remoteSender = vi.fn();
    const notify = createNotifier({ localSender, remoteSender, logger: vi.fn() });

    await notify('pomodoro', 'phase-switched', { delivery: 'local' });

    expect(localSender).toHaveBeenCalledWith('phase-switched', { delivery: 'local' });
    expect(remoteSender).not.toHaveBeenCalled();
  });

  it('delivery remote のとき remote sender を呼ぶ', async () => {
    const localSender = vi.fn();
    const remoteSender = vi.fn().mockResolvedValue(undefined);
    const notify = createNotifier({ localSender, remoteSender, logger: vi.fn() });

    await notify('pomodoro', 'phase-switched', { delivery: 'remote' });

    expect(remoteSender).toHaveBeenCalledWith('pomodoro', 'phase-switched', { delivery: 'remote' });
    expect(localSender).not.toHaveBeenCalled();
  });

  it('delivery toast のとき toast sender を呼ぶ', async () => {
    const toastSender = vi.fn().mockResolvedValue(true);
    const localSender = vi.fn();
    const notify = createNotifier({ toastSender, localSender, logger: vi.fn() });

    await notify('sync', 'complete', { delivery: 'toast' });

    expect(toastSender).toHaveBeenCalledWith({ delivery: 'toast' });
    expect(localSender).not.toHaveBeenCalled();
  });
});

describe('checkNotificationPermission', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('granted のとき true を返す', () => {
    stubNotification({ permission: 'granted' });
    expect(checkNotificationPermission()).toBe(true);
  });

  it('default のとき false を返す（requestPermission を呼ばない）', () => {
    const requestPermission = vi.fn();
    stubNotification({ permission: 'default', requestPermission });
    expect(checkNotificationPermission()).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('denied のとき false を返す', () => {
    stubNotification({ permission: 'denied' });
    expect(checkNotificationPermission()).toBe(false);
  });

  it('Notification が未定義のとき false を返す', () => {
    vi.stubGlobal('Notification', undefined);
    expect(checkNotificationPermission()).toBe(false);
  });
});

describe('local notification permission', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('default のとき permission request を呼ぶ', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    stubNotification({ permission: 'default', requestPermission });

    await expect(ensureNotificationPermission()).resolves.toBe(true);
    expect(requestPermission).toHaveBeenCalled();
  });

  it('requestPermission が throw しても false を返す', async () => {
    const requestPermission = vi.fn().mockRejectedValue(new Error('permission failed'));
    stubNotification({ permission: 'default', requestPermission });

    await expect(ensureNotificationPermission()).resolves.toBe(false);
  });

  it('Notification 生成で例外が出ても false を返す', async () => {
    function ThrowNotification() {
      throw new Error('boom');
    }
    ThrowNotification.permission = 'granted';
    ThrowNotification.requestPermission = vi.fn();

    stubWindowForNotification();
    stubNotification(ThrowNotification);

    const sender = createLocalPomodoroNotifier();
    await expect(sender('phase-switched', { title: 'a' })).resolves.toBe(false);
  });

  it('onclick が発火すると onNotifyClick を呼ぶ（例外なし）', async () => {
    const created = [];
    function MockNotification() {
      this.onclick = null;
      created.push(this);
    }
    MockNotification.permission = 'granted';
    MockNotification.requestPermission = vi.fn();

    const onNotifyClick = vi.fn();
    stubWindowForNotification();
    stubNotification(MockNotification);

    const sender = createLocalPomodoroNotifier({ onNotifyClick });
    await expect(sender('phase-switched', { title: 'x' })).resolves.toBe(true);
    expect(created).toHaveLength(1);

    expect(() => created[0].onclick()).not.toThrow();
    expect(onNotifyClick).toHaveBeenCalledTimes(1);
  });

  it('granted のとき notification を作成する', async () => {
    const created = [];
    function MockNotification(title, options) {
      created.push({ title, options });
      this.onclick = null;
    }
    MockNotification.permission = 'granted';
    MockNotification.requestPermission = vi.fn();

    stubWindowForNotification();
    stubNotification(MockNotification);

    const sender = createLocalPomodoroNotifier();
    await expect(sender('phase-switched', { title: 'a', body: 'b', tag: 'c' })).resolves.toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({ title: 'a', options: { body: 'b', tag: 'c' } });
  });
});

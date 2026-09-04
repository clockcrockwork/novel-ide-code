import { describe, it, expect, vi } from 'vitest';
import { appEvents, APP_EVENTS } from './appEvents';

describe('APP_EVENTS', () => {
  it('定数が定義されている', () => {
    expect(APP_EVENTS.SYNC_COMPLETE).toBe('sync:complete');
    expect(APP_EVENTS.EDITOR_ACTIVITY).toBe('editor:activity');
  });
});

describe('appEvents', () => {
  it('イベントを発火・受信できる', () => {
    const handler = vi.fn();
    appEvents.addEventListener(APP_EVENTS.SYNC_COMPLETE, handler);
    appEvents.dispatchEvent(new CustomEvent(APP_EVENTS.SYNC_COMPLETE));
    expect(handler).toHaveBeenCalledTimes(1);
    appEvents.removeEventListener(APP_EVENTS.SYNC_COMPLETE, handler);
  });

  it('removeEventListener で購読解除できる', () => {
    const handler = vi.fn();
    appEvents.addEventListener(APP_EVENTS.SYNC_COMPLETE, handler);
    appEvents.removeEventListener(APP_EVENTS.SYNC_COMPLETE, handler);
    appEvents.dispatchEvent(new CustomEvent(APP_EVENTS.SYNC_COMPLETE));
    expect(handler).not.toHaveBeenCalled();
  });

  it('detail を含む CustomEvent を渡せる', () => {
    const detail = { fileId: 'abc' };
    const handler = vi.fn();
    appEvents.addEventListener(APP_EVENTS.SYNC_COMPLETE, handler);
    appEvents.dispatchEvent(new CustomEvent(APP_EVENTS.SYNC_COMPLETE, { detail }));
    expect(handler.mock.calls[0][0].detail).toEqual(detail);
    appEvents.removeEventListener(APP_EVENTS.SYNC_COMPLETE, handler);
  });
});

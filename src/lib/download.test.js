import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadFile } from './download';

// jsdom は download 属性つきアンカーでも実ナビゲーションを試みログを出すため、
// click 自体を無害化し、呼び出しタイミング・DOM 接続状態だけを観測する。
describe('downloadFile（#216 / #219 ダウンロード共通ヘルパー）', () => {
  let clickSpy;

  beforeEach(() => {
    vi.useFakeTimers();
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function mocked() {
      this.__clickedWhileConnected = this.isConnected;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    clickSpy.mockRestore();
  });

  function captureAnchor(run) {
    let captured;
    const origCreateElement = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreateElement(tag);
      if (tag === 'a') captured = el;
      return el;
    });
    run();
    spy.mockRestore();
    return captured;
  }

  it('mime を省略すると既定で text/plain になる', () => {
    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL');
    downloadFile('hello', 'a.txt');
    const blob = createObjectURLSpy.mock.calls[0][0];
    expect(blob.type).toBe('text/plain');
    createObjectURLSpy.mockRestore();
  });

  it('a.download にファイル名がそのまま入る', () => {
    const a = captureAnchor(() => downloadFile('hello', 'my-file.json', 'application/json'));
    expect(a.download).toBe('my-file.json');
  });

  it('revokeObjectURL は click 直後には呼ばれず、100ms 後に呼ばれる（即時実行にしない）', () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    downloadFile('hello', 'a.txt');
    expect(revokeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(revokeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    revokeSpy.mockRestore();
  });

  it('click 時は document に接続されており、click 後に取り除かれる（A4）', () => {
    const a = captureAnchor(() => downloadFile('hello', 'a.txt'));
    expect(a.__clickedWhileConnected).toBe(true);
    expect(a.isConnected).toBe(false);
  });
});

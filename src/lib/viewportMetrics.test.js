import { test, expect, afterEach, vi } from 'vitest';
import { viewportBottomLimit } from './viewportMetrics';

afterEach(() => {
  document.documentElement.style.removeProperty('--footer-cover');
  document.documentElement.style.removeProperty('--footer-h');
  vi.unstubAllGlobals();
});

function setInnerHeight(px) {
  vi.stubGlobal('innerHeight', px);
}

test('--footer-cover 未設定なら innerHeight をそのまま返す', () => {
  setInnerHeight(800);
  expect(viewportBottomLimit()).toBe(800);
});

test('footer-cover（フッター高＋キーボード高）を innerHeight から差し引く', () => {
  setInnerHeight(800);
  document.documentElement.style.setProperty('--footer-cover', '300px');
  expect(viewportBottomLimit()).toBe(500);
});

test('cover が innerHeight を超えても負値を返さない', () => {
  setInnerHeight(200);
  document.documentElement.style.setProperty('--footer-cover', '600px');
  expect(viewportBottomLimit()).toBe(0);
});

test('不正な cover 値は 0 とみなす', () => {
  setInnerHeight(640);
  document.documentElement.style.setProperty('--footer-cover', 'calc(50px)');
  expect(viewportBottomLimit()).toBe(640);
});

test('visualViewport があれば vv 幾何から同期的に算出する（--footer-cover の rAF 遅延を回避）', () => {
  // キーボード開で vv が縮んだ直後、--footer-cover はまだ rAF 前の古い値（footer のみ=90）。
  // vv ベースなら footer 高を引いた最新の下端を返す。
  document.documentElement.style.setProperty('--footer-h', '90px');
  document.documentElement.style.setProperty('--footer-cover', '90px');
  vi.stubGlobal('visualViewport', { height: 400, offsetTop: 0 });
  // 400(可視高) + 0(offset) - 90(footer) = 310
  expect(viewportBottomLimit()).toBe(310);
});

test('visualViewport の offsetTop も加味する', () => {
  document.documentElement.style.setProperty('--footer-h', '90px');
  vi.stubGlobal('visualViewport', { height: 400, offsetTop: 50 });
  // 400 + 50 - 90 = 360
  expect(viewportBottomLimit()).toBe(360);
});

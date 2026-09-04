// 浮遊 UI（コンテキストメニュー・ポップアップ）がフッターやソフトウェアキーボードの
// 裏に隠れないよう、利用可能なビューポート下端の Y 座標（client 座標）を返す。
//
// visualViewport があれば、その可視領域下端（height + offsetTop, レイアウトビューポート基準）から
// フッター高を引いて同期的に算出する。useViewportFooter は --footer-cover を requestAnimationFrame で
// 更新するため、キーボード開閉直後（rAF 前）に --footer-cover を読むと 1 フレーム古い値になり、popup が
// キーボード裏に隠れる。visualViewport の幾何は同期で最新なので、その遅延を回避できる。
// （footer 高はキーボード開閉では変わらないため、inline style から読んでも遅延の影響を受けない。）
// この式は従来の `innerHeight - (footer 高 + キーボード高)` と代数的に等価で、iOS（offset 補正）・
// Android（interactive-widget=resizes-content で innerHeight 自体が縮む）どちらも同じ式で扱える。
export function viewportBottomLimit() {
  if (typeof window === 'undefined') return 0;
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  const vv = window.visualViewport;
  if (vv && typeof vv.height === 'number' && typeof vv.offsetTop === 'number') {
    let footerH = 0;
    if (root) {
      const parsed = parseFloat(root.style.getPropertyValue('--footer-h'));
      if (Number.isFinite(parsed)) footerH = parsed;
    }
    return Math.max(0, vv.height + Math.max(0, vv.offsetTop) - footerH);
  }
  // visualViewport 非対応環境（古い Android WebView 等）は rAF 更新済みの --footer-cover にフォールバック。
  const innerHeight = window.innerHeight || 0;
  let cover = 0;
  if (root) {
    const parsed = parseFloat(root.style.getPropertyValue('--footer-cover'));
    if (Number.isFinite(parsed)) cover = parsed;
  }
  return Math.max(0, innerHeight - cover);
}

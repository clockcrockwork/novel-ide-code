import { useEffect } from 'react';

const KEYBOARD_THRESHOLD = 120;

export function useViewportFooter(footerRef) {
  useEffect(() => {
    const vv = window.visualViewport ?? null;
    const root = document.documentElement;
    let rafId = null;

    const upd = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const footer = footerRef.current;
        // visualViewport 非対応（古い Android WebView 等）は innerHeight にフォールバックし off=0。
        const vvHeight = vv && typeof vv.height === 'number' ? vv.height : window.innerHeight;
        const vvOffsetTop = vv && typeof vv.offsetTop === 'number' ? Math.max(0, vv.offsetTop) : 0;
        // キーボード高 = レイアウトビューポート - 可視ビューポート。
        // interactive-widget=resizes-content が効く環境（Android Chrome 等）では innerHeight も
        // キーボード分縮むため off≈0 となり、#root の 100dvh 側が縮んで footer が追従する。
        // iOS Safari は interactive-widget 未対応なので off>0 を JS 補正に使う。どちらも同一式で扱え、
        // dvh 縮小と offset 補正が二重に効くことはない。
        const off = Math.max(0, window.innerHeight - vvHeight - vvOffsetTop);
        if (!footer) return;
        const height = footer.getBoundingClientRect().height;
        root.style.setProperty('--footer-h', height + 'px');
        root.style.setProperty('--footer-vv-offset', off + 'px');
        // --footer-cover = footer 高 + キーボード高。スクロール padding や
        // エディタの最小タップ高（min-height）がキーボードに隠れないよう確保する。
        root.style.setProperty('--footer-cover', height + off + 'px');
        root.classList.toggle('keyboard-open', off > KEYBOARD_THRESHOLD);
      });
    };

    const footer = footerRef.current;
    const ro = footer && window.ResizeObserver ? new window.ResizeObserver(upd) : null;
    if (ro && footer) ro.observe(footer);
    vv?.addEventListener('resize', upd);
    vv?.addEventListener('scroll', upd);
    window.addEventListener('resize', upd);
    upd();
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro?.disconnect();
      vv?.removeEventListener('resize', upd);
      vv?.removeEventListener('scroll', upd);
      window.removeEventListener('resize', upd);
      root.classList.remove('keyboard-open');
      root.style.removeProperty('--footer-h');
      root.style.removeProperty('--footer-vv-offset');
      root.style.removeProperty('--footer-cover');
    };
  }, [footerRef]);
}

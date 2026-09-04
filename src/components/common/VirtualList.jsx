/**
 * VirtualList — virtua ベースの共通仮想リストコンポーネント
 *
 * Props:
 *   items             {Array}    表示するアイテムの配列（必須）
 *   renderItem        {Function} (item, index) => ReactNode（必須）
 *   getItemKey        {Function} (item, index) => string|number。省略時は index を使用
 *   height            {string|number} リストの高さ。デフォルト '100%'
 *   overscan          {number}   可視範囲外に先読みするアイテム数。デフォルト 3
 *   onKeyDown         {Function} キーボードイベントのカスタムハンドラ（省略可）
 *   onItemActivate    {Function} (item, index) => void。Enter/Space 押下時またはアイテムクリック時に呼ばれる（省略可）
 *   ariaLabel         {string}   listbox のアクセシブルネーム（ariaLabelledBy と排他）
 *   ariaLabelledBy    {string}   listbox をラベル付けする要素の id（ariaLabel と排他）
 *   className         {string}   外側コンテナへの追加クラス
 *   style             {Object}   外側コンテナへの追加スタイル
 *   scrollRestorationKey {string} スクロール位置を sessionStorage に保存する際のキー。
 *                                省略時は保存しない
 *
 * ref（forwardRef）:
 *   virtua VList の imperative handle を公開。scrollTo(offset)・scrollToIndex(index) 等が使用可能。
 *
 * キーボード操作:
 *   ArrowUp / ArrowDown — フォーカスアイテムを移動
 *   Home / End          — 先頭 / 末尾へ移動
 *   Enter / Space       — onItemActivate を呼び出す
 */
import { useRef, useState, useEffect, useCallback, useId, forwardRef } from 'react';
import { VList } from 'virtua';

const SCROLL_KEY_PREFIX = 'vlist-scroll:';

const VirtualList = forwardRef(function VirtualList(
  {
    items,
    renderItem,
    getItemKey,
    height = '100%',
    overscan = 3,
    onKeyDown,
    onItemActivate,
    ariaLabel,
    ariaLabelledBy,
    className,
    style,
    scrollRestorationKey,
  },
  forwardedRef,
) {
  const ref = useRef(null);
  const containerRef = useRef(null);
  const [focusIndex, setFocusIndex] = useState(-1);
  const [containerFocused, setContainerFocused] = useState(false);
  const idPrefix = useId();

  // items が縮小したとき focusIndex をクランプ（items.length 変化時のみ実行）
  useEffect(() => {
    setFocusIndex((prev) =>
      prev >= items.length ? (items.length > 0 ? items.length - 1 : -1) : prev,
    );
  }, [items.length]);

  // 内部 ref と外部 forwardedRef を両立させるコールバック ref
  const setRef = useCallback(
    (node) => {
      ref.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  // スクロール位置の復元
  useEffect(() => {
    if (!scrollRestorationKey || !ref.current) return;
    const key = SCROLL_KEY_PREFIX + scrollRestorationKey;
    try {
      const saved = sessionStorage.getItem(key);
      const offset = Number(saved);
      if (saved != null && Number.isFinite(offset)) ref.current.scrollTo(offset);
    } catch {}
  }, [scrollRestorationKey]); // ref.current は依存に含めない（マウント後のみ実行）

  // アンマウント時にスクロール位置を保存
  useEffect(() => {
    if (!scrollRestorationKey) return;
    const key = SCROLL_KEY_PREFIX + scrollRestorationKey;
    const vlist = ref.current;
    return () => {
      try {
        if (vlist) sessionStorage.setItem(key, String(vlist.scrollOffset));
      } catch {}
    };
  }, [scrollRestorationKey]);

  const handleKeyDown = useCallback(
    (e) => {
      if (onKeyDown) {
        onKeyDown(e);
        if (e.defaultPrevented) return;
      }

      const len = items.length;
      if (len === 0) return;

      let next;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          next = focusIndex < 0 || focusIndex >= len - 1 ? 0 : focusIndex + 1;
          break;
        case 'ArrowUp':
          e.preventDefault();
          next = focusIndex <= 0 ? len - 1 : focusIndex - 1;
          break;
        case 'Home':
          e.preventDefault();
          next = 0;
          break;
        case 'End':
          e.preventDefault();
          next = len - 1;
          break;
        case 'Enter':
        case ' ':
          if (focusIndex >= 0) {
            e.preventDefault();
            onItemActivate?.(items[focusIndex], focusIndex);
          }
          return;
        default:
          return;
      }

      if (next != null && next !== focusIndex) {
        setFocusIndex(next);
        ref.current?.scrollToIndex(next, { align: 'nearest' });
      }
    },
    [focusIndex, items, onKeyDown, onItemActivate],
  );

  const activeDescendant = focusIndex >= 0 ? `${idPrefix}-${focusIndex}` : undefined;

  // Tab フォーカスがコンテナ上にあり、かつアイテムが未選択の場合のみリング表示
  const containerOutline =
    containerFocused && focusIndex < 0 ? '2px solid var(--ac, #007bff)' : 'none';

  return (
    <div
      ref={containerRef}
      role="listbox"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-activedescendant={activeDescendant}
      onKeyDown={handleKeyDown}
      onFocus={() => setContainerFocused(true)}
      onBlur={() => setContainerFocused(false)}
      className={className}
      style={{ height, outline: containerOutline, outlineOffset: -2, ...style }}
    >
      <VList ref={setRef} overscan={overscan} style={{ height: '100%' }}>
        {items.map((item, index) => {
          const key = getItemKey ? getItemKey(item, index) : index;
          return (
            <div
              key={key}
              id={`${idPrefix}-${index}`}
              role="option"
              aria-selected={focusIndex === index}
              style={
                focusIndex === index
                  ? { outline: '1px solid var(--ac, #007bff)', outlineOffset: -1 }
                  : undefined
              }
              onClick={() => {
                setFocusIndex(index);
                onItemActivate?.(item, index);
                containerRef.current?.focus();
              }}
            >
              {renderItem(item, index)}
            </div>
          );
        })}
      </VList>
    </div>
  );
});

export default VirtualList;

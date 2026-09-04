# Issue #159 実装検証・改善ロードマップ

**日付**: 2026-05-29  
**Issue**: #159 iOS Safariの仮想キーボード・フォーカス・スクロール崩れを前提にモバイルエディタレイアウトを設計し直す  
**PR**: #162 (マージ済み 2026-05-27)  
**ブランチ**: `claude/mobile-ios-layout-159`

---

## 実装状況: ✅ 完了

iOS モバイルレイアウト修正は **PR #162 にて全面実装・テスト・マージ済み**。Issue #159 の受け入れ条件 10 項目はすべて達成。

### 受け入れ条件 検証結果

| # | 条件 | 状態 | 根拠 |
|----|------|------|------|
| 1 | body/window スクロールなしの 100dvh app shell | ✅ | `html, body { overflow: hidden }`、`#root { height: calc(100dvh - var(--footer-vv-offset)) }` |
| 2 | editor 専用スクロール領域 | ✅ | `.main-area { overflow-y: auto }` が唯一の主スクロール |
| 3 | モバイル footer/toolbar が layout 内で安定 | ✅ | footer は flex item（`position: fixed` 依存なし） |
| 4 | VisualViewport API の用途を keyboard 検知に限定 | ✅ | `useViewportFooter()` フックが CSS 変数更新のみを担当 |
| 5 | scroll + 入力中に footer/toolbar が消えない | ✅ | `--footer-vv-offset`・`--footer-cover` CSS 変数で動的スペース管理 |
| 6 | focus/selection scroll 競合の解消 | ✅ | `handleScrollToSelection()` でタッチデバイス限定の scrollIntoView 抑制 |
| 7 | keyboard 表示中の smooth scroll 無効化 | ✅ | `.keyboard-open .main-area { scroll-behavior: auto }` |
| 8 | keyboard + scroll でポップアップ/floating UI が安定 | ✅ | `RubyEditPopup` が keyboard/scroll 時に自動クローズ（MutationObserver + フック） |
| 9 | iOS WebKit 向け E2E テスト追加 | ✅ | 6 スイート（ios-viewport-layout、ios-keyboard-scroll、ios-focus-scroll、ios-floating-ui-keyboard-scroll、ios-footer-flex-layout、footer-keyboard） |
| 10 | 実機確認手順をドキュメント化 | ✅ | `docs/mobile-manual-test.md` にチェックリスト形式で記載 |

---

## PR #162 の実装内容

### フェーズ 1: 構造基盤
- `useViewportFooter` フック — VisualViewport API + CSS 変数管理
- `--footer-vv-offset`・`--footer-h`・`--footer-cover` CSS 変数
- `keyboard-open` クラスフラグ（アニメーション抑制用）

### フェーズ 2: editor スクロール領域
- `.main-area` を唯一の縦スクロールコンテナとして確立
- footer を flex レイアウトに移動（fixed 依存排除）

### フェーズ 3: focus/selection scroll 制御
- TipTap `handleScrollToSelection()` 抑制（keyboard open 時）
- タッチデバイス限定（デスクトップのスクロール動作は維持）
- IME composition 状態の追跡（composition 中は scroll 補正を抑制）

### フェーズ 4: アニメーション・transition 抑制
- `.keyboard-open` クラスで smooth scroll・transition を無効化
- sidebar の `transition: none` を keyboard 中に適用

### フェーズ 5: ポップアップ・floating UI
- `RubyEditPopup`: keyboard-open クラス変化を MutationObserver で監視 → 自動クローズ
- `usePopoverClose` フック: scroll 時のポップアップ自動クローズ

### フェーズ 6: E2E テスト（48 件超）
- WebKit/iPhone + Chromium 両環境で実行
- landscape orientation エッジケース対応

### フェーズ 7: 手動テストドキュメント
- `docs/mobile-manual-test.md` — iPhone/iPad/Android 向け手順

### レビュー対応サイクル（4 ラウンド）
- VisualViewport プロパティの null/NaN ガード追加
- テスト信頼性改善（landscape スキップ処理）
- CSS 変数アンマウント時クリーンアップ追加
- dead CSS rule（`.keyboard-open .footer`）除去

---

## コード品質

| 観点 | 状態 | 備考 |
|------|------|------|
| 型安全性 | ✅ | VisualViewport API に `typeof === 'number'` ガード |
| メモリ安全性 | ✅ | アンマウント時に CSS 変数を `removeProperty` でクリーンアップ |
| テストカバレッジ | ✅ | 48 件超の E2E（iOS WebKit + Chromium） |
| ドキュメント | ✅ | 実機確認手順・実装経緯を記録 |
| ブラウザ互換性 | ✅ | VisualViewport 未サポート環境は `window.innerHeight` にフォールバック |

---

## 今後の改善候補

実装は完成・堅牢だが、**コードの保守性・組織化**を高める余地が残っている。

### 1. VisualViewport 状態の一元化（リファクタリング）

**現状**: viewport 状態の管理が複数箇所に散在している。
- `useViewportFooter()` が keyboard 検知 + CSS 変数管理を担当
- `RubyEditPopup` が `window.visualViewport` に直接アクセスしてポップアップ位置を計算（106行目）
- `PreviewMode` が `window.getSelection()` でツールバー位置を計算

**改善**: `src/lib/viewportState.js` に統一 API を作成
```javascript
export function getKeyboardState() {
  // 統一された keyboard 状態 API
  // 戻り値: { isOpen, height, offsetTop }
}
```

**メリット**: 単体テスト容易・fallback 動作の一貫性・重複排除  
**工数目安**: 1〜2時間

---

### 2. IME composition 状態のエクスポート（機能追加）

**現状**: `EditorBox` が `isComposingRef` で IME composition を追跡しているが、外部から参照できない。

- `RubyEditPopup` が scroll 時に自動クローズするが、IME 入力中でも閉じてしまう可能性がある

**改善**: `src/hooks/useEditorCompositionState.js` を作成
```javascript
export function useEditorCompositionState() {
  // 戻り値: { isComposing }
  // ポップアップ側が composition 中のクローズをスキップできる
}
```

**メリット**: IME 入力中のポップアップ誤クローズを防止  
**工数目安**: 1時間

---

### 3. ポップアップ位置計算の共通化（リファクタリング）

**現状**: ポップアップごとに位置計算方法が異なる。
- `RubyEditPopup`: `visualViewport.width` 直接参照（106行目）
- `PreviewMode` ツールバー: `getBoundingClientRect()` を使用
- ctx メニュー: `WriteMode.jsx` にインライン実装

**改善**: `src/hooks/usePopupPosition.js` を作成し統一
- VisualViewport への安全アクセス（fallback 付き）
- スクロールオフセット補正
- viewport 境界チェック（はみ出し防止）
- iOS Safari 固有の挙動を一箇所でドキュメント化

**メリット**: iOS 対応ロジックの重複排除・一貫した挙動  
**工数目安**: 2時間

---

### 4. iOS Safari 固有処理のコードコメント（ドキュメント）

**現状**: 実装は存在するが、iOS Safari 特有の理由を説明するコメントがない。

**改善**: 以下の箇所に1行コメントを追加
- `EditorBox.jsx`: `handleScrollToSelection` 抑制がタッチデバイス限定の理由
- `RubyEditPopup.jsx`: MutationObserver を使う理由・`visualViewport` 使用の理由
- `useViewportFooter.js`: CSS 変数計算のロジック説明

**メリット**: 将来の保守者が iOS 固有挙動を把握しやすくなる  
**工数目安**: 1時間

---

### 5. E2E テストの補完（テスト）

**現状**: 48 件のテストで主要シナリオをカバー済み。

**未カバーのエッジケース**:
- IME composition 中のポップアップライフサイクル
- ポップアップ表示中の orientation 変化
- keyboard の高速開閉サイクル

**改善**: 補完テストを 2〜3 件追加  
**工数目安**: 1〜2時間

---

## 今後の対応方針

### Option A: 完了確認のみ（最小限）
Issue の実装は完了済みのため、#159 をクローズして終了。

**工数**: 30分

### Option B: 保守性向上のリファクタリング（推奨）
1. `src/lib/viewportState.js` を作成（30分）
2. `src/hooks/useEditorCompositionState.js` を作成（30分）
3. `src/hooks/usePopupPosition.js` を作成（1時間）
4. `RubyEditPopup` + `PreviewMode` を新フックに移行（1時間）
5. iOS 固有処理にコメント追加（30分）

**工数合計**: 3〜4時間

### Option C: 完全強化（最大カバレッジ）
Option B に加えて:
- 追加 E2E テスト（composition + popup、orientation 変化）
- `docs/MOBILE_VIEWPORT_DESIGN.md` — 設計意思決定の記録

**工数合計**: 5〜7時間

---

## PR #162 変更ファイル一覧

**コア実装**:
- `src/hooks/useViewportFooter.js`
- `src/index.css`
- `src/components/editor/EditorBox.jsx`

**モバイル UI**:
- `src/components/footer/FooterBox.jsx`
- `src/components/editor/RubyEditPopup.jsx`
- `src/components/editor/PreviewMode.jsx`
- `src/components/editor/WriteMode.jsx`

**テスト・ドキュメント**:
- `e2e/mobile/ios-viewport-layout.spec.js`
- `e2e/mobile/ios-keyboard-scroll.spec.js`
- `e2e/mobile/ios-focus-scroll.spec.js`
- `e2e/mobile/ios-floating-ui-keyboard-scroll.spec.js`
- `e2e/mobile/ios-footer-flex-layout.spec.js`
- `e2e/mobile/footer-keyboard.spec.js`
- `docs/mobile-manual-test.md`

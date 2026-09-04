# SVG最適化メモ

## 1. 最適化対象
- `src/components/Icons.jsx`
  - `GhIcon`
  - `MenuIcon`
  - `FileIcon`
  - `GearIcon`
  - `ExportIcon`
  - `ChevronRight`
- `public/icons.svg`（シンボルスプライト）

## 2. 共通ポリシー
- 数値精度: `floatPrecision: 1` を基本値にする（崩れがない範囲で軽量化）。
- 属性整理:
  - 不要な `style` / `class` / `id`（参照されないもの）は削除。
  - `fillRule` は必要な形状のみ付与（むやみに全アイコンへ強制しない）。
- テーマ連動:
  - Reactアイコン（`src/components/Icons.jsx`）は `fill="currentColor"` / `stroke="currentColor"` を維持。

## 3. 今回の最適化内容
- `GearIcon` のみをSVGO相当（`floatPrecision: 1`）で最適化。
- それ以外のアイコンは短く、今回の変更対象外。
- `public/icons.svg` はこのPRでは非変更（既存ブランドカラー指定を維持）。

## 4. 視認チェック方針
- 12 / 14 / 16 / 20px で表示崩れの目視確認を行う。
- 崩れが出る場合のみ個別に精度を `0 -> 1` または `1 -> 2` へ戻す。

## 5. 変更ログ（今回）
- `src/components/Icons.jsx`
  - `GearIcon` `path d` 文字数: `1765 -> 1072`（約39.3%削減）
  - 見た目影響: 想定なし（同一シルエット）
  - 例外対応: なし

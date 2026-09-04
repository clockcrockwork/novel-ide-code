// PR 本文組み立てヘルパー（check-artifacts ゲートのテスト共通）。
// checkArtifacts.test.js の個別テストと checkArtifactsSweep.test.js の表駆動スイープが
// 同じ body ビルダーを共有し、ボイラープレートの重複を避ける（issue #401）。

// 全必須要素（5 セクション＋関連 issue）を満たした妥当な PR 本文。
// 個別テストは .replace(...) で1要素だけ差し替えて負例を作るため、文字列内容は不変に保つ。
export const FULL_ARTIFACTS = `
## 完了条件
- [ ] X を実装 — 検証方法: unit test

## 想定ケース
### 不正・異常入力
- null / 空文字

## 既存実装調査
| # | 目的 | 検索クエリ / 参照先 | 結果 | 判断 | 理由 |
|---|---|---|---|---|---|
| 1 | 類似機能 | Grep "x" src/ | なし | 新規 | 既存に該当なし |

## 証拠表
| 宣言 | 証拠 | 判定 |
|---|---|---|
| X を実装 | scripts/x.js:10 / tests/x.test.js | ✅ |

## レビューループ記録
Tier: Light（テスト用最小例）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |

refs #1
`;

// 証拠セル1つを差し替えた標準の証拠表マークアップ（スイープの証拠ポインタ系で多用）
export const evidenceTable = (cell) => `| 宣言 | 証拠 | 判定 |
|---|---|---|
| X | ${cell} | ✅ |`;

// 差し替え部品（named slot）を受け取り完全な PR 本文を組み立てる。
// - evidence: 証拠表セクション本文（既定は実ポインタ付きで受理される表）
// - loop:     レビューループ記録のセクション本文（既定は Tier 宣言行＋系統列付きの収束済み表。
//             Tier 宣言行とヘッダを含めること — #452 で Tier 宣言×系統列が機械検査されるため）
// - issue:    末尾の関連 issue 参照行（既定 refs #1）
// 各スロットの既定値のみで組むと checkArtifacts はエラー0（受理）になる。
export function buildBody({
  evidence = `| 宣言 | 証拠 | 判定 |
|---|---|---|
| X を実装 | scripts/x.js:10 / tests/x.test.js | ✅ |`,
  loop = `Tier: Light（テスト用最小例）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋清掃 | 0件 | 収束 |`,
  issue = 'refs #1',
} = {}) {
  return `
## 完了条件
- [ ] X を実装 — 検証方法: unit test

## 想定ケース
- 異常系

## 既存実装調査
- Grep "x" src/ → なし（新規）

## 証拠表
${evidence}

## レビューループ記録
${loop}

${issue}
`;
}

// 証拠表以外の必須要素（完了条件・想定ケース・既存実装調査・ループ記録・issue 参照）を満たした上で
// 証拠表セクションだけを差し替えるヘルパー（buildBody の evidence スロットのみ差し替えと等価）
export const withEvidence = (evidenceSection) => buildBody({ evidence: evidenceSection });

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkPlan, extractPlanPaths } from '../scripts/agent/check-plan.js';
import { readPlanFile } from '../scripts/agent/hooks/check-plan-gates.js';
import { REMINDER } from '../scripts/agent/hooks/plan-mode-reminder.js';

const HOOK = fileURLToPath(new URL('../scripts/agent/hooks/check-plan-gates.js', import.meta.url));
const REMINDER_HOOK = fileURLToPath(
  new URL('../scripts/agent/hooks/plan-mode-reminder.js', import.meta.url),
);

const FULL_PLAN = `
# 変更計画

## 変更内容
- \`src/lib/foo.js\` に関数を追加する

## 想定ケース
| ケース | 対応 |
|---|---|
| null 入力 | ガードして早期 return |

## 既存実装調査
| # | 目的 | 結果 | 判断 |
|---|---|---|---|
| 1 | 類似検索 | なし | 新規 |
`;

const STEPS_PLAN = `
## 変更内容
- \`src/lib/foo.js\` を修正

## 実施手順
1. /risk-modeling を実行して想定ケース表を作成
2. /codebase-recon を実行して既存実装調査表を作成
3. 実装
`;

// --- checkPlan（純粋ロジック） ---

test('コードパス言及 + 両セクション非空 → エラーなし・mandated', () => {
  const { errors, mandated } = checkPlan({ plan: FULL_PLAN });
  assert.equal(mandated, true);
  assert.deepEqual(errors, []);
});

test('コードパス言及 + ワークフロー工程の明記のみ → エラーなし', () => {
  const { errors } = checkPlan({ plan: STEPS_PLAN });
  assert.deepEqual(errors, []);
});

test('コードパス言及 + 成果物も工程明記も無し → 2 エラー', () => {
  const { errors, mandated } = checkPlan({
    plan: '## 変更内容\n- src/lib/foo.js を修正する',
  });
  assert.equal(mandated, true);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.includes('想定ケース表')));
  assert.ok(errors.some((e) => e.includes('既存実装調査表')));
});

test('セクションと工程明記の混在（片方ずつ） → エラーなし', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

## 想定ケース
- 空入力でも落ちない

## 手順
1. /codebase-recon を実行してから実装
`;
  assert.deepEqual(checkPlan({ plan }).errors, []);
});

test('docs/prose パスのみ言及 → mandated=false・エラーなし', () => {
  const { errors, mandated, warnings } = checkPlan({
    plan: '## 変更内容\n- docs/ARCHITECTURE.md と CLAUDE.md を更新する',
  });
  assert.equal(mandated, false);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('ゲート対象外')));
});

test('パス言及ゼロの plan → 厳格側（mandated=true）＋根拠をエラーで明示', () => {
  const { errors, mandated } = checkPlan({ plan: '## 変更内容\ndiff 表示を高速化する' });
  assert.equal(mandated, true);
  assert.ok(errors.some((e) => e.includes('パス言及')));
});

test('skip マーカー（理由あり） → 通過＋警告', () => {
  const { errors, mandated, warnings } = checkPlan({
    plan: '<!-- plan-gate: skip (設定ファイルの調査のみで変更なし) -->\nsrc/lib/foo.js を読む',
  });
  assert.equal(mandated, false);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('スキップ')));
});

test('skip マーカーの理由が空・プレースホルダ → エラー', () => {
  for (const marker of [
    '<!-- plan-gate: skip -->',
    '<!-- plan-gate: skip (　) -->',
    '<!-- plan-gate: skip (なし) -->',
    '<!-- plan-gate: skip (TODO) -->',
    '<!-- plan-gate: skip (未定) -->',
    '<!-- plan-gate: skip (tbd) -->',
  ]) {
    const { errors } = checkPlan({ plan: `${marker}\nsrc/lib/foo.js` });
    assert.ok(
      errors.some((e) => e.includes('skip マーカー')),
      `理由なし skip を通してはいけない: ${marker}`,
    );
  }
});

test('セクションはあるが空・プレースホルダのみ → エラー（hasSubstance 再利用）', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

## 想定ケース
...

## 既存実装調査
| # | 目的 | 結果 |
|---|---|---|
`;
  const { errors } = checkPlan({ plan });
  assert.equal(errors.length, 2);
});

test('H3 見出しのセクションも検出する（levels オプション）', () => {
  const plan = `
## 準備
### 想定ケース
- 空入力

### 既存実装調査
- Grep "foo" src/ → なし（新規）

## 変更内容
- src/lib/foo.js
`;
  assert.deepEqual(checkPlan({ plan }).errors, []);
});

test('コードフェンス内の見出し・工程名・skip マーカーは受理しない', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

\`\`\`md
## 想定ケース
- 例示
## 既存実装調査
- 例示
/risk-modeling /codebase-recon
<!-- plan-gate: skip (例示) -->
\`\`\`
`;
  const { errors, mandated } = checkPlan({ plan });
  assert.equal(mandated, true);
  assert.equal(errors.length, 2);
});

test('異種フェンス混在（``` 内の ~~~ 行）でもフェンス内の例示を受理しない', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

\`\`\`md
~~~
## 想定ケース
- 例示
## 既存実装調査
- 例示
/risk-modeling /codebase-recon
\`\`\`
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('ワークフロー doc への参照パスの列挙だけでは「実行の明記」にならない', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

## 関連ドキュメント
- docs/agent-workflows/risk-modeling.md
- docs/agent-workflows/codebase-recon.md
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('拡張子なしコードファイル（Dockerfile 等）+ prose パスでも docs-only にならない', () => {
  const { mandated } = checkPlan({ plan: '## 変更内容\n- Dockerfile と docs/README.md を更新' });
  assert.equal(mandated, true);
});

// --- #408 レビュー指摘の回帰（PATH_TOKEN 結合・フェンスインデント・拡張子なしコード領域） ---

test('extractPlanPaths: 空白なし区切り（カンマ）で隣接パスが結合しない', () => {
  assert.deepEqual(extractPlanPaths('foo.js,docs/README.md'), ['foo.js', 'docs/README.md']);
  assert.deepEqual(extractPlanPaths('src/lib/a.js;src/lib/b.js'), ['src/lib/a.js', 'src/lib/b.js']);
  assert.deepEqual(extractPlanPaths('[src/lib/a.js]{docs/b.md}'), ['src/lib/a.js', 'docs/b.md']);
});

test('隣接パスの結合による docs-only 誤判定が起きない（回帰: #408 Gemini指摘）', () => {
  const { mandated } = checkPlan({
    plan: '## 変更内容\nsrc/lib/foo.js,docs/README.md を更新する',
  });
  assert.equal(mandated, true);
});

test('フェンス開始はインデント無制限で認識する（ネストリスト・タブ経由の見落とし回帰）', () => {
  const nested = `
## 変更内容
- src/lib/foo.js を修正

- 記法サンプル:

    \`\`\`
## 想定ケース
- 空入力

## 既存実装調査
- Grep "foo" src/ → なし（新規）

    \`\`\`
`;
  // 4スペースインデント（ネストリスト直下の典型例）の \`\`\` もフェンス開始として認識され、
  // 内側の見出しは隠される（開始側の見落としは可視化バイパスに直結するため緩く保つ）
  const nestedResult = checkPlan({ plan: nested });
  assert.equal(nestedResult.errors.length, 2);

  const tabbed = `
## 変更内容
- src/lib/foo.js を修正

\t\`\`\`
\t/risk-modeling は例です（実施ではない）
\t/codebase-recon も例です
\t\`\`\`
`;
  // タブインデントの \`\`\` もフェンス開始として認識され、内側の工程トークン例示は隠される
  const tabbedResult = checkPlan({ plan: tabbed });
  assert.equal(tabbedResult.errors.length, 2);
});

test('フェンス早期クローズによる偽装コンテンツ受理を防ぐ（回帰: #408 Gemini指摘・実バイパス）', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

\`\`\`
    \`\`\`
## 想定ケース
- 例示（フェンス内のはずが4スペースインデント裸フェンスで早期クローズされ漏れる）
## 既存実装調査
- 例示
/risk-modeling /codebase-recon
\`\`\`
`;
  // 4スペースインデントの ``` は閉じフェンスとして扱われない（終了は CommonMark 準拠で
  // 0〜3スペースのみ。開始とは非対称）ため、以降もフェンス内のまま。偽装コンテンツは受理されない
  const { errors, mandated } = checkPlan({ plan });
  assert.equal(mandated, true);
  assert.equal(errors.length, 2);
});

test('拡張子なしコード領域言及（src/ 等）+ prose パス併記で docs-only にならない（回帰: #408 Codex指摘）', () => {
  const plan =
    '## 変更内容\nCLAUDE.md の説明に合わせて src/lib の認証まわりを修正する。\n' +
    'docs/agent-workflows/risk-modeling.md の想定ケースは省略。';
  const { mandated, errors } = checkPlan({ plan });
  assert.equal(mandated, true);
  assert.ok(errors.some((e) => e.includes('想定ケース表')));
  assert.ok(errors.some((e) => e.includes('既存実装調査表')));
});

test('コードルート言及があってもワークフロー明記があれば通過する', () => {
  const plan =
    '## 変更内容\nCLAUDE.md に合わせて scripts/foo.js を直す。\n' +
    '## 手順\n1. /risk-modeling 実行\n2. /codebase-recon 実行';
  assert.deepEqual(checkPlan({ plan }).errors, []);
});

test('prose パスのみ（コードルート言及なし）は引き続き docs-only 扱い', () => {
  const { mandated } = checkPlan({ plan: '## 変更内容\nCLAUDE.md と docs/README.md を更新' });
  assert.equal(mandated, false);
});

test('CODE_ROOT_MENTION は末尾スラッシュなしの自然な言い方も拾う（回帰: #408 再検証）', () => {
  const cases = [
    'CLAUDE.md の説明に合わせて src 配下のコードを直す。docs/agent-workflows/risk-modeling.md は省略。',
    'worker のコードを更新する。CLAUDE.md も更新。',
    'bench 配下のベンチマークコードと docs/README.md を見直す。',
  ];
  for (const plan of cases) {
    const { mandated } = checkPlan({ plan: `## 変更内容\n${plan}` });
    assert.equal(mandated, true, `bare word code-root mention should be strict: ${plan}`);
  }
});

test('extractPlanPaths: 全角区切り文字（中黒・全角カンマ）でも隣接パスが結合しない（回帰: #408 再検証）', () => {
  assert.deepEqual(extractPlanPaths('vite.config.js・docs/README.md'), [
    'vite.config.js',
    'docs/README.md',
  ]);
  assert.deepEqual(extractPlanPaths('foo.js，docs/README.md'), ['foo.js', 'docs/README.md']);
  const { mandated } = checkPlan({
    plan: '## 変更内容\n対象は vite.config.js・docs/README.md の2点。',
  });
  assert.equal(mandated, true);
});

test('CODE_ROOT_MENTION は大文字表記（Cloudflare Worker 等）も拾う（回帰: #408 再検証）', () => {
  const { mandated } = checkPlan({
    plan:
      '## 変更内容\nCLAUDE.md の説明に合わせて Cloudflare Worker 同期サーバーを修正する。\n' +
      'docs/agent-workflows/risk-modeling.md は省略。',
  });
  assert.equal(mandated, true);
});

test('テーブルのプレースホルダ行のみのセクションは実質なし扱い（回帰: #408 再検証）', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

## 想定ケース
| # | ケース | 対応 |
|---|---|---|
| TODO | TODO | TODO |

## 既存実装調査
| # | 目的 | 結果 |
|---|---|---|
| なし | - | N/A |
`;
  const { errors } = checkPlan({ plan });
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.includes('想定ケース表')));
  assert.ok(errors.some((e) => e.includes('既存実装調査表')));
});

test('テーブルに実質的なセルが1つでもあれば通過する', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

## 想定ケース
| # | ケース | 対応 |
|---|---|---|
| 1 | null 入力 | ガードして早期 return |

## 既存実装調査
| # | 目的 | 結果 | 判断 |
|---|---|---|---|
| 1 | 類似検索 | なし | 新規 |
`;
  assert.deepEqual(checkPlan({ plan }).errors, []);
});

test('箇条書きのプレースホルダのみのセクションも実質なし扱い', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

## 想定ケース
- TODO
- なし

## 既存実装調査
- 記入
`;
  const { errors } = checkPlan({ plan });
  assert.equal(errors.length, 2);
});

// --- 追加レビュー（Gemini/Codex）の回帰: プレースホルダ・パス抽出・plan 取得の穴 ---

test('ID列に数値があるプレースホルダ表を実質なし扱い（回帰: Gemini high）', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

## 想定ケース
| # | ケース | 対応 |
|---|---|---|
| 1 | TODO | TODO |
| 2 | なし | TBD |

## 既存実装調査
| # | 目的 | 結果 |
|---|---|---|
| 1 | # | * |
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('複数行 HTML コメントでコメントアウトした成果物は実質なし扱い（回帰: Codex）', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

## 想定ケース
<!--
- 空入力でも落ちない
-->

## 既存実装調査
<!-- - Grep foo src/ → なし（新規） -->
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('外側パイプなしの GFM 表のプレースホルダも実質なし扱い（回帰: Codex）', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

## 想定ケース
ケース | 対応
--- | ---
TODO | TODO

## 既存実装調査
目的 | 結果
--- | ---
なし | N/A
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('番号付き・タスクリストのプレースホルダも実質なし扱い（回帰: Gemini medium）', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

## 想定ケース
1. TODO
2. なし

## 既存実装調査
- [ ] TODO
- [ ] TBD
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('grep 等のパイプ付きコマンドを含む既存実装調査は誤ブロックしない（回帰: 区切り行なしの | 行）', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

## 想定ケース
- 出力を tee | logger に渡すケースでも落ちない

## 既存実装調査
- rg "handler" src/ | head → 該当なし（新規）
`;
  assert.deepEqual(checkPlan({ plan }).errors, []);
});

test('番号付きリストに実質があれば通過する', () => {
  const plan = `
## 変更内容
- src/lib/foo.js を修正

## 想定ケース
1. 空入力でエラーを返す

## 既存実装調査
- [x] Grep "foo" src/ で類似実装を確認 — なし（新規）
`;
  assert.deepEqual(checkPlan({ plan }).errors, []);
});

test('extractPlanPaths: 先頭ドットの設定ファイル（.env 等）を prose 併記でも抽出（回帰: Codex）', () => {
  assert.ok(extractPlanPaths('CLAUDE.md と .env を更新する').includes('.env'));
  assert.ok(extractPlanPaths('.npmrc と .editorconfig を調整').includes('.npmrc'));
  // prose パス（CLAUDE.md）併記でも .env が code 判定を起こし mandated=true
  const { mandated } = checkPlan({ plan: '## 変更内容\nCLAUDE.md と .env を更新する' });
  assert.equal(mandated, true);
});

test('skip 理由がプレースホルダ語で始まる実質理由 → 弾かない', () => {
  const { errors, warnings } = checkPlan({
    plan: '<!-- plan-gate: skip (未使用ブランチの調査のみで変更なし) -->\nsrc/lib/foo.js',
  });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('スキップ')));
});

test('コードフェンス内のコードパス言及は code 判定の根拠になる', () => {
  const plan = `
## 変更内容
docs/README.md を更新し、以下も変更:

\`\`\`js
// src/lib/foo.js
\`\`\`
`;
  assert.equal(checkPlan({ plan }).mandated, true);
});

test('CRLF 本文でも同一判定', () => {
  const { errors } = checkPlan({ plan: FULL_PLAN.replace(/\n/g, '\r\n') });
  assert.deepEqual(errors, []);
});

test('extractPlanPaths: URL・日付・バージョンをパスと誤認しない', () => {
  const paths = extractPlanPaths(
    '2026/07/11 に v1.2.3 をリリース。https://example.com/foo.js を参照。変更は src/lib/db.js。',
  );
  assert.deepEqual(paths, ['src/lib/db.js']);
});

// --- #409 mdast 移行の AST 境界回帰 ---

const CODE_HEADER = '## 変更内容\n- src/lib/foo.js を修正\n';

test('引用内の見出し（> ## 想定ケース）はセクションとして採用しない', () => {
  const plan = `${CODE_HEADER}
> ## 想定ケース
> - 引用された他者の記録

> ## 既存実装調査
> - 同上
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('0〜3スペースインデントの見出しを認識する（旧行ベースの誤ブロック解消を固定）', () => {
  // インデント見出しの直前がリストだと CommonMark のリスト継続で見出しがリスト内に
  // 取り込まれるため、段落で区切った独立文脈で検証する（下の別テストで固定）
  const plan = `## 変更内容

src/lib/foo.js を修正する。

  ## 想定ケース

空入力でも落ちないことを確認する。

   ## 既存実装調査

Grep "foo" src/ で類似実装なし（新規）。
`;
  assert.deepEqual(checkPlan({ plan }).errors, []);
});

test('リスト直後のインデント見出しはリスト項目に取り込まれセクション不採用（GitHub 描画と一致）', () => {
  const plan = `${CODE_HEADER}
  ## 想定ケース
- 空入力

  ## 既存実装調査
- Grep → なし
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('4スペースインデントの見出しはインデントコード扱いでセクション不採用', () => {
  const plan = `${CODE_HEADER}
    ## 想定ケース
    - 空入力

    ## 既存実装調査
    - Grep → なし
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('コメントのみの見出し（## <!-- 想定ケース -->）はセクション不採用', () => {
  const plan = `${CODE_HEADER}
## <!-- 想定ケース -->
- 不可視の見出しで充足させない

## <!-- 既存実装調査 -->
- 同上
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('インラインコメントのみの項目は実質なし・実内容併記は実質あり', () => {
  const placeholderOnly = `${CODE_HEADER}
## 想定ケース
- <!-- 空入力でも落ちない -->

## 既存実装調査
- <!-- Grep → なし -->
`;
  assert.equal(checkPlan({ plan: placeholderOnly }).errors.length, 2);

  const withRealContent = `${CODE_HEADER}
## 想定ケース
- 空入力でも落ちない <!-- 補足コメント -->

## 既存実装調査
- Grep "foo" src/ → なし（新規） <!-- 補足 -->
`;
  assert.deepEqual(checkPlan({ plan: withRealContent }).errors, []);
});

test('セクション本文の途中から次セクション手前まで跨ぐ複数行コメントも実質なし扱い', () => {
  const plan = `${CODE_HEADER}
## 想定ケース
<!--
- 空入力でも落ちない
- 巨大入力

## この見出しごとコメント内
-->

## 既存実装調査
<!-- - Grep → なし
- 慣習確認 -->
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('リスト内にネストしたプレースホルダ表は実質なし・実質あり表は通過', () => {
  const placeholder = `${CODE_HEADER}
## 想定ケース
- TODO
  | # | ケース |
  |---|---|
  | 1 | TODO |

## 既存実装調査
- TBD
  | # | 目的 |
  |---|---|
  | 1 | なし |
`;
  assert.equal(checkPlan({ plan: placeholder }).errors.length, 2);

  const real = `${CODE_HEADER}
## 想定ケース
- 一覧:
  | # | ケース |
  |---|---|
  | 1 | null 入力でガードして早期 return |

## 既存実装調査
- 一覧:
  | # | 目的 |
  |---|---|
  | 1 | Grep "foo" src/ → なし（新規） |
`;
  assert.deepEqual(checkPlan({ plan: real }).errors, []);
});

test('setext 見出し（想定ケース + ---）を H2 として認識する', () => {
  const plan = `${CODE_HEADER}
想定ケース
---
- 空入力でも落ちない

既存実装調査
---
- Grep "foo" src/ → なし（新規）
`;
  assert.deepEqual(checkPlan({ plan }).errors, []);
});

test('資源ガード: 行数超過の mandated plan は fail-loud', () => {
  const plan = `${CODE_HEADER}${'埋め草の行\n'.repeat(2100)}`;
  const { errors, mandated } = checkPlan({ plan });
  assert.equal(mandated, true);
  assert.ok(errors.some((e) => e.includes('plan 本文の行数が多すぎます')));
});

test('資源ガード: 引用ネスト超過は fail-loud', () => {
  const plan = `${CODE_HEADER}${'>'.repeat(33)} 深い引用`;
  const { errors } = checkPlan({ plan });
  assert.ok(errors.some((e) => e.includes('引用（>）のネストが深すぎます')));
});

test('資源ガード: 行数・引用ネストの両方が超過していても fail-loud（早期 return の境界）', () => {
  // 行数超過を検知した時点で早期 return するため引用ネストのエラーは出ないが、
  // 呼び出し側は guard.length > 0 のみで判定するため fail-loud であることに変わりはない
  const plan = `${CODE_HEADER}${'埋め草の行\n'.repeat(2100)}${'>'.repeat(33)} 深い引用`;
  const { errors } = checkPlan({ plan });
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('行数が多すぎます'));
});

test('資源ガード超過でも skip マーカーが先に評価され免除できる', () => {
  const plan = `<!-- plan-gate: skip (貼り付け資料が長大なだけでコード変更を含まない) -->\n${CODE_HEADER}${'埋め草の行\n'.repeat(2100)}`;
  const { errors, warnings, mandated } = checkPlan({ plan });
  assert.deepEqual(errors, []);
  assert.equal(mandated, false);
  assert.ok(warnings.some((w) => w.includes('スキップ')));
});

test('dotfile 一般化: 許可リスト外の dotfile（.prettierignore 等）も code 判定する', () => {
  // #408 の固定許可リスト方式ではリスト漏れが緩み側バイパスになっていた（.prettierignore 指摘）
  assert.ok(
    extractPlanPaths('CLAUDE.md と .prettierignore を更新する').includes('.prettierignore'),
  );
  const { mandated } = checkPlan({
    plan: '## 変更内容\nCLAUDE.md と .prettierignore を更新する',
  });
  assert.equal(mandated, true);
});

test('dotfile 一般化: 拡張子の単独言及（.js を追加 等）は mandated を変えない', () => {
  const paths = extractPlanPaths('docs/README.md の説明に .js と .css を追加する');
  assert.deepEqual(paths, ['docs/README.md']);
  const { mandated } = checkPlan({
    plan: '## 変更内容\ndocs/README.md の説明に .js と .css の記述を追加する',
  });
  assert.equal(mandated, false);
});

test('dotfile 一般化: prose 扱いの dotfile（.gitignore）は classify で除外され mandated を変えない', () => {
  const paths = extractPlanPaths('CLAUDE.md と .gitignore を更新する');
  assert.deepEqual(paths, ['CLAUDE.md']);
  const { mandated } = checkPlan({ plan: '## 変更内容\nCLAUDE.md と .gitignore を更新する' });
  assert.equal(mandated, false);
});

test('不可視コメント偽装（タグ同居・リンクtitle・インラインコード内）で token 判定を充足できない', () => {
  // コメント「ノード」単位の除去だけでは漏れる3形態（#409 レビューで実測したバイパス）。
  // いずれも GitHub 上で /risk-modeling 等が不可視（または例示）なのに充足になっていた
  const cases = [
    `${CODE_HEADER}\n<div><!-- /risk-modeling を実行 --></div>\n<div><!-- /codebase-recon を実行 --></div>\n`,
    `${CODE_HEADER}\n<!-- /risk-modeling --><b>x</b>\n\n<!-- /codebase-recon --><i>y</i>\n`,
    `${CODE_HEADER}\n[参考](https://example.com "<!-- /risk-modeling /codebase-recon -->")\n`,
    `${CODE_HEADER}\n\`<!-- /risk-modeling -->\` と \`<!-- /codebase-recon -->\` の例\n`,
  ];
  for (const plan of cases) {
    assert.equal(
      checkPlan({ plan }).errors.length,
      2,
      `不可視コメント偽装を通してはいけない: ${plan}`,
    );
  }
});

test('引用装飾のプレースホルダ（> TODO）は実質なし扱い', () => {
  const plan = `${CODE_HEADER}
## 想定ケース

> TODO

## 既存実装調査

> なし
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('リスト内引用のプレースホルダ（- > TODO）も実質なし扱い（交互ネストの不動点剥がし）', () => {
  const plan = `${CODE_HEADER}
## 想定ケース
- > TODO

## 既存実装調査
- > なし
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('コメント分断による doc 参照偽装（risk-modeling<!-- x -->.md）が token 判定を充足できない', () => {
  // GitHub はコメントを除去して前後を「結合」して描画する。空白化のままだと
  // `risk-modeling<!-- x -->.md` が `risk-modeling   .md` になり (?!\.md) を素通りする
  // （#409 収束レビューで実測した緩み側回帰）
  const plan = `${CODE_HEADER}
## 関連ドキュメント
- docs/agent-workflows/risk-modeling<!-- x -->.md
- docs/agent-workflows/codebase-recon<!-- x -->.md
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('コメント分断によるプレースホルダ偽装（TO<!-- -->DO）が実質判定を充足できない', () => {
  // GitHub 描画では結合されて `TODO` / `なし` になる（#409 収束レビューで実測）
  const plan = `${CODE_HEADER}
## 想定ケース
- TO<!-- -->DO

## 既存実装調査
- な<!-- -->し
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('閉じ忘れコメント内の工程トークンは token 判定を充足できない', () => {
  // GitHub は閉じ忘れ <!-- 以降を文書末尾まで不可視にする。token 判定は生テキストへの
  // 正規表現のため、mdast の html ブロック化だけでは遮断されない（#409 収束レビューで実測）
  const hiddenBoth = `${CODE_HEADER}
<!--
/risk-modeling を実行
/codebase-recon を実行
`;
  assert.equal(checkPlan({ plan: hiddenBoth }).errors.length, 2);
  const hiddenOne = `${CODE_HEADER}
## 想定ケース
- 空入力でも落ちない: ガードを追加

<!--
/codebase-recon を実行
`;
  assert.equal(checkPlan({ plan: hiddenOne }).errors.length, 1);
});

test('閉じ忘れコメントの前にある可視トークン・閉じたコメントの後の可視トークンは充足する', () => {
  const plan = `${CODE_HEADER}
<!-- メモ -->
実装前に /risk-modeling と /codebase-recon を実行する。

<!--
以降は不可視
`;
  assert.equal(checkPlan({ plan }).errors.length, 0);
});

test('プレースホルダ行の末尾に閉じ忘れコメントを付けても実質判定を充足できない', () => {
  // GitHub 描画は「TODO」のみ可視。ゲートが「TODO <!--」を非プレースホルダと
  // 誤認しないこと
  const plan = `${CODE_HEADER}
## 想定ケース
- TODO <!--
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('dotfile 一般化: 拡張子なしの dot ディレクトリ配下パス（.github/workflows）で mandated=true', () => {
  // PATH_TOKEN は拡張子必須のため拾えない。GENERIC_DOTFILE がパス全体を拾い
  // classify で code 判定される（#409 収束レビューで実測した緩み側の穴）
  const paths = extractPlanPaths('.github/workflows に CI ワークフローを追加する');
  assert.ok(paths.includes('.github/workflows'));
  const { mandated } = checkPlan({
    plan: '## 変更内容\n.github/workflows に CI ワークフローを追加し、docs/README.md を更新する',
  });
  assert.equal(mandated, true);
});

test('dotfile 一般化: 先頭セグメントでないネスト dotfile（config/.eslintrc 等）も抽出する（#411 code-review）', () => {
  // GENERIC_DOTFILE の否定後読みが `/`・`\` を除外していたため、拡張子名が PATH_TOKEN の
  // \w{1,6} 上限を超えるネスト dotfile（.eslintrc=8文字 等）がどのチャネルからも拾われず
  // docs-only 誤判定になっていた（緩み側バイパス）
  for (const [text, expected] of [
    ['config/.eslintrc を更新する', '.eslintrc'],
    ['packages/x/.prettierrc を更新する', '.prettierrc'],
    ['ルートの .browserslistrc を直す', '.browserslistrc'],
  ]) {
    const paths = extractPlanPaths(text);
    assert.ok(paths.includes(expected), `抽出できていない: ${text} -> ${JSON.stringify(paths)}`);
    const { mandated } = checkPlan({ plan: `## 変更内容\ndocs/README.md と ${text}` });
    assert.equal(mandated, true, `mandated=true になっていない: ${text}`);
  }
  // 通常拡張子（直前が単語文字）は従来どおり PATH_TOKEN 側に委ね、GENERIC_DOTFILE では
  // 二重に拾わない（境界差分: 直前が /・\ のケースのみ緩和、単語文字直後は変更なし）
  const normalExt = extractPlanPaths('docs/README.md の説明');
  assert.deepEqual(normalExt, ['docs/README.md']);
});

test('dotfile 一般化: 同一 dotfile の大量重複言及でも抽出・mandated 判定が正しい（Set dedup 非退行）', () => {
  // GENERIC_DOTFILE の raw match を Set で重複排除しても、生存トークンの集合・最終判定は
  // 重複排除前と同一であること（ログ貼り付け等の大量重複への perf 対応。#411 Gemini 指摘）
  const repeated = '.eslintrc の設定を直す。\n'.repeat(500);
  const paths = extractPlanPaths(repeated);
  assert.ok(paths.includes('.eslintrc'));
  const { mandated, errors } = checkPlan({ plan: `## 変更内容\n${repeated}` });
  assert.equal(mandated, true);
  assert.equal(errors.length, 2);
});

test('dotfile 一般化: パス先頭セグメント（.claude 等）を単独トークンとして誤抽出しない', () => {
  // `.claude/agents/foo.md` から `.claude` を切り出すと classify の PROSE_PATTERNS
  // （末尾スラッシュ必須）に不一致で code 誤判定になり、docs + .claude 配下の設計文書のみの
  // plan が恒常的に誤 mandated 化する（#409 レビューで実測した strict 側回帰）
  assert.deepEqual(extractPlanPaths('docs/README.md と .claude/agents/foo.md を更新する'), [
    'docs/README.md',
    '.claude/agents/foo.md',
  ]);
  const { mandated } = checkPlan({
    plan: '## 変更内容\ndocs/README.md と .claude/agents/foo.md を更新する',
  });
  assert.equal(mandated, false);
});

test('.claude/settings.json は hook 実行コマンド宣言ファイルのため code 扱いで plan 言及も mandated=true になる（#446）', () => {
  // PATH_TOKEN・GENERIC_DOTFILE の両チャネルにヒットして重複するが、チャネル間重複は
  // extractPlanPaths 冒頭コメントのとおり既存設計で許容している（判定結果には影響しない）
  assert.deepEqual(extractPlanPaths('docs/README.md と .claude/settings.json を更新する'), [
    'docs/README.md',
    '.claude/settings.json',
    '.claude/settings.json',
  ]);
  const { mandated } = checkPlan({
    plan: '## 変更内容\ndocs/README.md と .claude/settings.json を更新する',
  });
  assert.equal(mandated, true);
});

test('Windows バックスラッシュパスを forward-slash と同一に判定する（#411 Gemini）', () => {
  // classify の PROSE_PATTERNS は `/` 固定のため、正規化しないと prose 配下の
  // backslash パスが厳格側（mandated=true）に誤判定される
  assert.equal(
    checkPlan({ plan: '## 変更内容\n.claude\\agents\\foo.md を更新する' }).mandated,
    false,
  );
  assert.equal(
    checkPlan({ plan: '## 変更内容\ndocs/README.md と .claude\\agents\\foo.md を更新する' })
      .mandated,
    false,
  );
  // 実コードパスは backslash でも非 prose のまま mandated=true（緩み側に倒れない）
  assert.equal(checkPlan({ plan: '## 変更内容\nsrc\\lib\\foo.js を修正する' }).mandated, true);
  // .claude/settings.json は code 扱い（#446）のため backslash 表記でも mandated=true のまま
  assert.equal(
    checkPlan({ plan: '## 変更内容\n.claude\\settings.json を更新する' }).mandated,
    true,
  );
});

test('dotfile 一般化: 頻出拡張子の単独言及（.scss / .d.ts 等）も mandated を変えない', () => {
  const { mandated } = checkPlan({
    plan: '## 変更内容\ndocs/README.md の説明に .scss と .d.ts の記述を追加する',
  });
  assert.equal(mandated, false);
});

test('資源ガードの行数は空行を除いてカウントする（長いログ貼り付けフェンスを誤ブロックしない）', () => {
  const plan = `${CODE_HEADER}
## 想定ケース
- 空入力でも落ちない

## 既存実装調査
- Grep "foo" src/ → なし（新規）

## 参考ログ
\`\`\`
${'ログ行\n'.repeat(2100)}\`\`\`
`;
  // フェンス内 2100 行は空白化されるため資源ガードに数えず、実質セクション完備なら通過
  assert.deepEqual(checkPlan({ plan }).errors, []);
});

test('フェンスを挟んだ断片の結合で setext 見出しが偽装成立しない（フェンス空行化の固定）', () => {
  // フェンス内行を「削除」すると `想定ケース` と `---` が隣接して setext H2 が
  // 偽装成立し、成果物なしで充足してしまう。空行化でブロック結合を防ぐ
  const plan = `${CODE_HEADER}
想定ケース
\`\`\`
フェンス内
\`\`\`
---
- 偽の実質

既存実装調査
\`\`\`
x
\`\`\`
---
- 同上
`;
  assert.equal(checkPlan({ plan }).errors.length, 2);
});

test('長大な単一トークン入力でも時間内に完了する（ReDoS 回帰）', () => {
  const plan = `src/${'a'.repeat(64 * 1024)}`;
  const start = process.hrtime.bigint();
  checkPlan({ plan });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 2000, `checkPlan が ${elapsedMs}ms かかっています`);
});

// --- readPlanFile（plan ファイル読み込みの境界） ---

test('readPlanFile: 許可 root 配下の .md のみ読む・root 外は null', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-gate-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'plan-gate-out-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const inside = path.join(dir, 'plan.md');
  writeFileSync(inside, 'plan body');
  const outsideMd = path.join(outside, 'other.md');
  writeFileSync(outsideMd, 'secret');

  const opts = { projectDir: dir, homeDir: path.join(dir, 'no-home') };
  assert.equal(readPlanFile(inside, opts), 'plan body');
  assert.equal(readPlanFile(outsideMd, opts), null);
  assert.equal(readPlanFile(path.join(dir, 'missing.md'), opts), null);
  assert.equal(readPlanFile(123, opts), null);
  assert.equal(readPlanFile(path.join(dir, 'not-markdown.txt'), opts), null);

  // `..` 始まりの正当なファイル名は root 外扱いにしない（セグメント判定）
  const dotdotName = path.join(dir, '..plan.md');
  writeFileSync(dotdotName, 'dotdot');
  assert.equal(readPlanFile(dotdotName, opts), 'dotdot');

  // root 内の symlink が root 外を指す場合は realpath 後に弾かれる
  const link = path.join(dir, 'link.md');
  symlinkSync(outsideMd, link);
  assert.equal(readPlanFile(link, opts), null);
});

test('readPlanFile: ~/.claude 配下（plan-file モードの既定置き場）も許可', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'plan-gate-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const plansDir = path.join(home, '.claude', 'plans');
  mkdirSync(plansDir, { recursive: true });
  const file = path.join(plansDir, 'x.md');
  writeFileSync(file, 'home plan');
  assert.equal(
    readPlanFile(file, { projectDir: path.join(home, 'nowhere'), homeDir: home }),
    'home plan',
  );
});

// --- hook プロセス（stdin JSON → exit code） ---

function runHook(stdin, env = {}) {
  return spawnSync(process.execPath, [HOOK], {
    input: stdin,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

test('hook: NG plan → exit 2 + stderr に不足内容', () => {
  const r = runHook(
    JSON.stringify({
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '## 変更内容\n- src/lib/foo.js を修正' },
    }),
  );
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('想定ケース表'));
  assert.ok(r.stderr.includes('plan-gate: skip'));
});

test('hook: OK plan → exit 0', () => {
  const r = runHook(JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: { plan: FULL_PLAN } }));
  assert.equal(r.status, 0);
});

test('hook: tool_input.plan 欠落 → fail-open（exit 0）＋stderr に告知', () => {
  const r = runHook(JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: {} }));
  assert.equal(r.status, 0);
  assert.ok(r.stderr.includes('plan 本文を取得できません'));
});

test('hook: 不正 JSON → fail-open（exit 0）', () => {
  const r = runHook('{ not json');
  assert.equal(r.status, 0);
});

test('hook: tool_input 中の実在 .md パス（plan-file モード）経由でも検査される', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-gate-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, 'plan.md');
  writeFileSync(planPath, '## 変更内容\n- src/lib/foo.js を修正');
  const r = runHook(
    JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: { plan_file_path: planPath } }),
    { CLAUDE_PROJECT_DIR: dir },
  );
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('既存実装調査表'));
});

test('hook: 無関係な .md 参照フィールドより "plan" を含むフィールドを優先する（回帰: #408 再検証）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-gate-priority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const unrelated = path.join(dir, 'unrelated.md');
  writeFileSync(unrelated, '## 無関係\nこれは plan ではない参照ドキュメント');
  const planPath = path.join(dir, 'plan.md');
  writeFileSync(planPath, '## 変更内容\n- src/lib/foo.js を修正');
  // JSON のキー順は unrelated_doc が先。優先探索が効いていなければ unrelated.md を
  // plan として誤検査し、期待するエラーメッセージが出ない
  const r = runHook(
    JSON.stringify({
      tool_name: 'ExitPlanMode',
      tool_input: { unrelated_doc: unrelated, plan_file_path: planPath },
    }),
    { CLAUDE_PROJECT_DIR: dir },
  );
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('既存実装調査表'));
});

test('readPlanFile: ディレクトリは isFile() で除外される', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-gate-dir-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const subdir = path.join(dir, 'looks-like-a-file.md');
  mkdirSync(subdir);
  assert.equal(readPlanFile(subdir, { projectDir: dir, homeDir: path.join(dir, 'no-home') }), null);
});

test('hook: tool_input.plan が .md パスの場合は本文を読む（回帰: Codex）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'plan-gate-planpath-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, 'plan.md');
  writeFileSync(planPath, '## 変更内容\n- src/lib/foo.js を修正');
  // plan がパス文字列で届いた場合、ファイル名を prose 扱いせずに中身を読んで検査する
  const r = runHook(JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: { plan: planPath } }), {
    CLAUDE_PROJECT_DIR: dir,
  });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('既存実装調査表'));
});

// --- plan-mode-reminder hook ---

function runReminder(stdin) {
  return spawnSync(process.execPath, [REMINDER_HOOK], { input: stdin, encoding: 'utf-8' });
}

test('reminder: permission_mode=plan のときのみ 1 行注入', () => {
  const planMode = runReminder(JSON.stringify({ permission_mode: 'plan', prompt: 'x' }));
  assert.equal(planMode.status, 0);
  assert.equal(planMode.stdout, `${REMINDER}\n`);

  for (const stdin of [
    JSON.stringify({ permission_mode: 'default', prompt: 'x' }),
    JSON.stringify({ prompt: 'x' }),
    '{ not json',
  ]) {
    const r = runReminder(stdin);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

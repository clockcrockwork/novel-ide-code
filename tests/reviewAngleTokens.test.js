import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ANGLE_TOKENS,
  CONDITIONAL_ANGLE_TOKENS,
  TIER_ANGLES,
  DESIGN_ADDON_ANGLES,
  TIER_DECL_NAMES,
  formatAngleList,
  parseAngleList,
} from '../scripts/agent/review-angle-tokens.js';
import {
  classify,
  DESIGN_DOC_PATTERNS,
  RECORD_DOC_PATTERNS,
} from '../scripts/agent/classify-changes.js';

// prose（review-angles/README.md）と機械ゲート（review-angle-tokens.js / classify-changes.js）の
// drift 検査（#452）。README の系統表・加算規則のパス列挙が正本の prose 側、スクリプトが判定の正
// — 両者がずれると「文書上は設計文書 Tier・ゲート上は非該当」の不整合 PR が生まれるため、
// 片方だけの更新をテストで落とす（docExamplesDogfood と同じ思想）。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(join(ROOT, 'docs/agent-workflows/review-angles/README.md'), 'utf-8');

test('#452: ANGLE_TOKENS の全トークンが README に存在する（系統名の drift 検査）', () => {
  for (const [key, def] of Object.entries(ANGLE_TOKENS)) {
    assert.ok(README.includes(def.label), `系統「${key}」の正式名「${def.label}」が README にない`);
    for (const tok of def.accept) {
      assert.ok(
        README.includes(tok),
        `系統「${key}」の受理トークン「${tok}」が README にない（短縮形も README の語彙に含めること）`,
      );
    }
  }
});

test('条件起動系統: CONDITIONAL_ANGLE_TOKENS が ANGLE_TOKENS と重複せず README の条件起動節に存在する（drift 検査）', () => {
  assert.ok(README.includes('条件起動系統'), 'README に「条件起動系統」の節が見つからない');
  for (const [key, def] of Object.entries(CONDITIONAL_ANGLE_TOKENS)) {
    assert.ok(
      !(key in ANGLE_TOKENS),
      `条件起動系統「${key}」が ANGLE_TOKENS と重複している（条件起動系統は通常 angle と種別が異なる` +
        `ため分離を維持すること。Full = ANGLE_TOKENS 全キーの不変条件は Phase 5 §15.4 で既に撤去済み` +
        `で、分離を要求する理由ではない）`,
    );
    assert.ok(
      README.includes(def.label),
      `条件起動系統「${key}」の正式名「${def.label}」が README の条件起動節にない`,
    );
    for (const tok of def.accept) {
      assert.ok(
        README.includes(tok),
        `条件起動系統「${key}」の受理トークン「${tok}」が README にない`,
      );
    }
  }
});

test('条件起動系統: CONDITIONAL_ANGLE_TOKENS の accept 文字列が ANGLE_TOKENS の accept 文字列と交差しない（check-artifacts の found/lastCount 汚染防止）', () => {
  const baseAccept = new Set(Object.values(ANGLE_TOKENS).flatMap((def) => def.accept));
  for (const [key, def] of Object.entries(CONDITIONAL_ANGLE_TOKENS)) {
    for (const tok of def.accept) {
      assert.ok(
        !baseAccept.has(tok),
        `条件起動系統「${key}」の受理トークン「${tok}」が ANGLE_TOKENS のいずれかの受理トークンと重複している（check-artifacts の照合で必須系統の found/lastCount を汚染するため分離を維持すること）`,
      );
    }
  }
});

test('#452/Phase2: TIER_ANGLES の構成が README の Tier 定義と一致する', () => {
  // Full = legacy 7系統（減算＋既存5系統＋清掃） / Light = 減算＋敵対的＋risk-model＋品質＋清掃 /
  // 設計文書 = 減算＋仕様＋運用性＋清掃（docs のみ mandate の基礎値。加算分 DESIGN_ADDON_ANGLES とは別）/
  // Record = 減算＋清掃 / Docs = 清掃のみ
  //
  // Phase 5 §15.4 authority switch: 「Full = ANGLE_TOKENS 全キー」の不変条件は明示的に撤去した
  // （testquality を ANGLE_TOKENS へ登録した一方、legacyReviewContract の構成要素である Full は
  // switch 前の7系統リテラルのまま凍結する）。したがって Full は ANGLE_TOKENS 全キーとの
  // deepEqual ではなく、switch 前から変わらない明示リテラル集合と比較する。
  assert.deepEqual(
    new Set(TIER_ANGLES.Full),
    new Set(['subtractive', 'riskmodel', 'spec', 'adversarial', 'quality', 'operability', 'cleanup']),
  );
  assert.ok(
    !TIER_ANGLES.Full.includes('testquality'),
    'legacy Full は testquality を含めない（凍結した pre-switch policy の意味を変えないため。' +
      'canonical registry 登録〔ANGLE_TOKENS〕と Tier 必須系統への追加は独立した決定）',
  );
  assert.deepEqual(
    new Set(TIER_ANGLES.Light),
    new Set(['subtractive', 'riskmodel', 'adversarial', 'quality', 'cleanup']),
  );
  assert.deepEqual(
    new Set(TIER_ANGLES['設計文書']),
    new Set(['subtractive', ...DESIGN_ADDON_ANGLES, 'cleanup']),
  );
  assert.deepEqual(new Set(TIER_ANGLES.Record), new Set(['subtractive', 'cleanup']));
  assert.deepEqual(new Set(TIER_ANGLES.Docs), new Set(['cleanup']));
  // 全 Tier の系統キーが ANGLE_TOKENS に実在する
  for (const angles of Object.values(TIER_ANGLES)) {
    for (const a of angles) {
      assert.ok(a in ANGLE_TOKENS, `TIER_ANGLES の系統キー「${a}」が ANGLE_TOKENS にない`);
    }
  }
});

test('#452: TIER_DECL_NAMES の全宣言名が README に存在する（Tier 語彙の drift 検査）', () => {
  for (const name of TIER_DECL_NAMES) {
    assert.ok(
      README.includes(name),
      `Tier 宣言名「${name}」が README にない（TIER_DECL_NAMES と README「収束と記録」を同一 PR で更新すること）`,
    );
  }
});

test('#452: README の加算規則パス列挙が classify の DESIGN_DOC_PATTERNS と一致する', () => {
  // README の加算規則 blockquote 行からバッククォート囲みのパスを抽出する
  const quoteLine = README.split('\n').find(
    (l) => l.startsWith('>') && l.includes('docs/agent-workflows/'),
  );
  assert.ok(quoteLine, 'README に加算規則のパス列挙（blockquote 行）が見つからない');
  const paths = [...quoteLine.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.ok(paths.length > 0, 'パス列挙からバッククォート囲みのパスを抽出できない');
  for (const p of paths) {
    // ディレクトリはファイルを補って、ファイルはそのまま classify に通す
    const probe = p.endsWith('/') ? `${p}x.md` : p;
    assert.equal(
      classify([probe]).designDocsChanged,
      true,
      `README 列挙のパス「${p}」が classify で設計文書と判定されない（DESIGN_DOC_PATTERNS を更新すること）`,
    );
  }
  // 逆方向: パターン数が README 列挙数と一致（スクリプト側だけの追加も drift として検出）
  assert.equal(
    DESIGN_DOC_PATTERNS.length,
    paths.length,
    `DESIGN_DOC_PATTERNS（${DESIGN_DOC_PATTERNS.length}件）と README 列挙（${paths.length}件）の件数が一致しない — 両方を同一 PR で更新すること`,
  );
});

test('Phase2: README の Record Tier 対象パスが classify の RECORD_DOC_PATTERNS と一致する', () => {
  assert.equal(
    RECORD_DOC_PATTERNS.length,
    1,
    'RECORD_DOC_PATTERNS の件数が想定外。README「Record」節も同一 PR で更新すること',
  );
  assert.ok(
    README.includes('docs/agent-memory/records/'),
    'README に Record Tier 対象パス（docs/agent-memory/records/）の記載がない',
  );
  assert.equal(
    classify(['docs/agent-memory/records/x.json']).recordDocsChanged,
    true,
    'classify が docs/agent-memory/records/ 配下を記憶レコードと判定しない',
  );
});

// angle-subtractive.md / angle-cleanup.md の「モード判定」表は意図的に同一内容（両系統とも
// implementation/documentation-workflow/mixed の3モードを共有する）。分離原則により本文を
// 相互参照させられないため、drift はこのテストで機械検出する（減算レビューで指摘。#452 Phase2）
function extractModeSection(text) {
  const match = text.match(/## モード判定\n[\s\S]*?(?=\n## )/);
  if (!match) throw new Error('「## モード判定」セクションが見つからない');
  return match[0];
}

test('Phase2: angle-subtractive.md と angle-cleanup.md の「モード判定」表が一致する（意図的重複の drift 検査）', () => {
  const subtractive = readFileSync(
    join(ROOT, 'docs/agent-workflows/review-angles/angle-subtractive.md'),
    'utf-8',
  );
  const cleanup = readFileSync(
    join(ROOT, 'docs/agent-workflows/review-angles/angle-cleanup.md'),
    'utf-8',
  );
  assert.equal(
    extractModeSection(subtractive),
    extractModeSection(cleanup),
    'angle-subtractive.md と angle-cleanup.md の「モード判定」セクションが乖離した（両ファイルとも同一内容に保つ）',
  );
});

// #645: review-plan.js（生成）と check-artifacts.js（検証）が共有する authority receipt の
// 「空集合表現」規約。どちらか一方だけ規約が変わると receipt の空リストが誤って非空・逆に非空が
// 空と解釈される（生成側と検証側の暗黙契約が乖離する）ため、round-trip で固定する。
test('#645 formatAngleList/parseAngleList: 空集合は "-"、非空はカンマ区切りで round-trip する', () => {
  assert.equal(formatAngleList([]), '-');
  assert.deepEqual(parseAngleList('-'), []);
  assert.equal(formatAngleList(['riskmodel', 'testquality']), 'riskmodel,testquality');
  assert.deepEqual(parseAngleList('riskmodel,testquality'), ['riskmodel', 'testquality']);
});

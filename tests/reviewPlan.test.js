import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  anglesForTierName,
  applyBudget,
  AUTO_EXPLORATION_BUDGET,
  baseTierOf,
  buildPlan,
  computeInitialTier,
  emptyState,
  hasDesignAddon,
  deriveSignals,
  discardLegacyFindingArtifacts,
  escalateAngles,
  formatPlan,
  STATE_VERSION,
  loadState,
  planCommand,
  plannedLaunches,
  reclassifyTier,
  recordRun,
  recordRunCommand,
  resolveRecordRunSnapshotId,
  selectMode,
  stateFile,
  tierNameForAngles,
  upgradeWhenPatchNarrower,
} from '../scripts/agent/review-plan.js';
import { classify } from '../scripts/agent/classify-changes.js';
import { makeTmpGitRepo, sh } from './helpers/tmpGitRepo.js';
import { DESIGN_ADDON_ANGLES, TIER_ANGLES } from '../scripts/agent/review-angle-tokens.js';
import {
  changedFilesBetween,
  classifyFile,
  createSnapshot,
  latestSnapshot,
} from '../scripts/agent/review-snapshot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function file(path, extra = {}) {
  return {
    path,
    status: 'M',
    additions: 5,
    deletions: 1,
    ...classifyFile(path, extra.oldPath),
    ...extra,
  };
}

function manifest(extra = {}) {
  return {
    snapshotId: '0001-abcdef1',
    previousSnapshotId: 'prev',
    guardChangeInFix: false,
    semanticDocChangeInFix: false,
    ...extra,
  };
}

// 段階の状態機械（減算 → 本体 → 清掃）: 本体以降の挙動を検証するテストは、先に減算（入口）を
// その snapshot で収束させておく必要がある（減算が未収束の間、本体系統は保留される＝正本手順
// 「減算を先に起動する」）。
// 「1 snapshot = 1 周」の判定はモードを見ないため、完了記録は全体再探索で代表させる
function settleSubtractive(state, snapshotId = '0001-abcdef1') {
  recordRun(state, {
    angle: 'subtractive',
    mode: 'full-rescan',
    fresh: true,
    status: 'complete',
    snapshotId,
  });
}

// buildPlan / plannedLaunches / recordRunCommand が受け取る snapshot の最小形。
// テストは `latestSnapshot()` と同じ形の値を渡す
function snap({ snapshotId = '0001-abcdef1', files = [], changedInFix = null, ...rest } = {}) {
  return {
    snapshotId,
    manifest: manifest({ snapshotId, ...rest }),
    changedFiles: { files, changedInFix: changedInFix ?? files },
  };
}

// 「計画 → 起動 → 記録」の順を守った記録。計画が要求している mode / fresh をその場で引き直して
// 記録するので、テスト側が提案内容を手で写す必要がない
function recordPlanned(state, snapshot, angle, extra = {}, resolveChangedSince = null) {
  const planned = plannedLaunches(state, snapshot, { resolveChangedSince }).find(
    (e) => e.angle === angle,
  );
  assert.ok(planned, `計画が ${angle} の起動を要求していない`);
  return recordRunCommand(
    state,
    {
      angle,
      mode: planned.mode,
      fresh: planned.fresh,
      status: 'complete',
      snapshotId: snapshot.snapshotId,
      ...extra,
    },
    { resolveSnapshot: () => snapshot, resolveChangedSince },
  );
}

// ---------------------------------------------------------------------------
// Tier 判定
// ---------------------------------------------------------------------------

test('初期 Tier: 通常コード変更は Light', () => {
  const t = computeInitialTier([file('src/lib/writingRules.js')]);
  assert.equal(t.tier, 'Light');
});

test('初期 Tier: 高リスク領域は Full', () => {
  const t = computeInitialTier([file('src/lib/db.js')]);
  assert.equal(t.tier, 'Full');
  assert.ok(t.reasons.some((r) => r.includes('高リスク')));
});

test('初期 Tier: 実行可能設計文書との混在は「＋設計文書」を加算する', () => {
  const t = computeInitialTier([
    file('src/lib/writingRules.js'),
    file('docs/agent-workflows/x.md'),
  ]);
  assert.equal(t.tier, 'Light＋設計文書');
  assert.ok(t.angles.includes('spec') && t.angles.includes('operability'));
});

test('初期 Tier: docs のみは 設計文書 > Record > Docs の優先順位', () => {
  assert.equal(computeInitialTier([file('docs/agent-workflows/x.md')]).tier, '設計文書');
  assert.equal(computeInitialTier([file('docs/agent-memory/records/a.json')]).tier, 'Record');
  assert.equal(computeInitialTier([file('docs/history.md')]).tier, 'Docs');
});

test('初期 Tier: 設計文書パスの大小変種でも設計文書 Tier になる（#446 round7 観点別レビュー 敵対的N1）', () => {
  assert.equal(computeInitialTier([file('.CLAUDE/agents/x.md')]).tier, '設計文書');
  assert.equal(computeInitialTier([file('Claude.md')]).tier, '設計文書');
});

test('初期 Tier: 依存 manifest のみ・変更なしは「なし」', () => {
  assert.equal(computeInitialTier([]).tier, 'なし');
  assert.equal(computeInitialTier([file('package.json'), file('package-lock.json')]).tier, 'なし');
});

test('初期 Tier: rename で code だった旧パス（oldPath）が Tier を下げない（#446 round3）', () => {
  // src/x.js（code）を docs/x.md（新パスだけなら prose）へ rename した場合、oldPath を
  // classify に含めないと Tier が Docs 側へ落ちてしまう（review-snapshot.js の
  // classifyFile と同じ密輸対策）
  const renamed = file('docs/x.md', { status: 'R', oldPath: 'src/x.js' });
  const result = computeInitialTier([renamed]);
  assert.notEqual(result.tier, 'Docs', `rename元がcodeならDocsへ落ちるべきでない: ${result.tier}`);
});

test('初期 Tier: 依存 manifest を prose パスへ rename した変更集合は「なし」に落ちない（#446 round4 敵対的 F-r4-1）', () => {
  // oldPath を classify 入力へ混ぜたことで、depOnly && allFilesAreDep が rename 経由でも
  // 成立してしまい、本来 Docs（origin/main と同じ）になるべき変更が「なし」（0系統）へ
  // 落ちる回帰があった。展開後のパス（rename 先が docs/ 配下）が docsChanged になるため、
  // 早期 return の「全展開パスが依存 manifest かつ非 prose」条件を満たさず対象外に残る
  // （#446 round6 で `hasRename` 一律除外から本条件へ変更した後も、この2ケースは
  // 従来どおり Docs のまま）。
  const renamedLockfile = file('docs/legacy/package-lock.json', {
    status: 'R',
    oldPath: 'package-lock.json',
  });
  assert.equal(computeInitialTier([renamedLockfile]).tier, 'Docs');

  const renamedManifest = file('docs/notes.md', { status: 'R', oldPath: 'package.json' });
  const lockfileBump = file('package-lock.json');
  assert.equal(computeInitialTier([renamedManifest, lockfileBump]).tier, 'Docs');
});

test('初期 Tier: 依存 manifest を既知 npm プロジェクト外へ rename すると通常判定になる（#446 round8 敵対的N4で仕様変更）', () => {
  // round6 では「rename 先・rename 元とも非 prose の依存 manifest なら『なし』」としていたが、
  // round7 で HIGH_RISK_PATTERNS 判定を導入した際に Dependabot の worker/ プロジェクトの
  // バンプが誤って Full に跳ねる回帰が起きた。round8 で「純粋な dep manifest」を
  // isKnownDepManifestPath（リポジトリルート・worker/ 直下）による allowlist へ置換した結果、
  // apps/foo/ のような未知の npm プロジェクトへの rename は早期 return の対象外になり、
  // 通常判定（highRisk でなければ Light）へ進む。rename 先が実在するプロジェクトかは静的パス
  // だけでは判別できないため、fail-closed 側（レビュー対象に含める）に倒す。
  const pureRename = file('apps/foo/package-lock.json', {
    status: 'R',
    oldPath: 'package-lock.json',
  });
  assert.equal(computeInitialTier([pureRename]).tier, 'Light');
});

test('初期 Tier: 既知 npm プロジェクト（ルート・worker/）直下の依存 manifest のみは「なし」（#446 round8 敵対的N4）', () => {
  assert.equal(
    computeInitialTier([file('package.json'), file('package-lock.json')]).tier,
    'なし',
  );
  assert.equal(
    computeInitialTier([file('worker/package.json'), file('worker/package-lock.json')]).tier,
    'なし',
    'Dependabot の worker/ プロジェクトの週次バンプが HIGH_RISK 条件で Full に跳ねてはいけない',
  );
});

test('初期 Tier: 依存 manifest のみは「なし」の reasons は「依存 manifest のみ」（変更なしと区別。#446 round7 観点別レビュー 敵対的N2）', () => {
  const result = computeInitialTier([file('package.json'), file('package-lock.json')]);
  assert.equal(result.tier, 'なし');
  assert.deepEqual(result.reasons, ['依存 manifest のみ']);
  assert.deepEqual(computeInitialTier([]).reasons, ['変更なし']);
});

test('初期 Tier: 依存 manifest が既知 npm プロジェクト外（bundled action の dist 配下等）にあると「なし」に落ちず Light 以上になる（#446 round7/round8 観点別レビュー 敵対的N2）', () => {
  // .github/actions/artifacts-gate/dist/package.json はパス単体では依存 manifest かつ
  // 非 prose に見えるため round6 の判定だけでは早期 return（Tier「なし」）してしまうが、
  // isKnownDepManifestPath（リポジトリルート・worker/ のみ）に該当しないため
  // bundled action への変更が観点別レビューを素通りしないよう Light 以上にする
  // （round7 は HIGH_RISK_PATTERNS 直接判定だったが、round8 で worker/ バンプの誤爆〔敵対的
  // N4〕を防ぐため isKnownDepManifestPath ベースへ置換。この個別ケースの結果は変わらない）。
  const bundleDep = file('.github/actions/artifacts-gate/dist/package.json');
  const lockfile = file('package-lock.json');
  const result = computeInitialTier([bundleDep, lockfile]);
  assert.notEqual(result.tier, 'なし');
  assert.notEqual(result.tier, 'Docs');
  assert.equal(result.base, 'Full');
});

test('初期 Tier: 設計文書＋依存bumpの混在は「なし」ではなく設計文書になる（回帰）', () => {
  const t = computeInitialTier([
    file('docs/agent-workflows/pre-commit-review.md'),
    file('package.json'),
    file('package-lock.json'),
  ]);
  assert.notEqual(
    t.tier,
    'なし',
    'depOnly の早期return が prose/設計文書の混在を無視してはいけない',
  );
  assert.equal(t.tier, '設計文書');
});

test('初期 Tier: 記憶レコード＋依存bumpの混在は Record になる（回帰）', () => {
  const t = computeInitialTier([
    file('docs/agent-memory/records/a.json'),
    file('package.json'),
    file('package-lock.json'),
  ]);
  assert.equal(t.tier, 'Record');
});

test('初期 Tier: .gitignore のみの変更は Docs（NON_EXPLANATORY_PROSE_PATTERNS を Tier 判定に転用しない、回帰）', () => {
  const t = computeInitialTier([file('.gitignore')]);
  assert.equal(t.tier, 'Docs');
  assert.ok(t.angles.includes('cleanup'), 'Docs Tier は清掃系統を必須にする');
});

test('初期 Tier: LICENSE のみの変更は Docs（回帰）', () => {
  const t = computeInitialTier([file('LICENSE')]);
  assert.equal(t.tier, 'Docs');
});

test('初期 Tier: 大規模 diff は Full へ引き上がる', () => {
  const files = Array.from({ length: 40 }, (_, i) => file(`src/components/x${i}.jsx`));
  assert.equal(computeInitialTier(files).tier, 'Full');
});

test('初期 Tier: #559 再現 — 依存キャッシュ削除＋設計文書変更は Light＋設計文書に固定される（Docs へ誤判定しない）', () => {
  const t = computeInitialTier([
    file('.vite/deps/_metadata.json', { status: 'D' }),
    file('docs/agent-workflows/pre-commit-review.md'),
  ]);
  assert.equal(t.tier, 'Light＋設計文書');
});

test('computeInitialTier は classify() の codeChanged/designDocsChanged/recordDocsChanged と drift しない', () => {
  const cases = [
    [file('src/lib/writingRules.js')],
    [file('src/lib/db.js')],
    [file('src/lib/writingRules.js'), file('docs/agent-workflows/x.md')],
    [file('docs/agent-workflows/x.md')],
    [file('docs/agent-memory/records/a.json')],
    [file('docs/history.md')],
    [file('package.json'), file('package-lock.json')],
    [
      file('.vite/deps/_metadata.json', { status: 'D' }),
      file('docs/agent-workflows/pre-commit-review.md'),
    ],
  ];
  for (const files of cases) {
    const paths = files.map((f) => f.path);
    const { codeChanged, designDocsChanged, recordDocsChanged, depOnly } = classify(paths);
    const t = computeInitialTier(files);
    if (depOnly) {
      assert.equal(t.tier, 'なし', `depOnly drift: ${paths.join(',')}`);
      continue;
    }
    assert.equal(t.base !== null, codeChanged, `codeChanged drift: ${paths.join(',')}`);
    if (!codeChanged) {
      assert.equal(
        t.tier === '設計文書',
        designDocsChanged,
        `designDocsChanged drift: ${paths.join(',')}`,
      );
      assert.equal(
        t.tier === 'Record',
        !designDocsChanged && recordDocsChanged,
        `recordDocsChanged drift: ${paths.join(',')}`,
      );
    } else {
      assert.equal(
        t.addon,
        designDocsChanged,
        `addon(designDocsChanged) drift: ${paths.join(',')}`,
      );
    }
  }
});

test('初期 Tier: 系統集合は基礎 Tier の必須系統を縮小しない（Light＋設計文書 が Light の全系統を含む）', () => {
  const t = computeInitialTier([
    file('src/lib/writingRules.js'),
    file('docs/agent-workflows/x.md'),
  ]);
  const required = new Set([...TIER_ANGLES.Light, ...DESIGN_ADDON_ANGLES]);
  for (const a of required) {
    assert.ok(t.angles.includes(a), `${a} が Light＋設計文書 の必須系統から欠落`);
  }
});

test('tierNameForAngles: 与えた系統をすべて含む最も弱い宣言名を選ぶ（不要な昇格をしない）', () => {
  assert.equal(tierNameForAngles(anglesForTierName('Light')), 'Light');
  assert.equal(
    tierNameForAngles([...anglesForTierName('Light'), 'operability']),
    'Light＋設計文書',
  );
});

test('tierNameForAngles: 同一系統集合の宣言名は基礎 Tier のヒントで解決する（Full が Light へ落ちない）', () => {
  // Light＋設計文書 と Full は必須系統が同一（7系統）。ヒント無しでは弱い方を返す
  assert.equal(tierNameForAngles(anglesForTierName('Full')), 'Light＋設計文書');
  assert.equal(tierNameForAngles(anglesForTierName('Full'), { preferBase: 'Full' }), 'Full');
  assert.equal(baseTierOf('Full＋設計文書'), 'Full');
  assert.equal(baseTierOf('Light'), 'Light');
  assert.equal(baseTierOf('Record'), null);
});

test('anglesForTierName: 加算形式は仕様＋運用性を含む', () => {
  const a = anglesForTierName('Light＋設計文書');
  assert.ok(a.includes('spec') && a.includes('operability'));
  assert.deepEqual(anglesForTierName('なし'), []);
});

// ---------------------------------------------------------------------------
// シグナルとモード選択
// ---------------------------------------------------------------------------

test('deriveSignals: 変更ファイルと manifest からシグナルを立てる', () => {
  const s = deriveSignals(manifest({ guardChangeInFix: true }), [
    file('src/lib/db.js'),
    { ...file('docs/agent-workflows/x.md'), status: 'A' },
  ]);
  assert.equal(s.code, true);
  assert.equal(s.highRisk, true);
  assert.equal(s.designDoc, true);
  assert.equal(s.newFile, true);
  assert.equal(s.guard, true);
  assert.equal(s.semanticDoc, false);
});

test('初回はどの観点も fresh の全体再探索になる', () => {
  const state = emptyState();
  const sel = selectMode(state, 'adversarial', deriveSignals(manifest(), []), { snapshotId: 's1' });
  assert.deepEqual([sel.run, sel.mode, sel.fresh], [true, 'full-rescan', true]);
});

test('ガード種の修正は敵対的を全体再探索へ引き上げる（境界そのものが動くため）', () => {
  const state = emptyState();
  recordRun(state, { angle: 'adversarial', mode: 'full-rescan', fresh: true, snapshotId: 's1' });
  const sel = selectMode(
    state,
    'adversarial',
    deriveSignals(manifest({ guardChangeInFix: true }), []),
    {
      snapshotId: 's2',
    },
  );
  assert.equal(sel.mode, 'full-rescan');
  assert.equal(sel.fresh, true);
});

test('修正差分がこの観点の探索対象を変えていなければ再起動しない（所見の有無は machine が持たない）', () => {
  const state = emptyState();
  recordRun(state, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's1' });
  const sel = selectMode(state, 'quality', deriveSignals(manifest(), [file('docs/history.md')]), {
    snapshotId: 's2',
  });
  assert.equal(sel.run, false, '所見確認モードは machine が提案しない（裁定は docs/pr/PR-*.md）');
  assert.equal(sel.mode, null);
});

test('直近の起動が incomplete なら所見ゼロで収束させず fresh で再探索する', () => {
  const state = emptyState();
  recordRun(state, {
    angle: 'spec',
    mode: 'full-rescan',
    fresh: true,
    status: 'incomplete',
    snapshotId: 's1',
  });
  const sel = selectMode(state, 'spec', deriveSignals(manifest(), []), { snapshotId: 's1' });
  assert.equal(sel.run, true);
  assert.equal(sel.fresh, true);
  assert.match(sel.reason, /incomplete/);
});

test('直近の起動が error（起動失敗）なら所見ゼロで収束させず fresh で再探索する（live-lock 回避）', () => {
  const state = emptyState();
  recordRun(state, {
    angle: 'spec',
    mode: 'full-rescan',
    fresh: true,
    status: 'error',
    snapshotId: 's1',
  });
  const sel = selectMode(state, 'spec', deriveSignals(manifest(), []), { snapshotId: 's1' });
  assert.equal(sel.run, true, 'error のまま放置すると当該観点が永久に再起動提案されない');
  assert.equal(sel.mode, 'full-rescan');
  assert.equal(sel.fresh, true);
  assert.match(sel.reason, /error/);
});

test('予算: 自動の新規探索は1観点1回。トリガーが立ち続けても2回目は提案しない', () => {
  const state = emptyState();
  const signals = deriveSignals(manifest(), [file('src/a.js')]);
  // 1回目: 予算あり
  assert.equal(applyBudget(selectMode(state, 'quality', signals), state, 'quality').run, true);

  assert.equal(AUTO_EXPLORATION_BUDGET, 1, '既定の予算は1観点1回（増やす前に効果を測る）');
  recordRun(state, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's1' });

  // 2回目: **同じ snapshot でも新しい snapshot でも**提案しない（トリガー自体は立っている）
  const trig = selectMode(state, 'quality', signals);
  assert.equal(trig.run, true, 'トリガーは予算を知らない');
  const sel = applyBudget(trig, state, 'quality');
  assert.equal(sel.run, false);
  assert.equal(sel.budgetOutcome, 'exhausted');
  // 見送った探索の内容を残す（「トリガー非該当」と区別できないと未確認範囲が消える）
  assert.equal(sel.withheld.mode, trig.mode);
  assert.match(sel.reason, /予算終了/);
});

test('予算: この snapshot を読み終えた系統は「未確認範囲あり」にしない（1 snapshot = 1 周）', () => {
  const state = emptyState();
  const signals = deriveSignals(manifest(), [file('src/a.js')]);
  recordRun(state, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's1' });
  const sel = applyBudget(selectMode(state, 'quality', signals), state, 'quality', {
    snapshotId: 's1',
  });
  assert.equal(sel.run, false);
  assert.equal(
    sel.budgetOutcome,
    'satisfied',
    '確認済みの系統まで人間判断へ並べると、本当に未確認な系統が埋もれる',
  );
  assert.match(sel.reason, /この snapshot で実施済み/);

  // 次の snapshot になれば、その hop は未確認範囲として改めて現れる
  const next = applyBudget(selectMode(state, 'quality', signals), state, 'quality', {
    snapshotId: 's2',
  });
  assert.equal(next.budgetOutcome, 'exhausted');

  // 「この snapshot に complete が1件でもあるか」で判定すると、その後の再探索が
  // incomplete で終わっても「実施済み」に見え、未確認範囲が人間判断から漏れる
  const reExplored = emptyState();
  recordRun(reExplored, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's1' });
  recordRun(reExplored, {
    angle: 'quality',
    mode: 'full-rescan',
    fresh: true,
    snapshotId: 's1',
    status: 'incomplete',
  });
  const afterIncomplete = applyBudget(
    selectMode(reExplored, 'quality', signals),
    reExplored,
    'quality',
    { snapshotId: 's1' },
  );
  assert.equal(afterIncomplete.budgetOutcome, 'exhausted');
  assert.match(afterIncomplete.reason, /incomplete/);

  // 計画の理由欄でも「トリガー非該当」に化けない（トリガーは立っている）
  const planState = lightState();
  recordRun(planState, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's1' });
  settleSubtractive(planState, 's1');
  const changed = [file('src/a.js')];
  const e = buildPlan({
    state: planState,
    manifest: manifest({ snapshotId: 's1' }),
    changedFiles: changed,
    changedInFix: changed,
  }).entries.find((x) => x.angle === 'quality');
  assert.match(e.reason, /この snapshot で実施済み/);
  assert.doesNotMatch(e.reason, /再探索トリガー該当なし/);
});

test('予算: status=error も消費する（起動失敗の自動リトライに上限が無いと止まらない）', () => {
  const state = emptyState();
  const signals = deriveSignals(manifest(), [file('src/a.js')]);
  recordRun(state, {
    angle: 'quality',
    mode: 'full-rescan',
    fresh: true,
    snapshotId: 's1',
    status: 'error',
  });
  const sel = applyBudget(selectMode(state, 'quality', signals), state, 'quality');
  assert.equal(
    sel.run,
    false,
    'error を消費から外すと、起動が恒常的に失敗する環境で最も高価な組合せ' +
      '（opus × 全体再探索）の自動ループが止まらない',
  );
  assert.equal(sel.budgetOutcome, 'exhausted');
  assert.match(sel.reason, /error/, 'まだ一度も完走していないことを人間判断へ返す');
});

test('予算: status=incomplete は消費する。所見ゼロで収束させず未確認範囲を人間へ返す', () => {
  const state = emptyState();
  const signals = deriveSignals(manifest(), [file('src/a.js')]);
  recordRun(state, {
    angle: 'quality',
    mode: 'full-rescan',
    fresh: true,
    snapshotId: 's1',
    status: 'incomplete',
  });
  const sel = applyBudget(selectMode(state, 'quality', signals), state, 'quality');
  assert.equal(sel.run, false);
  assert.equal(sel.budgetOutcome, 'exhausted');
  assert.match(sel.reason, /incomplete/);
});

test('予算: 未消化の escalation は予算検査を迂回する（人間が割り当てた予算そのもの）', () => {
  const state = emptyState();
  state.initialTier = 'Light';
  const signals = deriveSignals(manifest(), [file('src/a.js')]);
  recordRun(state, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's1' });
  assert.equal(applyBudget(selectMode(state, 'quality', signals), state, 'quality').run, false);

  escalateAngles(state, { angles: ['quality'], reason: '外部レビューで見逃しが判明' });
  const sel = applyBudget(selectMode(state, 'quality', signals), state, 'quality');
  assert.equal(sel.run, true);
  assert.equal(sel.escalated, true);

  // 消化したら再び予算終了へ戻る（1 escalation = 1 起動）
  recordRun(state, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's2' });
  assert.equal(
    applyBudget(selectMode(state, 'quality', signals), state, 'quality').budgetOutcome,
    'exhausted',
  );
});

test('予算: escalation は incomplete でも消化される（1 escalation = 1 起動）', () => {
  const state = lightState();
  const signals = deriveSignals(manifest(), [file('src/a.js')]);
  recordRun(state, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's1' });
  escalateAngles(state, { angles: ['quality'], reason: '外部レビューで見逃しが判明' });
  assert.equal(applyBudget(selectMode(state, 'quality', signals), state, 'quality').run, true);

  // maxTurns に当たって incomplete で戻った
  recordRun(state, {
    angle: 'quality',
    mode: 'full-rescan',
    fresh: true,
    snapshotId: 's2',
    status: 'incomplete',
  });
  const after = applyBudget(selectMode(state, 'quality', signals), state, 'quality');
  assert.equal(
    after.run,
    false,
    'incomplete で消化されないと、1回の人間判断が無限の起動へ増幅する' +
      '（予算が自動探索を止めても、この経路だけが残る）',
  );
  assert.equal(after.budgetOutcome, 'exhausted');
  assert.match(after.reason, /incomplete/, '未確認範囲があることは人間判断へ返す');
});

test('予算: escalation の消化は status を問わない（1 escalation = 1 起動）', () => {
  const state = lightState();
  const signals = deriveSignals(manifest(), [file('src/a.js')]);
  recordRun(state, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's1' });
  for (const status of ['error', 'incomplete']) {
    const s2 = structuredClone(state);
    escalateAngles(s2, { angles: ['quality'], reason: '外部レビューで見逃しが判明' });
    assert.equal(applyBudget(selectMode(s2, 'quality', signals), s2, 'quality').run, true);
    recordRun(s2, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's2', status });
    assert.equal(
      applyBudget(selectMode(s2, 'quality', signals), s2, 'quality').budgetOutcome,
      'exhausted',
      `${status} で消化されないと、1回の人間判断が無限の起動へ増幅する`,
    );
  }
});

test('予算: baselineRange が返しうる range はすべて ⚠️ ブロックの説明を持つ', () => {
  const code = [file('src/a.js')];
  // 4値それぞれを実際に作り、formatPlan が落ちない（＝説明が存在する）ことを固定する
  const cases = [
    ['初回', { state: lightState(), manifest: manifest({ snapshotId: 's1' }) }],
    [
      '直前',
      (() => {
        const st = lightState();
        recordRun(st, { angle: 'subtractive', mode: 'full-rescan', fresh: true, snapshotId: 's1' });
        return { state: st, manifest: manifest({ snapshotId: 's2', previousSnapshotId: 's1' }) };
      })(),
    ],
    [
      '累積',
      (() => {
        const st = lightState();
        recordRun(st, { angle: 'subtractive', mode: 'full-rescan', fresh: true, snapshotId: 's1' });
        return {
          state: st,
          manifest: manifest({ snapshotId: 's3', previousSnapshotId: 's2' }),
          resolveChangedSince: () => ({
            files: code,
            guardChange: false,
            semanticDocChange: false,
          }),
        };
      })(),
    ],
    [
      '解決不能',
      (() => {
        const st = lightState();
        recordRun(st, { angle: 'subtractive', mode: 'full-rescan', fresh: true, snapshotId: 's1' });
        return {
          state: st,
          manifest: manifest({ snapshotId: 's3', previousSnapshotId: 's2' }),
          resolveChangedSince: () => {
            throw new Error('prune 済み');
          },
        };
      })(),
    ],
  ];
  const seen = new Set();
  for (const [expected, args] of cases) {
    const plan = buildPlan({ changedFiles: code, changedInFix: code, ...args });
    const e = plan.entries.find((x) => x.angle === 'subtractive');
    assert.equal(e.baseline.range, expected);
    seen.add(e.baseline.range);
    // 説明が無いと formatPlan が実行時に落ちる（fail-loud）
    assert.doesNotThrow(() => formatPlan(plan, null), `range=${expected} の説明が無い`);
  }
  assert.equal(seen.size, 4, 'baselineRange の値域4つすべてを通す');
});

test('予算: 起動しない判定（トリガー非該当）には budgetOutcome を立てない', () => {
  const state = emptyState();
  const sel = applyBudget({ run: false, mode: null, fresh: null, reason: 'r' }, state, 'quality');
  assert.equal(sel.budgetOutcome, undefined);
});

test('モードの patch が判定範囲を覆っていなければ全体再探索へ引き上げる', () => {
  const sel = () => ({ run: true, mode: 'findings-check', fresh: false, reason: 'r' });

  // 前回 snapshot が無い（修正差分そのものが存在しない）
  const noPatch = upgradeWhenPatchNarrower(sel(), { hasPatch: false });
  assert.equal(noPatch.mode, 'full-rescan');
  assert.equal(noPatch.fresh, true);

  // 判定に使ったのが累積差分（直前 hop の修正差分に収まらない）。ここを引き上げないと、
  // 起動の根拠になった変更が渡らないまま complete が記録され baseline だけが前進する
  const cumulative = upgradeWhenPatchNarrower(sel(), { hasPatch: true, cumulative: true });
  assert.equal(cumulative.mode, 'full-rescan');
  assert.equal(cumulative.fresh, true);
  assert.match(cumulative.reason, /累積差分/);

  // 直前 hop の修正差分で判定したなら引き上げない
  assert.equal(
    upgradeWhenPatchNarrower(sel(), { hasPatch: true, cumulative: false }).mode,
    'findings-check',
  );
});

// ---------------------------------------------------------------------------
// 実効 Tier の拡大（起動側の判断）
// ---------------------------------------------------------------------------

function lightState() {
  const state = emptyState();
  state.initialTier = 'Light';
  state.effectiveTier = 'Light';
  return state;
}

test('escalate: 初期 Tier 対象外の観点を加算すると実効 Tier が広がる', () => {
  const state = lightState();
  escalateAngles(state, { angles: ['operability'], reason: '外部レビューで実行主体が不在' });
  assert.ok(state.addedAngles.includes('operability'));
  assert.equal(state.effectiveTier, 'Light＋設計文書');
  assert.equal(state.escalations[0].kind, 'manual-escalation');
  assert.deepEqual(state.escalations[0].angles, ['operability']);
});

test('escalate: --reason は要求するが state には保存しない（裁定は docs/pr/PR-{番号}.md）', () => {
  const state = lightState();
  const reason = '外部レビューで手順の実行主体が不在と指摘された（所見の本文）';
  escalateAngles(state, { angles: ['operability'], reason });
  assert.equal(
    state.escalations[0].reason,
    null,
    '自由記述で保存すると所見の内容が machine state へ戻り、裁定の記録先が2つに割れる',
  );
  assert.ok(
    !JSON.stringify(state).includes('実行主体が不在'),
    '所見本文が state のどこにも現れない',
  );
  // 理由の言語化そのものは要求する（黙って escalate させない）
  assert.throws(() => escalateAngles(state, { angles: ['spec'], reason: '' }), /--reason/);
});

test('escalate: Tier 再検証は machine が導出した理由を記録する（人間由来テキストとは別扱い）', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js'), file('docs/agent-workflows/x.md')];
  reclassifyTier(state, changed);
  assert.equal(state.escalations[0].kind, 'tier-reclassification');
  assert.match(
    state.escalations[0].reason,
    /変更ファイルの再分類/,
    '変更ファイルから導出した理由は machine の判断根拠なので保持してよい',
  );
});

test('escalate: 実施済み観点への加算は fresh・全体再探索を要求する', () => {
  const state = lightState();
  recordRun(state, { angle: 'adversarial', mode: 'full-rescan', fresh: true, snapshotId: 's1' });
  escalateAngles(state, { angles: ['adversarial'], reason: '外部レビューが迂回経路を検出' });
  const sel = selectMode(state, 'adversarial', deriveSignals(manifest(), []), { snapshotId: 's1' });
  assert.equal(sel.mode, 'full-rescan');
  assert.equal(sel.fresh, true);
  assert.equal(sel.escalated, true);
});

test('escalate: 複数観点をまとめて加算できる', () => {
  const state = lightState();
  escalateAngles(state, { angles: ['spec', 'operability'], reason: '横断所見' });
  assert.ok(state.addedAngles.includes('spec') && state.addedAngles.includes('operability'));
});

test('escalate: 所見の意味（重大度・因果・分類）は受け取らない', () => {
  const state = lightState();
  // 語彙は「どの系統をやり直すか」＋自由記述の理由だけ。impact-class 相当の引数は存在しない
  assert.throws(() => escalateAngles(state, { angles: [], reason: 'x' }), /--angles/);
  assert.throws(() => escalateAngles(state, { angles: ['spec'], reason: '' }), /--reason/);
  assert.throws(() => escalateAngles(state, { angles: ['なんとなく'], reason: 'x' }), /未知の観点/);
  assert.deepEqual(state.addedAngles, [], '拒否された escalate は state を汚さない');
});

test('escalate: 実効 Tier は PR 内で縮小しない', () => {
  const state = lightState();
  escalateAngles(state, {
    angles: ['spec', 'operability', 'riskmodel'],
    reason: '外部レビューで複数系統の見逃し',
  });
  const widened = state.effectiveTier;
  assert.notEqual(widened, 'Light');
  escalateAngles(state, { angles: ['quality'], reason: '軽微な追加確認' });
  assert.equal(state.effectiveTier, widened, '後続の弱い加算で実効 Tier が下がってはいけない');
});

test('escalate: 加算された観点は確認が済んでも履歴上保持される', () => {
  const state = lightState();
  escalateAngles(state, { angles: ['operability'], reason: 'x' });
  recordRun(state, { angle: 'operability', mode: 'full-rescan', fresh: true, snapshotId: 's2' });
  assert.ok(state.addedAngles.includes('operability'));
  assert.equal(state.escalations.length, 1);
});

// ---------------------------------------------------------------------------
// Tier の毎回再検証（widen-only、#559）
// ---------------------------------------------------------------------------

test('reclassifyTier: 修正差分の再分類で必須系統が広がったら実効 Tier を widen する', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js'), file('docs/agent-workflows/x.md')];
  const result = reclassifyTier(state, changed);
  assert.ok(result);
  assert.equal(state.effectiveTier, 'Light＋設計文書');
  assert.ok(state.addedAngles.includes('spec') && state.addedAngles.includes('operability'));
  assert.equal(state.escalations[0].kind, 'tier-reclassification');
});

test('reclassifyTier: 再計算結果が現状の部分集合なら何もしない（narrowing is refused の直接検証）', () => {
  const state = emptyState();
  state.initialTier = 'Full';
  state.effectiveTier = 'Full';
  const changed = [file('src/lib/writingRules.js')]; // Light 相当の変更のみ（Full より狭い）
  const result = reclassifyTier(state, changed);
  assert.equal(result, null, '狭い再計算結果では実効 Tier を動かさない');
  assert.equal(state.effectiveTier, 'Full');
  assert.deepEqual(state.escalations, []);
});

test('reclassifyTier: 同一の変更ファイル集合への複数回呼び出しは冪等（拡大記録が重複しない）', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js'), file('docs/agent-workflows/x.md')];
  reclassifyTier(state, changed);
  const afterFirst = { effectiveTier: state.effectiveTier, escalations: state.escalations.length };
  const second = reclassifyTier(state, changed);
  assert.equal(second, null, '既に必須系統に含まれていれば再度 widen しない');
  assert.equal(state.effectiveTier, afterFirst.effectiveTier);
  assert.equal(state.escalations.length, afterFirst.escalations, '拡大記録が重複しない');
});

test('reclassifyTier: state.initialTier 自体は書き換えない', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js'), file('docs/agent-workflows/x.md')];
  reclassifyTier(state, changed);
  assert.equal(state.initialTier, 'Light', '初期 Tier の名称は変わらない');
});

test('reclassifyTier: 高リスクファイル追加で Full 相当へ拡大する場合、design doc が無くても Full を選ぶ（Light＋設計文書 への誤判定を防ぐ。外部レビュー Codex 指摘）', () => {
  const state = lightState();
  // src/lib/db.js は HIGH_RISK_PATTERNS に一致する。design doc は含まない
  const changed = [file('src/lib/writingRules.js'), file('src/lib/db.js', { highRisk: true })];
  const result = reclassifyTier(state, changed);
  assert.ok(result);
  assert.equal(result.recomputedTier, 'Full');
  assert.equal(
    state.effectiveTier,
    'Full',
    'spec/operability が新規追加され Light＋設計文書 と系統集合が一致しても、' +
      '再計算した基礎 Tier（Full）を優先し Light＋設計文書 へ誤って倒れない',
  );
});

test('reclassifyTier: 系統集合が既に一致していても（missing=[]）、基礎Tierの強化を検出してwidenする（外部レビュー Codex 指摘・5回目）', () => {
  // 初期状態を Light＋設計文書（既に7系統＝Fullと同一の必須系統集合）にしておく
  const state = emptyState();
  state.initialTier = 'Light＋設計文書';
  state.effectiveTier = 'Light＋設計文書';
  // 高リスクファイルを追加した変更集合。必須系統集合は Full と同じ7系統のため
  // missing=[] になるが、基礎Tierは Full 相当へ強化されている
  const changed = [file('docs/agent-workflows/x.md'), file('src/lib/db.js', { highRisk: true })];
  const result = reclassifyTier(state, changed);
  assert.ok(result, 'missing=[] でも基礎Tierの強化があれば widen する');
  assert.equal(
    state.effectiveTier,
    'Full＋設計文書',
    '系統集合が変化しなくても、高リスクファイル追加によるFull相当への強化を反映する',
  );
});

test('reclassifyTier: Full に実行可能設計文書が追加された場合、Full＋設計文書へ更新する（外部レビュー Codex 指摘・5回目）', () => {
  const state = emptyState();
  state.initialTier = 'Full';
  state.effectiveTier = 'Full';
  // Full は既に7系統（design addon 込み）のため、設計文書を追加しても系統集合は変化しない
  const changed = [file('src/lib/db.js', { highRisk: true }), file('docs/agent-workflows/x.md')];
  const result = reclassifyTier(state, changed);
  assert.ok(result);
  assert.equal(
    state.effectiveTier,
    'Full＋設計文書',
    '系統集合が変化しなくても、設計文書addonの新規追加を宣言名に反映する' +
      '（check-artifacts は Full＋設計文書 の明示宣言を要求する）',
  );
});

test('reclassifyTier: 既に Full へ広がった実効Tierに、通常diffの設計文書追加が来た場合 Full＋設計文書へ更新する（外部レビュー Codex 指摘・8回目）', () => {
  const state = lightState(); // initialTier='Light'
  // 高リスク変更の再分類等で実効Tierだけが Full へ強化済みの状態（初期Tierは Light のまま）
  state.effectiveTier = 'Full';

  // 通常コードに実行可能設計文書が追加された（highRisk/大規模diffではない、通常の Light 相当の diff）
  const changed = [file('src/lib/writingRules.js'), file('docs/agent-workflows/x.md')];
  const result = reclassifyTier(state, changed);
  assert.ok(result, 'widen が発生する（前提）');
  assert.equal(
    state.effectiveTier,
    'Full＋設計文書',
    '既に Full へ広がっている実効Tierに、今回検出した設計文書addonを合成する必要がある。' +
      'recomputed.base（今回のdiff単体ではLight相当）をそのままpreferBaseに使うと、' +
      'widenEffectiveTier内の縮小禁止チェック（shrinksBase）がnextTierをFullへ差し戻す際に' +
      'addonごと失われ、Full＋設計文書ではなくFullになってしまう（外部レビュー Codex 指摘）',
  );
});

test('計画: 毎回の plan で不足系統が拡大されると次の buildPlan に fresh・全体再探索として現れる', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js'), file('docs/agent-workflows/x.md')];
  reclassifyTier(state, changed);
  settleSubtractive(state); // Tier 拡大後の減算を収束させてから本体段階の挙動を見る
  const plan = buildPlan({
    state,
    manifest: manifest(),
    changedFiles: changed,
    changedInFix: changed,
  });
  const spec = plan.entries.find((e) => e.angle === 'spec');
  assert.equal(spec.run, true);
  assert.equal(spec.mode, 'full-rescan');
  assert.equal(spec.fresh, true);
});

test('selectMode: Tier 再検証によるエスカレーションは reason にその旨を明示する（外部新規所見と誤認させない）', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js'), file('docs/agent-workflows/x.md')];
  reclassifyTier(state, changed);
  const sel = selectMode(state, 'spec', deriveSignals(manifest(), []), { snapshotId: 's1' });
  assert.equal(sel.escalated, true);
  assert.match(sel.reason, /Tier 再検証によるエスカレーション/);
  assert.doesNotMatch(sel.reason, /起動側の判断によるエスカレーション/);
});

test('selectMode: __proto__/constructor 等のプロトタイプ鎖キーは「未知の観点」として拒否する（外部レビュー Copilot 指摘）', () => {
  const state = lightState();
  const signals = deriveSignals(manifest(), []);
  for (const angle of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(
      () => selectMode(state, angle, signals),
      /トリガー定義のない観点です/,
      `${angle} は own-property でない限り拒否されるべき（ANGLE_TRIGGERS[angle] だけでは` +
        ' Object.prototype 由来の値を返し素通りしてしまう）',
    );
  }
});

// ---------------------------------------------------------------------------
// PR #601: manual escalation と Tier 強化の同時成立で escalated が握り潰されない
// ---------------------------------------------------------------------------

test('buildPlan: manual escalation と Tier 強化が同一 round で成立しても escalated が保持される（PR #601）', () => {
  const state = lightState();
  // 1) 'quality' の自動探索予算を使い切る
  recordRun(state, {
    angle: 'quality',
    mode: 'full-rescan',
    fresh: true,
    status: 'complete',
    snapshotId: 's1',
  });
  // 2) Tier 強化（quality の lastRunSeq より後の seq が tierWidenedSeq に立つ）
  const changed = [file('src/lib/writingRules.js'), file('docs/agent-workflows/x.md')];
  reclassifyTier(state, changed);
  // 3) 減算はここで完了させる（tierWidenedSeq より後の seq を持たせ、Tier 強化の再評価対象から外す）
  settleSubtractive(state, 's1');
  // 4) 人間が quality へ追加予算を割り当てる（manual escalation。seq は runs/escalations/
  //    tierWidenedSeq の最大値より後になる）
  escalateAngles(state, { angles: ['quality'], reason: '外部レビューで見逃しが判明' });

  const snapshot = snap({ snapshotId: 's1', files: changed, changedInFix: changed });
  const plan = buildPlan({
    state,
    manifest: snapshot.manifest,
    changedFiles: snapshot.changedFiles.files,
    changedInFix: snapshot.changedFiles.changedInFix,
  });
  const quality = plan.entries.find((e) => e.angle === 'quality');
  assert.equal(quality.run, true);
  assert.equal(quality.mode, 'full-rescan');
  assert.equal(quality.fresh, true);
  assert.equal(
    quality.escalated,
    true,
    '丸ごと差し替えると manual escalation の escalated:true が消え、予算切れ扱いになる（PR #601）',
  );
  assert.equal(quality.budgetOutcome, undefined);
  assert.match(quality.reason, /起動側の判断によるエスカレーション/);
  assert.match(quality.reason, /Tier 強化/);
});

test('buildPlan: Tier 強化分岐は pending escalation の kind が manual-escalation でなければ予算を迂回しない（fail-closed）', () => {
  const cases = [
    ['tier-reclassification（明示）', 'tier-reclassification'],
    ['欠落', undefined],
    ['未知文字列', 'bogus-kind'],
    ['前方一致の近傍値', 'manual-escalation-auto'],
    ['部分一致の近傍値', 'xmanual-escalationx'],
  ];
  for (const [label, kind] of cases) {
    const state = lightState();
    recordRun(state, {
      angle: 'quality',
      mode: 'full-rescan',
      fresh: true,
      status: 'complete',
      snapshotId: 's1',
    });
    const escalation = { seq: 2, angles: ['quality'], reason: null, effectiveTier: 'Light' };
    if (kind !== undefined) escalation.kind = kind;
    state.escalations.push(escalation);
    state.tierWidenedSeq = 3;

    const changed = [file('src/lib/writingRules.js')];
    const plan = buildPlan({
      state,
      manifest: manifest({ snapshotId: 's2', previousSnapshotId: 's1' }),
      changedFiles: changed,
      changedInFix: changed,
    });
    const quality = plan.entries.find((e) => e.angle === 'quality');
    assert.equal(quality.escalated, false, `kind=${label}: 予算を迂回してはいけない`);
    assert.equal(quality.budgetOutcome, 'exhausted', `kind=${label}: 予算切れとして人間判断へ返す`);
  }
});

test('buildPlan: base.unresolved 分岐（selectMode を経由しない短絡経路）でも pending manual escalation は保持される（所見F1）', () => {
  const state = lightState();
  recordRun(state, {
    angle: 'quality',
    mode: 'full-rescan',
    fresh: true,
    status: 'complete',
    snapshotId: 's1',
  });
  recordRun(state, {
    angle: 'subtractive',
    mode: 'full-rescan',
    fresh: true,
    status: 'complete',
    snapshotId: 's3',
  });
  escalateAngles(state, { angles: ['quality'], reason: '外部レビューで見逃しが判明' });

  const changed = [file('src/a.js')];
  const plan = buildPlan({
    state,
    manifest: manifest({ snapshotId: 's3', previousSnapshotId: 's2' }),
    changedFiles: changed,
    changedInFix: changed,
  });
  const quality = plan.entries.find((e) => e.angle === 'quality');
  assert.equal(
    quality.baseline.range,
    '解決不能',
    'この分岐（base.unresolved）を通ったことの確認',
  );
  assert.equal(quality.run, true);
  assert.equal(quality.escalated, true);
  assert.equal(quality.budgetOutcome, undefined);
});

test('buildPlan: Tier 強化を伴わない素の escalation だけでも reason が二重付与されない（row B）', () => {
  const state = lightState();
  recordRun(state, {
    angle: 'quality',
    mode: 'full-rescan',
    fresh: true,
    status: 'complete',
    snapshotId: 's1',
  });
  escalateAngles(state, { angles: ['quality'], reason: '外部レビューで見逃しが判明' });
  // reclassifyTier は呼ばない（tierWidenedSeq を立てない）。baseline は解決可能にする
  settleSubtractive(state, 's2');

  const changed = [file('src/a.js')];
  const plan = buildPlan({
    state,
    manifest: manifest({ snapshotId: 's2', previousSnapshotId: 's1' }),
    changedFiles: changed,
    changedInFix: changed,
  });
  const quality = plan.entries.find((e) => e.angle === 'quality');
  assert.equal(quality.run, true);
  assert.equal(quality.escalated, true);
  assert.equal(quality.budgetOutcome, undefined);
  assert.doesNotMatch(
    quality.reason,
    /起動側の判断によるエスカレーションを保持/,
    'selectMode がすでに escalation 由来の理由を作っている場合、出口復元（!sel.escalated ガード）で二重付与してはいけない',
  );
});

// ---------------------------------------------------------------------------
// 計画・収束
// ---------------------------------------------------------------------------

test('計画: 減算が先頭・清掃は他系統収束まで保留される', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  const plan = buildPlan({
    state,
    manifest: manifest(),
    changedFiles: changed,
    changedInFix: changed,
  });
  assert.equal(plan.entries[0].angle, 'subtractive');
  const cleanup = plan.entries.find((e) => e.angle === 'cleanup');
  assert.equal(cleanup.run, false);
  assert.match(cleanup.reason, /最終1周/);
});

test('計画: 段階は「減算（入口）→ 本体 → 清掃（最終1周）」の順に進む', () => {
  const state = lightState();
  const bodyAnglesForLight = ['riskmodel', 'adversarial', 'quality'];
  const changed = [file('src/new.js', { status: 'A' })];
  const args = {
    state,
    manifest: manifest({ snapshotId: 's1', previousSnapshotId: 's0' }),
    changedFiles: changed,
    changedInFix: changed,
  };

  // 段階1: 減算のみが起動する
  const plan1 = buildPlan(args);
  assert.equal(plan1.stage, 'subtractive');
  assert.equal(plan1.entries.find((e) => e.angle === 'subtractive').run, true);
  for (const angle of [...bodyAnglesForLight, 'cleanup']) {
    const e = plan1.entries.find((x) => x.angle === angle);
    assert.equal(e.run, false, `${angle} は減算段階では起動しない`);
    assert.match(e.reason, /保留（dirty だが現在の段階は 減算（入口））/);
  }

  // 段階2: 減算を実施すると本体段階へ進む
  recordRun(state, {
    angle: 'subtractive',
    mode: 'diff-explore',
    fresh: true,
    status: 'complete',
    snapshotId: 's1',
  });
  const plan2 = buildPlan(args);
  assert.equal(plan2.stage, 'body');
  assert.ok(
    bodyAnglesForLight.every((a) => plan2.entries.find((e) => e.angle === a).run),
    '本体段階では本体系統が起動する',
  );
  assert.equal(
    plan2.entries.find((e) => e.angle === 'cleanup').run,
    false,
    '清掃は本体段階では起動しない',
  );

  // 段階3: 本体系統を実施すると清掃（最終1周）が起動する
  for (const angle of bodyAnglesForLight) {
    recordRun(state, {
      angle,
      mode: 'diff-explore',
      fresh: true,
      status: 'complete',
      snapshotId: 's1',
    });
  }
  const plan3 = buildPlan(args);
  assert.equal(plan3.stage, 'cleanup');
  assert.equal(plan3.entries.find((e) => e.angle === 'cleanup').run, true);
});

test('予算: 実施済みの系統は新しい snapshot でも自動では回り直さない（自己増殖の停止）', () => {
  const state = lightState();
  for (const angle of anglesForTierName('Light')) {
    recordRun(state, {
      angle,
      mode: 'full-rescan',
      fresh: true,
      status: 'complete',
      snapshotId: 's0',
    });
  }
  // 新しい修正差分（新規ファイル）が探索対象を変えている＝トリガーは全系統で立つ
  const changed = [file('src/new.js', { status: 'A' })];
  const plan = buildPlan({
    state,
    manifest: manifest({ snapshotId: 's1', previousSnapshotId: 's0' }),
    changedFiles: changed,
    changedInFix: changed,
  });

  assert.equal(
    plan.entries.filter((e) => e.run).length,
    0,
    'トリガーが立っていても自動の新規探索は提案しない（修正 → fresh → 修正 → fresh を止める）',
  );
  const exhausted = plan.entries.filter((e) => e.budgetOutcome === 'exhausted');
  assert.ok(exhausted.length > 0);
  for (const e of exhausted) {
    assert.match(e.reason, /予算終了/);
    assert.ok(e.withheld.mode, '予算が無ければ要求していた探索を残す');
    assert.doesNotMatch(
      e.reason,
      /義務は満たされている/,
      '予算終了をトリガー非該当と同じ文言に畳むと、未確認範囲が実施済みの顔で収束記録に載る',
    );
  }
  // **段階は進むが収束はしない。** 進行を止めると人間が来るまで入口で固まり、
  // 収束させると「未確認範囲を残したまま収束」が各系統1回起動した後の既定になる
  assert.equal(plan.stage, 'done');
  assert.equal(plan.converged, false);
  assert.ok(
    plan.nextActions.some((a) => a.includes('escalate')),
    '収束をブロックする以上、解除できる行動を同じ計画が提案する',
  );
});

test('計画: 記憶適合はヒットがある場合のみ載る（条件起動）', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  const args = { state, manifest: manifest(), changedFiles: changed, changedInFix: changed };
  assert.ok(!buildPlan(args).entries.some((e) => e.angle === 'memory'));
  assert.ok(buildPlan({ ...args, memoryHits: 2 }).entries.some((e) => e.angle === 'memory'));
});

test('計画: 記憶適合が未収束の間は清掃（最終1周）を起動しない（外部レビュー Codex 指摘・6回目）', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  // cleanup を除く Light 必須系統をすべて収束させる（cleanup 自身はゲート対象・記憶適合は
  // Tier 必須集合に含まれないため、どちらもここでは記録しない）
  const bodyAnglesForLight = ['subtractive', 'riskmodel', 'adversarial', 'quality'];
  for (const a of bodyAnglesForLight) {
    recordRun(state, { angle: a, mode: 'full-rescan', fresh: true, snapshotId: '0001-abcdef1' });
  }
  const args = {
    state,
    manifest: manifest(),
    changedFiles: changed,
    changedInFix: changed,
    memoryHits: 2,
  };
  const plan = buildPlan(args);
  const memory = plan.entries.find((e) => e.angle === 'memory');
  assert.equal(memory.run, true, '記憶適合はヒットがあり未実施なので起動する');
  const cleanup = plan.entries.find((e) => e.angle === 'cleanup');
  assert.equal(
    cleanup.run,
    false,
    '通常系統が収束済みでも、記憶適合が未収束の間は清掃と並行起動してはいけない',
  );
  assert.match(
    cleanup.reason,
    /保留（dirty だが現在の段階は 本体）/,
    '清掃は「現在の段階が本体である」ことを理由に保留される（記憶適合は本体段階に属する）',
  );

  // 記憶適合を記録して収束させると、清掃が起動可能になる
  recordRun(state, {
    angle: 'memory',
    mode: memory.mode,
    fresh: true,
    snapshotId: '0001-abcdef1',
  });
  const plan2 = buildPlan(args);
  assert.equal(
    plan2.entries.find((e) => e.angle === 'cleanup').run,
    true,
    '記憶適合が収束すれば清掃が起動できる',
  );
});

test('計画: 記憶適合が起動する round では清掃を並行起動しない（外部レビュー Codex 指摘・7回目）', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  const bodyAnglesForLight = ['subtractive', 'riskmodel', 'adversarial', 'quality'];
  // 通常系統は実施済み（記憶適合単体の起動が清掃をブロックすることを検証したいため、
  // 他の要因で清掃が保留されないようにする）
  for (const a of bodyAnglesForLight) {
    recordRun(state, { angle: a, mode: 'full-rescan', fresh: true, snapshotId: '0002-newsha' });
  }

  // 記憶ヒットが来た。記憶適合はこの attempt で未実施なので起動する —
  // にもかかわらず清掃が並行起動されてはいけない
  const plan = buildPlan({
    state,
    manifest: manifest({ snapshotId: '0002-newsha', previousSnapshotId: '0001-abcdef1' }),
    changedFiles: changed,
    changedInFix: changed,
    memoryHits: 3,
  });
  const memory = plan.entries.find((e) => e.angle === 'memory');
  assert.equal(memory.run, true, 'この attempt でまだ未実施なので起動する');
  const cleanup = plan.entries.find((e) => e.angle === 'cleanup');
  assert.equal(
    cleanup.run,
    false,
    '清掃ゲートは過去ログではなく今回のエントリの run 判定を見る必要がある',
  );
});

test('計画: 減算にエスカレーションが入った round は、本体が実施済みでも減算から回し直す', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  const bodyAngles = ['riskmodel', 'adversarial', 'quality'];
  settleSubtractive(state, 's1');
  for (const a of bodyAngles) {
    recordRun(state, { angle: a, mode: 'full-rescan', fresh: true, snapshotId: 's1' });
  }
  // 人間が減算へ追加予算を割り当てた（＝入口をやり直す指示）
  escalateAngles(state, { angles: ['subtractive'], reason: '外部レビューが追加物の必要性を指摘' });

  const plan = buildPlan({
    state,
    manifest: manifest({ snapshotId: 's2', previousSnapshotId: 's1' }),
    changedFiles: changed,
    changedInFix: changed,
  });
  assert.equal(plan.stage, 'subtractive', '入口をやり直す間は本体・清掃を並行起動しない');
  for (const a of bodyAngles) {
    assert.equal(
      plan.entries.find((e) => e.angle === a).run,
      false,
      `${a} は減算がこの round を終えるまで保留される（過去に実施済みでも同じ）`,
    );
  }
});

test('計画: 減算・本体が空集合の Tier（Docs / Record / なし）でも段階機械が正しく素通りする', () => {
  // Docs: 必須は清掃のみ → 減算・本体は空でスキップし、いきなり清掃段階
  const docs = emptyState();
  docs.initialTier = 'Docs';
  docs.effectiveTier = 'Docs';
  const docsChanged = [file('docs/history.md')];
  const docsPlan = buildPlan({
    state: docs,
    manifest: manifest(),
    changedFiles: docsChanged,
    changedInFix: docsChanged,
  });
  assert.equal(docsPlan.stage, 'cleanup');
  assert.equal(docsPlan.entries.find((e) => e.angle === 'cleanup').run, true);
  assert.ok(
    !docsPlan.entries.some((e) => e.angle === 'subtractive'),
    'Docs Tier は減算を必須にしないため entries にも現れない',
  );

  // Record: 減算＋清掃。本体が空なので減算収束後は清掃へ直行する
  const rec = emptyState();
  rec.initialTier = 'Record';
  rec.effectiveTier = 'Record';
  const recChanged = [file('docs/agent-memory/records/a.json')];
  const recArgs = {
    state: rec,
    manifest: manifest(),
    changedFiles: recChanged,
    changedInFix: recChanged,
  };
  assert.equal(buildPlan(recArgs).stage, 'subtractive');
  settleSubtractive(rec);
  const recPlan = buildPlan(recArgs);
  assert.equal(recPlan.stage, 'cleanup', '本体が空集合なら減算の次は清掃');
  assert.equal(recPlan.entries.find((e) => e.angle === 'cleanup').run, true);

  // なし: 全段階が空 → 即収束
  const none = emptyState();
  none.initialTier = 'なし';
  none.effectiveTier = 'なし';
  const nonePlan = buildPlan({
    state: none,
    manifest: manifest(),
    changedFiles: [],
    changedInFix: [],
  });
  assert.equal(nonePlan.stage, 'done');
  assert.equal(nonePlan.converged, true);
  assert.deepEqual(nonePlan.entries, []);
});

test('plan: 段階が後退したら、前段階の起動要求は撤回される（孤立した義務が残らない）', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  planCommand(state, snap1); // 減算段階
  settleSubtractive(state, 's1');
  const plan1 = planCommand(state, snap1);
  assert.equal(plan1.stage, 'body');
  assert.ok(plannedLaunches(state, snap1).length > 0, '本体段階の起動が計画から要求される（前提）');

  // escalate で減算段階へ戻る（＝本体の要求は撤回された）
  escalateAngles(state, { angles: ['subtractive'], reason: '外部レビューが見逃しを検出' });
  const plan2 = planCommand(state, snap1);
  assert.equal(plan2.stage, 'subtractive');
  assert.deepEqual(
    plannedLaunches(state, snap1).map((e) => e.angle),
    ['subtractive'],
    '撤回された要求が残ると、計画自身が起動するなと言っている起動を記録しない限り' +
      '先へ進めなくなる。要求は毎回計画から引き直すので、撤回は次の計画にそのまま現れる',
  );
});

test('計画: 基礎 Tier が強化された round では、以前から必須集合にあった系統も再評価を要求する（外部レビュー Codex 指摘・15回目 P2）', () => {
  const state = lightState();
  const docs = [file('docs/agent-workflows/x.md')];
  // 設計文書レビューとして operability を含む全系統を一度完了しておく
  reclassifyTier(state, docs);
  const before = buildPlan({
    state,
    manifest: manifest(),
    changedFiles: docs,
    changedInFix: docs,
  });
  for (const e of before.entries) {
    recordRun(state, { angle: e.angle, mode: 'full-rescan', fresh: true, snapshotId: 's1' });
  }

  // 高リスクコード（worker/）が加わり Full へ再分類される
  const withWorker = [...docs, file('worker/src/index.js')];
  const result = reclassifyTier(state, withWorker);
  assert.ok(result, 'Full への基礎 Tier 強化を検出する');
  assert.equal(baseTierOf(state.effectiveTier), 'Full');

  // Tier 強化後は減算から回る（段階順）。減算を収束させてから本体段階の挙動を見る
  settleSubtractive(state, 's2');
  const after = buildPlan({
    state,
    manifest: manifest({ snapshotId: 's2', previousSnapshotId: 's1' }),
    changedFiles: withWorker,
    changedInFix: withWorker,
  });
  const op = after.entries.find((e) => e.angle === 'operability');
  assert.ok(op, 'operability は必須集合に含まれる');
  // **Tier 強化は予算を迂回しない。** 自動発火する再分類で `escalated` を立てると、
  // 人間の判断を1つも経ずに既存系統ぶんの予算が一括でリセットされる（敵対的 F3）。
  // 「今回 Full 対象になった高リスクコードが未確認」であることは失わず、人間判断へ返す
  assert.equal(op.run, false, '予算を使い切った系統は自動では回り直さない');
  assert.equal(op.budgetOutcome, 'exhausted');
  assert.equal(op.withheld.mode, 'full-rescan');
  assert.match(op.withheld.reason, /Tier 強化/);
  assert.equal(after.converged, false, '未確認のまま収束させない');

  // 新しく必須集合へ入った系統は消費0なので初回探索として走る（増幅ではない）
  const fresh = lightState();
  reclassifyTier(fresh, withWorker);
  settleSubtractive(fresh, 's2');
  const firstRun = buildPlan({
    state: fresh,
    manifest: manifest({ snapshotId: 's2', previousSnapshotId: 's1' }),
    changedFiles: withWorker,
    changedInFix: withWorker,
  }).entries.find((e) => e.angle === 'operability');
  assert.equal(firstRun.run, true);
  assert.equal(firstRun.mode, 'full-rescan');
});

test('計画: 記憶適合が addedAngles と条件起動の両方に入っても entries に重複しない（外部レビュー Codex 指摘・16回目）', () => {
  const state = lightState();
  state.memoryRequired = true;
  // escalate により memory が addedAngles にも加算された状態
  escalateAngles(state, { angles: ['memory'], reason: '外部レビューで記憶との矛盾を検出' });
  settleSubtractive(state);
  const changed = [file('src/lib/writingRules.js')];
  const plan = buildPlan({
    state,
    manifest: manifest(),
    changedFiles: changed,
    changedInFix: changed,
  });
  const memEntries = plan.entries.filter((e) => e.angle === 'memory');
  assert.equal(
    memEntries.length,
    1,
    '同一系統の run:true エントリが2件あると、1件目を記録した時点で計画がその系統を' +
      '実施済みへ倒し、2件目が「計画が要求していない起動」として拒否される',
  );
});

test('計画: 同じ snapshot で plan を再実行しても段階・収束が変わらない（純粋な導出。外部レビュー Codex 指摘・17回目 P2）', () => {
  const state = emptyState();
  const changed = [file('src/lib/writingRules.js')];
  const cleanupFix = [file('src/lib/writingRules.js', { additions: 0, deletions: 12 })];
  const at = (id, prev, fix) =>
    snap({ snapshotId: id, previousSnapshotId: prev, files: changed, changedInFix: fix });
  const s1 = at('s1', null, changed);
  planCommand(state, s1);
  settleSubtractive(state, 's1');
  const bodyPlan = planCommand(state, s1);
  for (const e of bodyPlan.entries.filter((x) => x.run)) recordPlanned(state, s1, e.angle);
  planCommand(state, s1);
  recordPlanned(state, s1, 'cleanup');
  // 清掃所見を直した新 snapshot（全系統が予算を使い切っているので自動では回らない）
  const s2 = at('s2', 's1', cleanupFix);
  const first = planCommand(state, s2);
  assert.equal(first.stage, 'done');
  assert.equal(first.entries.filter((e) => e.run).length, 0);

  // 進捗確認・収束確認として同じ snapshot で再実行しても結果が変わらない
  const again = planCommand(state, s2);
  assert.equal(again.stage, first.stage, 'plan は段階状態を書き換えない');
  assert.equal(again.converged, first.converged);
  assert.deepEqual(
    again.entries.filter((e) => e.budgetOutcome === 'exhausted').map((e) => e.angle),
    first.entries.filter((e) => e.budgetOutcome === 'exhausted').map((e) => e.angle),
    '人間判断の一覧も再実行で変わらない（純粋な導出）',
  );
});

test('予算: escalate は指名した系統にだけ予算を割り当てる（他系統を巻き込んで回し直さない）', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  settleSubtractive(state);
  for (const a of anglesForTierName('Light')) {
    recordRun(state, { angle: a, mode: 'full-rescan', fresh: true, snapshotId: 's1' });
  }
  escalateAngles(state, {
    angles: ['operability'],
    reason: '外部レビューが横断的な見落としを検出',
  });
  const plan = buildPlan({
    state,
    manifest: manifest({ snapshotId: 's2', previousSnapshotId: 's1' }),
    changedFiles: changed,
    changedInFix: changed,
  });
  const running = new Set(plan.entries.filter((e) => e.run).map((e) => e.angle));
  // 加算で実効 Tier が広がると spec も必須系統に入る。これは「一度も見ていない観点の初回探索」
  // であって予算の増幅ではない（Light → Light＋設計文書 の必須系統の差分）
  assert.deepEqual([...running].sort(), ['operability', 'spec']);
  for (const a of ['subtractive', 'riskmodel', 'adversarial', 'quality']) {
    assert.equal(
      plan.entries.find((e) => e.angle === a).run,
      false,
      `${a} は指名されていないので回し直さない — エスカレーション1件で全系統を回すと、` +
        '1回の人間判断が N 回の起動へ増幅する' +
        '（他系統も要るなら --angles に列挙する。正本: review-angles/README.md「実効 Tier の更新」）',
    );
  }
  assert.equal(plan.stage, 'body', '加算された系統が属する段階から進む');
});

test('escalate: 条件起動系統（記憶適合）は宣言 Tier 名を広げない（外部レビュー Codex 指摘）', () => {
  const state = lightState();
  escalateAngles(state, { angles: ['memory'], reason: '記憶適合だけ再確認したい' });
  assert.equal(
    state.effectiveTier,
    'Light',
    'memory は Tier 表に属さないため tierNameForAngles が被覆できず、宣言名の計算に含めると' +
      'フォールバックの Full＋設計文書 へ倒れる（Light の PR が全7系統と重い予算を要求される）',
  );
  assert.ok(state.addedAngles.includes('memory'), '加算と再起動義務には反映する');

  // 対照: 通常系統の escalate は従来どおり実効 Tier を広げる
  const normal = lightState();
  escalateAngles(normal, { angles: ['operability'], reason: 'x' });
  assert.equal(normal.effectiveTier, 'Light＋設計文書');
});

test('discardLegacyFindingArtifacts: 旧 plan が書いた findings.json を snapshot ディレクトリから消す（外部レビュー Codex 指摘）', (t) => {
  const dir = makePlanRepo(t);
  const root = join(dir, '.git/agent-review');
  for (const snap of ['0001-aaaaaaa', '0002-bbbbbbb']) {
    mkdirSync(join(root, snap), { recursive: true });
    writeFileSync(
      join(root, snap, 'findings.json'),
      JSON.stringify({ findings: [{ summary: '所見の要旨', relation: 'in-diff' }] }),
    );
    writeFileSync(join(root, snap, 'review-plan.json'), '{}\n');
  }

  const removed = discardLegacyFindingArtifacts(dir);
  assert.equal(removed.length, 2, '既存の snapshot ディレクトリ全体から消す');
  for (const snap of ['0001-aaaaaaa', '0002-bbbbbbb']) {
    assert.ok(!existsSync(join(root, snap, 'findings.json')), '所見の成果物が残らない');
    assert.ok(existsSync(join(root, snap, 'review-plan.json')), '起動計画は消さない');
  }
  assert.deepEqual(discardLegacyFindingArtifacts(dir), [], '2回目は no-op');
});

test('record-run: 所見確認（findings-check）は machine の記録対象外として fail-loud する（外部レビュー指摘 F2）', () => {
  const state = lightState();
  assert.throws(
    () =>
      recordRun(state, {
        angle: 'quality',
        mode: 'findings-check',
        fresh: false,
        snapshotId: 's1',
      }),
    /machine の起動記録の対象外/,
    '所見確認は machine が提案しないため pending が無く、黙って受理すると計画にない起動が' +
      '台帳へ入る。§7 の手運用と docs/pr/PR-{番号}.md へ誘導する',
  );
  assert.deepEqual(state.runs, []);
});

test('計画: 最終独立レビューを machine の起動義務として持たない（1回の invocation を系統ごとに水増ししない）', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  const s1 = snap({ files: changed });
  for (const a of anglesForTierName('Light')) {
    recordRun(state, { angle: a, mode: 'full-rescan', fresh: true, snapshotId: '0001-abcdef1' });
  }
  const plan = planCommand(state, s1);

  assert.equal(plan.stage, 'done', '計画した起動をすべて記録すれば段階は終わる');
  assert.equal(plan.converged, true);
  assert.equal(
    plan.finalIndependentReview,
    undefined,
    '最終独立レビューの起動単位は系統ではないため machine では表現しない' +
      '（実施の判断・記録は review-memory-boundary.md §7 の手順が正本）',
  );
  assert.deepEqual(
    plannedLaunches(state, s1),
    [],
    '1回の外部レビューを系統ごとの起動要求へ分解しない（execution state は実 invocation と一致させる）',
  );
  const serialized = JSON.stringify(plan);
  assert.ok(!serialized.includes('final'), 'plan に final 起動義務のフィールドが残っていない');
});

test('計画: 起動待ちが残っている間は converged を true にしない（外部レビュー Codex 指摘・7回目）', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  const lightAngles = anglesForTierName('Light');
  for (const a of lightAngles) {
    recordRun(state, { angle: a, mode: 'full-rescan', fresh: true, snapshotId: '0001-abcdef1' });
  }
  const plan1 = buildPlan({
    state,
    manifest: manifest(),
    changedFiles: changed,
    changedInFix: changed,
  });
  assert.equal(plan1.converged, true, 'この snapshot の起動義務を消化した直後は収束する（前提）');

  // 人間が追加予算を割り当てた＝起動待ちが生じる
  escalateAngles(state, { angles: ['adversarial'], reason: '外部レビューで見逃しが判明' });
  const plan2 = buildPlan({
    state,
    manifest: manifest({ snapshotId: '0002-newsha', previousSnapshotId: '0001-abcdef1' }),
    changedFiles: changed,
    changedInFix: changed,
  });
  assert.ok(
    plan2.entries.some((e) => e.run),
    '割り当てられた予算の起動待ちが残っている（前提）',
  );
  assert.equal(
    plan2.converged,
    false,
    'この snapshot への起動待ちが残っている間は converged を true にしてはいけない',
  );
});

test('計画: 実効 Tier で加算された観点が entries に含まれる', () => {
  const state = lightState();
  settleSubtractive(state); // 本体段階の挙動を見る
  escalateAngles(state, { angles: ['operability'], reason: '外部レビューで運用性の欠陥を検出' });
  const changed = [file('src/lib/writingRules.js')];
  const plan = buildPlan({
    state,
    manifest: manifest(),
    changedFiles: changed,
    changedInFix: changed,
  });
  assert.equal(plan.initialTier, 'Light');
  assert.equal(plan.effectiveTier, 'Light＋設計文書');
  const op = plan.entries.find((e) => e.angle === 'operability');
  assert.equal(op.run, true);
  assert.equal(op.fresh, true);
});

test('recordRun / escalateAngles は未知の値を受理しない（typo・プロトタイプ鎖キーを含む）', () => {
  const state = lightState();
  assert.throws(() => recordRun(state, { angle: 'spec', mode: 'nope' }), /未知のレビューモード/);
  assert.throws(
    () => recordRun(state, { angle: 'spec', mode: 'full-rescan', status: 'maybe' }),
    /未知の status/,
  );
  assert.throws(() => escalateAngles(state, { angles: ['nope'], reason: 'x' }), /未知の観点/);
  // typo（record-run の未指定が「記録済み」として通るのを防ぐ）
  assert.throws(
    () => recordRun(state, { angle: 'qualty', mode: 'full-rescan', snapshotId: 's1' }),
    /未知の観点です: qualty/,
  );
  // __proto__/constructor/toString 等はプロパティアクセスで「有効な観点」に見えてしまう
  // （ANGLE_TRIGGERS[a] が真値を返す）— own-property のみを受理すること（プロトタイプ汚染対策）
  for (const proto of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.throws(
      () => recordRun(state, { angle: proto, mode: 'full-rescan', snapshotId: 's1' }),
      /未知の観点です/,
      `recordRun がプロトタイプ鎖キー ${proto} を観点として受理してはいけない`,
    );
    assert.throws(
      () => escalateAngles(state, { angles: [proto], reason: 'x' }),
      /未知の観点/,
      `escalateAngles がプロトタイプ鎖キー ${proto} を観点として受理してはいけない`,
    );
  }
});

test('計画: 記憶適合も 1 snapshot = 1 周（同じ snapshot で実施済みなら再起動しない）', () => {
  const state = lightState();
  settleSubtractive(state); // 記憶適合は本体段階に属する
  const changed = [file('src/lib/writingRules.js')];
  const args = {
    state,
    manifest: manifest(),
    changedFiles: changed,
    changedInFix: changed,
    memoryHits: 2,
  };
  const first = buildPlan(args).entries.find((e) => e.angle === 'memory');
  assert.equal(first.run, true, 'ヒットがあれば起動する');
  assert.ok(first.exec, '起動する場合は実行設定が付く');

  recordRun(state, {
    angle: 'memory',
    mode: first.mode,
    fresh: true,
    snapshotId: '0001-abcdef1',
  });
  const second = buildPlan(args).entries.find((e) => e.angle === 'memory');
  assert.equal(second.run, false, '同じ snapshot での再起動はしない');
  assert.equal(second.exec, null);
});

test('トリガー: 記憶適合の再探索トリガーは ANGLE_TRIGGERS.memory に従う（予算とは別の問い）', () => {
  const withPrevRun = () => {
    const state = lightState();
    state.memoryRequired = true;
    recordRun(state, { angle: 'memory', mode: 'full-rescan', fresh: true, snapshotId: 'prev' });
    return state;
  };
  const sig = (files) => deriveSignals(manifest(), files);

  // 関係する変更がなければ再探索トリガーは立たない
  const quiet = selectMode(withPrevRun(), 'memory', sig([file('docs/history.md')]));
  assert.equal(quiet.run, false);

  // コードの変更は差分探索トリガー
  const onCode = selectMode(withPrevRun(), 'memory', sig([file('src/lib/writingRules.js')]));
  assert.equal(onCode.run, true);
  assert.equal(onCode.mode, 'diff-explore');

  // 記憶レコードの変更はアンカー自体が動くので全体再探索
  const onRecord = selectMode(
    withPrevRun(),
    'memory',
    sig([file('docs/agent-memory/records/a.json')]),
  );
  assert.equal(onRecord.run, true);
  assert.equal(onRecord.mode, 'full-rescan');
});

test('計画: 記憶適合は適用対象である限り計画から消えない（起動しない round でも系統として現れる）', () => {
  const state = lightState();
  state.memoryRequired = true;
  settleSubtractive(state);
  recordRun(state, { angle: 'memory', mode: 'full-rescan', fresh: true, snapshotId: 'prev' });
  const docsOnly = [file('docs/history.md')];
  const plan = buildPlan({
    state,
    manifest: manifest(),
    changedFiles: docsOnly,
    changedInFix: docsOnly,
  });
  const mem = plan.entries.find((e) => e.angle === 'memory');
  assert.ok(mem, '適用対象である限り、計画には系統として現れる（消えない）');
  assert.equal(
    mem.run,
    false,
    '「一度ヒットしたら全 snapshot で必ず1周」は再探索トリガー表より強い新ルールになるため採らない',
  );

  // 初回（この attempt でまだ未実施）は起動する
  const first = lightState();
  settleSubtractive(first);
  const firstMem = buildPlan({
    state: first,
    manifest: manifest(),
    changedFiles: docsOnly,
    changedInFix: docsOnly,
    memoryHits: 2,
  }).entries.find((e) => e.angle === 'memory');
  assert.equal(firstMem.run, true, '初回探索（この観点をこの attempt でまだ起動していない）');
  assert.equal(firstMem.mode, 'full-rescan');
});

test('実効 Tier は「＋設計文書」の加算表記を落とさない（artifacts-gate の宣言名要件）', () => {
  const state = emptyState();
  state.initialTier = 'Full＋設計文書';
  state.effectiveTier = 'Full＋設計文書';
  escalateAngles(state, { angles: ['spec', 'operability'], reason: '外部レビューの横断所見' });
  assert.equal(
    state.effectiveTier,
    'Full＋設計文書',
    '設計文書に触れる PR で加算表記が落ちるとゲートが「＋設計文書 としてください」で落ちる',
  );

  // 既に全系統を含む Tier へ escalate しても、加算表記は落ちない
  const s2 = emptyState();
  s2.initialTier = 'Light＋設計文書';
  s2.effectiveTier = 'Light＋設計文書';
  escalateAngles(s2, { angles: TIER_ANGLES.Full, reason: '全系統の再確認を要求' });
  assert.equal(s2.effectiveTier, 'Light＋設計文書');
  assert.equal(hasDesignAddon('Full＋設計文書'), true);
  assert.equal(hasDesignAddon('Full'), false);
});

test('escalate は系統を加算するだけで、基礎 Tier（Light → Full）を昇格させない', () => {
  const state = lightState();
  escalateAngles(state, { angles: TIER_ANGLES.Full, reason: '全系統の再確認を要求' });
  assert.equal(
    baseTierOf(state.effectiveTier),
    'Light',
    '所見の重大度を machine が判定しなくなったため、escalate から基礎 Tier を上げる経路は無い' +
      '（基礎 Tier の強化は reclassifyTier＝変更ファイルの再分類が担う）',
  );
  assert.ok(
    anglesForTierName(state.effectiveTier).includes('operability'),
    '要求された系統は必須集合へ入る',
  );
});

test('CLI 契約: 初期 Tier 未確定のまま escalate しない（fail-loud）', () => {
  // escalateAngles は initialTier との差分で加算を決めるため、未確定だと誤判定する
  const state = emptyState();
  assert.equal(state.initialTier, null);
  // 直接 escalateAngles を呼べば加算判定は空集合との比較になる（＝CLI 側でガードする必要がある）
  escalateAngles(state, { angles: ['operability'], reason: 'x' });
  assert.notEqual(
    state.effectiveTier,
    'Light',
    '初期 Tier 未確定では実効 Tier が正しく決まらない（CLI が plan を先に要求する根拠）',
  );
});

// ---------------------------------------------------------------------------
// 記録規律（計画との照合。起動義務台帳は持たない）
// ---------------------------------------------------------------------------

// `case 'plan':` の CLI ハンドラが呼ぶ planCommand をそのまま使う薄いラッパー
// （review-plan.js 側のロジックを複製しない。ファイル I/O は行わない — snap.dir を持たない
// テスト用 snap を渡すため、planCommand もファイル書き込みを行わない設計になっている）
function simulatePlan(state, snapshotId, changed, extraManifest = {}) {
  return planCommand(state, snap({ snapshotId, files: changed, ...extraManifest }));
}

test('plan: 減算だけを実施して次の snapshot へ進んでも停止しない（起動義務を snapshot 跨ぎで持たない）', () => {
  const state = emptyState();
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  const plan1 = planCommand(state, snap1);
  assert.equal(state.initialTier, 'Light');
  assert.equal(plan1.stage, 'subtractive');
  assert.deepEqual(
    [...new Set(plannedLaunches(state, snap1).map((e) => e.angle))],
    ['subtractive'],
    '減算段階では減算の起動だけが要求される（本体系統は起動を要求されていない）',
  );

  // 正本手順どおり、減算だけを実施・記録し、所見を直して次の snapshot へ進む
  recordPlanned(state, snap1, 'subtractive');
  const snap2 = snap({ snapshotId: 's2', previousSnapshotId: 's1', files: changed });
  assert.doesNotThrow(
    () => planCommand(state, snap2),
    '前 snapshot の起動提案が未記録でも、新しい snapshot の計画は現在の state から作れる',
  );

  // s2 では減算は予算を使い切っているので回り直さず、本体段階へ進む
  const plan2 = planCommand(state, snap2);
  assert.equal(plan2.stage, 'body');
  assert.ok(
    plannedLaunches(state, snap2).some((e) => e.angle === 'adversarial'),
    '本体段階では本体系統が要求される',
  );

  // 本体系統を記録しないまま次の snapshot へ進んでも停止しない。未実施の系統は
  // 「過去 snapshot の未消化義務」としてではなく、現在の state から再び要求される
  const snap3 = snap({ snapshotId: 's3', previousSnapshotId: 's2', files: changed });
  assert.doesNotThrow(() => planCommand(state, snap3));
  assert.ok(
    plannedLaunches(state, snap3).some((e) => e.angle === 'adversarial'),
    's2 で起動しなかった本体系統は、s3 の計画で改めて要求される（義務を持ち越さず再計算する）',
  );
});

test('plan: 中断・cache 削除の後も、現在の repo state から必要な起動を再計算できる（Case A / Case D）', () => {
  const changed = [file('src/lib/writingRules.js')];
  const s1 = snap({ snapshotId: 's1', files: changed });

  // 起動の途中でセッションが終わり、作業キャッシュ（review-state.json）が失われた
  const resumed = emptyState();
  const plan = planCommand(resumed, s1);
  assert.equal(plan.stage, 'subtractive');
  assert.deepEqual(
    plannedLaunches(resumed, s1).map((e) => e.angle),
    ['subtractive'],
    'cache が無くても、現在の snapshot から必要な起動が出る',
  );
  assert.ok(
    plan.entries.every((e) => !e.run || e.fresh === true),
    '再開時は「全部実施済み」へ fail-open せず、未実施として fresh 起動を要求する（安全側）',
  );
  assert.equal(plan.converged, false, 'cache 消失を収束として扱わない');
});

test('record-run: 計画が要求していない起動（段階順の先回り記録）を拒否する（外部レビュー Codex 指摘・11回目 P1）', () => {
  const state = emptyState();
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  const plan1 = planCommand(state, snap1);
  assert.equal(plan1.stage, 'subtractive');

  // 減算段階のうちに本体系統を先回りで記録できると、減算完了後に本体段階が丸ごと
  // 「実施済み」として飛ばされる（段階順を CLI から迂回できる）
  for (const angle of ['riskmodel', 'adversarial', 'quality']) {
    assert.throws(
      () =>
        recordRunCommand(
          state,
          { angle, mode: 'full-rescan', fresh: true, status: 'complete', snapshotId: 's1' },
          { resolveSnapshot: () => snap1 },
        ),
      /計画が要求していない起動を記録しようとしています/,
      `${angle} は減算段階では要求されていないため記録できない`,
    );
  }
  assert.ok(
    !state.runs.some((r) => r.angle !== 'subtractive'),
    '拒否された記録は state.runs にも追加されない',
  );

  // 減算を記録すれば本体段階へ進み、そこで初めて本体系統を記録できる
  recordPlanned(state, snap1, 'subtractive');
  const plan2 = planCommand(state, snap1);
  assert.equal(plan2.stage, 'body');
  assert.doesNotThrow(() => recordPlanned(state, snap1, 'riskmodel'));
});

test('record-run: snapshot を渡さない記録は受理しない（照合できないまま通さない）', () => {
  const state = emptyState();
  assert.throws(
    () =>
      recordRunCommand(state, {
        angle: 'subtractive',
        mode: 'full-rescan',
        fresh: true,
        status: 'complete',
        snapshotId: 's1',
      }),
    /record-run には snapshot が必要です/,
  );
  assert.deepEqual(state.runs, []);
});

test('record-run: 記録対象の snapshot と読み込んだ snapshot の不一致は fail-loud', () => {
  const state = emptyState();
  const changed = [file('src/lib/writingRules.js')];
  assert.throws(
    () =>
      recordRunCommand(
        state,
        {
          angle: 'subtractive',
          mode: 'full-rescan',
          fresh: true,
          status: 'complete',
          snapshotId: 's1',
        },
        { resolveSnapshot: () => snap({ snapshotId: 's2', files: changed }) },
      ),
    /一致しません/,
  );
});

test('record-run: status を問わず記録される（成否の判断は起動側に委ねる）', () => {
  const state = emptyState();
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  simulatePlan(state, 's1', changed);
  for (const e of plannedLaunches(state, snap1)) {
    recordRunCommand(
      state,
      { angle: e.angle, mode: e.mode, fresh: e.fresh, status: 'error', snapshotId: 's1' },
      { resolveSnapshot: () => snap1 },
    );
  }
  assert.ok(state.runs.every((r) => r.status === 'error'));
  assert.ok(state.runs.length > 0);
});

test('retry パターン: status=error の後は escalate で予算を割り当てて再起動する', () => {
  const state = emptyState();
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  simulatePlan(state, 's1', changed);
  const [entry] = plannedLaunches(state, snap1);
  assert.ok(entry, 'この Tier では最低1系統が起動提案される');

  // API 失敗で status: error を記録（record-run 自体は行われている）
  recordRunCommand(
    state,
    { angle: entry.angle, mode: entry.mode, fresh: true, status: 'error', snapshotId: 's1' },
    { resolveSnapshot: () => snap1 },
  );

  // **自動では再提案しない**（起動失敗の自動リトライに上限が無いと止まらないため）
  const afterError = simulatePlan(state, 's1', changed);
  const stalled = afterError.entries.find((e) => e.angle === entry.angle);
  assert.equal(stalled.run, false);
  assert.equal(stalled.budgetOutcome, 'exhausted');
  assert.equal(afterError.converged, false, '一度も完走していない系統を収束扱いにしない');

  // 人間が予算を割り当てればリトライできる
  escalateAngles(state, { angles: [entry.angle], reason: '起動失敗のリトライ' });
  const retryPlan = simulatePlan(state, 's1', changed);
  const retried = retryPlan.entries.find((e) => e.angle === entry.angle);
  assert.equal(retried.run, true);

  recordRunCommand(
    state,
    { angle: entry.angle, mode: retried.mode, fresh: true, status: 'complete', snapshotId: 's1' },
    { resolveSnapshot: () => snap1 },
  );
  assert.ok(
    state.runs.some((r) => r.angle === entry.angle && r.status === 'complete'),
    'retry の成功が記録される',
  );
  assert.doesNotThrow(() => simulatePlan(state, 's2', changed));
});

test('record-run: 提案されたモードと異なるモードでの記録は拒否される（外部レビュー Codex 指摘）', () => {
  const state = emptyState();
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  simulatePlan(state, 's1', changed);
  const [entry] = plannedLaunches(state, snap1);
  assert.ok(entry, 'この Tier では最低1系統が起動提案される');

  // 提案は entry.mode（例: full-rescan）だが、異なるモードで record-run する
  const wrongMode = entry.mode === 'full-rescan' ? 'diff-explore' : 'full-rescan';
  assert.throws(
    () =>
      recordRunCommand(
        state,
        { angle: entry.angle, mode: wrongMode, fresh: true, status: 'complete', snapshotId: 's1' },
        { resolveSnapshot: () => snap1 },
      ),
    /計画が要求していない起動を記録しようとしています/,
    '提案と異なるモードの記録を受理すると、段階判定が「実施済み」と誤認して必須の探索を飛ばす',
  );
  assert.ok(
    plannedLaunches(state, snap1).some((e) => e.angle === entry.angle && e.mode === entry.mode),
    '拒否された記録の後も、計画は同じ起動を要求し続ける',
  );

  // 提案どおりのモードで記録すれば受理される
  recordPlanned(state, snap1, entry.angle);
  assert.ok(
    !plannedLaunches(state, snap1).some((e) => e.angle === entry.angle),
    '提案どおりのモードでの記録は、その系統の起動要求を解消する',
  );
});

test('record-run: fresh 要件と一致しない記録（--continue）は拒否される（外部レビュー Codex 指摘・3回目）', () => {
  const state = emptyState();
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  simulatePlan(state, 's1', changed);
  const entry = plannedLaunches(state, snap1).find((e) => e.fresh === true);
  assert.ok(entry, '初回探索は fresh:true で提案される');

  assert.throws(
    () =>
      recordRunCommand(
        state,
        {
          angle: entry.angle,
          mode: entry.mode,
          fresh: false,
          status: 'complete',
          snapshotId: 's1',
        },
        { resolveSnapshot: () => snap1 },
      ),
    /計画が要求していない起動を記録しようとしています/,
    '独立レビュアーへの交代が要求されているのに継続レビュアーの記録で代替できてはいけない',
  );

  // fresh も一致させれば受理される
  recordPlanned(state, snap1, entry.angle);
  assert.ok(state.runs.some((r) => r.angle === entry.angle && r.fresh === true));
});

test('plan: 記憶適合は一度ヒットで要求されたらその attempt の必須系統として残る（--memory-hits を渡し忘れても義務が消えない。外部レビュー Codex 指摘・6/10回目）', () => {
  const state = emptyState();
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  planCommand(state, snap1); // 段階1（減算）
  recordPlanned(state, snap1, 'subtractive');

  const plan1 = planCommand(state, snap1, { memoryHits: 3 });
  assert.equal(plan1.stage, 'body');
  assert.ok(
    plan1.entries.some((e) => e.angle === 'memory' && e.run),
    'memory-hits > 0 なら memory が起動提案される',
  );
  assert.equal(state.memoryRequired, true, '記憶適合の要求が state に固定される');

  // s1 で提案されたすべての起動を記録する（memory は起動失敗 = error として記録）
  for (const e of plan1.entries) {
    if (!e.run) continue;
    recordRunCommand(
      state,
      {
        angle: e.angle,
        mode: e.mode,
        fresh: e.fresh,
        status: e.angle === 'memory' ? 'error' : 'complete',
        snapshotId: 's1',
      },
      { resolveSnapshot: () => snap1 },
    );
  }

  // 次の snapshot（s2）で --memory-hits を渡し忘れた（0）としても、記憶適合の義務は state に
  // 固定されているため**系統としては計画に残り続ける**（義務が消えて落ちてはいけない）
  const snap2 = snap({ snapshotId: 's2', previousSnapshotId: 's1', files: changed });
  const plan2 = planCommand(state, snap2, { memoryHits: 0 });
  const mem2 = plan2.entries.find((e) => e.angle === 'memory');
  assert.ok(mem2, '--memory-hits を渡し忘れても、記憶適合の義務は state から復元される');
  // ただし error も予算を消費するので、自動では回り直さない（起動失敗の無限リトライを作らない）
  assert.equal(mem2.run, false);
  assert.equal(mem2.budgetOutcome, 'exhausted');
  assert.match(mem2.reason, /error/, '一度も完走していないことを人間判断へ返す');
  assert.equal(plan2.converged, false, '未確認のまま収束させない');

  // 人間が予算を割り当てれば起動する
  escalateAngles(state, { angles: ['memory'], reason: '起動失敗のリトライ' });
  const granted = planCommand(state, snap2, { memoryHits: 0 });
  assert.ok(granted.entries.some((e) => e.angle === 'memory' && e.run));
});

test('plan: エスカレーション後は同一 snapshot でも強い起動（全体再探索・fresh）が要求される', () => {
  const state = emptyState();
  settleSubtractive(state, 's1'); // 本体段階へ進める
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  planCommand(state, snap1);
  recordPlanned(state, snap1, 'quality');
  assert.ok(
    !plannedLaunches(state, snap1).some((e) => e.angle === 'quality'),
    '記録済みの系統は同じ snapshot で再要求されない（前提）',
  );

  escalateAngles(state, { angles: ['quality'], reason: '外部レビューが横断的な見落としを検出' });
  const after = plannedLaunches(state, snap1).filter((e) => e.angle === 'quality');
  assert.equal(after.length, 1, '同一系統の要求は1件のみ（重複しない）');
  assert.deepEqual(
    { mode: after[0].mode, fresh: after[0].fresh },
    { mode: 'full-rescan', fresh: true },
    'エスカレーションは fresh・全体再探索を要求する。記録は毎回この計画と照合されるので、' +
      '古い提案が別の場所に残って照合をすり抜けることがない',
  );
});

test('record-run: 再要求された同一 identity は新しい起動として記録する（冪等 no-op で escalation を消化不能にしない。外部レビュー Codex 指摘 P1）', () => {
  const state = emptyState();
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  planCommand(state, snap1);
  recordPlanned(state, snap1, 'subtractive');
  planCommand(state, snap1);
  recordPlanned(state, snap1, 'quality'); // full-rescan / fresh / complete
  assert.ok(
    !plannedLaunches(state, snap1).some((e) => e.angle === 'quality'),
    '前提: この snapshot の quality は実施済み',
  );

  // エスカレーションが同じ起動形（full-rescan / fresh）を改めて要求する
  escalateAngles(state, { angles: ['quality'], reason: '外部レビューが横断的な見落としを検出' });
  const requested = plannedLaunches(state, snap1).find((e) => e.angle === 'quality');
  assert.deepEqual(
    { mode: requested.mode, fresh: requested.fresh },
    { mode: 'full-rescan', fresh: true },
    '前提: 再要求は直前の記録と同じ identity になる',
  );

  const before = state.runs.length;
  recordPlanned(state, snap1, 'quality');
  assert.equal(
    state.runs.length,
    before + 1,
    '再要求された起動を冪等 no-op にすると新しい seq が付かず、pendingEscalation の' +
      '「要求発生後の run」条件を永久に満たせない（計画が同じ起動を要求し続ける）',
  );
  assert.ok(
    !plannedLaunches(state, snap1).some((e) => e.angle === 'quality'),
    '記録によりエスカレーションが消化される',
  );
});

test('record-run: 再要求された起動が error / incomplete で終わっても新しい invocation として記録する（外部レビュー Codex 指摘 P2）', () => {
  for (const status of ['error', 'incomplete']) {
    const state = emptyState();
    const changed = [file('src/lib/writingRules.js')];
    const snap1 = snap({ snapshotId: 's1', files: changed });
    planCommand(state, snap1);
    recordPlanned(state, snap1, 'subtractive');
    planCommand(state, snap1);
    recordPlanned(state, snap1, 'quality'); // complete

    escalateAngles(state, { angles: ['quality'], reason: '外部レビューが横断的な見落としを検出' });
    const requested = plannedLaunches(state, snap1).find((e) => e.angle === 'quality');
    const before = state.runs.length;

    // 再要求された起動が失敗した（maxTurns 到達・起動失敗）。既存の complete との conflict
    // として拒否すると、実際の失敗を記録できず state には古い成功だけが残る
    recordRunCommand(
      state,
      {
        angle: 'quality',
        mode: requested.mode,
        fresh: requested.fresh,
        status,
        snapshotId: 's1',
      },
      { resolveSnapshot: () => snap1 },
    );
    assert.equal(state.runs.length, before + 1, `再要求された起動の ${status} が記録される`);
    assert.equal(state.runs.at(-1).status, status);

    // **1 escalation = 1 起動。** error / incomplete のどちらでも自動では回り直さない
    // （起動失敗・maxTurns の自動リトライに上限が無いと、1回の人間判断が無限の起動へ増幅する）
    assert.equal(
      plannedLaunches(state, snap1).some((e) => e.angle === 'quality'),
      false,
      `${status} で自動再起動しない`,
    );
    const plan = planCommand(state, snap1);
    const e = plan.entries.find((x) => x.angle === 'quality');
    assert.equal(e.budgetOutcome, 'exhausted', '所見ゼロで収束させず未確認範囲として残す');
    assert.match(e.reason, new RegExp(status));
    assert.equal(plan.converged, false);
  }
});

test('plan: 誤った mode の記録は拒否され、再計画でも同じ起動が要求され続ける（外部レビュー Codex 指摘・3回目）', () => {
  const state = emptyState();
  settleSubtractive(state, 's1'); // 本体段階へ進める
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  planCommand(state, snap1);
  const before = plannedLaunches(state, snap1).find((e) => e.angle === 'quality');
  assert.equal(before.mode, 'full-rescan', 'この Tier では quality は full-rescan で提案される');

  // 異なる mode での記録は受理されない
  assert.throws(
    () =>
      recordRunCommand(
        state,
        {
          angle: 'quality',
          mode: 'diff-explore',
          fresh: true,
          status: 'complete',
          snapshotId: 's1',
        },
        { resolveSnapshot: () => snap1 },
      ),
    /計画が要求していない起動を記録しようとしています/,
  );

  // 同一 snapshot で再計画しても、要求は同じ内容で出続ける
  const replanned = planCommand(state, snap1);
  const q = replanned.entries.find((e) => e.angle === 'quality');
  assert.equal(q.run, true, '未記録の要求は同じ内容で再提案される');
  assert.equal(q.mode, 'full-rescan');

  // 提案どおりの mode で記録すれば受理される
  recordPlanned(state, snap1, 'quality');
  assert.ok(!plannedLaunches(state, snap1).some((e) => e.angle === 'quality'));
});

test('plan: 提案どおりでない記録は拒否され、次の snapshot では現在の state から再要求される（Case B）', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  planCommand(state, snap1); // 減算段階
  settleSubtractive(state, 's1');
  const plan = planCommand(state, snap1); // 本体段階
  const quality = plan.entries.find((e) => e.angle === 'quality');
  assert.equal(quality.run, true);
  assert.equal(quality.mode, 'full-rescan');

  // 提案と異なる mode の記録は受理されない
  assert.throws(
    () =>
      recordRunCommand(
        state,
        {
          angle: 'quality',
          mode: 'diff-explore',
          fresh: true,
          status: 'complete',
          snapshotId: 's1',
        },
        { resolveSnapshot: () => snap1 },
      ),
    /計画が要求していない起動を記録しようとしています/,
  );

  // 未記録のまま次の snapshot へ進める（停止しない）。s1 の義務を supersede で引き継ぐのでは
  // なく、s2 の state から起動要求を作り直す
  const snap2 = snap({ snapshotId: 's2', previousSnapshotId: 's1', files: changed });
  assert.doesNotThrow(() => planCommand(state, snap2));
  settleSubtractive(state, 's2');
  const plan2 = planCommand(state, snap2);
  const q2 = plan2.entries.find((e) => e.angle === 'quality');
  assert.equal(q2.run, true, '一度も完了していない系統は新しい snapshot でも要求される');
  assert.equal(q2.fresh, true, '未実施の系統は fresh 起動を要求する（安全側）');
});

// CLI 経路の結合テスト。実 git リポジトリで snapshot を取り、鮮度検証・計画照合が
// 実際の成果物に対して働くことを確認する。
function makePlanRepo(t) {
  const dir = makeTmpGitRepo('review-plan-cli-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'src.js'), 'export const a = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'base']);
  sh(dir, ['branch', 'feature']);
  sh(dir, ['checkout', '-q', 'feature']);
  return dir;
}

// --snapshot-id 無指定時のフォールバック（resolveRecordRunSnapshotId({}, dir) === 最新 snapshot）と
// 明示指定時の解決（resolveRecordRunSnapshotId({ 'snapshot-id': ... }, dir) === 指定 snapshot）は、
// 単体テストではなく下記の結合テスト内のアサーションで両方カバーする
// CLI 経路の結合テスト。単体テストは各関数を直接呼ぶため、CLI が引数を渡し忘れて
// いても通ってしまう（実運用だけが壊れる。過去に3度発生した失敗クラス）
function runPlanCli(dir, args) {
  return execFileSync('node', [join(ROOT, 'scripts/agent/review-plan.js'), ...args], {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readPlanState(dir) {
  return JSON.parse(readFileSync(join(dir, '.git/agent-review/review-state.json'), 'utf-8'));
}

test('CLI: escalate は観点と理由だけを受け取り、所見の意味は state に残さない', (t) => {
  const dir = makePlanRepo(t);
  writeFileSync(join(dir, 'src.js'), 'export const a = 2;\n');
  execFileSync('git', ['commit', '-qam', 'f1'], { cwd: dir });
  createSnapshot({ cwd: dir, baseRef: 'main' });

  runPlanCli(dir, ['plan']); // 初期 Tier の確定（escalate の前提）
  runPlanCli(dir, [
    'escalate',
    '--angles',
    'operability',
    '--reason',
    '外部レビューで手順の実行主体が不在と指摘',
  ]);

  const state = readPlanState(dir);
  assert.ok(state.addedAngles.includes('operability'));
  const esc = state.escalations.at(-1);
  assert.equal(esc.kind, 'manual-escalation');
  assert.equal(esc.reason, null, '理由の本文は state に保存しない');
  assert.ok(!JSON.stringify(state).includes('実行主体が不在'));
  assert.equal(state.findings, undefined, '所見台帳は state に作られない');
  const serialized = JSON.stringify(state);
  for (const token of ['relation', 'disposition', 'impactClass', 'dismissClass']) {
    assert.ok(!serialized.includes(token), `${token} が state に残っている`);
  }
});

test('CLI: record-run は削除されたフラグ（--final / --new-findings）を黙って無視しない', (t) => {
  const dir = makePlanRepo(t);
  writeFileSync(join(dir, 'src.js'), 'export const a = 2;\n');
  execFileSync('git', ['commit', '-qam', 'f1'], { cwd: dir });
  createSnapshot({ cwd: dir, baseRef: 'main' });
  runPlanCli(dir, ['plan']);
  const requested = plannedLaunches(emptyState(), latestSnapshot(dir))[0];
  const base = [
    'record-run',
    '--angle',
    requested.angle,
    '--mode',
    requested.mode,
    '--fresh',
    '--status',
    'complete',
  ];

  const expectRefusal = (args, pattern) =>
    assert.throws(
      () => runPlanCli(dir, args),
      (err) => {
        assert.match(`${err.stdout ?? ''}${err.stderr ?? ''}`, pattern);
        return true;
      },
    );
  // 黙って無視すると、旧手順どおり叩いた側は「最終独立レビューを記録した」つもりで
  // 通常 run を1本記録してしまう
  expectRefusal([...base, '--final'], /--final を受理しません/);
  expectRefusal([...base, '--new-findings', '3'], /--new-findings を受理しません/);
  assert.equal(readPlanState(dir).runs.length, 0, '拒否された記録は台帳に入らない');
});

test('CLI: 削除された所見ライフサイクルのサブコマンドは受理しない（別名での温存を検出する）', (t) => {
  const dir = makePlanRepo(t);
  writeFileSync(join(dir, 'src.js'), 'export const a = 2;\n');
  execFileSync('git', ['commit', '-qam', 'f1'], { cwd: dir });
  createSnapshot({ cwd: dir, baseRef: 'main' });
  runPlanCli(dir, ['plan']);

  for (const cmd of [
    'add-finding',
    'resolve-finding',
    'dismiss-finding',
    'defer-finding',
    'set-relation',
  ]) {
    assert.throws(
      () => runPlanCli(dir, [cmd, '--angle', 'cleanup', '--summary', 'x']),
      /usage/,
      `${cmd} は machine から削除されている（裁定の正本は docs/pr/PR-{番号}.md）`,
    );
  }
});

test('CLI: supersede-batch は受理せず、サブコマンドの受理文法は4つに閉じている', (t) => {
  const dir = makePlanRepo(t);
  let usage = '';
  try {
    runPlanCli(dir, ['supersede-batch', '--snapshot-id', 'x', '--reason', 'y']);
  } catch (err) {
    usage = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  assert.match(usage, /plan\|escalate\|record-run\|state/);
});

test('CLI: 作業キャッシュを削除しても、現在の repo state から計画を作り直せる（Case D）', (t) => {
  const dir = makePlanRepo(t);
  writeFileSync(join(dir, 'src.js'), 'export const a = 2;\n');
  execFileSync('git', ['commit', '-qam', 'f1'], { cwd: dir });
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snapshot = latestSnapshot(dir);
  runPlanCli(dir, ['plan']);
  const requested = plannedLaunches(emptyState(), snapshot)[0];
  runPlanCli(dir, [
    'record-run',
    '--angle',
    requested.angle,
    '--mode',
    requested.mode,
    requested.fresh ? '--fresh' : '--continue',
    '--snapshot-id',
    snapshot.snapshotId,
    '--status',
    'complete',
  ]);
  assert.equal(readPlanState(dir).runs.length, 1, '前提: 起動が1件記録されている');

  // 作業キャッシュを削除する（別セッション・別マシンでの再開に相当）
  rmSync(stateFile(dir));

  const out = runPlanCli(dir, ['plan']);
  const state = readPlanState(dir);
  assert.equal(state.version, STATE_VERSION);
  assert.deepEqual(state.runs, [], '過去 attempt の起動記録は復元しない');
  assert.match(out, /すべて記録済み|未記録の起動要求あり/);
  assert.ok(
    plannedLaunches(state, latestSnapshot(dir)).length > 0,
    'cache が無くても現在の snapshot から必要な起動が再計算される',
  );
  assert.ok(
    !/計画が要求した起動: すべて記録済み/.test(out),
    'cache 消失を「全部実施済み」へ fail-open しない（安全側に未実施として出し直す）',
  );
});

test('計画: 実効 Tier の必須系統は、段階を通じて必ず一度は起動される（誤って skip しない）', () => {
  const state = emptyState();
  const changed = [file('src/lib/db.js')]; // 高リスク＝ Full（7系統）
  const required = new Set(anglesForTierName('Full'));
  const launched = new Set();

  // 1 snapshot の中で段階（減算 → 本体 → 清掃）を回し切る
  const current = snap({ snapshotId: 's1', files: changed });
  for (let round = 0; round < 10; round += 1) {
    const plan = planCommand(state, current);
    if (plan.converged) break;
    for (const e of plan.entries.filter((x) => x.run)) {
      recordPlanned(state, current, e.angle);
      launched.add(e.angle);
    }
  }
  assert.deepEqual(
    [...required].filter((a) => !launched.has(a)),
    [],
    '必須系統が一度も起動されないまま収束してはいけない',
  );
  assert.ok(
    [...launched].indexOf('subtractive') === 0 && [...launched].at(-1) === 'cleanup',
    '起動順は 減算（入口） → 本体 → 清掃（最終1周）',
  );
  assert.equal(planCommand(state, current).converged, true);
});

// 実在した起動義務台帳の名前が surface へ戻っていないことだけを固定する
test('起動義務台帳が撤去されたままである（実在した名前の surface を固定する）', async () => {
  const mod = await import('../scripts/agent/review-plan.js');
  const removed = [
    'pendingLaunches',
    'supersededLaunches',
    'checkPendingLaunches',
    'formatPendingLaunchesError',
    'resolvePendingLaunch',
    'supersedeBatch',
  ];
  const surface = new Set([...Object.keys(mod), ...Object.keys(emptyState())]);
  assert.deepEqual(
    removed.filter((name) => surface.has(name)),
    [],
    '撤去した起動義務台帳が export / state フィールドとして戻っている',
  );
});

test('record-run: --snapshot-id は「どの snapshot を読んだレビューか」を明示する（無指定は最新）', (t) => {
  const dir = makePlanRepo(t);
  writeFileSync(join(dir, 'src.js'), 'export const a = 2;\n');
  execFileSync('git', ['commit', '-qam', 'f1'], { cwd: dir });
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap1 = latestSnapshot(dir);

  // 修正せずにもう一度 snapshot を取る（内容は同じなので snap1 も鮮度上は有効なまま）
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap2 = latestSnapshot(dir);
  assert.notEqual(snap2.snapshotId, snap1.snapshotId);

  // 無指定は最新へフォールバックする
  assert.equal(resolveRecordRunSnapshotId({}, dir), snap2.snapshotId);
  // 明示すれば、レビュアーが実際に読んだ snapshot として記録できる
  assert.equal(
    resolveRecordRunSnapshotId({ 'snapshot-id': snap1.snapshotId }, dir),
    snap1.snapshotId,
  );

  const state = emptyState();
  const requested = plannedLaunches(state, snap1);
  assert.ok(requested.length > 0, 'この Tier では最低1系統が起動提案される');
  for (const e of requested) {
    recordRunCommand(
      state,
      {
        angle: e.angle,
        mode: e.mode,
        fresh: e.fresh,
        status: 'complete',
        snapshotId: snap1.snapshotId,
      },
      { resolveSnapshot: () => snap1 },
    );
  }
  assert.ok(
    state.runs.every((r) => r.snapshotId === snap1.snapshotId),
    '記録はレビュアーが読んだ snapshot に紐づく（最新へ付け替えない）',
  );
});

test('loadState: 破損した review-state.json は fail-loud する（ファイルパスと原因を含む）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-plan-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  const file2 = stateFile(dir);
  mkdirSync(dirname(file2), { recursive: true });
  writeFileSync(file2, '{ this is not json');
  assert.throws(
    () => loadState(dir),
    (err) => {
      assert.match(err.message, /review-state\.json/);
      return true;
    },
  );
});

// JSON 構文としては正しいが構造が不正（配列・null・プリミティブ値・配列フィールドの型違反）な
// review-state.json を fail-loud で拒否する（黙って空状態化 → 直後の saveState で台帳データが
// 消失する事故の防止）。
// loadState は reviewRoot() 経由で `git rev-parse --git-path` のみ使う（コミットしないため
// user.email/user.name の設定は不要 — makePlanRepo と異なりコミット・ブランチ作成を伴わない）
function makeStateDir(t) {
  const dir = makeTmpGitRepo('review-plan-state-struct-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const [label, content] of [
  ['配列', '[]'],
  ['null', 'null'],
  ['runs が文字列', JSON.stringify({ version: STATE_VERSION, runs: 'oops' })],
  ['escalations が null', JSON.stringify({ version: STATE_VERSION, escalations: null })],
  ['addedAngles が配列でない', JSON.stringify({ version: STATE_VERSION, addedAngles: 'oops' })],
]) {
  test(`loadState: 構造が不正な review-state.json（${label}）は fail-loud する`, (t) => {
    const dir = makeStateDir(t);
    const file2 = stateFile(dir);
    mkdirSync(dirname(file2), { recursive: true });
    writeFileSync(file2, content);
    assert.throws(
      () => loadState(dir),
      (err) => {
        assert.match(err.message, /構造が不正です/);
        return true;
      },
    );
  });
}

test('loadState: 欠けたフィールドは emptyState() の既定値で補完される', (t) => {
  const dir = makeStateDir(t);
  const f2 = stateFile(dir);
  mkdirSync(dirname(f2), { recursive: true });
  writeFileSync(f2, JSON.stringify({ version: STATE_VERSION, initialTier: 'Light', runs: [] }));
  const state = loadState(dir);
  assert.equal(state.memoryRequired, false, '欠けたフィールドは emptyState() の既定値で補完される');
  assert.equal(state.initialTier, 'Light', '既存フィールドは失われない');
});

test('loadState: boolean フィールドが boolean でない場合は fail-loud する（型強制で "false" を true と解釈しない）', (t) => {
  const dir = makeStateDir(t);
  const f2 = stateFile(dir);
  mkdirSync(dirname(f2), { recursive: true });
  writeFileSync(f2, JSON.stringify({ version: STATE_VERSION, memoryRequired: 'false' }));
  assert.throws(
    () => loadState(dir),
    /memoryRequired は boolean である必要があります/,
    'Boolean("false") === true の型強制で必須レビューの要求状態を取り違えない',
  );
});

test('loadState: Object.prototype が（別コードにより）汚染されていても、own property のみを検証する（外部レビュー Copilot 指摘）', (t) => {
  const dir = makeStateDir(t);
  const file2 = stateFile(dir);
  mkdirSync(dirname(file2), { recursive: true });
  // own property としては何も持たないオブジェクト（`findings` を own では持たない）
  writeFileSync(file2, JSON.stringify({ version: STATE_VERSION }));
  // `key in parsed` は prototype chain も見るため、Object.prototype 側に配列でない値が
  // 生えていると誤って「壊れている」と fail-loud してしまう（own-property のみを見るべき）
  Object.defineProperty(Object.prototype, 'findings', {
    value: 'polluted',
    configurable: true,
    enumerable: false,
  });
  t.after(() => {
    delete Object.prototype.findings;
  });
  assert.doesNotThrow(
    () => loadState(dir),
    'own property でない findings は検証対象にならない（Object.prototype 汚染に引きずられない）',
  );
});

// ---------------------------------------------------------------------------
// Phase 4 受け入れ fixture（PR1 で実際に起きた発散クラスの再現）
//
// 「設計上は収束しそう」ではなく「PR1 で起きた発散を機械的に再発防止した」を主張するための固定。
// 番号は再設計計画 v2 §4 の A1-A6 に対応する（A3 Tier 往復 / A6 causal in-diff は後続 PR）
// ---------------------------------------------------------------------------

// A1/A2（所見の relation・disposition に依存した LIMIT 周回・収束ガード）は、finding semantics の
// 撤去に伴い machine の契約ではなくなった。予算・打ち切りの判断は
// docs/planning/review-memory-boundary.md §4・§7 の運用手順が担う。
// 代わりに固定するのは「machine が finding semantics を持たない」こと自体
test('semantic finding state が machine の収束判定に復活していない', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  for (const a of anglesForTierName('Light')) {
    recordRun(state, { angle: a, mode: 'full-rescan', fresh: true, snapshotId: 'z1' });
  }
  const plan = simulatePlan(state, 'z1', changed);
  assert.equal(plan.converged, true, '計画した起動をすべて記録すれば収束する');
  assert.deepEqual(plan.nextActions, []);

  // 収束判定・計画出力のどこにも所見の意味に基づくフィールドを持たない
  const serialized = JSON.stringify(plan);
  for (const token of [
    'openFindings',
    'unknownRelation',
    'relation',
    'disposition',
    'impactClass',
    'dismissClass',
    'limits',
  ]) {
    assert.ok(!serialized.includes(token), `plan に ${token} が残っている（別名での温存を含む）`);
  }
  assert.equal(state.findings, undefined, 'state に所見台帳を作らない');
});

// A4: PR1 では docs 1行の修正が入口からの全系統やり直しを誘発した。既存ファイルへの修正で
// dirty になるのは、その修正がアンカーを動かした義務だけであるべき
test('A4: 既存ファイルの修正では必要な obligation だけが dirty になる', () => {
  const state = lightState();
  settleSubtractive(state, 's1');
  for (const a of anglesForTierName('Light')) {
    if (a !== 'subtractive') {
      recordRun(state, { angle: a, mode: 'full-rescan', fresh: true, snapshotId: 's1' });
    }
  }
  // 同じ内容の周回（修正差分なし）では、どの義務も dirty にならない
  const quiet = simulatePlan(state, 's2', [], { previousSnapshotId: 's1' });
  const dirtyAngles = quiet.entries.filter((e) => e.dirty).map((e) => e.angle);
  assert.deepEqual(dirtyAngles, [], '修正差分が無い周回は義務が dirty にならない');
  for (const e of quiet.entries) {
    assert.match(e.reason, /義務は満たされている/, `${e.angle} は保留ではなく充足として報告される`);
  }

  // 逆向き: シグナルが立たなくても**一度も完了していない必須義務**は dirty。
  // 「トリガーが無いから」で未実施の系統を素通りさせない
  const partial = lightState();
  settleSubtractive(partial, 's1');
  const ran = new Set(['subtractive']);
  for (const a of anglesForTierName('Light')) {
    if (a === 'subtractive' || a === 'quality') continue;
    recordRun(partial, { angle: a, mode: 'full-rescan', fresh: true, snapshotId: 's1' });
    ran.add(a);
  }
  const plan = simulatePlan(partial, 's2', [], { previousSnapshotId: 's1' });
  const quality = plan.entries.find((e) => e.angle === 'quality');
  assert.equal(quality.dirty, true, '一度も完了していない必須義務は dirty');
  const done = plan.entries.find((e) => e.angle !== 'quality' && ran.has(e.angle));
  assert.equal(done.dirty, false, '完了済みの義務は dirty にならない');
});

// record-run の冪等性と conflict は別物。完全同一は no-op（リトライで壊れない）だが、
// 完了したと記録済みの起動を別の結果で覆すのは黙って後勝ちにしない
test('record-run: 完全同一は no-op、完了済みを覆す記録は conflict で fail-loud', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  simulatePlan(state, 's1', changed);
  const requested = plannedLaunches(state, snap1).find((e) => e.angle === 'subtractive');
  const args = {
    angle: 'subtractive',
    mode: requested.mode,
    fresh: requested.fresh,
    status: 'complete',
    snapshotId: 's1',
  };
  const first = recordRunCommand(state, args, { resolveSnapshot: () => snap1 });
  const runCount = state.runs.length;

  // 完全に同一の記録は no-op（同じ seq を返し、記録を増やさない）
  const again = recordRunCommand(state, args, { resolveSnapshot: () => snap1 });
  assert.equal(again.seq, first.seq, '同一記録は no-op');
  assert.equal(state.runs.length, runCount, '記録を二重に増やさない');

  // 同じ起動に異なる結果は受理しない（どちらが真実かは機械には決められない）
  assert.throws(
    () => recordRunCommand(state, { ...args, status: 'error' }, { resolveSnapshot: () => snap1 }),
    /同じ起動に異なる結果/,
    '完了済みの起動を別の結果で覆さない',
  );
});

// version を検査しないと、別 schema の state を黙って現行版として読んでしまう。
// version 2 は凍結中の #569 が別 schema に使っている番号なので受理しない
test('loadState: 現行版以外の state は移行せず fail-loud（旧版の起動義務を読み替えない）', (t) => {
  const dir = makeStateDir(t);
  mkdirSync(dirname(stateFile(dir)), { recursive: true });
  const write = (obj) => writeFileSync(stateFile(dir), JSON.stringify(obj));

  // 旧版の runs には旧 `final`（最終独立レビュー）や supersede 由来の記録が混ざる。
  // 素通しすると通常レビュー完了として解釈され、未実施の系統が実施済みになる
  for (const version of [1, 2, 3, 99]) {
    write({ version, runs: [] });
    assert.throws(
      () => loadState(dir),
      new RegExp(`version を認識できません: ${version}`),
      `version ${version} は移行せず拒否する`,
    );
  }
  assert.throws(() => loadState(dir), /旧版からの移行は行いません/, '復旧手段を案内する');

  write({ runs: [] });
  assert.throws(() => loadState(dir), /version フィールドなし/);

  write({ version: STATE_VERSION, runs: [] });
  assert.doesNotThrow(() => loadState(dir), '現行版だけを受理する');
});

// 鮮度検証は実 git リポジトリでしか確かめられない（manifest.currentCommit との diff・
// untracked のハッシュ比較がいずれも実リポジトリの状態に依存する）。
// snapshot 表現は #570 のもの（branch は持たない。HEAD + 作業ツリー + untracked ハッシュ）
test('freshness: HEAD・tracked・untracked の変化をそれぞれ検出する', async (t) => {
  const { createSnapshot, snapshotFreshness, latestSnapshot } =
    await import('../scripts/agent/review-snapshot.js');
  const dir = makePlanRepo(t);
  // makePlanRepo が commit 済みの src.js を持つ。その内容を確定させてから snapshot を取る
  const original = readFileSync(join(dir, 'src.js'), 'utf-8');
  createSnapshot({ cwd: dir, baseRef: 'main' });

  const snap = latestSnapshot(dir);
  assert.equal(snapshotFreshness(snap, dir).fresh, true, '取った直後は fresh');

  // tracked の作業ツリー変更
  writeFileSync(join(dir, 'src.js'), `${original}// edited\n`);
  const afterEdit = snapshotFreshness(snap, dir);
  assert.equal(afterEdit.fresh, false);
  assert.ok(afterEdit.stale.some((r) => /tracked/.test(r)));
  writeFileSync(join(dir, 'src.js'), original);
  assert.equal(snapshotFreshness(snap, dir).fresh, true, '戻せば fresh に復帰する');

  // HEAD の変化
  writeFileSync(join(dir, 'other.js'), 'export const b = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-qm', 'c2'], { cwd: dir, stdio: 'ignore' });
  assert.ok(snapshotFreshness(snap, dir).stale.some((r) => /HEAD/.test(r)));
});

test('freshness: untracked は集合が同じでも内容が変われば stale', async (t) => {
  const { createSnapshot, snapshotFreshness, latestSnapshot } =
    await import('../scripts/agent/review-snapshot.js');
  const dir = makePlanRepo(t);
  writeFileSync(join(dir, 'note.md'), '# before\n');
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap = latestSnapshot(dir);
  assert.equal(snapshotFreshness(snap, dir).fresh, true);

  // パス集合は変えず中身だけ書き換える（#570 が塞いだのと同じ失敗様式）
  writeFileSync(join(dir, 'note.md'), '# after\n');
  const res = snapshotFreshness(snap, dir);
  assert.equal(res.fresh, false, 'untracked の内容変更を見逃さない');
  assert.ok(res.stale.some((r) => /untracked の内容/.test(r)));
});

// untracked の symlink は readFileSync がリンク先を辿るため、内容ハッシュの対象から外して
// いた。結果としてリンク先だけ差し替えても「集合も内容も同じ」と判定され、コミット可能な
// 変更がレビュー済み扱いのまま受理される（外部レビュー Codex 指摘）
test('freshness: untracked symlink はリンク先が変わったら stale', async (t) => {
  const { createSnapshot, snapshotFreshness, latestSnapshot } =
    await import('../scripts/agent/review-snapshot.js');
  const dir = makePlanRepo(t);
  writeFileSync(join(dir, 'a.txt'), 'A\n');
  writeFileSync(join(dir, 'b.txt'), 'B\n');
  symlinkSync('a.txt', join(dir, 'link'));
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap = latestSnapshot(dir);
  assert.equal(snapshotFreshness(snap, dir).fresh, true, '前提: 取った直後は fresh');

  // パス集合は変えずリンク先だけ差し替える
  rmSync(join(dir, 'link'));
  symlinkSync('b.txt', join(dir, 'link'));
  const res = snapshotFreshness(snap, dir);
  assert.equal(res.fresh, false, 'symlink のリンク先変更を見逃さない');
  assert.ok(res.stale.some((r) => /untracked の内容/.test(r)));
});

// 作業ツリーの差し替えは createSnapshot が拒否するのに、鮮度検証だけが素通りしていた。
// 同一の入力クラス（作業ツリーが snapshot 時点から動いていないか）を判定する2実装の
// 受理集合が非対称だと、片方を迂回するだけで古い結果が受理される（外部レビュー Codex 指摘 / #572）
test('freshness: GIT_WORK_TREE による作業ツリー差し替えを拒否する', async (t) => {
  const { createSnapshot, snapshotFreshness, latestSnapshot } =
    await import('../scripts/agent/review-snapshot.js');
  const dir = makePlanRepo(t);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap = latestSnapshot(dir);
  assert.equal(snapshotFreshness(snap, dir).fresh, true, '前提: 取った直後は fresh');

  const prev = process.env.GIT_WORK_TREE;
  process.env.GIT_WORK_TREE = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = prev;
  });
  assert.throws(
    () => snapshotFreshness(snap, dir),
    (err) => {
      assert.match(err.message, /GIT_WORK_TREE/);
      return true;
    },
  );
});

test('freshness: core.worktree による作業ツリー差し替えを拒否する', async (t) => {
  const { createSnapshot, snapshotFreshness, latestSnapshot } =
    await import('../scripts/agent/review-snapshot.js');
  const dir = makePlanRepo(t);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap = latestSnapshot(dir);
  execFileSync('git', ['config', 'core.worktree', dir], { cwd: dir });
  assert.throws(
    () => snapshotFreshness(snap, dir),
    (err) => {
      assert.match(err.message, /core\.worktree/);
      return true;
    },
  );
});

// 鮮度は検出できるだけでは意味がない。record-run が実際に拒否し、かつ**廃棄経路を案内する**
// ことまでを CLI 経路で固定する（関数直呼びでは CLI の引数渡し忘れを検出できない）
// 起動義務台帳を持たないので supersede は無い。stale な結果は受理せず、次の行動は
// 「snapshot を取り直して計画からやり直す」（Case C）
test('CLI: record-run は古くなった snapshot の結果を受理しない（stale を current として受理しない）', (t) => {
  const dir = makePlanRepo(t);
  writeFileSync(join(dir, 'src.js'), 'export const a = 2;\n');
  execFileSync('git', ['commit', '-qam', 'f1'], { cwd: dir });
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snapshot = latestSnapshot(dir);
  runPlanCli(dir, ['plan']);

  const requested = plannedLaunches(emptyState(), snapshot)[0];
  assert.ok(requested, '前提: 起動が要求されている');

  // バッチ中に修正が入り、snapshot 時点と作業ツリーがずれる
  writeFileSync(join(dir, 'src.js'), 'export const a = 3;\n');

  const args = [
    'record-run',
    '--angle',
    requested.angle,
    '--mode',
    requested.mode,
    requested.fresh ? '--fresh' : '--continue',
    '--snapshot-id',
    snapshot.snapshotId,
    '--status',
    'complete',
  ];
  assert.throws(
    () => runPlanCli(dir, args),
    (err) => {
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      assert.match(out, /現在の作業ツリーと一致しません/, '鮮度違反として拒否する');
      assert.match(out, /review:snapshot/, '次の行動（snapshot 取り直し）を案内する');
      return true;
    },
  );
  assert.deepEqual(readPlanState(dir).runs, [], '拒否された stale 結果は記録されない');

  // 案内どおり snapshot を取り直せば前へ進める（廃棄用の専用コマンドは要らない）
  createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.doesNotThrow(() => runPlanCli(dir, ['plan']));
  const fresh = latestSnapshot(dir);
  const next = plannedLaunches(loadState(dir), fresh)[0];
  assert.ok(next, '新しい snapshot でも必要な起動は再計算される');
  runPlanCli(dir, [
    'record-run',
    '--angle',
    next.angle,
    '--mode',
    next.mode,
    next.fresh ? '--fresh' : '--continue',
    '--snapshot-id',
    fresh.snapshotId,
    '--status',
    'complete',
  ]);
  assert.equal(readPlanState(dir).runs.length, 1);
});

// `--snapshot-id <古い ID>` で鮮度検証を迂回できてはいけない。
// 「読めないので検査を飛ばす」も禁止（証明できないなら受理しない）
test('CLI: 古い snapshot を指定しても鮮度検証を迂回できない', (t) => {
  const dir = makePlanRepo(t);
  writeFileSync(join(dir, 'src.js'), 'export const a = 2;\n');
  execFileSync('git', ['commit', '-qam', 'f1'], { cwd: dir });
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const old = latestSnapshot(dir);
  runPlanCli(dir, ['plan']);
  const pending = plannedLaunches(emptyState(), old)[0];

  // 作業ツリーを進めたうえで**新しい snapshot を取る**。latest だけを検証する実装だと
  // 「latest は fresh」なので古い snapshot への記録が通ってしまう
  writeFileSync(join(dir, 'src.js'), 'export const a = 3;\n');
  execFileSync('git', ['commit', '-qam', 'f2'], { cwd: dir });
  createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.notEqual(latestSnapshot(dir).snapshotId, old.snapshotId, '前提: latest は別 snapshot');

  assert.throws(
    () =>
      runPlanCli(dir, [
        'record-run',
        '--angle',
        pending.angle,
        '--mode',
        pending.mode,
        pending.fresh ? '--fresh' : '--continue',
        '--snapshot-id',
        old.snapshotId,
        '--status',
        'complete',
      ]),
    (err) => {
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      assert.match(out, /一致しません|受理できません/, '古い snapshot でも鮮度を検証する');
      assert.match(out, /review:snapshot/, '次の行動を案内する');
      return true;
    },
  );

  // 台帳に無い snapshot も「検査できないので通す」にしない
  assert.throws(
    () =>
      runPlanCli(dir, [
        'record-run',
        '--angle',
        pending.angle,
        '--mode',
        pending.mode,
        '--fresh',
        '--snapshot-id',
        '9999-deadbee-ffffffff-0000-0000-0000-000000000000',
        '--status',
        'complete',
      ]),
    (err) => {
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      assert.match(out, /台帳にありません|受理できません/);
      return true;
    },
  );
});

// 鮮度の材料が欠けている snapshot は「検査できないので通す」にしない。
// 旧形式・破損・整理済みのいずれも、証明できない以上は受理しない
// 計画照合の材料（changed-files.json）が読めない snapshot への記録も fail-closed。
// 「読めないので検査を飛ばす」を許すと、成果物を消すだけで段階順の照合を迂回できる
test('CLI: 計画照合の材料が読めない snapshot への記録は fail-closed', (t) => {
  const dir = makePlanRepo(t);
  writeFileSync(join(dir, 'src.js'), 'export const a = 2;\n');
  execFileSync('git', ['commit', '-qam', 'f1'], { cwd: dir });
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snapshot = latestSnapshot(dir);
  runPlanCli(dir, ['plan']);
  const requested = plannedLaunches(emptyState(), snapshot)[0];
  const args = [
    'record-run',
    '--angle',
    requested.angle,
    '--mode',
    requested.mode,
    requested.fresh ? '--fresh' : '--continue',
    '--snapshot-id',
    snapshot.snapshotId,
    '--status',
    'complete',
  ];
  const changedFiles = join(dir, '.git/agent-review', snapshot.snapshotId, 'changed-files.json');

  // 成果物が消えている
  rmSync(changedFiles);
  assert.throws(
    () => runPlanCli(dir, args),
    (err) => {
      assert.match(`${err.stdout ?? ''}${err.stderr ?? ''}`, /changed-files\.json がありません/);
      return true;
    },
  );

  // 成果物が壊れている
  writeFileSync(changedFiles, '{ not json');
  assert.throws(
    () => runPlanCli(dir, args),
    (err) => {
      assert.match(`${err.stdout ?? ''}${err.stderr ?? ''}`, /changed-files\.json が壊れています/);
      return true;
    },
  );
  assert.equal(readPlanState(dir).runs.length, 0, '照合できない記録は state に入らない');
});

test('CLI: 鮮度を証明できない snapshot への記録は fail-closed（材料欠落・ハッシュ欠落）', (t) => {
  const dir = makePlanRepo(t);
  writeFileSync(join(dir, 'note.md'), '# untracked\n');
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snapshot = latestSnapshot(dir);
  runPlanCli(dir, ['plan']);
  const pending = plannedLaunches(emptyState(), snapshot)[0];
  const args = (id) => [
    'record-run',
    '--angle',
    pending.angle,
    '--mode',
    pending.mode,
    pending.fresh ? '--fresh' : '--continue',
    '--snapshot-id',
    id,
    '--status',
    'complete',
  ];
  const expectRefusal = (pattern) =>
    assert.throws(
      () => runPlanCli(dir, args(snapshot.snapshotId)),
      (err) => {
        const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
        assert.match(out, pattern);
        return true;
      },
    );

  // 台帳から untracked の内容ハッシュが失われた場合（同名のまま書き換えを証明できない）
  const indexFile = join(dir, '.git/agent-review/index.json');
  const index = JSON.parse(readFileSync(indexFile, 'utf-8'));
  for (const e of index.snapshots) delete e.untrackedHashes;
  writeFileSync(indexFile, JSON.stringify(index, null, 2));
  expectRefusal(/内容ハッシュがありません/);

  // manifest から鮮度の材料が欠けた場合
  const manifestFile = join(dir, '.git/agent-review', snapshot.snapshotId, 'manifest.json');
  const m = JSON.parse(readFileSync(manifestFile, 'utf-8'));
  delete m.headSha;
  writeFileSync(manifestFile, JSON.stringify(m, null, 2));
  expectRefusal(/鮮度を証明できません/);
});

// seq を振る記録の一部だけを走査すると、異なるレコードに同じ seq が付き、seq を参照する
// 関係（エスカレーションの消化判定・Tier 強化後の再評価）が別のレコードを指す
test('プロトタイプ鎖キーは閉じた語彙の検証を素通りしない（angle / mode / Tier 名）', () => {
  for (const key of ['__proto__', 'constructor', 'toString', 'valueOf']) {
    // 空集合へ倒すと「必須系統なし」＝ converged: true になり、壊れた state が
    // 全レビュー完了として通る（fail-open）。fail-loud であることまで確認する
    assert.throws(
      () => anglesForTierName(key),
      /未知の Tier 宣言名です/,
      `anglesForTierName(${key}) は空集合へ倒さず拒否する`,
    );
    assert.throws(
      () => recordRun(emptyState(), { angle: 'quality', mode: key, fresh: true, snapshotId: 's1' }),
      /未知のレビューモードです/,
      `mode=${key} は1段目の語彙検証で落とす（2段目に頼らない）`,
    );
  }
});

// ---------------------------------------------------------------------------
// 系統ごとの再探索基準（last successful run snapshot → current）
//
// 再探索トリガー表が「直前 snapshot からの修正差分」だけを見ると、ある snapshot の起動提案を
// 実行せず次へ進んだ場合に、その hop の変更をその系統が一度も見ないまま収束できる。
// 基準を**その系統が最後にレビューした snapshot**にすることで塞ぐ（永続 state は増やさない）。
// ---------------------------------------------------------------------------

test('計画: 見送った hop の変更は、予算で起動しない round でも未確認として残る（外部レビュー Codex P1 / 内部 仕様・敵対的・運用性）', () => {
  const state = emptyState();
  const code = [file('src/lib/writingRules.js')];
  const docsOnly = [file('docs/history.md')];

  // 各 hop で何が変わったか。累積差分はこの範囲 (from, to] の和になる
  const hops = { s2: code, s3: docsOnly };
  const order = ['s1', 's2', 's3'];
  const resolveChangedSince = (from, to) => {
    const files = order
      .slice(order.indexOf(from) + 1, order.indexOf(to) + 1)
      .flatMap((id) => hops[id] ?? []);
    return { files, guardChange: false, semanticDocChange: false };
  };
  const plan = (snapshot) => planCommand(state, snapshot, { resolveChangedSince });
  const record = (snapshot, angle) =>
    recordPlanned(state, snapshot, angle, {}, resolveChangedSince);

  // s1: 全系統を実施して収束させる
  const s1 = snap({ snapshotId: 's1', files: code });
  for (let i = 0; i < 8; i += 1) {
    const p = plan(s1);
    if (p.converged) break;
    for (const e of p.entries.filter((x) => x.run)) record(s1, e.angle);
  }
  assert.equal(plan(s1).converged, true, '前提: s1 で全系統が1回ずつ実施された');

  // s2: コードを再修正（この hop はどの系統も見ていない）
  const s2 = snap({ snapshotId: 's2', previousSnapshotId: 's1', files: code });
  const body = ['riskmodel', 'adversarial', 'quality'];
  assert.equal(plan(s2).entries.filter((e) => e.run).length, 0, '予算を使い切っている');

  // s3: 無関係な docs だけを直した新しい snapshot（直前 hop だけを見ればトリガーは立たない）
  const s3 = snap({
    snapshotId: 's3',
    previousSnapshotId: 's2',
    files: [...code, ...docsOnly],
    changedInFix: docsOnly,
  });
  const s3plan = plan(s3);
  for (const a of body) {
    const e = s3plan.entries.find((x) => x.angle === a);
    // **fail-closed のフォールバックで残ったのでは意味がない** — 累積差分を実際に解決した
    // うえで、その範囲のコード変更がトリガーを立てたことを固定する
    assert.deepEqual(
      e.baseline,
      { snapshotId: 's1', range: '累積' },
      `${a} は s1（この観点が最後に complete した snapshot）以降の累積差分で判定される`,
    );
    assert.equal(
      e.budgetOutcome,
      'exhausted',
      `${a} は s1→s2 のコード変更を一度も見ていない。予算で見送るが「実施済み」にはしない`,
    );
    assert.match(e.withheld.reason, /code/, `${a} の要求理由は累積範囲のコード変更`);
    assert.equal(
      e.withheld.mode,
      'full-rescan',
      '累積範囲は修正差分に収まらないので成果物を覆うモードへ',
    );
    assert.ok(
      s3plan.entries.some((x) => x.angle === a && x.budgetOutcome === 'exhausted'),
      `${a} の未確認範囲が人間判断の列挙に出る（これが本 PR で維持する安全性そのもの）`,
    );
  }
  // 基準は系統ごとに「最後に complete した snapshot」。s2 は誰も起動していないので
  // 減算も同じく s1 が基準になる（直前 hop へ縮めない）
  assert.deepEqual(s3plan.entries.find((e) => e.angle === 'subtractive').baseline, {
    snapshotId: 's1',
    range: '累積',
  });

  // 人間が予算を割り当てれば、その系統だけが実際に起動する
  escalateAngles(state, { angles: ['adversarial'], reason: '未確認の累積差分を確認する' });
  const granted = plan(s3);
  assert.deepEqual(
    granted.entries.filter((e) => e.run).map((e) => e.angle),
    ['adversarial'],
  );
  record(s3, 'adversarial');
  assert.ok(
    state.runs.some((r) => r.angle === 'adversarial' && r.snapshotId === 's3'),
    '割り当てた予算で s1→s2 の変更が実際に確認される',
  );
});

test('計画: 最終レビュー以降の変更がその観点のトリガーに触れていなければ再起動しない（過剰起動を作らない）', () => {
  const state = lightState();
  const code = [file('src/lib/writingRules.js')];
  settleSubtractive(state, 's1');
  for (const a of anglesForTierName('Light')) {
    if (a !== 'subtractive') {
      recordRun(state, { angle: a, mode: 'full-rescan', fresh: true, snapshotId: 's1' });
    }
  }
  // s1 が基準のまま、修正差分が docs だけの snapshot。operability 等のトリガーは立たない
  const docsOnly = [file('docs/history.md')];
  const plan = buildPlan({
    state,
    manifest: manifest({ snapshotId: 's2', previousSnapshotId: 's1' }),
    changedFiles: [...code, ...docsOnly],
    changedInFix: docsOnly,
  });
  const quality = plan.entries.find((e) => e.angle === 'quality');
  assert.equal(quality.run, false, '基準以降の変更がトリガーに触れなければ起動しない');
  assert.match(quality.reason, /義務は満たされている/);
});

test('計画: 基準 snapshot の差分を解決できない場合は fail-closed（直前 snapshot へ縮めない）', () => {
  const state = lightState();
  const code = [file('src/lib/writingRules.js')];
  settleSubtractive(state, 's3');
  recordRun(state, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's1' });

  // quality の基準は s1 だが、この snapshot の直前は s2（＝ s1→s3 の差分が要る）。
  // 解決手段が無い / 解決に失敗する場合は全体再探索を要求する（＝予算があれば起動する）
  const args = {
    state,
    manifest: manifest({ snapshotId: 's3', previousSnapshotId: 's2' }),
    changedFiles: code,
    changedInFix: [],
  };
  for (const [label, resolver] of [
    ['解決手段が無い', null],
    [
      'prune 済みで解決に失敗する',
      () => {
        throw new Error('snapshot=s1 の commit が既に到達不能です');
      },
    ],
  ]) {
    const plan = buildPlan({ ...args, resolveChangedSince: resolver });
    const e = plan.entries.find((x) => x.angle === 'quality');
    assert.deepEqual(e.baseline, { snapshotId: 's1', range: '解決不能' }, label);
    // 予算を使い切っているので自動では起動しない。**しかし「解決できないので実施済み」へは
    // 倒さない** — 要求内容を保持して人間判断へ返す
    assert.equal(e.budgetOutcome, 'exhausted', label);
    assert.equal(e.withheld.mode, 'full-rescan', `${label}: 範囲が不明なので全体再探索`);
    assert.equal(e.withheld.fresh, true, label);
    assert.match(e.withheld.reason, /確認できない/, label);
    assert.ok(
      plan.entries.some((x) => x.angle === 'quality' && x.budgetOutcome === 'exhausted'),
      `${label}: 最も安全側に倒すべき系統が人間判断の列挙から漏れてはいけない`,
    );
  }
});

test('計画: 基準 snapshot からの累積差分でトリガーを判定する（解決できる場合）', () => {
  const state = lightState();
  const code = [file('src/lib/writingRules.js')];
  settleSubtractive(state, 's3');
  recordRun(state, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's1' });

  // 直前 hop（s2→s3）は docs だけだが、基準（s1）からの累積ではコードが動いている
  const plan = buildPlan({
    state,
    manifest: manifest({ snapshotId: 's3', previousSnapshotId: 's2' }),
    changedFiles: code,
    changedInFix: [file('docs/history.md')],
    resolveChangedSince: (from, to) => {
      assert.equal(from, 's1', 'その系統が最後にレビューした snapshot を基準にする');
      assert.equal(to, 's3');
      return { files: code, guardChange: false, semanticDocChange: false };
    },
  });
  const quality = plan.entries.find((e) => e.angle === 'quality');
  // 予算を使い切っているので自動では起動しないが、**累積差分の判定結果は残る** —
  // ここを「トリガー非該当」に畳むと、s1→s2 のコード変更を誰も見ないまま収束できてしまう
  assert.equal(quality.budgetOutcome, 'exhausted');
  assert.match(quality.withheld.reason, /code/, '起動理由は累積範囲のコード変更');
  // 差分探索の成果物は previous-to-current.patch（docs 1行）で、根拠になった s1→s2 の
  // コード変更を含まない。判定範囲を覆うモードへ引き上げたうえで見送る
  assert.equal(
    quality.withheld.mode,
    'full-rescan',
    '判定範囲を覆う成果物を持つモードへ引き上げる',
  );
  // 判定に使った範囲が成果物に出ないと、読み手は `シグナル:`（直前 hop の docsOther）と
  // 理由（累積の code）の食い違いを計画のバグと誤読する
  assert.deepEqual(quality.baseline, { snapshotId: 's1', range: '累積' });
  assert.deepEqual(
    plan.entries.find((e) => e.angle === 'subtractive').baseline,
    { snapshotId: 's3', range: '直前' },
    '直前 hop で判定した系統も「どの範囲で判定したか」を名指しする（null へ潰さない）',
  );
});

test('計画: 累積差分は直前 hop の修正差分を必ず含む（狭める方向へ倒さない）', () => {
  const state = lightState();
  settleSubtractive(state, 's3');
  recordRun(state, { angle: 'quality', mode: 'full-rescan', fresh: true, snapshotId: 's1' });

  // commit 差分からは何も見えない（untracked / skip-worktree / submodule 未具現化など、
  // snapshot commit に載らない変更しかない round）。それでも直前 hop の修正差分は非空
  const plan = buildPlan({
    state,
    manifest: manifest({ snapshotId: 's3', previousSnapshotId: 's2' }),
    changedFiles: [file('src/lib/writingRules.js')],
    changedInFix: [file('src/lib/writingRules.js', { status: 'U' })],
    resolveChangedSince: () => ({ files: [], guardChange: false, semanticDocChange: false }),
  });
  const quality = plan.entries.find((e) => e.angle === 'quality');
  assert.equal(
    quality.budgetOutcome,
    'exhausted',
    '累積が空でも直前 hop のコード変更でトリガーは立つ（和で合成する）',
  );
  assert.ok(quality.withheld.mode, '要求内容を保持する');
  assert.ok(plan.entries.some((x) => x.angle === 'quality' && x.budgetOutcome === 'exhausted'));
});

test('計画: 累積差分の再計算が manifest の fail-closed シグナルを降格させない', () => {
  const state = lightState();
  settleSubtractive(state, 's3');
  recordRun(state, { angle: 'adversarial', mode: 'full-rescan', fresh: true, snapshotId: 's1' });

  // unreportedPaths（skip-worktree 等）由来で manifest 側は「ガード変更なしと証明できない」。
  // commit 差分から再計算した false でこれを上書きすると、無効化したガードが素通りする
  const plan = buildPlan({
    state,
    manifest: manifest({ snapshotId: 's3', previousSnapshotId: 's2', guardChangeInFix: true }),
    changedFiles: [file('scripts/agent/guard.js')],
    changedInFix: [],
    resolveChangedSince: () => ({ files: [], guardChange: false, semanticDocChange: false }),
  });
  const adversarial = plan.entries.find((e) => e.angle === 'adversarial');
  assert.equal(adversarial.budgetOutcome, 'exhausted', 'guard は adversarial の全体再探索トリガー');
  assert.equal(adversarial.withheld.mode, 'full-rescan');
  assert.ok(
    plan.entries.some((x) => x.angle === 'adversarial' && x.budgetOutcome === 'exhausted'),
    '降格させないことは、予算で見送る場合も人間判断として見えていなければ意味がない',
  );
});

test('loadState: seq が整数でない記録は fail-loud（採番と baseline で受理集合を割らない）', (t) => {
  const dir = makeStateDir(t);
  const file2 = stateFile(dir);
  mkdirSync(dirname(file2), { recursive: true });
  // nextSeq は文字列 seq を無視して採番するので、latestRunOf が生の比較で受理すると
  // この偽記録を正規の run が追い越せず baseline が恒久固定される
  const state = emptyState();
  state.runs.push({
    seq: '999999',
    angle: 'adversarial',
    mode: 'full-rescan',
    fresh: true,
    status: 'complete',
    snapshotId: 's9',
  });
  writeFileSync(file2, JSON.stringify(state));
  assert.throws(() => loadState(dir), /seq は 0 以上の安全な整数/);

  // 2^53 以上は Number.isInteger を通るが nextSeq の `max + 1` が飽和して同じ値へ戻るため、
  // 以後どの正規の記録も追い越せない（型ではなく値域で同じ恒久固定が成立する）
  const huge = emptyState();
  huge.runs.push({ ...state.runs[0], seq: Number.MAX_SAFE_INTEGER + 1 });
  writeFileSync(file2, JSON.stringify(huge));
  assert.throws(() => loadState(dir), /seq は 0 以上の安全な整数/);
});

test('loadState: runs の snapshotId が非文字列の記録は fail-loud（fail-closed を降格させない）', (t) => {
  const dir = makeStateDir(t);
  const file2 = stateFile(dir);
  mkdirSync(dirname(file2), { recursive: true });
  // snapshotId は累積判定の唯一のキー。null を通すと lastCompleteSnapshot が「完了記録なし」と
  // 同じ値を返し、全体再探索（fail-closed）ではなく直前 hop 判定へ降格して converged になる
  const state = emptyState();
  state.runs.push({
    seq: 1,
    angle: 'adversarial',
    mode: 'full-rescan',
    fresh: true,
    status: 'complete',
    snapshotId: null,
  });
  writeFileSync(file2, JSON.stringify(state));
  assert.throws(() => loadState(dir), /snapshotId は非空の文字列/);
});

test('loadState: tierWidenedSeq が整数でない state は fail-loud（恒久ループを作らない）', (t) => {
  const dir = makeStateDir(t);
  const file2 = stateFile(dir);
  mkdirSync(dirname(file2), { recursive: true });
  // 文字列だと `tierWidenedSeq >= 0` と `lastRunSeqOf(angle) < tierWidenedSeq` が常に true に
  // なり全系統を毎 round 再要求する一方、nextSeq は Number.isInteger で無視するので新しい
  // seq が追い越せない。出る辺の無い恒久ループになり、回復手段は state の手動削除だけ
  const state = emptyState();
  state.tierWidenedSeq = '999999';
  writeFileSync(file2, JSON.stringify(state));
  assert.throws(() => loadState(dir), /tierWidenedSeq は 0 以上の安全な整数/);
});

test('anglesForTierName: falsy な宣言名を空集合へ倒さない', () => {
  for (const bad of ['', 0, false, Number.NaN]) {
    assert.throws(() => anglesForTierName(bad), /未知の Tier 宣言名です/, `${JSON.stringify(bad)}`);
  }
  // 未設定と明示の「なし」だけが空集合
  assert.deepEqual(anglesForTierName(null), []);
  assert.deepEqual(anglesForTierName(undefined), []);
  assert.deepEqual(anglesForTierName('なし'), []);
});

test('計画: 作業キャッシュ削除で run 履歴が消えると、全系統が安全側に再要求される', () => {
  const code = [file('src/lib/writingRules.js')];
  const fresh = emptyState(); // cache 削除相当（runs が空）
  const plan = buildPlan({
    state: fresh,
    manifest: manifest({ snapshotId: 's3', previousSnapshotId: 's2' }),
    changedFiles: code,
    changedInFix: [],
  });
  assert.ok(plan.entries.length > 0);
  assert.ok(
    plan.entries.every((e) => e.dirty),
    'run 履歴が無いので基準も無く、全系統が未実施として要求される',
  );
  assert.equal(plan.converged, false);
});

test('計画: 未知の Tier 宣言名を持つ state は収束扱いにせず fail-loud する（外部レビュー Codex 指摘 P2）', () => {
  const state = emptyState();
  state.initialTier = 'constructor';
  state.effectiveTier = 'constructor';
  const changed = [file('src/lib/db.js')];
  assert.throws(
    () =>
      buildPlan({
        state,
        manifest: manifest(),
        changedFiles: changed,
        changedInFix: changed,
      }),
    /未知の Tier 宣言名です/,
    '必須系統が空集合になると entries:[] / stage:done / converged:true で素通りする',
  );
});

test('nextSeq: tierWidenedSeq も走査する（Tier 強化の seq が escalation と衝突しない）', () => {
  const state = emptyState();
  state.initialTier = 'Light';
  state.effectiveTier = 'Light';
  reclassifyTier(state, [file('src/lib/db.js')]); // 高リスク → Full へ widen
  assert.ok(Number.isInteger(state.tierWidenedSeq));
  assert.notEqual(
    state.tierWidenedSeq,
    state.escalations.at(-1).seq,
    'tierWidenedSeq を走査しないと、直後の escalation と必ず同じ seq が付く',
  );
});

test('nextSeq: seq を振るすべての記録を走査する（seq の衝突を作らない）', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];
  const snap1 = snap({ snapshotId: 's1', files: changed });
  simulatePlan(state, 's1', changed);
  recordPlanned(state, snap1, 'subtractive');
  escalateAngles(state, { angles: ['operability'], reason: '外部レビューの所見' });
  simulatePlan(state, 's1', changed);
  recordPlanned(state, snap1, 'operability');
  escalateAngles(state, { angles: ['quality'], reason: '別の外部所見' });
  simulatePlan(state, 's1', changed);
  recordPlanned(state, snap1, 'quality', { status: 'incomplete' });

  const seqs = [...state.runs, ...state.escalations].map((r) => r.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'seq が重複しない');
  assert.ok(state.runs.length > 2 && state.escalations.length > 1, '前提: 各記録が複数ある');
});

// 冪等な再実行は snapshot を読まない。ここで鮮度を要求すると、記録に成功した後に作業ツリーが
// 進んだだけで同じコマンドの再実行が失敗し、冪等性が担保するはずのリトライ安全性が失われる
// （その記録は最初に受理した時点で鮮度も計画一致も検証済み）
test('CLI: 完全同一の再記録は作業ツリーが進んでいても no-op、ただし snapshot が読めなければ fail-loud', (t) => {
  const dir = makePlanRepo(t);
  writeFileSync(join(dir, 'src.js'), 'export const a = 2;\n');
  execFileSync('git', ['commit', '-qam', 'f1'], { cwd: dir });
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snapshot = latestSnapshot(dir);
  runPlanCli(dir, ['plan']);
  const requested = plannedLaunches(emptyState(), snapshot)[0];
  const args = [
    'record-run',
    '--angle',
    requested.angle,
    '--mode',
    requested.mode,
    requested.fresh ? '--fresh' : '--continue',
    '--snapshot-id',
    snapshot.snapshotId,
    '--status',
    'complete',
  ];
  runPlanCli(dir, args);
  const runsAfterFirst = readPlanState(dir).runs.length;

  // 記録後に作業ツリーが進む（snapshot は古くなる）
  writeFileSync(join(dir, 'src.js'), 'export const a = 3;\n');

  // それでも完全同一の再実行は通り、台帳も増えない
  runPlanCli(dir, args);
  assert.equal(readPlanState(dir).runs.length, runsAfterFirst, '二重に記録しない');

  // ただし snapshot 成果物が読めなくなったら no-op にはせず fail-loud する。同一 identity でも
  // `escalate` / Tier 強化が同じ起動を再要求している最中かもしれず、計画を再計算できない以上
  // 「重複」と断定できない（断定すると記録成功を表示したままエスカレーションが未消化で残る）
  rmSync(join(dir, '.git/agent-review', snapshot.snapshotId), { recursive: true, force: true });
  assert.throws(
    () => runPlanCli(dir, args),
    (err) => {
      assert.match(`${err.stdout ?? ''}${err.stderr ?? ''}`, /受理できません|ありません/);
      return true;
    },
  );
  assert.equal(readPlanState(dir).runs.length, runsAfterFirst, '拒否されても記録は増えない');

  // 一方、**別の結果**での再記録は鮮度検証を通るので拒否される
  assert.throws(
    () => runPlanCli(dir, [...args.slice(0, -1), 'error']),
    (err) => {
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      assert.match(out, /受理できません|一致しません|異なる結果/);
      return true;
    },
  );
});

// 「収束していないのに次にできる行動が1つも無い」は恒久停止であって計画ではない。
// #203 / #205 / #206 はいずれもこの形（症状＝どのブロック条件か、だけが違う）だったので、
// 個別のブロック条件ごとに解除経路を人手で確かめるのではなく状態そのものを検査する
test('計画: 収束していない限り、次にできる行動を必ず1つ以上示す', () => {
  const state = lightState();
  const changed = [file('src/lib/writingRules.js')];

  // 初回（全系統が未達）
  let plan = simulatePlan(state, 's1', changed);
  assert.equal(plan.converged, false);
  assert.ok(plan.nextActions.length > 0, '起動提案があるはず');

  // escalate で段階が戻った直後も、次にできる行動が必ず出る
  escalateAngles(state, { angles: ['operability'], reason: '外部レビューの所見' });
  plan = simulatePlan(state, 's1', changed);
  assert.equal(plan.converged, false);
  assert.ok(plan.nextActions.length > 0);

  assert.ok(
    plan.nextActions.some((a) => /record-run/.test(a) && /review:snapshot/.test(a)),
    '未消化の起動には、記録経路と（鮮度違反時の）やり直し経路が対になる',
  );
});

// 鮮度違反で record-run が拒否される状態は、計画側にも脱出経路が現れなければならない
test('計画: 起動の行動には鮮度違反時のやり直し経路を併記する', () => {
  const state = lightState();
  const plan = simulatePlan(state, 's1', [file('src/lib/writingRules.js')]);
  assert.ok(
    plan.entries.some((e) => e.run),
    '前提: 起動提案がある',
  );
  assert.ok(
    plan.nextActions.some((a) => /record-run/.test(a) && /review:snapshot/.test(a)),
    '拒否されたときに打てる手を同じ行動に含める',
  );
});

// 鮮度検証は git diff だけで tracked を見ると、index の抑止フラグが立った改変を
// 「変わっていない」と断定する。createSnapshot は同じ機構を fail-closed に倒しているので、
// 受理集合が逆向きに乖離する（敵対的レビューで実測）
test('freshness: index の抑止フラグが立っていたら鮮度を証明できないとして拒否する', async (t) => {
  const { createSnapshot, snapshotFreshness, latestSnapshot } =
    await import('../scripts/agent/review-snapshot.js');
  const dir = makePlanRepo(t);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap = latestSnapshot(dir);
  assert.equal(snapshotFreshness(snap, dir).fresh, true, '前提: 取った直後は fresh');

  // 対照: 素の改変は stale として検出される
  const original = readFileSync(join(dir, 'src.js'), 'utf-8');
  writeFileSync(join(dir, 'src.js'), `${original}// edited\n`);
  assert.equal(snapshotFreshness(snap, dir).fresh, false);
  writeFileSync(join(dir, 'src.js'), original);

  // 抑止フラグを立てて隠すと、git diff は何も報告しない
  execFileSync('git', ['update-index', '--assume-unchanged', 'src.js'], { cwd: dir });
  writeFileSync(join(dir, 'src.js'), `${original}// hidden\n`);
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' }).trim(),
    '',
    '前提: status は空（git が報告を止めている）',
  );
  assert.throws(
    () => snapshotFreshness(snap, dir),
    /鮮度を証明できません/,
    '証明できない以上は fresh と断定しない',
  );
});

// CLI が `changedFilesBetween` を計画へ配線していることを固定する結合テスト。
// 単体テストの `resolveChangedSince` はすべてスタブなので、**配線を丸ごと削っても
// 全テストが通る**状態だった（最終独立レビュー P2-1 が実測）。実 CLI・実 git で
// 「見送った hop の変更が次の計画に累積として現れる」ところまで通す。
test('CLI: 見送った hop の変更が累積差分として次の計画に現れる（changedFilesBetween の配線）', (t) => {
  const dir = makePlanRepo(t);
  const commit = (rel, body, msg) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', msg], { cwd: dir });
  };

  // s1: 全系統をこの snapshot で実施して収束させる
  commit('src/a.js', 'export const a = 2;\n', 'c1');
  const s1 = createSnapshot({ cwd: dir, baseRef: 'main' });
  for (let i = 0; i < 8; i += 1) {
    const state = loadState(dir);
    const entries = plannedLaunches(state, latestSnapshot(dir));
    if (entries.length === 0) break;
    for (const e of entries) {
      runPlanCli(dir, [
        'record-run',
        '--angle',
        e.angle,
        '--mode',
        e.mode,
        ...(e.fresh ? ['--fresh'] : []),
        '--status',
        'complete',
      ]);
    }
  }
  assert.equal(plannedLaunches(loadState(dir), latestSnapshot(dir)).length, 0, '前提: s1 で収束');

  // s2: コードを変更するが、起動せずに次へ進む
  commit('src/b.js', 'export const b = /^[a-z]+$/;\n', 'c2');
  createSnapshot({ cwd: dir, baseRef: 'main' });

  // s3: 無関係な docs だけ。直前 hop だけを見れば本体系統のトリガーは立たない
  commit('docs/history.md', '# 履歴\n\nメモ\n', 'c3');
  const s3 = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(s3.manifest.previousSnapshotId.startsWith('0002-'), true);

  const out = runPlanCli(dir, ['plan']);
  // 配線が無いと baseline が解決できず「差分の解決手段が無い」で fail-closed に倒れる。
  // 倒れても人間判断には出るので、**累積として解決できたこと**まで見ないと配線を固定できない
  assert.match(out, /累積差分で判定した系統/, 'CLI が累積差分を解決して計画へ反映している');
  assert.doesNotMatch(out, /差分の解決手段が無い/, 'fail-closed のフォールバックへ落ちていない');
  assert.match(
    out,
    new RegExp(`${s1.snapshotId} 以降`),
    '基準は s1（最後に complete した snapshot）',
  );
  // 予算で見送った未確認範囲が、収束の顔で隠れず人間判断として出る
  assert.match(out, /予算終了（人間判断が要る/);
  assert.match(out, new RegExp(`未確認範囲: ${s1.snapshotId} 以降の累積差分`));
  assert.match(out, /予算が無ければ要求していた探索: 全体再探索/);

  // API 経由でも同じ範囲が解決できる（CLI の表示だけに依存しない配線の固定）
  const since = changedFilesBetween(dir, s1.snapshotId, s3.snapshotId);
  assert.ok(
    since.files.some((f) => f.path === 'src/b.js'),
    '見送った hop の変更が累積差分に載る',
  );
});

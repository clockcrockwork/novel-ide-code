import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ANGLE_EXEC_BASELINE,
  ANGLE_TRIGGERS,
  CHANGE_SIGNALS,
  HIGH_RISK_PATTERNS,
  NON_ANGLE_EXEC_BASELINE,
  REVIEW_MODES,
  ALL_ANGLE_KEYS,
  inspectEffectiveConfig,
  parseFrontmatter,
  resolveExecConfig,
} from '../scripts/agent/review-exec-config.js';

// prose（review-angles/README.md・second-opinion-review.md）と機械側（review-exec-config.js・
// .claude/agents/review-*.md の frontmatter）の drift 検査。
// 実行設定・トリガーは「文書に書いてあるが実装されていない」が最も起きやすい箇所なので、
// 片方だけの更新をテストで落とす（reviewAngleTokens.test.js と同じ思想）。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(join(ROOT, 'docs/agent-workflows/review-angles/README.md'), 'utf-8');

test('観点キーの集合が一致する（ANGLE_TRIGGERS = ANGLE_EXEC_BASELINE = 7系統＋条件起動）', () => {
  assert.deepEqual(Object.keys(ANGLE_TRIGGERS).sort(), [...ALL_ANGLE_KEYS].sort());
  assert.deepEqual(Object.keys(ANGLE_EXEC_BASELINE).sort(), [...ALL_ANGLE_KEYS].sort());
});

test('トリガー表のシグナル名が CHANGE_SIGNALS の閉じた語彙に収まる', () => {
  for (const [angle, trig] of Object.entries(ANGLE_TRIGGERS)) {
    for (const s of [...trig.exploreSignals, ...trig.fullRescanSignals]) {
      assert.ok(
        CHANGE_SIGNALS.includes(s),
        `観点「${angle}」のトリガーに未知のシグナル「${s}」があります（CHANGE_SIGNALS に追加するか綴りを直す）`,
      );
    }
  }
});

test('README にレビューモード3種の見出しと各ラベルが存在する（drift 検査）', () => {
  assert.ok(README.includes('## レビューモード'), 'README に「レビューモード」節がない');
  for (const def of Object.values(REVIEW_MODES)) {
    assert.ok(README.includes(def.label), `モード「${def.label}」が README にない`);
  }
});

test('README に再探索トリガー・実効 Tier・継続/リフレッシュ・実行設定・計測の節がある（drift 検査）', () => {
  for (const heading of [
    '## 観点別の再探索トリガー',
    '## 実効 Tier の更新',
    '## レビュアーの継続とリフレッシュ',
    '## 共通成果物（snapshot',
    '## 実行設定',
    '## 計測',
  ]) {
    assert.ok(README.includes(heading), `README に「${heading}」節がない`);
  }
});

test('一律 low effort ではない: 探索系の観点は high effort、全観点で effort が明示される', () => {
  const efforts = new Set(Object.values(ANGLE_EXEC_BASELINE).map((c) => c.effort));
  assert.ok(
    !efforts.has('low'),
    'レビュアーに low effort を割り当てない（探索能力が結果を決める）',
  );
  for (const angle of ['subtractive', 'spec', 'adversarial', 'operability']) {
    assert.equal(
      ANGLE_EXEC_BASELINE[angle].effort,
      'high',
      `高リスク観点「${angle}」は high effort であること`,
    );
  }
  for (const [angle, cfg] of Object.entries(ANGLE_EXEC_BASELINE)) {
    assert.ok(
      ['low', 'medium', 'high', 'xhigh', 'max'].includes(cfg.effort),
      `${angle}: 未知の effort`,
    );
    assert.ok(
      Number.isInteger(cfg.maxTurns) && cfg.maxTurns > 0,
      `${angle}: maxTurns が整数でない`,
    );
    assert.ok(['haiku', 'sonnet', 'opus', 'fable'].includes(cfg.model), `${angle}: 未知の model`);
  }
});

test('所見確認では model を引き下げるが、敵対的は引き下げない（騙し耐性）', () => {
  assert.equal(resolveExecConfig('spec', 'findings-check').model, 'sonnet');
  assert.equal(resolveExecConfig('spec', 'full-rescan').model, 'opus');
  assert.equal(resolveExecConfig('adversarial', 'findings-check').model, 'opus');
});

test('エスカレーション時は所見確認でも model を引き下げない', () => {
  assert.equal(resolveExecConfig('spec', 'findings-check', { escalated: true }).model, 'opus');
});

test('未知の観点・モードは例外にする（黙って既定値へ落とさない）', () => {
  assert.throws(() => resolveExecConfig('unknown-angle', 'full-rescan'), /未知の観点/);
  assert.throws(() => resolveExecConfig('spec', 'unknown-mode'), /未知のレビューモード/);
});

test('.claude/agents/review-*.md の frontmatter が実行設定表と一致する（drift 検査）', () => {
  const { errors, entries } = inspectEffectiveConfig(ROOT, {});
  assert.deepEqual(errors, [], `frontmatter drift:\n${errors.join('\n')}`);
  assert.equal(
    entries.length,
    Object.keys(ANGLE_EXEC_BASELINE).length + Object.keys(NON_ANGLE_EXEC_BASELINE).length,
  );
});

test('観点レビュアーは Agent ツールを持たない（オーケストレーションの兼務禁止）', () => {
  const { entries } = inspectEffectiveConfig(ROOT, {});
  for (const e of entries) {
    assert.ok(e.actual.tools, `${e.file}: tools キーが必要（キー不在＝全ツール継承）`);
    assert.ok(!/\bAgent\b/.test(e.actual.tools), `${e.file}: tools に Agent を含めない`);
  }
});

test('全レビュアーが incomplete 契約を本文に持つ（maxTurns 到達を所見ゼロにしない）', () => {
  const { entries } = inspectEffectiveConfig(ROOT, {});
  for (const e of entries) {
    const text = readFileSync(join(ROOT, '.claude/agents', e.file), 'utf-8');
    assert.ok(
      text.includes('未完了: incomplete'),
      `${e.file}: incomplete 契約（未完了宣言）が本文にない`,
    );
  }
});

test('環境変数による frontmatter 上書きを検出して報告する', () => {
  const { envOverrides } = inspectEffectiveConfig(ROOT, {
    CLAUDE_CODE_SUBAGENT_MODEL: 'haiku',
  });
  assert.ok(
    envOverrides.some((o) => o.includes('CLAUDE_CODE_SUBAGENT_MODEL')),
    'CLAUDE_CODE_SUBAGENT_MODEL は frontmatter の model より優先されるため報告が必要',
  );
  assert.deepEqual(inspectEffectiveConfig(ROOT, {}).envOverrides, []);
});

test('高リスク領域の列挙が second-opinion-review.md の対象と対応する（drift 検査）', () => {
  const soc = readFileSync(join(ROOT, 'docs/agent-workflows/second-opinion-review.md'), 'utf-8');
  // §1 の6カテゴリが機械判定側に1つ以上のパターンとして落ちていることを確認する
  const samples = {
    editor: 'src/lib/tiptap/RubyMark.js',
    persistence: 'src/lib/db.js',
    sync: 'src/lib/sync.js',
    security: 'scripts/gh/post-reply.sh',
    performance: 'src/lib/markdown.js',
  };
  for (const [name, path] of Object.entries(samples)) {
    assert.ok(
      HIGH_RISK_PATTERNS.some((re) => re.test(path)),
      `高リスク領域「${name}」の代表パス ${path} が HIGH_RISK_PATTERNS に一致しない`,
    );
  }
  assert.ok(
    soc.includes('高リスク変更のみ'),
    'second-opinion-review.md の §1 見出しが変わっている',
  );
});

test('parseFrontmatter: frontmatter が無いファイルは null を返す', () => {
  assert.equal(parseFrontmatter('# just markdown\n'), null);
  assert.deepEqual(
    { ...parseFrontmatter('---\nname: x\nmodel: opus\n---\nbody') },
    {
      name: 'x',
      model: 'opus',
    },
  );
});

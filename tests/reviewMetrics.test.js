import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  OBTAINABLE_METRICS,
  UNOBTAINABLE_METRICS,
  formatSummary,
  metricsFile,
  readAll,
  record,
  summarize,
} from '../scripts/agent/review-metrics.js';
import { makeTmpGitRepo, sh, write } from './helpers/tmpGitRepo.js';

function makeRepo() {
  const dir = makeTmpGitRepo('review-metrics-');
  write(dir, 'a.txt', 'a\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'init']);
  return dir;
}

test('取得可能な指標のみ記録し、未知のキーは落とす', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const row = record(
    {
      snapshotId: '0001-abc',
      angle: 'adversarial',
      mode: 'full-rescan',
      fresh: true,
      model: 'opus',
      effort: 'high',
      maxTurns: 60,
      status: 'complete',
      durationMs: 12000,
      newFindings: 2,
      // 取得不能な指標は記録対象外（独自計測基盤を足さない方針の明示）
      tokens: 12345,
      turns: 7,
    },
    dir,
  );
  assert.equal(row.angle, 'adversarial');
  assert.equal(row.tokens, undefined);
  assert.equal(row.turns, undefined);
  assert.ok(row.at, 'タイムスタンプは常に付ける');
  assert.equal(readAll(dir).length, 1);
  assert.ok(metricsFile(dir).endsWith(join('.git', 'agent-review', 'metrics.jsonl')));
});

test('未知の観点・モードは受理しない（閉じた語彙）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => record({ angle: 'nope', mode: 'full-rescan' }, dir), /未知の観点/);
  assert.throws(() => record({ angle: 'spec', mode: 'nope' }, dir), /未知のレビューモード/);
});

test('条件起動系統（記憶適合）も記録できる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(record({ angle: 'memory', mode: 'diff-explore' }, dir).angle, 'memory');
});

test('集計: 起動数・fresh/継続・モード別・所見・未完了・エスカレーションを出す', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  record(
    { angle: 'subtractive', mode: 'full-rescan', fresh: true, newFindings: 1, durationMs: 1000 },
    dir,
  );
  record({ angle: 'subtractive', mode: 'findings-check', fresh: false, confirmedFindings: 1 }, dir);
  record({ angle: 'adversarial', mode: 'full-rescan', fresh: true, status: 'incomplete' }, dir);
  record(
    { angle: 'spec', mode: 'full-rescan', fresh: true, externalFindings: 2, escalation: true },
    dir,
  );

  const s = summarize(readAll(dir));
  assert.equal(s.invocations, 4);
  assert.equal(s.fresh, 3);
  assert.equal(s.continued, 1);
  assert.equal(s.byAngle.subtractive, 2);
  assert.equal(s.byMode['full-rescan'], 3);
  assert.equal(s.byMode['findings-check'], 1);
  assert.equal(s.incomplete, 1);
  assert.equal(s.newFindings, 1);
  assert.equal(s.confirmedFindings, 1);
  assert.equal(s.externalFindings, 2);
  assert.equal(s.escalations, 1);
  assert.equal(s.durationMs, 1000);
});

test('レポートは取得不能な指標を明示する（取れない値を取れたことにしない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const text = formatSummary(summarize(readAll(dir)));
  assert.match(text, /取得不能な指標/);
  for (const key of Object.keys(UNOBTAINABLE_METRICS)) {
    assert.ok(text.includes(key), `取得不能な指標「${key}」がレポートに出ていない`);
  }
  assert.ok(
    !OBTAINABLE_METRICS.some((k) => k in UNOBTAINABLE_METRICS),
    '取得可否の分類が重複している',
  );
});

test('記録ファイルが無い状態でも集計できる（空レポート）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readAll(dir), []);
  assert.equal(summarize([]).invocations, 0);
});

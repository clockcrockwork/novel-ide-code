import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

import {
  formatDate,
  dateCompact,
  parseArgs,
  normalizeRecord,
  detectSecrets,
  validateFieldGrammar,
  classifyLinkState,
  linkVerdict,
  reachesSelf,
  validateLinks,
  validateAll,
  globMatch,
  isValidCalendarDate,
  isActive,
  matchQuery,
  applyFilters,
  buildIdReservation,
  searchRecords,
  formatResults,
  SCOPE_VOCAB,
  LINK_TABLE,
} from '../scripts/agent-memory.js';
import { AREA_KEYWORDS } from '../scripts/analyze-pr-history.js';
import { CONTROL_ONLY_DIRS } from '../scripts/policy/public-tree-policy.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../scripts/agent-memory.js');

function makeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentmem-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRec(dir, record) {
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2));
}

function runRaw(dir, args, extraEnv = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, AGENT_MEMORY_DIR: dir, ...extraEnv },
  });
}

// promote / reject / retire / supersede / purge は --endorsed-by が必須（設計 §6.0。#532）。
// 個々のテストの主題は遷移そのものなので endorse はここで補い、必須性は専用テストで検査する。
const ENDORSE_COMMANDS = new Set(['promote', 'reject', 'retire', 'supersede', 'purge']);

function run(dir, args, extraEnv = {}) {
  const needsEndorse = ENDORSE_COMMANDS.has(args[0]) && !args.includes('--endorsed-by');
  return runRaw(dir, needsEndorse ? [...args, '--endorsed-by', 'human'] : args, extraEnv);
}

// 最小妥当レコード（no errors）。over で上書き。
function rec(over = {}) {
  return {
    id: 'mem-20260101-aaaaaa',
    createdAt: '2026-01-01',
    kind: 'decision',
    status: 'accepted',
    visibility: 'control',
    scope: ['github-sync'],
    title: 'タイトル',
    summary: '要約',
    sources: ['issue#1'],
    author: 'claude',
    ...over,
  };
}

function indexOf(records) {
  const idx = Object.create(null);
  for (const r of records) idx[r.id] = normalizeRecord(r);
  return idx;
}

// ---- 日付・引数 ----

test('formatDate: ローカル日付を YYYY-MM-DD で組む（UTC slice を使わない）', () => {
  assert.equal(formatDate(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(dateCompact(new Date(2026, 6, 18)), '20260718');
});

test('parseArgs: command / 値フラグ / 真偽フラグ / 位置引数', () => {
  const p = parseArgs(['search', '同期 競合', '--scope', 'github-sync', '--all']);
  assert.equal(p.command, 'search');
  assert.deepEqual(p.positionals, ['同期 競合']);
  assert.equal(p.flags.scope, 'github-sync');
  assert.equal(p.flags.all, true);
});

test('parseArgs: 真偽フラグが後続の位置引数を値として吸わない', () => {
  const p = parseArgs(['search', '--all', 'クエリ']);
  assert.equal(p.flags.all, true);
  assert.deepEqual(p.positionals, ['クエリ']);
});

test('parseArgs: --key=value 構文で -- を含む値を渡せる（空白区切りと共存）', () => {
  const p = parseArgs(['add', '--title=--scope の値欠落', '--summary', 's']);
  assert.equal(p.flags.title, '--scope の値欠落');
  assert.equal(p.flags.summary, 's');
});

test('parseArgs: 真偽フラグに --key=value 構文を使うと fail-loud（--all=true が文字列化して黙って無効化されるのを防ぐ）', () => {
  assert.throws(() => parseArgs(['search', 'q', '--all=true']), /--all は値を取りません/);
  assert.throws(() => parseArgs(['search', 'q', '--any=false']), /--any は値を取りません/);
});

test('parseArgs: 真偽フラグの通常構文（値なし）は引き続き動作する', () => {
  const p = parseArgs(['search', 'q', '--all']);
  assert.equal(p.flags.all, true);
});

test('parseArgs: 単独 -- 以降は常に位置引数（-- 始まりのクエリ語も渡せる）', () => {
  const p = parseArgs(['search', '--', '--path', '--format']);
  assert.equal(p.command, 'search');
  assert.deepEqual(p.positionals, ['--path', '--format']);
  assert.deepEqual(p.flags, Object.create(null));
});

test('parseArgs: -- の前のフラグは通常どおり解釈される', () => {
  const p = parseArgs(['search', '--scope', 'github-sync', '--', '--path']);
  assert.equal(p.flags.scope, 'github-sync');
  assert.deepEqual(p.positionals, ['--path']);
});

// ---- 文法検査 ----

test('validateFieldGrammar: 最小妥当はエラーなし', () => {
  assert.deepEqual(validateFieldGrammar(rec()).errors, []);
});

test('validateFieldGrammar: 未知フィールドはエラー', () => {
  const { errors } = validateFieldGrammar(rec({ bogus: 1 }));
  assert.ok(errors.some((e) => /未知フィールド/.test(e)));
});

test('validateFieldGrammar: id 形式不正・id≠createdAt', () => {
  assert.ok(validateFieldGrammar(rec({ id: 'bad' })).errors.some((e) => /id 形式/.test(e)));
  const mismatch = validateFieldGrammar(rec({ id: 'mem-20260102-aaaaaa', createdAt: '2026-01-01' }));
  assert.ok(mismatch.errors.some((e) => /createdAt が不一致/.test(e)));
});

test('validateFieldGrammar: 未知 kind/status/visibility', () => {
  assert.ok(validateFieldGrammar(rec({ kind: 'x' })).errors.some((e) => /未知 kind/.test(e)));
  assert.ok(validateFieldGrammar(rec({ status: 'x' })).errors.some((e) => /未知 status/.test(e)));
  assert.ok(
    validateFieldGrammar(rec({ visibility: 'x' })).errors.some((e) => /未知 visibility/.test(e)),
  );
});

test('validateFieldGrammar: scope 空配列はエラー・未知語彙はエラー・unclassified は警告', () => {
  assert.ok(validateFieldGrammar(rec({ scope: [] })).errors.some((e) => /scope は1要素/.test(e)));
  assert.ok(
    validateFieldGrammar(rec({ scope: ['nope'] })).errors.some((e) => /未知 scope 語彙/.test(e)),
  );
  const u = validateFieldGrammar(rec({ scope: ['unclassified'] }));
  assert.deepEqual(u.errors, []);
  assert.ok(u.warnings.some((w) => /unclassified/.test(w)));
});

test('validateFieldGrammar: 必須空文字はエラー', () => {
  assert.ok(validateFieldGrammar(rec({ title: '' })).errors.some((e) => /title は非空/.test(e)));
});

test('validateFieldGrammar: sources ゼロは警告', () => {
  assert.ok(validateFieldGrammar(rec({ sources: [] })).warnings.some((w) => /sources が空/.test(w)));
});

test('validateFieldGrammar: supersededBy⇔superseded 双方向', () => {
  // supersededBy 非 null なのに status≠superseded
  assert.ok(
    validateFieldGrammar(rec({ status: 'accepted', supersededBy: 'mem-20260101-bbbbbb' })).errors.some(
      (e) => /status は superseded/.test(e),
    ),
  );
  // superseded なのに supersededBy null
  assert.ok(
    validateFieldGrammar(rec({ status: 'superseded', supersededBy: null })).errors.some((e) =>
      /supersededBy は非 null/.test(e),
    ),
  );
});

test('validateFieldGrammar: 配列型に null は不可・supersedes 重複はエラー', () => {
  assert.ok(validateFieldGrammar(rec({ tags: null })).errors.some((e) => /null は不可/.test(e)));
  const dup = validateFieldGrammar(
    rec({ supersedes: ['mem-20260101-bbbbbb', 'mem-20260101-bbbbbb'] }),
  );
  assert.ok(dup.errors.some((e) => /supersedes に重複/.test(e)));
});

test('validateFieldGrammar: supersedes に自 id は不可（自己置換）', () => {
  const self = validateFieldGrammar(rec({ supersedes: ['mem-20260101-aaaaaa'] }));
  assert.ok(self.errors.some((e) => /自 id は不可/.test(e)));
});

test('detectSecrets: トークン実形は error・inline-credential は warn', () => {
  assert.deepEqual(detectSecrets(rec({ summary: 'AKIAIOSFODNN7EXAMPLE を含む' })), [
    { name: 'aws-access-key', level: 'error' },
  ]);
  // 前置文字での \b 回避を防ぐ（部分一致）
  assert.deepEqual(detectSecrets(rec({ summary: 'xghp_' + 'a'.repeat(36) })), [
    { name: 'github-token', level: 'error' },
  ]);
  // PEM / JWT も検出
  assert.ok(detectSecrets(rec({ rationale: '-----BEGIN RSA PRIVATE KEY-----' })).length === 1);
});

test('validateFieldGrammar: トークン実形は error・教訓の資格情報引用は warn（偽陽性でブロックしない）', () => {
  assert.ok(
    validateFieldGrammar(rec({ summary: 'AKIAIOSFODNN7EXAMPLE' })).errors.some((e) => /secret/.test(e)),
  );
  // kind:lesson が資格情報パターンを文書化する正当な用途は error にしない（warn のみ）
  const lesson = validateFieldGrammar(
    rec({ kind: 'lesson', summary: '教訓: 設定に api_key: "xxxxxxxxxx" と平文で書くと漏れる' }),
  );
  assert.deepEqual(lesson.errors, []);
  assert.ok(lesson.warnings.some((w) => /secret/.test(w)));
});

test('isValidCalendarDate / validateFieldGrammar: 実在しない暦日を拒否', () => {
  assert.equal(isValidCalendarDate('2026-02-29'), false);
  assert.equal(isValidCalendarDate('2026-01-31'), true);
  assert.ok(
    validateFieldGrammar(rec({ id: 'mem-99999999-abcabc', createdAt: '9999-99-99' })).errors.some(
      (e) => /実在しない暦日/.test(e),
    ),
  );
});

// ---- 15 セル整合表 ----

test('linkVerdict: 15 セルすべてが表どおり', () => {
  const expected = {
    proposed: { null: 'legal', self: 'error-proposed-self', other: 'warning-stale' },
    rejected: { null: 'legal', self: 'error-proposed-self', other: 'legal' },
    accepted: { null: 'error-repairable', self: 'normal', other: 'error-unless-chain' },
    superseded: { null: 'error-repairable', self: 'legal', other: 'legal' },
    retired: { null: 'legal', self: 'legal', other: 'legal' },
  };
  for (const status of Object.keys(expected)) {
    for (const state of ['null', 'self', 'other']) {
      assert.equal(linkVerdict(status, state), expected[status][state], `${status}×${state}`);
      assert.equal(LINK_TABLE[status][state], expected[status][state]);
    }
  }
});

test('classifyLinkState: null/self/other の3分類', () => {
  assert.equal(classifyLinkState(normalizeRecord(rec({ supersededBy: null })), 'mem-x'), 'null');
  assert.equal(
    classifyLinkState(normalizeRecord(rec({ status: 'superseded', supersededBy: 'mem-x' })), 'mem-x'),
    'self',
  );
  assert.equal(
    classifyLinkState(normalizeRecord(rec({ status: 'superseded', supersededBy: 'mem-y' })), 'mem-x'),
    'other',
  );
});

test('reachesSelf: A←B←C の推移到達とサイクル停止', () => {
  const A = rec({ id: 'mem-20260101-aaaaaa', status: 'superseded', supersededBy: 'mem-20260101-bbbbbb' });
  const B = rec({ id: 'mem-20260101-bbbbbb', status: 'superseded', supersededBy: 'mem-20260101-cccccc' });
  const C = rec({ id: 'mem-20260101-cccccc' });
  const idx = indexOf([A, B, C]);
  // A の supersededBy(B) から辿って C に到達する
  assert.equal(reachesSelf('mem-20260101-bbbbbb', 'mem-20260101-cccccc', idx), true);
  // 到達しない
  assert.equal(reachesSelf('mem-20260101-bbbbbb', 'mem-20260101-zzzzzz', idx), false);
  // サイクルでも停止して false
  const X = rec({ id: 'mem-20260101-xxxxxx', status: 'superseded', supersededBy: 'mem-20260101-yyyyyy' });
  const Y = rec({ id: 'mem-20260101-yyyyyy', status: 'superseded', supersededBy: 'mem-20260101-xxxxxx' });
  assert.equal(reachesSelf('mem-20260101-xxxxxx', 'mem-20260101-nnnnnnn', indexOf([X, Y])), false);
});

test('validateAll: 正常な置換ペア（accepted×self ＋ superseded×self）はエラーなし', () => {
  const newer = rec({
    id: 'mem-20260102-nnnnnn',
    createdAt: '2026-01-02',
    status: 'accepted',
    supersedes: ['mem-20260101-aaaaaa'],
  });
  const older = rec({ status: 'superseded', supersededBy: 'mem-20260102-nnnnnn' });
  assert.deepEqual(validateAll([newer, older]).errors, []);
});

test('validateAll: accepted×片方向（二重アクティブ）は修復可能エラー', () => {
  const newer = rec({
    id: 'mem-20260102-nnnnnn',
    createdAt: '2026-01-02',
    status: 'accepted',
    supersedes: ['mem-20260101-aaaaaa'],
  });
  const older = rec({ status: 'accepted', supersededBy: null });
  const { errors } = validateAll([newer, older]);
  assert.ok(errors.some((e) => /片方向リンク/.test(e)));
});

test('validateAll: accepted×競合敗北はチェーン到達で合法・非到達でエラー', () => {
  // 敗者 loser0 が「supersede loser0 winner」で勝者ごと置換した終着。
  // oldold←winner←loser0 の supersededBy チェーンが loser0（自己）に戻るため合法。
  const winnerChainOk = [
    rec({ id: 'mem-20260101-oldold', createdAt: '2026-01-01', status: 'superseded', supersededBy: 'mem-20260102-winner', supersedes: [], sources: ['x'] }),
    rec({ id: 'mem-20260102-winner', createdAt: '2026-01-02', status: 'superseded', supersededBy: 'mem-20260103-loser0', supersedes: ['mem-20260101-oldold'], sources: ['x'] }),
    rec({ id: 'mem-20260103-loser0', createdAt: '2026-01-03', status: 'accepted', supersedes: ['mem-20260101-oldold', 'mem-20260102-winner'], sources: ['x'] }),
  ];
  assert.deepEqual(validateAll(winnerChainOk).errors, []);

  // チェーンが自己に戻らない（winner はまだ有効）→ 競合敗北エラー
  const noChain = [
    rec({ id: 'mem-20260101-oldold', createdAt: '2026-01-01', status: 'superseded', supersededBy: 'mem-20260102-winner', supersedes: [], sources: ['x'] }),
    rec({ id: 'mem-20260102-winner', createdAt: '2026-01-02', status: 'accepted', supersedes: ['mem-20260101-oldold'], sources: ['x'] }),
    rec({ id: 'mem-20260103-loser0', createdAt: '2026-01-03', status: 'accepted', supersedes: ['mem-20260101-oldold'], sources: ['x'] }),
  ];
  assert.ok(validateAll(noChain).errors.some((e) => /並行 supersede の敗北/.test(e)));
});

test('validateAll: 非存在 old・宙ぶらりん逆リンク・O6・id 衝突', () => {
  // 非存在 old
  assert.ok(
    validateAll([rec({ supersedes: ['mem-20260101-zzzzzz'] })]).errors.some((e) =>
      /supersedes 先が存在しない/.test(e),
    ),
  );
  // 宙ぶらりん逆リンク（supersededBy 先の supersedes に自 id 無し）
  const dangling = [
    rec({ id: 'mem-20260101-aaaaaa', status: 'superseded', supersededBy: 'mem-20260102-bbbbbb' }),
    rec({ id: 'mem-20260102-bbbbbb', createdAt: '2026-01-02', status: 'accepted', supersedes: [] }),
  ];
  assert.ok(validateAll(dangling).errors.some((e) => /逆リンク宙ぶらりん/.test(e)));
  // O6: 同一 old を supersedes に持つ accepted 複数
  const o6 = [
    rec({ id: 'mem-20260101-oldold', status: 'superseded', supersededBy: 'mem-20260102-newer1' }),
    rec({ id: 'mem-20260102-newer1', createdAt: '2026-01-02', status: 'accepted', supersedes: ['mem-20260101-oldold'] }),
    rec({ id: 'mem-20260103-newer2', createdAt: '2026-01-03', status: 'accepted', supersedes: ['mem-20260101-oldold'] }),
  ];
  assert.ok(validateAll(o6).errors.some((e) => /accepted が複数/.test(e)));
});

test('validateAll: scope-proposal:* タグを集計', () => {
  const { proposals } = validateAll([
    rec({ id: 'mem-20260101-aaaaaa', scope: ['unclassified'], tags: ['scope-proposal:sync-engine'] }),
    rec({ id: 'mem-20260102-bbbbbb', createdAt: '2026-01-02', scope: ['unclassified'], tags: ['scope-proposal:sync-engine'] }),
  ]);
  assert.equal(proposals['sync-engine'], 2);
});

// ---- 検索・glob・フィルタ ----

test('globMatch: * は非スラッシュ・** は横断・アンカー・ReDoS 耐性', () => {
  assert.ok(globMatch('src/*.js', 'src/a.js'));
  assert.ok(!globMatch('src/*.js', 'src/sub/a.js'));
  assert.ok(globMatch('src/**', 'src/sub/a.js'));
  assert.ok(!globMatch('src/*.js', 'src/a.jsx'));
  assert.ok(globMatch('worker/**/*.ts', 'worker/src/a/b.ts'));
  // 敵対的 glob でも即座に返る（バックトラック爆発なし）。
  const start = process.hrtime.bigint();
  assert.equal(globMatch('*'.repeat(40) + 'x', 'a'.repeat(60)), false);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 500, `ReDoS 耐性（${ms}ms）`);
});

test('isActive: accepted かつ supersededBy null のみ', () => {
  assert.equal(isActive(normalizeRecord(rec())), true);
  assert.equal(isActive(normalizeRecord(rec({ status: 'proposed' }))), false);
  assert.equal(isActive(normalizeRecord(rec({ status: 'superseded', supersededBy: 'mem-x' }))), false);
});

test('matchQuery: 4 フィールド横断・AND / --any', () => {
  const r = normalizeRecord(rec({ title: '同期の設計', summary: '競合はユーザー選択', tags: ['data-loss'] }));
  assert.equal(matchQuery(r, ['同期', '競合'], {}), true); // 別フィールドで AND
  assert.equal(matchQuery(r, ['同期', '無関係'], {}), false);
  assert.equal(matchQuery(r, ['同期', '無関係'], { any: true }), true);
  // 検索対象外フィールド（scope）はヒットしない
  assert.equal(matchQuery(normalizeRecord(rec({ scope: ['github-sync'] })), ['github-sync'], {}), false);
});

test('applyFilters: kind/scope/path glob/status/visibility/tag', () => {
  const r = normalizeRecord(
    rec({ kind: 'decision', scope: ['github-sync'], paths: ['src/lib/sync.js'], visibility: 'public', tags: ['data-loss'] }),
  );
  assert.equal(applyFilters(r, { kind: ['decision'] }), true);
  assert.equal(applyFilters(r, { kind: ['constraint'] }), false);
  assert.equal(applyFilters(r, { scope: ['github-sync'] }), true);
  assert.equal(applyFilters(r, { path: 'src/**' }), true);
  assert.equal(applyFilters(r, { path: 'worker/**' }), false);
  assert.equal(applyFilters(r, { visibility: 'public' }), true);
  assert.equal(applyFilters(r, { visibility: 'control' }), false);
  assert.equal(applyFilters(r, { tag: 'data-loss' }), true);
  assert.equal(applyFilters(r, { tag: 'missing' }), false);
  // 非文字列 paths 要素があってもクラッシュしない
  const bad = normalizeRecord(rec({ paths: [123] }));
  assert.equal(applyFilters(bad, { path: '**' }), false);
  // 双方向: レコードの paths が glob でも具体パスで引ける
  const globStored = normalizeRecord(rec({ paths: ['worker/src/**'] }));
  assert.equal(applyFilters(globStored, { path: 'worker/src/foo.ts' }), true);
  assert.equal(applyFilters(globStored, { path: 'src/foo.ts' }), false);
});

test('validateAll: 置換元は accepted のみ（片方向リンク）', () => {
  // proposed 新が proposed old（supersededBy null）を supersede → fail-fast エラー
  const badTarget = [
    rec({ id: 'mem-20260101-oldold', status: 'proposed', sources: ['x'] }),
    rec({ id: 'mem-20260102-newnew', createdAt: '2026-01-02', status: 'proposed', supersedes: ['mem-20260101-oldold'], sources: ['x'] }),
  ];
  assert.ok(validateAll(badTarget).errors.some((e) => /置換元.*accepted でない/.test(e)));
  // proposed 新が accepted old を supersede（正当な中間状態）→ エラーなし
  const okTarget = [
    rec({ id: 'mem-20260101-oldold', status: 'accepted', sources: ['x'] }),
    rec({ id: 'mem-20260102-newnew', createdAt: '2026-01-02', status: 'proposed', supersedes: ['mem-20260101-oldold'], sources: ['x'] }),
  ];
  assert.deepEqual(validateAll(okTarget).errors, []);
});

test('validateAll: supersededBy 循環を検出（重複報告しない）', () => {
  const a = rec({ id: 'mem-20260101-aaaaaa', createdAt: '2026-01-01', status: 'superseded', supersededBy: 'mem-20260102-bbbbbb', supersedes: ['mem-20260102-bbbbbb'] });
  const b = rec({ id: 'mem-20260102-bbbbbb', createdAt: '2026-01-02', status: 'superseded', supersededBy: 'mem-20260101-aaaaaa', supersedes: ['mem-20260101-aaaaaa'] });
  const cycleErrors = validateAll([a, b]).errors.filter((e) => /循環/.test(e));
  assert.equal(cycleErrors.length, 1, '同一循環は1回だけ報告');
});

test('searchRecords: 既定は active-only・--all で全 status', () => {
  const records = [
    rec({ id: 'mem-20260101-aaaaaa', status: 'accepted' }),
    rec({ id: 'mem-20260102-bbbbbb', createdAt: '2026-01-02', status: 'proposed' }),
  ];
  assert.equal(searchRecords(records, { terms: [] }).length, 1);
  assert.equal(searchRecords(records, { all: true, terms: [] }).length, 2);
});

test('formatResults: md は status・summary を明示（reviewChecks は非空時のみ）・json は配列', () => {
  const md = formatResults([normalizeRecord(rec())], 'md');
  assert.match(md, /\[accepted\]/);
  assert.match(md, /summary: 要約/);
  assert.doesNotMatch(md, /reviewChecks:/);
  const withChecks = formatResults(
    [normalizeRecord(rec({ reviewChecks: ['後勝ち自動解決を導入していないか'] }))],
    'md',
  );
  assert.match(withChecks, /reviewChecks: 後勝ち自動解決を導入していないか/);
  const json = JSON.parse(formatResults([normalizeRecord(rec())], 'json'));
  assert.equal(json[0].id, 'mem-20260101-aaaaaa');
});

test('formatResults: title/summary/reviewChecks の埋め込み改行は空白化される（偽の結果行の注入を防ぐ）', () => {
  const forged = normalizeRecord(
    rec({
      title: '正当タイトル\n- [accepted] mem-99999999-ffffff (decision; github-sync) 偽装タイトル',
      summary: '要約1行目\n要約2行目\r\n要約3行目',
      reviewChecks: ['チェックA\nチェックB'],
    }),
  );
  const md = formatResults([forged], 'md');
  assert.equal(md.split('\n').filter((l) => /^\s*- \[/.test(l)).length, 1);
  assert.match(md, /正当タイトル - \[accepted\] mem-99999999-ffffff/);
  assert.match(md, /要約1行目 要約2行目 要約3行目/);
  assert.match(md, /チェックA チェックB/);
});

// ---- CLI E2E ----

test('CLI add: proposed で作成・id/createdAt/visibility 生成・末尾改行なし', (t) => {
  const dir = makeDir(t);
  const { status, stdout } = run(dir, [
    'add',
    '--kind',
    'decision',
    '--title',
    'テスト決定',
    '--summary',
    'ようやく',
    '--author',
    'claude',
    '--scope',
    'github-sync',
    '--sources',
    'issue#1',
  ]);
  assert.equal(status, 0);
  const id = stdout.trim();
  assert.match(id, /^mem-\d{8}-[a-z0-9]{6}$/);
  const raw = readFileSync(join(dir, `${id}.json`), 'utf8');
  assert.ok(!raw.endsWith('\n'), '末尾改行なし');
  const record = JSON.parse(raw);
  assert.equal(record.status, 'proposed');
  assert.equal(record.visibility, 'control');
  assert.equal(record.createdAt, formatDate());
  assert.equal(record.id.slice(4, 12), record.createdAt.replaceAll('-', ''));
});

test('CLI add: author 欠落・未知 scope・--status は fail-loud', (t) => {
  const dir = makeDir(t);
  const noAuthor = run(dir, ['add', '--kind', 'decision', '--title', 't', '--summary', 's', '--scope', 'github-sync']);
  assert.equal(noAuthor.status, 1);
  assert.match(noAuthor.stderr, /author/);

  const badScope = run(dir, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude', '--scope', 'nope',
  ]);
  assert.equal(badScope.status, 1);
  assert.match(badScope.stderr, /scope-proposal/);

  const withStatus = run(dir, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude', '--scope', 'github-sync', '--status', 'accepted',
  ]);
  assert.equal(withStatus.status, 1);
  assert.match(withStatus.stderr, /常に proposed/);
});

test('CLI add --supersedes: 旧レコードは無変更（promote 前）', (t) => {
  const dir = makeDir(t);
  const old = rec({ id: 'mem-20260101-oldold', status: 'accepted' });
  writeRec(dir, old);
  const { status, stdout } = run(dir, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude',
    '--scope', 'github-sync', '--sources', 'issue#1', '--supersedes', 'mem-20260101-oldold',
  ]);
  assert.equal(status, 0);
  const newRec = JSON.parse(readFileSync(join(dir, `${stdout.trim()}.json`), 'utf8'));
  assert.deepEqual(newRec.supersedes, ['mem-20260101-oldold']);
  const oldAfter = JSON.parse(readFileSync(join(dir, 'mem-20260101-oldold.json'), 'utf8'));
  assert.equal(oldAfter.supersededBy ?? null, null, '旧は無変更');
  assert.equal(oldAfter.status, 'accepted');
});

test('CLI add: kind:rejected は区別ノートを stderr に表示', (t) => {
  const dir = makeDir(t);
  const { status, stderr } = run(dir, [
    'add', '--kind', 'rejected', '--title', 't', '--summary', 's', '--author', 'claude', '--scope', 'github-sync', '--sources', 'issue#1',
  ]);
  assert.equal(status, 0);
  assert.match(stderr, /kind:rejected/);
  assert.match(stderr, /status:rejected/);
});

test('CLI add: sources 空・unclassified は追加時に警告を stderr に出す（fail-quiet 回避・非致命）', (t) => {
  const dir = makeDir(t);
  const noSources = run(dir, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude', '--scope', 'github-sync',
  ]);
  assert.equal(noSources.status, 0);
  assert.match(noSources.stderr, /sources が空/);

  const unclassified = run(dir, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude', '--scope', 'unclassified', '--sources', 'issue#1',
  ]);
  assert.equal(unclassified.status, 0);
  assert.match(unclassified.stderr, /scope-proposal/);
});

test('CLI: コマンド別許可リストにない未知フラグは fail-loud', (t) => {
  const dir = makeDir(t);
  // add の正しいフラグは --paths（複数形）。--path は未知 → 黙って空 paths を作らずエラー
  const typo = run(dir, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude', '--scope', 'github-sync', '--sources', 'x', '--path', 'src/lib/sync.js',
  ]);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /未知のオプション: --path/);
});

test('CLI add: --visibility に値がなければ fail-loud', (t) => {
  const dir = makeDir(t);
  const { status, stderr } = run(dir, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude', '--scope', 'github-sync', '--sources', 'x', '--visibility',
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /visibility/);
});

test('CLI search: 引用符なしの複数語も AND（黙殺しない）・ZWSP のみは空クエリ扱い', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ title: '同期の設計', summary: '競合はユーザー選択' }));
  const unquoted = run(dir, ['search', '同期', '競合']);
  assert.equal(unquoted.status, 0);
  assert.match(unquoted.stdout, /mem-20260101-aaaaaa/);
  // 2語目に無関係語を足すと AND で外れる（両語が使われている証拠）
  const andMiss = run(dir, ['search', '同期', '無関係語']);
  assert.equal(andMiss.status, 0);
  assert.match(andMiss.stdout, /該当なし/);
  // ゼロ幅スペースのみは空クエリとしてエラー
  const zwsp = run(dir, ['search', '\u200b\u200b']);
  assert.equal(zwsp.status, 1);
  assert.match(zwsp.stderr, /クエリが空/);
});

test('CLI validate: symlink レコードは fail-loud（外部ファイル追従を拒否）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  const outside = join(dir, 'outside.txt');
  writeFileSync(outside, 'secret payload');
  symlinkSync(outside, join(dir, 'mem-20260102-bbbbbb.json'));
  const { status, stderr } = run(dir, ['validate']);
  assert.equal(status, 1);
  assert.match(stderr, /symlink|通常ファイル/);
});

test('CLI validate --format json: 構造化レポートを stdout に出す', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ scope: ['unclassified'], tags: ['scope-proposal:sync-engine'] }));
  const { status, stdout } = run(dir, ['validate', '--format', 'json']);
  assert.equal(status, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.proposals['sync-engine'], 1);
  assert.ok(Array.isArray(report.warnings));
});

test('CLI search/validate: --format の不正値・値省略は fail-loud（md へ黙ってフォールバックしない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ title: '同期' }));
  const badSearch = run(dir, ['search', '同期', '--format', 'jsn']);
  assert.equal(badSearch.status, 1);
  assert.match(badSearch.stderr, /--format は md か json/);
  const missingSearch = run(dir, ['search', '同期', '--format']);
  assert.equal(missingSearch.status, 1);
  const badValidate = run(dir, ['validate', '--format', 'jsn']);
  assert.equal(badValidate.status, 1);
  assert.match(badValidate.stderr, /--format は json のみ/);
});

test('CLI add --supersedes: 置換元が非 accepted なら書込み前に fail-loud', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ id: 'mem-20260101-oldold', status: 'proposed' }));
  const { status, stderr } = run(dir, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude',
    '--scope', 'github-sync', '--sources', 'x', '--supersedes', 'mem-20260101-oldold',
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /accepted でない/);
  // accepted な old への置換提案は正常に通る（第1回対応との一貫性）
  const dir2 = makeDir(t);
  writeRec(dir2, rec({ id: 'mem-20260101-oldold', status: 'accepted' }));
  const ok = run(dir2, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude',
    '--scope', 'github-sync', '--sources', 'x', '--supersedes', 'mem-20260101-oldold',
  ]);
  assert.equal(ok.status, 0);
});

test('CLI search: 値を取るフィルタフラグの値省略は fail-loud（無フィルタへ黙って広がらない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ title: '同期' }));
  const { status, stderr } = run(dir, ['search', '同期', '--scope']);
  assert.equal(status, 1);
  assert.match(stderr, /--scope には値が必要/);
});

test('CLI search: split 後に空になるフィルタ値（--scope "" 等）は fail-loud（空クエリガードのすり抜けを防ぐ）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ title: '同期' }));
  const emptyScope = run(dir, ['search', '--scope', '']);
  assert.equal(emptyScope.status, 1);
  assert.match(emptyScope.stderr, /--scope の値が空/);
  const commaOnlyKind = run(dir, ['search', '--kind', ',']);
  assert.equal(commaOnlyKind.status, 1);
  assert.match(commaOnlyKind.stderr, /--kind の値が空/);
});

test('CLI search: フィルタの統制語彙タイプミスは fail-loud（黙って「該当なし」を返さない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ title: '同期' }));
  const badScope = run(dir, ['search', '--scope', 'github-syncc']);
  assert.equal(badScope.status, 1);
  assert.match(badScope.stderr, /--scope に未知の値/);
  const badStatus = run(dir, ['search', '--status', 'acceptted']);
  assert.equal(badStatus.status, 1);
  assert.match(badStatus.stderr, /--status に未知の値/);
  const badKind = run(dir, ['search', '--kind', 'decisionn']);
  assert.equal(badKind.status, 1);
  assert.match(badKind.stderr, /--kind に未知の値/);
  const badVisibility = run(dir, ['search', '--visibility', 'publicc']);
  assert.equal(badVisibility.status, 1);
  assert.match(badVisibility.stderr, /--visibility に未知の値/);
  // 正当な値は通る
  const ok = run(dir, ['search', '--status', 'accepted']);
  assert.equal(ok.status, 0);
});

test('CLI add: 値を取るオプションの値省略は書込み前に fail-loud（--supersedes 値なしで意図しない proposed を作らない）', (t) => {
  const dir = makeDir(t);
  const missingSupersedes = run(dir, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude',
    '--scope', 'github-sync', '--sources', 'x', '--supersedes',
  ]);
  assert.equal(missingSupersedes.status, 1);
  assert.match(missingSupersedes.stderr, /--supersedes には値が必要/);
  const missingPaths = run(dir, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude',
    '--scope', 'github-sync', '--sources', 'x', '--paths',
  ]);
  assert.equal(missingPaths.status, 1);
  assert.match(missingPaths.stderr, /--paths には値が必要/);
  // rationale は意図的な空文字を許容する（値なしフラグとは区別）
  const emptyRationale = run(dir, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude',
    '--scope', 'github-sync', '--sources', 'x', '--rationale', '',
  ]);
  assert.equal(emptyRationale.status, 0);
});

test('CLI search --path: 256 文字超の保存済み path があっても search --path が exit 1 にならない（双方向 glob の自己回帰対策）', (t) => {
  const dir = makeDir(t);
  const longPath = 'src/' + 'a'.repeat(300) + '.js';
  writeRec(dir, rec({ paths: [longPath] }));
  writeRec(dir, rec({ id: 'mem-20260102-bbbbbb', createdAt: '2026-01-02', paths: ['worker/src/foo.ts'] }));
  const { status, stdout } = run(dir, ['search', '--path', 'worker/src/foo.ts']);
  assert.equal(status, 0);
  assert.match(stdout, /mem-20260102-bbbbbb/);
  assert.doesNotMatch(stdout, /mem-20260101-aaaaaa/);
});

test('CLI search --path: 256 文字超の具体クエリを渡しても exit 1 にならず、保存済み glob にヒットする（さらなる自己回帰対策）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ paths: ['src/**'] }));
  const longQuery = 'src/' + 'a'.repeat(300) + '.js';
  const { status, stdout } = run(dir, ['search', '--path', longQuery]);
  assert.equal(status, 0);
  assert.match(stdout, /mem-20260101-aaaaaa/);
});

test('CLI search --path: 保存済み path とクエリが同一の256文字超パスでも完全一致でヒットする（3度目の自己回帰対策）', (t) => {
  const dir = makeDir(t);
  const longPath = 'src/' + 'a'.repeat(300) + '.js';
  writeRec(dir, rec({ paths: [longPath] }));
  const { status, stdout } = run(dir, ['search', '--path', longPath]);
  assert.equal(status, 0);
  assert.match(stdout, /mem-20260101-aaaaaa/);
});

test('CLI add: split 後に空になる paths/sources/supersedes/tags/reviewChecks は fail-loud', (t) => {
  const dir = makeDir(t);
  const base = ['add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude', '--scope', 'github-sync', '--sources', 'x'];
  const emptyPaths = run(dir, [...base, '--paths', '']);
  assert.equal(emptyPaths.status, 1);
  assert.match(emptyPaths.stderr, /--paths の値が空/);
  const commaOnlyTags = run(dir, [...base, '--tags', ',']);
  assert.equal(commaOnlyTags.status, 1);
  assert.match(commaOnlyTags.stderr, /--tags の値が空/);
});

test('CLI add: 余った位置引数は fail-loud（黙って無視しない）', (t) => {
  const dir = makeDir(t);
  const { status, stderr } = run(dir, [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's', '--author', 'claude',
    '--scope', 'github-sync', '--sources', 'x', 'src/lib/sync.js',
  ]);
  assert.equal(status, 1);
  assert.match(stderr, /位置引数を取りません/);
});

test('CLI show: CRLF 改行のレコードも読める（環境差の明示）', (t) => {
  const dir = makeDir(t);
  const body = JSON.stringify(rec(), null, 2).replace(/\n/g, '\r\n');
  writeFileSync(join(dir, 'mem-20260101-aaaaaa.json'), body);
  const { status, stdout } = run(dir, ['show', 'mem-20260101-aaaaaa']);
  assert.equal(status, 0);
  assert.equal(JSON.parse(stdout).id, 'mem-20260101-aaaaaa');
});

test('CLI show: 発見・not found', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  const found = run(dir, ['show', 'mem-20260101-aaaaaa']);
  assert.equal(found.status, 0);
  assert.equal(JSON.parse(found.stdout).id, 'mem-20260101-aaaaaa');
  const missing = run(dir, ['show', 'mem-20260101-zzzzzz']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /見つかりません/);
});

test('CLI show: 壊れたレコード（未知フィールド）は正規化済み view を出さず fail-loud（validate と同じ判断基準）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, { ...rec(), bogus: 'これは未知フィールド' });
  const { status, stdout, stderr } = run(dir, ['show', 'mem-20260101-aaaaaa']);
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /未知フィールド/);
});

test('CLI show: warnings のみ（sources 空）なら表示は継続しつつ stderr に警告を出す', (t) => {
  const dir = makeDir(t);
  const { sources: _sources, ...withoutSources } = rec();
  writeRec(dir, withoutSources);
  const { status, stdout, stderr } = run(dir, ['show', 'mem-20260101-aaaaaa']);
  assert.equal(status, 0);
  assert.equal(JSON.parse(stdout).id, 'mem-20260101-aaaaaa');
  assert.match(stderr, /warning:.*sources が空/);
});

test('CLI show: 無関係な壊れたレコードが他の show を巻き込まない（per-hit 検査・corpus 全体は強制しない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  writeRec(dir, { ...rec({ id: 'mem-20260102-bbbbbb', createdAt: '2026-01-02' }), bogus: 1 });
  const { status, stdout } = run(dir, ['show', 'mem-20260101-aaaaaa']);
  assert.equal(status, 0);
  assert.equal(JSON.parse(stdout).id, 'mem-20260101-aaaaaa');
});

test('CLI search: AND ヒット・空クエリ・フィルタのみ・両方無し', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ title: '同期の設計', summary: '競合はユーザー選択' }));
  const hit = run(dir, ['search', '同期 競合']);
  assert.equal(hit.status, 0);
  assert.match(hit.stdout, /mem-20260101-aaaaaa/);

  const empty = run(dir, ['search', '   ']);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /クエリが空/);

  const filterOnly = run(dir, ['search', '--scope', 'github-sync']);
  assert.equal(filterOnly.status, 0);
  assert.match(filterOnly.stdout, /mem-20260101-aaaaaa/);

  const neither = run(dir, ['search']);
  assert.equal(neither.status, 1);
  assert.match(neither.stderr, /クエリもフィルタも/);
});

test('CLI search --format json', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ title: '同期' }));
  const { status, stdout } = run(dir, ['search', '同期', '--format', 'json']);
  assert.equal(status, 0);
  assert.equal(JSON.parse(stdout)[0].id, 'mem-20260101-aaaaaa');
});

test('CLI validate: healthy は exit 0・二重アクティブは exit 1', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  const healthy = run(dir, ['validate']);
  assert.equal(healthy.status, 0);

  const newer = rec({ id: 'mem-20260102-nnnnnn', createdAt: '2026-01-02', status: 'accepted', supersedes: ['mem-20260101-aaaaaa'] });
  writeRec(dir, newer); // 旧(aaaaaa)は accepted・supersededBy null のまま → 二重アクティブ
  const broken = run(dir, ['validate']);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /片方向リンク/);
});

test('CLI validate: ファイル名と id 不一致は fail-loud', (t) => {
  const dir = makeDir(t);
  writeFileSync(join(dir, 'wrong-name.json'), JSON.stringify(rec(), null, 2));
  const { status, stderr } = run(dir, ['validate']);
  assert.equal(status, 1);
  assert.match(stderr, /ファイル名と id が不一致/);
});

test('CLI validate: 余った位置引数は fail-loud（対象ディレクトリを差し替えたつもりが黙って既定 dir を検査しない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  const { status, stderr } = run(dir, ['validate', '/tmp/bad-records']);
  assert.equal(status, 1);
  assert.match(stderr, /位置引数を取りません/);
});

test('CLI show: 余った位置引数は fail-loud', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  const { status, stderr } = run(dir, ['show', 'mem-20260101-aaaaaa', 'extra']);
  assert.equal(status, 1);
  assert.match(stderr, /id を1つだけ/);
});

test('CLI: コマンド欠落は exit 1（usage 表示は成功扱いにしない）', (t) => {
  const dir = makeDir(t);
  const { status, stderr } = run(dir, []);
  assert.equal(status, 1);
  assert.match(stderr, /使い方/);
});

test('CLI: help / --help は exit 0 のまま', (t) => {
  const dir = makeDir(t);
  const help = run(dir, ['help']);
  assert.equal(help.status, 0);
  const help2 = run(dir, ['--help']);
  assert.equal(help2.status, 0);
});

test('CLI search: -- terminator で -- 始まりのクエリ語を渡せる', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ title: '--path オプションの説明', summary: 'CLI フラグの記録' }));
  const { status, stdout } = run(dir, ['search', '--', '--path']);
  assert.equal(status, 0);
  assert.match(stdout, /mem-20260101-aaaaaa/);
});

test('CLI search: ヒットしたレコードが不正（未知フィールド）なら fail-loud（無関係な壊れたレコードは影響しない）', (t) => {
  const dir = makeDir(t);
  const bad = { ...rec({ title: '同期の設計' }), bogus: 1 };
  writeRec(dir, bad);
  const hit = run(dir, ['search', '同期']);
  assert.equal(hit.status, 1);
  assert.match(hit.stderr, /検索結果に不正なレコード/);
  // 無関係な壊れたレコードが存在しても、ヒットしないクエリは影響を受けない（blast radius を限定）
  const irrelevantHit = run(dir, ['search', '--scope', 'github-sync', '--kind', 'constraint']);
  assert.equal(irrelevantHit.status, 0);
  assert.match(irrelevantHit.stdout, /該当なし/);
});

test('CLI search: ヒットしたレコードのリンク不整合（片方向リンク＝promote 途中クラッシュ相当）も fail-loud', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ title: '同期の旧設計' }));
  // 新(nnnnnn)は accepted・supersedes で旧を指すが、旧(aaaaaa)は accepted・supersededBy null のまま
  // → 二重アクティブ（validate なら「片方向リンク」で exit 1 になる状態）
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-nnnnnn',
      createdAt: '2026-01-02',
      title: '同期の新設計',
      status: 'accepted',
      supersedes: ['mem-20260101-aaaaaa'],
    }),
  );
  const hit = run(dir, ['search', '新設計']);
  assert.equal(hit.status, 1);
  assert.match(hit.stderr, /片方向リンク/);
  // validateLinks はヒットしたレコード自身の supersedes/supersededBy のみ検査するため、
  // 旧レコード（supersedes/supersededBy を持たない側）だけを引くクエリは影響を受けない。
  const oldOnly = run(dir, ['search', '旧設計']);
  assert.equal(oldOnly.status, 0);
  assert.match(oldOnly.stdout, /旧設計/);
});

// ---- ライフサイクル遷移（PR-b2）----

function readRec(dir, id) {
  return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
}

test('CLI promote: proposed → accepted（supersedes なし）・冪等な再実行', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  const first = run(dir, ['promote', 'mem-20260101-aaaaaa']);
  assert.equal(first.status, 0);
  // stdout の 1 行目は id（機械出力契約）。2 行目は endorse trailer（#532）。
  assert.equal(first.stdout.split('\n')[0], 'mem-20260101-aaaaaa');
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').status, 'accepted');
  // 再実行は変更なしで exit 0（冪等）
  const again = run(dir, ['promote', 'mem-20260101-aaaaaa']);
  assert.equal(again.status, 0);
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').status, 'accepted');
});

test('CLI promote: 置換付き（新→旧の順で旧に supersededBy 付与＋superseded 化）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-nnnnnn',
      createdAt: '2026-01-02',
      status: 'proposed',
      supersedes: ['mem-20260101-aaaaaa'],
    }),
  );
  const { status } = run(dir, ['promote', 'mem-20260102-nnnnnn']);
  assert.equal(status, 0);
  const newRec = readRec(dir, 'mem-20260102-nnnnnn');
  const oldRec = readRec(dir, 'mem-20260101-aaaaaa');
  assert.equal(newRec.status, 'accepted');
  assert.equal(oldRec.status, 'superseded');
  assert.equal(oldRec.supersededBy, 'mem-20260102-nnnnnn');
  // 直後の validate が全緑（15セル整合を満たす完了状態）
  assert.equal(run(dir, ['validate']).status, 0);
});

test('CLI promote: リンク完遂モード（途中クラッシュ相当＝新 accepted・旧未リンクからの再実行で回復）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  // step 1 完了・step 2 未完了の中間状態（validate は片方向リンクで exit 1）
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-nnnnnn',
      createdAt: '2026-01-02',
      status: 'accepted',
      supersedes: ['mem-20260101-aaaaaa'],
    }),
  );
  assert.equal(run(dir, ['validate']).status, 1);
  const { status } = run(dir, ['promote', 'mem-20260102-nnnnnn']);
  assert.equal(status, 0);
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').supersededBy, 'mem-20260102-nnnnnn');
  assert.equal(run(dir, ['validate']).status, 0);
});

test('CLI promote: 継承時は健全だった replaces が promote 時点で壊れていれば書込前に拒否する（revise と同型の穴）', (t) => {
  // add 時点では replaces 先が rejected だったが、add〜promote の間に対象が purge されて
  // 実在しなくなるケース。promote は replaces を単一レコードの文法検査でしか見ないため、
  // 書込前の再検証が無いと exit 0 で Memory-Endorsement trailer まで発行し、直後の validate で
  // 初めて corpus の壊れが判明していた（外部レビュー指摘。revise 側の修正と対）。
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed', replaces: ['mem-20260101-rrrrrr'] }));
  // replaces 先が既に消えている状態を直接作る（purge 後の状態を模擬）
  const r = run(dir, ['promote', 'mem-20260101-aaaaaa'], { AGENT_MEMORY_DIR: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /replaces 先が存在しない/);
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').status, 'proposed', '検証失敗なのに昇格した');
});

test('CLI promote: rejected / retired はエラー・置換元が非 accepted はエラー・先勝ち衝突はエラー', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ id: 'mem-20260101-rrrrrr', status: 'rejected' }));
  const rejected = run(dir, ['promote', 'mem-20260101-rrrrrr']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /proposed 専用/);

  // 置換元が proposed（非 accepted）
  writeRec(dir, rec({ id: 'mem-20260101-oooooo', status: 'proposed' }));
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-nnnnnn',
      createdAt: '2026-01-02',
      status: 'proposed',
      supersedes: ['mem-20260101-oooooo'],
    }),
  );
  const notAccepted = run(dir, ['promote', 'mem-20260102-nnnnnn']);
  assert.equal(notAccepted.status, 1);
  assert.match(notAccepted.stderr, /accepted でない/);
  // 前提違反時は新レコードも書き換えられていない（前提検査→書込の順）
  assert.equal(readRec(dir, 'mem-20260102-nnnnnn').status, 'proposed');

  // 先勝ち: old が既に他レコードへ置換済み
  writeRec(dir, rec({ id: 'mem-20260101-wwwwww' }));
  writeRec(
    dir,
    rec({
      id: 'mem-20260101-lllll1',
      status: 'superseded',
      supersededBy: 'mem-20260102-winner',
    }),
  );
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-winner',
      createdAt: '2026-01-02',
      supersedes: ['mem-20260101-lllll1'],
    }),
  );
  writeRec(
    dir,
    rec({
      id: 'mem-20260103-loser1',
      createdAt: '2026-01-03',
      status: 'proposed',
      supersedes: ['mem-20260101-lllll1'],
    }),
  );
  const conflict = run(dir, ['promote', 'mem-20260103-loser1']);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /並行 supersede の敗北/);
});

test('CLI reject: proposed → rejected・非 proposed はエラー', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  const ok = run(dir, ['reject', 'mem-20260101-aaaaaa']);
  assert.equal(ok.status, 0);
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').status, 'rejected');

  writeRec(dir, rec({ id: 'mem-20260101-cccccc' }));
  const notProposed = run(dir, ['reject', 'mem-20260101-cccccc']);
  assert.equal(notProposed.status, 1);
  assert.match(notProposed.stderr, /proposed 専用/);
});

test('CLI reject: 置換案の却下では旧レコードが無傷（supersededBy 付与は promote まで起きない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-nnnnnn',
      createdAt: '2026-01-02',
      status: 'proposed',
      supersedes: ['mem-20260101-aaaaaa'],
    }),
  );
  assert.equal(run(dir, ['reject', 'mem-20260102-nnnnnn']).status, 0);
  const oldRec = readRec(dir, 'mem-20260101-aaaaaa');
  assert.equal(oldRec.status, 'accepted');
  assert.equal(oldRec.supersededBy ?? null, null);
});

test('CLI retire: accepted → retired（supersededBy null 維持）・非 accepted はエラー', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  const ok = run(dir, ['retire', 'mem-20260101-aaaaaa']);
  assert.equal(ok.status, 0);
  const retired = readRec(dir, 'mem-20260101-aaaaaa');
  assert.equal(retired.status, 'retired');
  assert.equal(retired.supersededBy ?? null, null);
  // retired は既定検索から自然に落ちる
  const search = run(dir, ['search', 'タイトル']);
  assert.equal(search.status, 0);
  assert.match(search.stdout, /該当なし/);

  writeRec(dir, rec({ id: 'mem-20260101-pppppp', status: 'proposed' }));
  const notAccepted = run(dir, ['retire', 'mem-20260101-pppppp']);
  assert.equal(notAccepted.status, 1);
  assert.match(notAccepted.stderr, /accepted 専用/);
});

test('CLI supersede: 既 accepted 同士の後付け置換・冪等な再実行', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  writeRec(dir, rec({ id: 'mem-20260102-nnnnnn', createdAt: '2026-01-02' }));
  const first = run(dir, ['supersede', 'mem-20260102-nnnnnn', 'mem-20260101-aaaaaa']);
  assert.equal(first.status, 0);
  const newRec = readRec(dir, 'mem-20260102-nnnnnn');
  const oldRec = readRec(dir, 'mem-20260101-aaaaaa');
  assert.deepEqual(newRec.supersedes, ['mem-20260101-aaaaaa']);
  assert.equal(oldRec.status, 'superseded');
  assert.equal(oldRec.supersededBy, 'mem-20260102-nnnnnn');
  assert.equal(run(dir, ['validate']).status, 0);
  // 再実行しても supersedes に重複を作らない
  const again = run(dir, ['supersede', 'mem-20260102-nnnnnn', 'mem-20260101-aaaaaa']);
  assert.equal(again.status, 0);
  assert.deepEqual(readRec(dir, 'mem-20260102-nnnnnn').supersedes, ['mem-20260101-aaaaaa']);
});

test('CLI supersede: 前提違反（new 非 accepted / old 置換済み / 自己置換 / 引数不足）は fail-loud', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ id: 'mem-20260101-pppppp', status: 'proposed' }));
  writeRec(dir, rec());
  const newNotAccepted = run(dir, ['supersede', 'mem-20260101-pppppp', 'mem-20260101-aaaaaa']);
  assert.equal(newNotAccepted.status, 1);
  assert.match(newNotAccepted.stderr, /accepted 同士専用/);

  // old が既に他レコードへ置換済み（先勝ち）
  writeRec(
    dir,
    rec({ id: 'mem-20260101-tttttt', status: 'superseded', supersededBy: 'mem-20260102-wwwwww' }),
  );
  writeRec(
    dir,
    rec({ id: 'mem-20260102-wwwwww', createdAt: '2026-01-02', supersedes: ['mem-20260101-tttttt'] }),
  );
  writeRec(dir, rec({ id: 'mem-20260102-xxxxxx', createdAt: '2026-01-02' }));
  const taken = run(dir, ['supersede', 'mem-20260102-xxxxxx', 'mem-20260101-tttttt']);
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /並行 supersede の敗北/);

  const self = run(dir, ['supersede', 'mem-20260101-aaaaaa', 'mem-20260101-aaaaaa']);
  assert.equal(self.status, 1);
  assert.match(self.stderr, /自己置換/);

  const missing = run(dir, ['supersede', 'mem-20260101-aaaaaa']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /2 引数が必要/);
});

test('CLI promote/reject/retire: 余った位置引数・id 欠落・存在しない id は fail-loud', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  const extra = run(dir, ['promote', 'mem-20260101-aaaaaa', 'extra']);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /id を1つだけ/);
  const noId = run(dir, ['reject']);
  assert.equal(noId.status, 1);
  assert.match(noId.stderr, /id を指定/);
  const notFound = run(dir, ['retire', 'mem-20260101-zzzzzz']);
  assert.equal(notFound.status, 1);
  assert.match(notFound.stderr, /見つかりません/);
});

test('CLI promote: 壊れたレコード（未知フィールド）は遷移させず fail-loud', (t) => {
  const dir = makeDir(t);
  writeRec(dir, { ...rec({ status: 'proposed' }), bogus: 1 });
  const { status, stderr } = run(dir, ['promote', 'mem-20260101-aaaaaa']);
  assert.equal(status, 1);
  assert.match(stderr, /未知フィールド/);
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').status, 'proposed');
});

test('CLI promote: 置換元 old が壊れている（未知フィールド）と遷移させず fail-loud（正規化書込で黙って落とさない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, { ...rec(), bogus: 1 });
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-nnnnnn',
      createdAt: '2026-01-02',
      status: 'proposed',
      supersedes: ['mem-20260101-aaaaaa'],
    }),
  );
  const { status, stderr } = run(dir, ['promote', 'mem-20260102-nnnnnn']);
  assert.equal(status, 1);
  assert.match(stderr, /置換元 mem-20260101-aaaaaa のレコードが不正/);
  assert.match(stderr, /未知フィールド/);
  // 新レコードも old も書き換えられていない（前提検査→書込の順を維持）
  assert.equal(readRec(dir, 'mem-20260102-nnnnnn').status, 'proposed');
});

test('CLI supersede: 勝者ごと置換のチェーン修復で無関係な既存 old を再検査しない（先勝ちの誤検出防止）', (t) => {
  const dir = makeDir(t);
  // old <- winner（既に完了済みの正当な置換）
  writeRec(dir, rec({ id: 'mem-20260101-oldold', status: 'superseded', supersededBy: 'mem-20260102-winner' }));
  writeRec(
    dir,
    rec({ id: 'mem-20260102-winner', createdAt: '2026-01-02', supersedes: ['mem-20260101-oldold'] }),
  );
  // loser は同じ old を supersedes に持つが競合に敗れた accepted（O6 の並行 supersede 競合状態）
  writeRec(
    dir,
    rec({ id: 'mem-20260102-loser1', createdAt: '2026-01-02', supersedes: ['mem-20260101-oldold'] }),
  );
  // validate が案内する回復コマンド: supersede <敗者> <勝者>
  const { status, stdout } = run(dir, ['supersede', 'mem-20260102-loser1', 'mem-20260102-winner']);
  assert.equal(status, 0);
  assert.equal(stdout.split('\n')[0], 'mem-20260102-loser1');
  const loser = readRec(dir, 'mem-20260102-loser1');
  assert.deepEqual(loser.supersedes, ['mem-20260101-oldold', 'mem-20260102-winner']);
  // old（無関係な既存リンク）は変更されていない（winner への置換のまま）
  const old = readRec(dir, 'mem-20260101-oldold');
  assert.equal(old.supersededBy, 'mem-20260102-winner');
  // winner が新たに loser から置換される
  const winner = readRec(dir, 'mem-20260102-winner');
  assert.equal(winner.status, 'superseded');
  assert.equal(winner.supersededBy, 'mem-20260102-loser1');
  // チェーン修復後は validate が全緑（reachesSelf のチェーン例外が成立）
  assert.equal(run(dir, ['validate']).status, 0);
});

// ---- digest（PR-b2）----

test('CLI digest: 既定は active-only・--status all で全件', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ title: '有効な記憶' }));
  writeRec(dir, rec({ id: 'mem-20260101-pppppp', title: '提案中の記憶', status: 'proposed' }));
  writeRec(dir, rec({ id: 'mem-20260101-tttttt', title: '退役済みの記憶', status: 'retired' }));
  const active = run(dir, ['digest']);
  assert.equal(active.status, 0);
  assert.match(active.stdout, /有効な記憶/);
  assert.doesNotMatch(active.stdout, /提案中の記憶/);
  assert.doesNotMatch(active.stdout, /退役済みの記憶/);
  const all = run(dir, ['digest', '--status', 'all']);
  assert.equal(all.status, 0);
  assert.match(all.stdout, /提案中の記憶/);
  assert.match(all.stdout, /退役済みの記憶/);
});

test('CLI digest: --visibility public で public かつ有効のみ・--paths glob で絞り込み', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ title: 'control の記憶' }));
  writeRec(
    dir,
    rec({
      id: 'mem-20260101-pubpub',
      title: 'public の記憶',
      visibility: 'public',
      paths: ['src/lib/sync.js'],
    }),
  );
  const pub = run(dir, ['digest', '--visibility', 'public']);
  assert.equal(pub.status, 0);
  assert.match(pub.stdout, /public の記憶/);
  assert.doesNotMatch(pub.stdout, /control の記憶/);
  const byPath = run(dir, ['digest', '--paths', 'src/lib/**']);
  assert.equal(byPath.status, 0);
  assert.match(byPath.stdout, /public の記憶/);
  assert.doesNotMatch(byPath.stdout, /control の記憶/);
});

test('CLI digest: --format jsonl は 1 行 1 レコード・不正な status/format/visibility は fail-loud', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  writeRec(dir, rec({ id: 'mem-20260101-cccccc' }));
  const jsonl = run(dir, ['digest', '--format', 'jsonl']);
  assert.equal(jsonl.status, 0);
  const lines = jsonl.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) assert.equal(typeof JSON.parse(line).id, 'string');

  const badStatus = run(dir, ['digest', '--status', 'accepted']);
  assert.equal(badStatus.status, 1);
  assert.match(badStatus.stderr, /--status は active か all/);
  const badFormat = run(dir, ['digest', '--format', 'json']);
  assert.equal(badFormat.status, 1);
  assert.match(badFormat.stderr, /--format は md か jsonl/);
  const badVis = run(dir, ['digest', '--visibility', 'pub']);
  assert.equal(badVis.status, 1);
  assert.match(badVis.stderr, /--visibility に未知の値/);
});

test('CLI digest: --format jsonl で該当 0 件のとき出力は空文字（空行を JSON.parse させない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' })); // active-only の既定条件に一致しない
  const { status, stdout } = run(dir, ['digest', '--format', 'jsonl']);
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('CLI digest: 出力対象に壊れたレコードが含まれると fail-loud（対象外の破損は止めない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, { ...rec(), bogus: 1 });
  const broken = run(dir, ['digest']);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /digest 対象に不正なレコード/);
  // 破損レコードが active でない（＝出力対象外）なら digest は成功する
  const dir2 = makeDir(t);
  writeRec(dir2, rec());
  writeRec(dir2, { ...rec({ id: 'mem-20260101-pppppp', status: 'proposed' }), bogus: 1 });
  const ok = run(dir2, ['digest']);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /mem-20260101-aaaaaa/);
});

// ---- revise（#518。コミット済み proposed の自己訂正） ----

// revise は docs 走査（旧 id 参照警告）を持つため、AGENT_MEMORY_DOCS_DIR も隔離して hermetic にする。
function runWithDocs(dir, docsDir, args) {
  return run(dir, args, { AGENT_MEMORY_DOCS_DIR: docsDir });
}

test('CLI revise: 正常系（旧削除・新生成・継承・上書き・revisedFrom・stdout 契約・validate 全緑）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(
    dir,
    rec({ status: 'proposed', rationale: '理由', tags: ['t1'], reviewChecks: ['c1'] }),
  );
  const r = runWithDocs(dir, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'claude', '--summary', '訂正後の要約',
  ]);
  assert.equal(r.status, 0, r.stderr);
  // stdout はちょうど 2 行: 新旧対応 + Memory-Revision trailer（コミットメッセージ転記用の機械出力契約）
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  const m = /^(mem-\d{8}-[a-z0-9]{6}) -> (mem-\d{8}-[a-z0-9]{6})$/.exec(lines[0]);
  assert.ok(m, `1行目が対応行でない: ${lines[0]}`);
  assert.equal(m[1], 'mem-20260101-aaaaaa');
  const newId = m[2];
  assert.notEqual(newId, 'mem-20260101-aaaaaa');
  assert.equal(lines[1], `Memory-Revision: mem-20260101-aaaaaa -> ${newId}`);
  // 旧ファイル消滅・新ファイル生成
  assert.throws(() => readRec(dir, 'mem-20260101-aaaaaa'));
  const created = readRec(dir, newId);
  // roundtrip: revisedFrom がディスク上に残存（normalizeRecord / serializeRecord の追加漏れ検出）
  assert.deepEqual(created.revisedFrom, ['mem-20260101-aaaaaa']);
  assert.equal(created.status, 'proposed');
  // 上書き指定したフィールドのみ変わり、未指定は旧値を継承
  assert.equal(created.summary, '訂正後の要約');
  assert.equal(created.title, 'タイトル');
  assert.equal(created.rationale, '理由');
  assert.deepEqual(created.tags, ['t1']);
  assert.deepEqual(created.reviewChecks, ['c1']);
  assert.deepEqual(created.sources, ['issue#1']);
  // id 日付部・createdAt は本日で再生成（旧値継承だと整合検査に落ちる）
  assert.equal(created.createdAt, formatDate(new Date()));
  assert.equal(newId.slice(4, 12), dateCompact(new Date()));
  // 直後の validate が全緑
  assert.equal(run(dir, ['validate']).status, 0);
});

test('CLI revise: proposed 以外は fail-loud（accepted は supersede/retire 案内・他は履歴として不変）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ id: 'mem-20260101-cccccc' }));
  const accepted = runWithDocs(dir, docs, ['revise', 'mem-20260101-cccccc', '--author', 'a', '--summary', 's']);
  assert.equal(accepted.status, 1);
  assert.match(accepted.stderr, /proposed 専用/);
  assert.match(accepted.stderr, /supersede（後継あり）または retire（後継なし）/);
  assert.equal(readRec(dir, 'mem-20260101-cccccc').status, 'accepted');

  for (const status of ['rejected', 'retired']) {
    writeRec(dir, rec({ id: 'mem-20260101-dddddd', status }));
    const r = runWithDocs(dir, docs, ['revise', 'mem-20260101-dddddd', '--author', 'a', '--summary', 's']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /履歴として残し/);
  }
  writeRec(dir, rec({ id: 'mem-20260101-eeeeee', status: 'superseded', supersededBy: 'mem-20260101-cccccc' }));
  writeRec(dir, rec({ id: 'mem-20260101-cccccc', supersedes: ['mem-20260101-eeeeee'] }));
  const sup = runWithDocs(dir, docs, ['revise', 'mem-20260101-eeeeee', '--author', 'a', '--summary', 's']);
  assert.equal(sup.status, 1);
  assert.match(sup.stderr, /履歴として残し/);
});

test('CLI revise: 引数・フラグの fail-loud（id 欠落/余剰・author 欠落・訂正内容ゼロ・値省略・空 split・禁止フラグ・未知フラグ）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  const cases = [
    [['revise', '--author', 'a', '--summary', 's'], /id を指定してください/],
    [['revise', 'mem-20260101-aaaaaa', 'extra', '--author', 'a', '--summary', 's'], /id を1つだけ取ります/],
    [['revise', 'mem-20260101-zzzzzz', '--author', 'a', '--summary', 's'], /記憶が見つかりません/],
    [['revise', 'mem-20260101-aaaaaa', '--summary', 's'], /--author（author）は必須です/],
    [['revise', 'mem-20260101-aaaaaa', '--author', 'a'], /訂正内容がありません/],
    [['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary'], /--summary には値が必要です/],
    [['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--paths'], /--paths には値が必要です/],
    [['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--paths', ','], /--paths の値が空です/],
    [['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--scope', ''], /--scope の値が空です/],
    [['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', 's', '--status', 'accepted'], /--status は指定できません/],
    [['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', 's', '--supersedes', 'mem-20260101-cccccc'], /--supersedes は指定できません/],
    [['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', 's', '--revisedFrom', 'mem-20260101-cccccc'], /未知のオプション: --revisedFrom/],
  ];
  for (const [args, re] of cases) {
    const r = runWithDocs(dir, docs, args);
    assert.equal(r.status, 1, `exit 1 のはず: ${args.join(' ')}`);
    assert.match(r.stderr, re);
    assert.equal(r.stdout, '', `失敗時 stdout は空: ${args.join(' ')}`);
  }
  // どの失敗でも旧レコードは無傷
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').status, 'proposed');
});

test('CLI revise: supersedes 保持・他レコードから参照される旧はエスカレーション（削除しない）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  // supersedes を持つ proposed（置換提案）は revise 対象外
  writeRec(dir, rec({ id: 'mem-20260101-oooooo' }));
  writeRec(
    dir,
    rec({ id: 'mem-20260102-pppppp', createdAt: '2026-01-02', status: 'proposed', supersedes: ['mem-20260101-oooooo'] }),
  );
  const holds = runWithDocs(dir, docs, ['revise', 'mem-20260102-pppppp', '--author', 'a', '--summary', 's']);
  assert.equal(holds.status, 1);
  assert.match(holds.stderr, /supersedes を持ちます/);
  assert.match(holds.stderr, /人間の判断/);

  // 他レコードの supersedes から参照されている proposed（stale な置換元）も削除しない
  const dir2 = makeDir(t);
  writeRec(dir2, rec({ id: 'mem-20260101-qqqqqq', status: 'proposed' }));
  writeRec(
    dir2,
    rec({ id: 'mem-20260102-rrrrr2', createdAt: '2026-01-02', status: 'proposed', supersedes: ['mem-20260101-qqqqqq'] }),
  );
  const referenced = runWithDocs(dir2, docs, ['revise', 'mem-20260101-qqqqqq', '--author', 'a', '--summary', 's']);
  assert.equal(referenced.status, 1);
  assert.match(referenced.stderr, /から参照されています/);
  assert.ok(readRec(dir2, 'mem-20260101-qqqqqq'));
});

test('CLI revise: 壊れた旧レコード・上書き値の secret（error 級）は書込前に fail-loud（旧は無傷）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, { ...rec({ status: 'proposed' }), bogus: 1 });
  const broken = runWithDocs(dir, docs, ['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', 's']);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /このレコードは不正です/);
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').bogus, 1);

  const dir2 = makeDir(t);
  writeRec(dir2, rec({ status: 'proposed' }));
  // 静的リテラルを置かず実行時連結で組む（github-token 検出正規表現 ghp_[A-Za-z0-9]{30,} に
  // 合致する長さは維持しつつ、strict secret scan の静的一致を避ける。値そのものは変更しない）。
  const secret = runWithDocs(dir2, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'a',
    '--summary', `トークン ${'ghp_' + 'a'.repeat(36)}`,
  ]);
  assert.equal(secret.status, 1);
  assert.match(secret.stderr, /revise 前検証に失敗/);
  assert.ok(readRec(dir2, 'mem-20260101-aaaaaa'));
  // 新レコードは書き込まれていない（旧 1 件のみ）
  assert.match(run(dir2, ['validate']).stderr, /validate: 1 件/);
});

test('CLI revise: 同値再指定（実質 no-op）は fail-loud（id 差し替えの launder 経路を閉じる）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  const sameTitle = runWithDocs(dir, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'claude', '--title', 'タイトル',
  ]);
  assert.equal(sameTitle.status, 1);
  assert.match(sameTitle.stderr, /すべて旧レコードと同一/);
  const sameRationale = runWithDocs(dir, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'claude', '--rationale', '',
  ]);
  assert.equal(sameRationale.status, 1);
  assert.match(sameRationale.stderr, /すべて旧レコードと同一/);
  // 意味的 no-op（末尾空白・配列の並べ替え・Unicode 合成形差）も正規化比較で拒否する
  const trailingSpace = runWithDocs(dir, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'claude', '--title', 'タイトル ',
  ]);
  assert.equal(trailingSpace.status, 1);
  assert.match(trailingSpace.stderr, /正規化後すべて旧レコードと同一/);
  const dir2 = makeDir(t);
  writeRec(dir2, rec({ status: 'proposed', scope: ['github-sync', 'architecture'] }));
  const reordered = runWithDocs(dir2, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'claude', '--scope', 'architecture,github-sync',
  ]);
  assert.equal(reordered.status, 1);
  assert.match(reordered.stderr, /正規化後すべて旧レコードと同一/);
  // 不可視文字（U+200B）の付加・配列要素の重複だけの「訂正」も no-op として拒否する
  const zeroWidth = runWithDocs(dir, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'claude', '--summary', '要約​',
  ]);
  assert.equal(zeroWidth.status, 1);
  assert.match(zeroWidth.stderr, /正規化後すべて旧レコードと同一/);
  const dupElem = runWithDocs(dir2, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'claude', '--scope', 'github-sync,architecture,github-sync',
  ]);
  assert.equal(dupElem.status, 1);
  assert.match(dupElem.stderr, /正規化後すべて旧レコードと同一/);
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').status, 'proposed');

  // ZWJ（U+200D）は意味のある文字（絵文字結合等）なので no-op 正規化で除去されず、正当な訂正として通る
  const dir3 = makeDir(t);
  writeRec(dir3, rec({ status: 'proposed', summary: '家族: 👩👩👧👦' }));
  const zwj = runWithDocs(dir3, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'claude', '--summary', '家族: 👩‍👩‍👧‍👦',
  ]);
  assert.equal(zwj.status, 0, zwj.stderr);
});

test('CLI revise: 未完遂 revise の新側（revisedFrom 先が残存）は revise 拒否（兄弟経由の検出線消失を防ぐ）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-ffffff',
      createdAt: '2026-01-02',
      status: 'proposed',
      revisedFrom: ['mem-20260101-aaaaaa'],
    }),
  );
  // 新側（ffffff）を revise しても、残存検査の検出リンクは消せない
  const sibling = runWithDocs(dir, docs, ['revise', 'mem-20260102-ffffff', '--author', 'a', '--summary', '改題']);
  assert.equal(sibling.status, 1);
  assert.match(sibling.stderr, /未完遂の revise の新側です/);
  assert.ok(readRec(dir, 'mem-20260102-ffffff'));
  assert.equal(run(dir, ['validate']).status, 1);
});

test('CLI revise: 連鎖 revise で revisedFrom が祖先 id を累積する（削除済み祖先の予約が失われない）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  const first = runWithDocs(dir, docs, ['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', '一次訂正']);
  assert.equal(first.status, 0, first.stderr);
  const idB = first.stdout.trim().split('\n')[0].split(' -> ')[1];
  const second = runWithDocs(dir, docs, ['revise', idB, '--author', 'a', '--summary', '二次訂正']);
  assert.equal(second.status, 0, second.stderr);
  const idC = second.stdout.trim().split('\n')[0].split(' -> ')[1];
  assert.deepEqual(readRec(dir, idC).revisedFrom, ['mem-20260101-aaaaaa', idB]);
  // 祖先 A も予約集合に残る
  const reserved = buildIdReservation([readRec(dir, idC)]);
  assert.equal(reserved['mem-20260101-aaaaaa'], true);
  assert.equal(reserved[idB], true);
  assert.equal(run(dir, ['validate']).status, 0);
});

test('buildIdReservation: 現存 id に加え revisedFrom の削除済み旧 id も予約する（再発行→残存誤判定の防止）', () => {
  const reserved = buildIdReservation([
    rec({ status: 'proposed' }),
    rec({ id: 'mem-20260102-ffffff', createdAt: '2026-01-02', revisedFrom: ['mem-20260101-gonegg'] }),
  ]);
  assert.equal(reserved['mem-20260101-aaaaaa'], true);
  assert.equal(reserved['mem-20260102-ffffff'], true);
  assert.equal(reserved['mem-20260101-gonegg'], true);
});

test('validate: 同一旧 id を revisedFrom に持つ複数レコード（並行 revise のフォーク）を警告する', (t) => {
  const dir = makeDir(t);
  writeRec(
    dir,
    rec({ id: 'mem-20260102-f1f1f1', createdAt: '2026-01-02', status: 'proposed', revisedFrom: ['mem-20260101-gonegg'] }),
  );
  writeRec(
    dir,
    rec({ id: 'mem-20260102-f2f2f2', createdAt: '2026-01-02', status: 'proposed', revisedFrom: ['mem-20260101-gonegg'] }),
  );
  const r = run(dir, ['validate']);
  // 旧は削除済み（不在）なので errors にはならないが、フォークとして warning を出す
  assert.equal(r.status, 0);
  assert.match(r.stderr, /同一旧 id を revisedFrom に持つレコードが複数/);

  // フォークの一員を revise で洗浄する経路は拒否される（検出線の消失防止）
  const docs = makeDir(t);
  const launder = runWithDocs(dir, docs, ['revise', 'mem-20260102-f1f1f1', '--author', 'a', '--title', '改題']);
  assert.equal(launder.status, 1);
  assert.match(launder.stderr, /フォークの一員です/);

  // 回復手順どおり片側を reject すると warning は消音される（rejected は採否判断済みとして集計除外）
  assert.equal(run(dir, ['reject', 'mem-20260102-f1f1f1']).status, 0);
  const after = run(dir, ['validate']);
  assert.equal(after.status, 0);
  assert.doesNotMatch(after.stderr, /同一旧 id を revisedFrom に持つレコードが複数/);
});

test('validate: フォーク両側が promote 後に supersede で決着した場合も warning は消音される（superseded は採否判断済み）', (t) => {
  const dir = makeDir(t);
  // フォーク B1, B2（revisedFrom は同一の削除済み旧 id）が両方 accepted になった後、
  // supersede <B2> <B1> で決着した状態: B1 は superseded・B2 は accepted。
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-b1b1b1',
      createdAt: '2026-01-02',
      status: 'superseded',
      supersededBy: 'mem-20260102-b2b2b2',
      revisedFrom: ['mem-20260101-gonegg'],
    }),
  );
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-b2b2b2',
      createdAt: '2026-01-02',
      supersedes: ['mem-20260102-b1b1b1'],
      revisedFrom: ['mem-20260101-gonegg'],
    }),
  );
  const r = run(dir, ['validate']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /同一旧 id を revisedFrom に持つレコードが複数/);
  assert.match(r.stderr, /warnings 0/);
});

test('validate: フォーク片側が通常の supersede で置換されても系譜は後継に帰属し、未決着の別系統が残る限り警告が消えない', (t) => {
  const dir = makeDir(t);
  // フォーク: B（revisedFrom [A]）と D（revisedFrom [A]）。B は通常更新 C（revisedFrom なし）に置換済み。
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-bbbbb1',
      createdAt: '2026-01-02',
      status: 'superseded',
      supersededBy: 'mem-20260103-ccccc1',
      revisedFrom: ['mem-20260101-gonegg'],
    }),
  );
  writeRec(
    dir,
    rec({
      id: 'mem-20260103-ccccc1',
      createdAt: '2026-01-03',
      supersedes: ['mem-20260102-bbbbb1'],
    }),
  );
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-ddddd1',
      createdAt: '2026-01-02',
      status: 'proposed',
      revisedFrom: ['mem-20260101-gonegg'],
    }),
  );
  // B は superseded だが系譜は後継 C に帰属 → C と D の 2 系統でフォーク警告が残る
  const before = run(dir, ['validate']);
  assert.equal(before.status, 0);
  assert.match(before.stderr, /同一旧 id を revisedFrom に持つレコードが複数/);
  // D を reject して決着すると消音される
  assert.equal(run(dir, ['reject', 'mem-20260102-ddddd1']).status, 0);
  const after = run(dir, ['validate']);
  assert.equal(after.status, 0);
  assert.doesNotMatch(after.stderr, /同一旧 id を revisedFrom に持つレコードが複数/);
});

test('CLI revise: revisedFrom から参照される旧（途中中断の併存状態）は再 revise を拒否し検出線を守る', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-ffffff',
      createdAt: '2026-01-02',
      status: 'proposed',
      revisedFrom: ['mem-20260101-aaaaaa'],
    }),
  );
  const r = runWithDocs(dir, docs, ['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', '別の訂正']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /revisedFrom から参照されています/);
  // 旧は無傷＝validate の残存検査（検出線）が生きたまま
  assert.ok(readRec(dir, 'mem-20260101-aaaaaa'));
  assert.equal(run(dir, ['validate']).status, 1);
});

test('validate: revise 途中中断（新旧併存）を revisedFrom 先の残存として検出し回復手順を案内する', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-ffffff',
      createdAt: '2026-01-02',
      status: 'proposed',
      revisedFrom: ['mem-20260101-aaaaaa'],
    }),
  );
  const mid = run(dir, ['validate']);
  assert.equal(mid.status, 1);
  assert.match(mid.stderr, /revisedFrom 先が残存: mem-20260101-aaaaaa/);
  assert.match(mid.stderr, /削除して完遂するか/);
  // 旧を削除すれば完遂（revisedFrom 先の不在が正常状態）
  rmSync(join(dir, 'mem-20260101-aaaaaa.json'));
  assert.equal(run(dir, ['validate']).status, 0);
});

test('validateFieldGrammar: revisedFrom の型・id 形式・重複・自 id を検査（空・省略は合法）', () => {
  assert.equal(validateFieldGrammar(rec({ revisedFrom: [] })).errors.length, 0);
  assert.equal(validateFieldGrammar(rec()).errors.length, 0);
  assert.ok(
    validateFieldGrammar(rec({ revisedFrom: 'x' })).errors.some((e) => /revisedFrom は配列/.test(e)),
  );
  assert.ok(
    validateFieldGrammar(rec({ revisedFrom: [1] })).errors.some((e) => /revisedFrom 要素は文字列/.test(e)),
  );
  assert.ok(
    validateFieldGrammar(rec({ revisedFrom: ['not-an-id'] })).errors.some((e) => /id 形式不正/.test(e)),
  );
  assert.ok(
    validateFieldGrammar(
      rec({ revisedFrom: ['mem-20260101-bbbbbb', 'mem-20260101-bbbbbb'] }),
    ).errors.some((e) => /重複 id/.test(e)),
  );
  assert.ok(
    validateFieldGrammar(rec({ revisedFrom: ['mem-20260101-aaaaaa'] })).errors.some((e) =>
      /自 id は不可/.test(e),
    ),
  );
});

test('CLI revise: docs 走査（旧 id 参照の warning・records 除外・symlink skip・docs 不在 note は非ブロッキング）', (t) => {
  // records を docs 配下に置く実運用配置で、新レコード自身の revisedFrom が偽陽性にならないことを確認
  const docsRoot = makeDir(t);
  const dir = join(docsRoot, 'records');
  mkdirSync(dir);
  writeRec(dir, rec({ status: 'proposed' }));
  // 別レコードの本文が旧 id を自由文で言及するケース（records 除外だと盲点になる）
  writeRec(
    dir,
    rec({
      id: 'mem-20260101-bbbbbb',
      status: 'proposed',
      summary: '旧 mem-20260101-aaaaaa の判断を踏まえる',
    }),
  );
  writeFileSync(join(docsRoot, 'ref.md'), '対応履歴: mem-20260101-aaaaaa を参照');
  writeFileSync(join(docsRoot, 'UPPER.MD'), '大文字拡張子でも mem-20260101-aaaaaa を参照');
  writeFileSync(join(docsRoot, 'unrelated.md'), '無関係');
  symlinkSync(join(docsRoot, 'ref.md'), join(docsRoot, 'link.md'));
  const r = runWithDocs(dir, docsRoot, ['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', 's']);
  assert.equal(r.status, 0, r.stderr);
  const hits = r.stderr.split('\n').filter((l) => l.includes('を参照する in-repo ファイル'));
  // 新レコード自身（revisedFrom に旧 id を保持する唯一の正当参照）だけが除外され、
  // ref.md（小文字）・UPPER.MD（大文字拡張子）・別レコード本文の言及は警告される
  assert.equal(hits.length, 3, r.stderr);
  assert.ok(hits.some((l) => /ref\.md/.test(l)));
  assert.ok(hits.some((l) => /UPPER\.MD/.test(l)));
  assert.ok(hits.some((l) => /mem-20260101-bbbbbb\.json/.test(l)));

  // docs 不在は note を出して走査 skip（exit 0 のまま）
  const dir2 = makeDir(t);
  writeRec(dir2, rec({ status: 'proposed' }));
  const missing = runWithDocs(dir2, join(dir2, 'no-such-docs'), [
    'revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', 's',
  ]);
  assert.equal(missing.status, 0);
  assert.match(missing.stderr, /参照走査をスキップしました/);
});

test('CLI revise: show / digest jsonl に revisedFrom が現れる（消費側が訂正由来を識別できる）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  const r = runWithDocs(dir, docs, ['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', 's']);
  assert.equal(r.status, 0);
  const newId = r.stdout.trim().split('\n')[0].split(' -> ')[1];
  const show = run(dir, ['show', newId]);
  assert.equal(show.status, 0);
  assert.deepEqual(JSON.parse(show.stdout).revisedFrom, ['mem-20260101-aaaaaa']);
  const jsonl = run(dir, ['digest', '--status', 'all', '--format', 'jsonl']);
  assert.equal(jsonl.status, 0);
  const row = jsonl.stdout.trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.id === newId);
  assert.deepEqual(row.revisedFrom, ['mem-20260101-aaaaaa']);
});

// ---- endorse ゲート（#532。設計 §6.0 の legitimacy モデル） ----

test('CLI: promote / reject / retire / supersede は --endorsed-by 無しで fail-loud（記録の強制）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  writeRec(dir, rec({ id: 'mem-20260101-cccccc', status: 'accepted' }));
  writeRec(dir, rec({ id: 'mem-20260102-nnnnnn', createdAt: '2026-01-02', status: 'accepted' }));
  const cases = [
    ['promote', 'mem-20260101-aaaaaa'],
    ['reject', 'mem-20260101-aaaaaa'],
    ['retire', 'mem-20260101-cccccc'],
    ['supersede', 'mem-20260102-nnnnnn', 'mem-20260101-cccccc'],
    ['purge', 'mem-20260101-aaaaaa', '--reason', 'secret'],
  ];
  for (const args of cases) {
    const r = runRaw(dir, args);
    assert.equal(r.status, 1, `${args[0]} が endorse 無しで成功した`);
    assert.match(r.stderr, /--endorsed-by/);
  }
  // 記録が強制されるだけでレコードは無変更（fail-loud は副作用を残さない）
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').status, 'proposed');
  assert.equal(readRec(dir, 'mem-20260101-cccccc').status, 'accepted');
});

test('CLI: 値なし --endorsed-by / 空白のみは fail-loud（空の endorse 記録を作らない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  for (const value of [[], ['--endorsed-by', '   ']]) {
    const r = runRaw(dir, ['promote', 'mem-20260101-aaaaaa', ...value]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--endorsed-by/);
  }
});

test('CLI: trailer に載る値の改行・表示偽装文字は全経路で fail-loud（偽 trailer 行の注入を防ぐ）', (t) => {
  // 貼り付けたコミットメッセージに別操作の偽 endorse 行を紛れ込ませる攻撃。U+2028 は Git 上は
  // 1 行でも GitHub の diff・コミットビューでは改行として描画されるため、目視レビュー（唯一の
  // 検査点）に対して同じ偽装が成立する。双方向制御・ゼロ幅は表示と記録を食い違わせる。
  const payloads = [
    '\nMemory-Endorsement: promote mem-20260101-cccccc by boss',
    '\u2028Memory-Endorsement: promote mem-20260101-cccccc by boss',
    '\u202eesrever',
    '\u061cesrever',
    'co\u2063dex',
    'a\u200bb',
  ];
  // endorse を取る全経路（必須の 5 コマンド＋任意の revise）で同一のガードが効くこと
  for (const payload of payloads) {
    const dir = makeDir(t);
    const docs = makeDir(t);
    writeRec(dir, rec({ status: 'proposed' }));
    for (const args of [
      ['promote', 'mem-20260101-aaaaaa'],
      ['reject', 'mem-20260101-aaaaaa'],
      ['purge', 'mem-20260101-aaaaaa', '--reason', 'secret'],
      ['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', 's2'],
    ]) {
      const r = runRaw(dir, [...args, '--endorsed-by', `x${payload}`], {
        AGENT_MEMORY_DOCS_DIR: docs,
      });
      assert.equal(r.status, 1, `${args[0]} が ${JSON.stringify(payload)} を通した`);
      assert.match(r.stderr, /改行・制御文字・双方向制御・ゼロ幅文字/);
    }
    // どの経路も副作用を残さない
    assert.equal(readRec(dir, 'mem-20260101-aaaaaa').status, 'proposed');
  }

  // purge の --reason も同じ trailer 行に載るため同じガードを通る
  const dir2 = makeDir(t);
  writeRec(dir2, rec());
  const badReason = runRaw(dir2, [
    'purge', 'mem-20260101-aaaaaa', '--endorsed-by', 'human',
    '--reason', 'x\nMemory-Purge: mem-20260101-cccccc (secret)',
  ]);
  assert.equal(badReason.status, 1);
  assert.match(badReason.stderr, /--reason/);
  assert.ok(readRec(dir2, 'mem-20260101-aaaaaa'));

  // 長すぎる値は trailer 行で他の記録を押し流せるため拒否
  const tooLong = runRaw(dir2, ['promote', 'mem-20260101-aaaaaa', '--endorsed-by', 'a'.repeat(201)]);
  assert.equal(tooLong.status, 1);
  assert.match(tooLong.stderr, /長すぎます/);

  // 空白・ハイフンを含む実在しうる名前は通す（過剰な拒否をしない）
  const dir3 = makeDir(t);
  writeRec(dir3, rec({ status: 'proposed' }));
  const ok = runRaw(dir3, ['promote', 'mem-20260101-aaaaaa', '--endorsed-by', 'Clock Crock-work']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /by Clock Crock-work$/m);
});

test('CLI purge: --retire-orphans は boolean（=value 構文は fail-loud。復活辺の語彙を持たない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  // 受理値が retire 一択になった時点で enum の器（値付きフラグ）は廃止した（減算レビュー）。
  // superseded → accepted の復活は add --replaces → promote の正規経路のみ。
  const eq = run(dir, ['purge', 'mem-20260101-aaaaaa', '--reason', 'secret', '--retire-orphans=true']);
  assert.equal(eq.status, 1);
  assert.match(eq.stderr, /値を取りません/);
  // 旧フラグ（--on-superseded）は未知フラグとして fail-loud（黙って無視しない）
  const legacy = run(dir, ['purge', 'mem-20260101-aaaaaa', '--reason', 'secret', '--on-superseded', 'retire']);
  assert.equal(legacy.status, 1);
  assert.ok(readRec(dir, 'mem-20260101-aaaaaa'), '検証失敗なのに削除された');
});

test('CLI: 遷移コマンドは stdout に Memory-Endorsement trailer を出す（git log --grep で列挙可能）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  const r = runRaw(dir, ['promote', 'mem-20260101-aaaaaa', '--endorsed-by', 'clockcrockwork']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], 'mem-20260101-aaaaaa');
  assert.equal(lines[1], 'Memory-Endorsement: promote mem-20260101-aaaaaa by clockcrockwork');
});

test('CLI supersede: trailer には新旧両方の id を並べる（どのリンクを endorse したか特定できる）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ id: 'mem-20260101-cccccc' }));
  writeRec(dir, rec({ id: 'mem-20260102-nnnnnn', createdAt: '2026-01-02' }));
  const r = runRaw(dir, [
    'supersede', 'mem-20260102-nnnnnn', 'mem-20260101-cccccc', '--endorsed-by', 'human',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /^Memory-Endorsement: supersede mem-20260102-nnnnnn mem-20260101-cccccc by human$/m,
  );
});

test('CLI revise: --endorsed-by は任意。付ければ endorse trailer が増え、無ければブランチ確認の催促が出る', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  const plain = runWithDocs(dir, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'claude', '--summary', 's2',
  ]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.trim().split('\n').length, 2);
  assert.match(plain.stderr, /作業ブランチで add したもの/);

  const dir2 = makeDir(t);
  writeRec(dir2, rec({ status: 'proposed' }));
  const endorsed = runWithDocs(dir2, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'claude', '--summary', 's2',
    '--endorsed-by', 'human',
  ]);
  assert.equal(endorsed.status, 0, endorsed.stderr);
  const lines = endorsed.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], 'Memory-Endorsement: revise mem-20260101-aaaaaa by human');
  // endorse 済み＝作業ブランチ外の正規経路なので、ブランチ確認の催促は出さない
  assert.doesNotMatch(endorsed.stderr, /作業ブランチで add したもの/);
});

// ---- replaces（#532。reject → 正しい内容の新規 add の系譜追跡） ----

test('validate: replaces 先は実在必須かつ rejected / retired のみ（revisedFrom と逆）', () => {
  const rejected = rec({ id: 'mem-20260101-rrrrrr', status: 'rejected' });
  const retired = rec({ id: 'mem-20260101-tttttt', status: 'retired' });
  const accepted = rec({ id: 'mem-20260101-cccccc', status: 'accepted' });
  const proposed = rec({ id: 'mem-20260101-pppppp', status: 'proposed' });
  const idx = indexOf([rejected, retired, accepted, proposed]);

  for (const target of ['mem-20260101-rrrrrr', 'mem-20260101-tttttt']) {
    const ok = normalizeRecord(rec({ id: 'mem-20260102-nnnnnn', replaces: [target] }));
    assert.deepEqual(validateLinks(ok, idx).errors, [], `${target} が拒否された`);
  }
  const missing = normalizeRecord(rec({ id: 'mem-20260102-nnnnnn', replaces: ['mem-20260101-zzzzzz'] }));
  assert.match(validateLinks(missing, idx).errors.join('\n'), /replaces 先が存在しない/);

  const onAccepted = normalizeRecord(rec({ id: 'mem-20260102-nnnnnn', replaces: ['mem-20260101-cccccc'] }));
  assert.match(validateLinks(onAccepted, idx).errors.join('\n'), /add --supersedes → promote/);
  const onProposed = normalizeRecord(rec({ id: 'mem-20260102-nnnnnn', replaces: ['mem-20260101-pppppp'] }));
  assert.match(validateLinks(onProposed, idx).errors.join('\n'), /revise/);
});

test('文法検査: replaces の id 形式・重複・自 id はエラー', () => {
  const bad = validateFieldGrammar(rec({ replaces: ['not-an-id'] }));
  assert.match(bad.errors.join('\n'), /replaces の id 形式不正/);
  const dup = validateFieldGrammar(
    rec({ replaces: ['mem-20260101-rrrrrr', 'mem-20260101-rrrrrr'] }),
  );
  assert.match(dup.errors.join('\n'), /replaces に重複 id/);
  const self = validateFieldGrammar(rec({ replaces: ['mem-20260101-aaaaaa'] }));
  assert.match(self.errors.join('\n'), /replaces に自 id は不可/);
});

test('CLI add --replaces: rejected は受理・accepted は案内付き fail-loud（壊れた proposed を書かない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ id: 'mem-20260101-rrrrrr', status: 'rejected' }));
  writeRec(dir, rec({ id: 'mem-20260101-cccccc', status: 'accepted' }));
  const base = [
    'add', '--kind', 'decision', '--title', 't', '--summary', 's',
    '--author', 'claude', '--scope', 'github-sync', '--sources', 'issue#532',
  ];
  const ok = run(dir, [...base, '--replaces', 'mem-20260101-rrrrrr']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readRec(dir, ok.stdout.trim()).replaces, ['mem-20260101-rrrrrr']);

  const before = readdirSync(dir).length;
  const ng = run(dir, [...base, '--replaces', 'mem-20260101-cccccc']);
  assert.equal(ng.status, 1);
  assert.match(ng.stderr, /--supersedes/);
  assert.equal(readdirSync(dir).length, before, '検証失敗なのにレコードが書かれた');

  const missing = run(dir, [...base, '--replaces', 'mem-20260101-zzzzzz']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /replaces 先が存在しない/);
});

test('CLI revise: replaces は継承され --replaces での上書きは拒否（系譜を訂正で失わない）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ id: 'mem-20260101-rrrrrr', status: 'rejected' }));
  writeRec(dir, rec({ status: 'proposed', replaces: ['mem-20260101-rrrrrr'] }));
  const rejectFlag = runWithDocs(dir, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', 's2',
    '--replaces', 'mem-20260101-rrrrrr',
  ]);
  assert.equal(rejectFlag.status, 1);
  assert.match(rejectFlag.stderr, /--replaces は指定できません/);

  const r = runWithDocs(dir, docs, ['revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', 's2']);
  assert.equal(r.status, 0, r.stderr);
  const newId = r.stdout.trim().split('\n')[0].split(' -> ')[1];
  assert.deepEqual(readRec(dir, newId).replaces, ['mem-20260101-rrrrrr']);
  assert.equal(run(dir, ['validate']).status, 0);
});

test('CLI revise: 継承する replaces が壊れている場合は書込前に拒否する（旧は無変更）', (t) => {
  // フィールド文法検査は単一レコードで閉じるため、旧の replaces 先が実在しない/終端状態でない
  // ケースはこれまで検出されず、revise は exit 0 のまま corpus を壊していた（外部レビュー指摘）。
  const dir = makeDir(t);
  const docs = makeDir(t);
  // ケース1: replaces 先が実在しない
  writeRec(dir, rec({ status: 'proposed', replaces: ['mem-20260101-zzzzzz'] }));
  const missing = runWithDocs(dir, docs, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', 's2',
  ]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /replaces 先が存在しない/);
  assert.ok(readRec(dir, 'mem-20260101-aaaaaa'), '検証失敗なのに旧が削除された');

  // ケース2: replaces 先が非終端状態（accepted）
  const dir2 = makeDir(t);
  writeRec(dir2, rec({ id: 'mem-20260101-cccccc', status: 'accepted' }));
  writeRec(
    dir2,
    rec({
      id: 'mem-20260102-dddddd',
      createdAt: '2026-01-02',
      status: 'proposed',
      replaces: ['mem-20260101-cccccc'],
    }),
  );
  const nonTerminal = runWithDocs(dir2, docs, [
    'revise', 'mem-20260102-dddddd', '--author', 'a', '--summary', 's2',
  ]);
  assert.equal(nonTerminal.status, 1);
  assert.match(nonTerminal.stderr, /replaces 先 mem-20260101-cccccc が rejected \/ retired でない/);
  assert.ok(readRec(dir2, 'mem-20260102-dddddd'), '検証失敗なのに旧が削除された');
});

// ---- purge（#532。secret 混入レコードの削除＋リンク整合の回復） ----

test('CLI purge: --reason / --endorsed-by は必須（無痕跡の取り下げ経路にしない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  for (const args of [
    ['purge', 'mem-20260101-aaaaaa', '--endorsed-by', 'human'],
    ['purge', 'mem-20260101-aaaaaa', '--reason', 'secret'],
  ]) {
    const r = runRaw(dir, args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--(reason|endorsed-by)/);
  }
  assert.ok(readRec(dir, 'mem-20260101-aaaaaa'), '検証失敗なのに削除された');
});

test('CLI purge: 対象本文に secret パターンが無い場合は警告する（拒否はしない）', (t) => {
  // 敵対的レビュー指摘: purge は「secret 混入専用」と自称するが、削除対象レコード本文の
  // secret 有無を一度も検証しなかったため、任意の accepted を無警告で消せる一般削除コマンドに
  // なっていた。既知パターン外の secret を偽陰性で弾いて漏洩対応を止めるコストの方が大きいため
  // 拒否はしないが、警告は必ず出す（用途の限定を最終的に担保するレビューへの手がかりにする）。
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec());
  const r = run(dir, ['purge', 'mem-20260101-aaaaaa', '--reason', '提案の取り下げ'], {
    AGENT_MEMORY_DOCS_DIR: docs,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /secret パターンが検出されませんでした/);
  assert.throws(() => readRec(dir, 'mem-20260101-aaaaaa'), 'secret 未検出でも拒否しない設計');
});

test('CLI purge: 対象本文に secret パターンがあれば警告しない', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ rationale: 'AKIAIOSFODNN7EXAMPLE' }));
  const r = run(dir, ['purge', 'mem-20260101-aaaaaa', '--reason', 'AWS アクセスキー混入'], {
    AGENT_MEMORY_DOCS_DIR: docs,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /secret パターンが検出されませんでした/);
});

test('CLI purge: 単独レコードを削除し Memory-Purge / Memory-Endorsement trailer を出す', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec());
  const r = run(dir, ['purge', 'mem-20260101-aaaaaa', '--reason', 'secret 混入'], {
    AGENT_MEMORY_DOCS_DIR: docs,
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(lines, [
    'mem-20260101-aaaaaa',
    // 必須にした --reason は trailer に残す（stderr の echo だけだと git log から引けない）
    'Memory-Purge: mem-20260101-aaaaaa (secret 混入)',
    'Memory-Endorsement: purge mem-20260101-aaaaaa by human',
  ]);
  assert.throws(() => readRec(dir, 'mem-20260101-aaaaaa'));
  // 作業ツリーの削除だけでは終わらないことを必ず告げる（Git 履歴に secret が残る）
  assert.match(r.stderr, /public-release-checklist/);
});

test('CLI purge: supersedes / replaces の参照元から id を除去する（dangling を残さない）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ id: 'mem-20260101-rrrrrr', status: 'rejected' }));
  writeRec(
    dir,
    rec({ id: 'mem-20260102-nnnnnn', createdAt: '2026-01-02', replaces: ['mem-20260101-rrrrrr'] }),
  );
  const r = run(dir, ['purge', 'mem-20260101-rrrrrr', '--reason', 'secret'], {
    AGENT_MEMORY_DOCS_DIR: docs,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readRec(dir, 'mem-20260102-nnnnnn').replaces ?? [], []);
  // strip した被参照は docs 走査には出ない（走査時点で id が消えている）ため明示報告する
  assert.match(r.stderr, /mem-20260102-nnnnnn の supersedes \/ replaces から/);
  assert.equal(run(dir, ['validate']).status, 0);
});

test('CLI purge: 置換先を消す場合は --retire-orphans の明示指定が必須（暗黙の既定値を持たない）', (t) => {
  const docs = makeDir(t);
  // noFlag / retire の両分岐が同一 corpus を検査することをフィクスチャ共有で保証する
  const setup = () => {
    const d = makeDir(t);
    writeRec(d, rec({ status: 'superseded', supersededBy: 'mem-20260102-nnnnnn' }));
    writeRec(
      d,
      rec({
        id: 'mem-20260102-nnnnnn',
        createdAt: '2026-01-02',
        supersedes: ['mem-20260101-aaaaaa'],
      }),
    );
    return d;
  };
  const dir = setup();
  const noFlag = run(dir, ['purge', 'mem-20260102-nnnnnn', '--reason', 'secret'], {
    AGENT_MEMORY_DOCS_DIR: docs,
  });
  assert.equal(noFlag.status, 1);
  assert.match(noFlag.stderr, /--retire-orphans/);
  assert.ok(readRec(dir, 'mem-20260102-nnnnnn'), '判断待ちなのに削除された');

  const retireDir = setup();
  const retire = run(
    retireDir,
    ['purge', 'mem-20260102-nnnnnn', '--reason', 'secret', '--retire-orphans'],
    { AGENT_MEMORY_DOCS_DIR: docs },
  );
  assert.equal(retire.status, 0, retire.stderr);
  assert.equal(readRec(retireDir, 'mem-20260101-aaaaaa').status, 'retired');
  assert.equal(readRec(retireDir, 'mem-20260101-aaaaaa').supersededBy ?? null, null);
  assert.equal(run(retireDir, ['validate']).status, 0);
});

test('CLI purge: 削除済み id への再実行はリンク修復のみ完遂する（中断からの回復）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(
    dir,
    rec({ id: 'mem-20260101-rrrrrr', status: 'rejected' }),
  );
  writeRec(
    dir,
    rec({ id: 'mem-20260102-nnnnnn', createdAt: '2026-01-02', replaces: ['mem-20260101-rrrrrr'] }),
  );
  // 削除だけ済んで修復前に中断した状態を再現（validate が dangling を error として検出する側）
  rmSync(join(dir, 'mem-20260101-rrrrrr.json'));
  const broken = run(dir, ['validate']);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /replaces 先が存在しない/);

  const r = run(dir, ['purge', 'mem-20260101-rrrrrr', '--reason', 'secret'], {
    AGENT_MEMORY_DOCS_DIR: docs,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /既にありません/);
  assert.equal(run(dir, ['validate']).status, 0);
});

test('CLI purge: 対象も修復対象も無い id は fail-loud（存在しない id の空振りを成功にしない）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec());
  const r = run(dir, ['purge', 'mem-20260101-zzzzzz', '--reason', 'secret'], {
    AGENT_MEMORY_DOCS_DIR: docs,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /修復すべきリンクもありません/);
});

test('CLI: endorser に " by " は使えない（trailer の <id...> by <endorser> 分解の曖昧化を防ぐ）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  const r = runRaw(dir, ['promote', 'mem-20260101-aaaaaa', '--endorsed-by', 'alice by proxy']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /" by " を含められません/);
});

test('CLI promote: 変更ゼロの再実行は trailer を stdout に出さない（回復候補は stderr に案内）', (t) => {
  // no-op で stdout に trailer を出すと、diff を伴わない endorse 記録を任意に量産できる
  // （trailer と実状態遷移の 1:1 対応が崩れる。敵対的レビューが実証）。回復用の候補 trailer は
  // stderr のみに置く（cmdRevise の unlink 失敗経路と同じ作法）。
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'accepted' }));
  const r = runRaw(dir, ['promote', 'mem-20260101-aaaaaa', '--endorsed-by', 'human']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Memory-Endorsement/, 'no-op なのに stdout に trailer が出た');
  assert.match(r.stderr, /変更なし/);
  assert.match(r.stderr, /Memory-Endorsement: promote mem-20260101-aaaaaa by human/);
  assert.match(r.stderr, /中断していた（＝コミット履歴に記録が無い）場合のみ/);
});

test('CLI promote: no-op 経路でも自己 endorse を警告する（偽記録の誘因が最も強い経路）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'accepted' }));
  const r = runRaw(dir, ['promote', 'mem-20260101-aaaaaa', '--endorsed-by', 'Claude']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /エージェント名です/);
});

test('CLI: endorser がエージェント名 / author と同一なら警告する（自己 endorse の可視化）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed', author: 'someone' }));
  const agent = runRaw(dir, ['promote', 'mem-20260101-aaaaaa', '--endorsed-by', 'Claude']);
  assert.equal(agent.status, 0, agent.stderr);
  assert.match(agent.stderr, /エージェント名です/);

  const dir2 = makeDir(t);
  writeRec(dir2, rec({ status: 'proposed', author: 'someone' }));
  const sameAuthor = runRaw(dir2, ['promote', 'mem-20260101-aaaaaa', '--endorsed-by', 'someone']);
  assert.equal(sameAuthor.status, 0, sameAuthor.stderr);
  assert.match(sameAuthor.stderr, /author と同一/);
  // 警告であってブロックではない（人間が author を兼ねる正当なケースがある）
  assert.match(sameAuthor.stdout, /Memory-Endorsement: promote/);
});

test('CLI purge: orphan の退役・系譜の除去を warning で報告し、trailer に orphan id も載せる', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ status: 'superseded', supersededBy: 'mem-20260102-nnnnnn' }));
  writeRec(
    dir,
    rec({ id: 'mem-20260102-nnnnnn', createdAt: '2026-01-02', supersedes: ['mem-20260101-aaaaaa'] }),
  );
  const r = run(
    dir,
    ['purge', 'mem-20260102-nnnnnn', '--reason', 'secret', '--retire-orphans'],
    { AGENT_MEMORY_DOCS_DIR: docs },
  );
  assert.equal(r.status, 0, r.stderr);
  // 復旧遷移は状態を書き換えるので明示報告し、再有効化の正規経路も添える
  assert.match(r.stderr, /mem-20260101-aaaaaa を retired へ退役させました/);
  assert.match(r.stderr, /add --replaces mem-20260101-aaaaaa/);
  // 1 回の endorse で status が変わった全 id を trailer に載せる（git log で追跡可能にする）。
  // op は purge に統一（復旧遷移が retire 一択なので語彙を分けない）
  assert.match(
    r.stdout,
    /^Memory-Endorsement: purge mem-20260102-nnnnnn mem-20260101-aaaaaa by human$/m,
  );
});

test('CLI promote/supersede: 完遂済みリンクの冪等な再実行は trailer を stdout に出さない', (t) => {
  // supersedes を持つレコードは配列が非空のままなので、「配列の有無」で no-op を判定する
  // だけでは済まない（Codex レビュー指摘）。no-op 判定は applySupersedeWrites の実書込有無で行い、
  // 変更ゼロなら trailer は stderr の回復案内のみ（stdout 契約は「遷移させた実行」に限る）。
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'accepted' }));
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-nnnnnn',
      createdAt: '2026-01-02',
      status: 'proposed',
      supersedes: ['mem-20260101-aaaaaa'],
    }),
  );
  const first = runRaw(dir, ['promote', 'mem-20260102-nnnnnn', '--endorsed-by', 'human']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Memory-Endorsement: promote/);
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').status, 'superseded');

  const again = runRaw(dir, ['promote', 'mem-20260102-nnnnnn', '--endorsed-by', 'human']);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /Memory-Endorsement/, '完遂済みの再実行で stdout に trailer が出た');
  assert.match(again.stderr, /Memory-Endorsement: promote mem-20260102-nnnnnn by human/);

  // supersede も同様
  const sup = runRaw(dir, [
    'supersede', 'mem-20260102-nnnnnn', 'mem-20260101-aaaaaa', '--endorsed-by', 'human',
  ]);
  assert.equal(sup.status, 0, sup.stderr);
  assert.doesNotMatch(sup.stdout, /Memory-Endorsement/, '完遂済み supersede で stdout に trailer が出た');
  assert.match(sup.stderr, /完遂済みです/);
  assert.match(sup.stderr, /Memory-Endorsement: supersede mem-20260102-nnnnnn mem-20260101-aaaaaa by human/);
});
test('CLI purge: 削除対象自身の author も自己 endorse 判定の対象にする', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  // 孤立レコード（strip / orphans がともに空）でも対象の author が検査されること
  writeRec(dir, rec({ author: 'someone' }));
  const r = run(dir, ['purge', 'mem-20260101-aaaaaa', '--reason', 'secret'], {
    AGENT_MEMORY_DOCS_DIR: docs,
  });
  assert.equal(r.status, 0, r.stderr);
  const dir2 = makeDir(t);
  writeRec(dir2, rec({ author: 'someone' }));
  const selfEndorsed = runRaw(dir2, [
    'purge', 'mem-20260101-aaaaaa', '--reason', 'secret', '--endorsed-by', 'someone',
  ], { AGENT_MEMORY_DOCS_DIR: docs });
  assert.equal(selfEndorsed.status, 0, selfEndorsed.stderr);
  assert.match(selfEndorsed.stderr, /author と同一/);
});

test('CLI purge: revisedFrom に対象 id を持つ後継は「更新してください」警告の対象外', (t) => {
  const dir = makeDir(t);
  // 走査対象を records ディレクトリ自身に向け、後継 JSON が走査に掛かる状況を作る
  // revise 途中中断（新旧併存）状態で旧側を purge する。旧が消えれば後継の revisedFrom は
  // 正常な監査系譜になるので、更新を促してはならない。
  writeRec(dir, rec({ status: 'proposed' }));
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-nnnnnn',
      createdAt: '2026-01-02',
      status: 'proposed',
      revisedFrom: ['mem-20260101-aaaaaa'],
    }),
  );
  const r = run(dir, ['purge', 'mem-20260101-aaaaaa', '--reason', 'secret'], {
    AGENT_MEMORY_DOCS_DIR: dir,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(
    r.stderr,
    /warning: 削除した id mem-20260101-aaaaaa を参照する in-repo ファイル/,
    '正当な revisedFrom 参照に更新を促した',
  );
  assert.match(r.stderr, /revisedFrom に mem-20260101-aaaaaa を保持します/);
  assert.equal(run(dir, ['validate']).status, 0);
});

test('CLI revise: --endorsed-by 経路でも自己 endorse を警告する', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ status: 'proposed', author: 'someone' }));
  const r = runRaw(dir, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'someone', '--summary', 's2',
    '--endorsed-by', 'someone',
  ], { AGENT_MEMORY_DOCS_DIR: docs });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /author と同一/);
  assert.match(r.stdout, /Memory-Endorsement: revise/);
});

test('CLI purge: --reason に secret 実値を書くと fail-loud（漏洩対応が再漏洩を作らない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  // 理由は Memory-Purge trailer 経由でコミットメッセージに残るため、実値は拒否する
  const leaked = runRaw(dir, [
    'purge', 'mem-20260101-aaaaaa', '--endorsed-by', 'human',
    '--reason', 'AKIAIOSFODNN7EXAMPLE が混入',
  ]);
  assert.equal(leaked.status, 1);
  assert.match(leaked.stderr, /secret らしきパターン/);
  assert.ok(readRec(dir, 'mem-20260101-aaaaaa'), '検証失敗なのに削除された');

  // 種別だけなら通る
  const ok = run(dir, [
    'purge', 'mem-20260101-aaaaaa', '--reason', 'AWS アクセスキー混入',
  ], { AGENT_MEMORY_DOCS_DIR: makeDir(t) });
  assert.equal(ok.status, 0, ok.stderr);
});

test('CLI purge: 修復対象にも同じ secret がある場合でもリンク修復できる（相互待ちの回避）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  // 同じ漏洩値が置換チェーンの両側にある状況。secret 検出で修復対象を弾くと、どちらの
  // レコードも purge できず漏洩対応が進まなくなる。
  const leak = 'AKIAIOSFODNN7EXAMPLE';
  writeRec(
    dir,
    rec({ status: 'superseded', supersededBy: 'mem-20260102-nnnnnn', rationale: leak }),
  );
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-nnnnnn',
      createdAt: '2026-01-02',
      supersedes: ['mem-20260101-aaaaaa'],
      rationale: leak,
    }),
  );
  const r = run(
    dir,
    ['purge', 'mem-20260102-nnnnnn', '--reason', 'AWS アクセスキー混入', '--retire-orphans'],
    { AGENT_MEMORY_DOCS_DIR: docs },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').status, 'retired');
});

test('CLI purge: revisedFrom 以外に対象 id が残るファイルは警告対象に戻す', (t) => {
  const dir = makeDir(t);
  // 後継の revisedFrom は正当だが、同じファイルの summary に残る自由文参照は更新が必要
  writeRec(dir, rec({ status: 'proposed' }));
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-nnnnnn',
      createdAt: '2026-01-02',
      status: 'proposed',
      revisedFrom: ['mem-20260101-aaaaaa'],
      summary: 'mem-20260101-aaaaaa を訂正した記録',
    }),
  );
  const r = run(dir, ['purge', 'mem-20260101-aaaaaa', '--reason', 'secret 種別'], {
    AGENT_MEMORY_DOCS_DIR: dir,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /revisedFrom に mem-20260101-aaaaaa を保持します/);
  // revisedFrom を除いても summary に id が残るので、更新を促す警告は出す
  assert.match(r.stderr, /warning: 削除した id mem-20260101-aaaaaa を参照する in-repo ファイル/);
});

test('validate: 同一の差し替え元を replaces に持つレコードが複数あっても警告しない（片方向系譜）', (t) => {
  // replaces は旧側を書き換えない片方向リンクで dangling も競合敗北も起こらないため、
  // 「同一の rejected を複数が replaces する」は不整合ではなく並行提案（採否はレビューの判断）。
  // 双方向リンクの supersedes とは検出の必要性が異なるので、増殖警告は持たない。
  const dir = makeDir(t);
  writeRec(dir, rec({ id: 'mem-20260101-rrrrrr', status: 'rejected' }));
  for (const id of ['mem-20260102-aaaaaa', 'mem-20260102-bbbbbb']) {
    writeRec(
      dir,
      rec({ id, createdAt: '2026-01-02', status: 'proposed', replaces: ['mem-20260101-rrrrrr'] }),
    );
  }
  const r = run(dir, ['validate']);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /replaces に持つレコードが複数/);
});

test('CLI purge: supersede チェーン中間ノードの purge — corpus が valid に戻り、変更した全レコードが trailer に載る', (t) => {
  // 外部レビュー P1 の再発防止と追跡可能性を同一フィクスチャで固定する（フィクスチャを分けると
  // 仕様変更時に trailer 検査と valid 復帰検査が別シナリオへ乖離する。品質レビュー指摘）。
  // winner（wwwwww）が purge 対象（nnnnnn）とその祖先（aaaaaa）の両方を supersedes する状態で
  // 中間ノードを消すと、以前は片方向リンクが残り purge exit 0 なのに validate error になった。
  // 現仕様は祖先を退役させ、winner.supersedes から祖先 id も除去し（系譜の主張は warning と
  // Git 履歴に残る）、変更した全レコードの id を trailer に「削除 id 先頭＋変更分昇順」で載せる。
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ status: 'superseded', supersededBy: 'mem-20260102-nnnnnn' }));
  writeRec(
    dir,
    rec({
      id: 'mem-20260102-nnnnnn',
      createdAt: '2026-01-02',
      status: 'superseded',
      supersededBy: 'mem-20260103-wwwwww',
      supersedes: ['mem-20260101-aaaaaa'],
    }),
  );
  writeRec(
    dir,
    rec({
      id: 'mem-20260103-wwwwww',
      createdAt: '2026-01-03',
      supersedes: ['mem-20260101-aaaaaa', 'mem-20260102-nnnnnn'],
    }),
  );
  const r = run(
    dir,
    ['purge', 'mem-20260102-nnnnnn', '--reason', 'secret 種別', '--retire-orphans'],
    { AGENT_MEMORY_DOCS_DIR: docs },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /mem-20260101-aaaaaa を retired へ退役させました/);
  assert.match(r.stderr, /mem-20260103-wwwwww の supersedes \/ replaces から/);
  const ancestor = readRec(dir, 'mem-20260101-aaaaaa');
  assert.equal(ancestor.status, 'retired');
  assert.equal(ancestor.supersededBy ?? null, null);
  const winner = readRec(dir, 'mem-20260103-wwwwww');
  assert.deepEqual(winner.supersedes ?? [], [], 'winner の supersedes に退役側への片方向リンクが残った');
  assert.equal(run(dir, ['validate']).status, 0, run(dir, ['validate']).stderr);
  assert.match(
    r.stdout,
    /^Memory-Endorsement: purge mem-20260102-nnnnnn mem-20260101-aaaaaa mem-20260103-wwwwww by human$/m,
  );
});
test('CLI purge: orphan を supersedes する生存側は status を問わずリンクを除去し corpus を valid に保つ', (t) => {
  // rehome（supersededBy の張り替え）は status 依存の分岐が2度 P1 を生んだため全廃した。
  // orphan を retired にすると、それを supersedes に持つ生存側は accepted / superseded /
  // proposed のいずれでも片方向リンクの validate error になる（実測）。生存側の status を
  // 問わず supersedes から orphan id を除去することで、どの組合せでも valid に戻す。
  for (const survivorStatus of ['accepted', 'superseded', 'proposed']) {
    const dir = makeDir(t);
    const docs = makeDir(t);
    writeRec(dir, rec({ status: 'superseded', supersededBy: 'mem-20260102-nnnnnn' }));
    writeRec(
      dir,
      rec({ id: 'mem-20260102-nnnnnn', createdAt: '2026-01-02', supersedes: ['mem-20260101-aaaaaa'] }),
    );
    const survivor = {
      id: 'mem-20260103-ssssss',
      createdAt: '2026-01-03',
      status: survivorStatus,
      supersedes: ['mem-20260101-aaaaaa'],
    };
    if (survivorStatus === 'superseded') {
      survivor.supersededBy = 'mem-20260104-wwwwww';
      writeRec(
        dir,
        rec({ id: 'mem-20260104-wwwwww', createdAt: '2026-01-04', supersedes: ['mem-20260103-ssssss'] }),
      );
    }
    writeRec(dir, rec(survivor));
    const r = run(
      dir,
      ['purge', 'mem-20260102-nnnnnn', '--reason', 'secret 種別', '--retire-orphans'],
      { AGENT_MEMORY_DOCS_DIR: docs },
    );
    assert.equal(r.status, 0, `survivor=${survivorStatus}: ${r.stderr}`);
    const ancestor = readRec(dir, 'mem-20260101-aaaaaa');
    assert.equal(ancestor.status, 'retired', `survivor=${survivorStatus}`);
    assert.equal(ancestor.supersededBy ?? null, null);
    assert.deepEqual(readRec(dir, 'mem-20260103-ssssss').supersedes ?? [], [], `survivor=${survivorStatus}: 片方向リンクが残った`);
    const v = run(dir, ['validate']);
    assert.equal(v.status, 0, `survivor=${survivorStatus}: purge 後に validate が失敗\n${v.stderr}`);
  }
});

test('CLI: --endorsed-by に secret パターンは trailer 発行前に fail-loud', (t) => {
  // この値は Memory-Endorsement trailer としてコミットメッセージに残る（--reason と同じ経路）。
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  // 公式サンプル値（gitleaks 既定 allowlist 対象。本ファイル内の他フィクスチャと同じ値）を使う。
  const r = runRaw(dir, ['promote', 'mem-20260101-aaaaaa', '--endorsed-by', 'AKIAIOSFODNN7EXAMPLE']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /secret らしきパターン/);
  assert.doesNotMatch(r.stdout, /Memory-Endorsement/);
  assert.equal(readRec(dir, 'mem-20260101-aaaaaa').status, 'proposed', '検証失敗なのに遷移した');
});
test('CLI purge: warn 級の credential も --reason で拒否する（レコード本文とは許容度が違う）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  // inline-credential はレコード本文では warn（引用が偽陽性になりやすい）だが、--reason は
  // 種別を一言書く欄で引用の必要がなく、値はコミットメッセージに残る
  const r = runRaw(dir, [
    'purge', 'mem-20260101-aaaaaa', '--endorsed-by', 'human',
    '--reason', 'password="correct-horse-battery"',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /inline-credential/);
  assert.ok(readRec(dir, 'mem-20260101-aaaaaa'), '検証失敗なのに削除された');
});

test('CLI: 日本語名・空白入りの endorser は通る（bidi/ゼロ幅ガードが過剰拒否しない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  const r = runRaw(dir, ['promote', 'mem-20260101-aaaaaa', '--endorsed-by', '時計 太郎']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /by 時計 太郎$/m);
});

test('CLI purge: secret 検査の除外が他の文法エラーを巻き込まない（検査のデータ削除への反転を防ぐ）', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  // 未知フィールド名に検出メッセージと同じ文字列を仕込む。文字列包含で除外していると、この
  // 未知フィールドの文法エラーごと消え、purge が exit 0 で writeRecord の正規化が未知
  // フィールドを黙って落とす（fail-loud のはずの検査がデータ削除に反転する）。
  writeRec(dir, {
    ...rec({ status: 'superseded', supersededBy: 'mem-20260102-nnnnnn' }),
    'secret らしきパターン検出': '握り潰したい値',
  });
  writeRec(
    dir,
    rec({ id: 'mem-20260102-nnnnnn', createdAt: '2026-01-02', supersedes: ['mem-20260101-aaaaaa'] }),
  );
  const r = run(
    dir,
    ['purge', 'mem-20260102-nnnnnn', '--reason', 'secret 種別', '--retire-orphans'],
    { AGENT_MEMORY_DOCS_DIR: docs },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未知フィールド/);
  // 未知フィールドが黙って消えていないこと
  assert.ok('secret らしきパターン検出' in readRec(dir, 'mem-20260101-aaaaaa'));
});

test('CLI purge: 不正な id は回復案内より先に fail-loud（タイプミスを完遂扱いにしない）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  const bad = run(dir, ['purge', 'not-an-id', '--reason', 'secret 種別']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /id 形式不正/);
  // 不正 id に対して文法違反の trailer を案内しない
  assert.doesNotMatch(bad.stderr, /Memory-Purge:/);

  const badDate = run(dir, ['purge', 'mem-20261345-aaaaaa', '--reason', 'secret 種別']);
  assert.equal(badDate.status, 1);
  assert.match(badDate.stderr, /実在しない暦日/);
});

test('CLI revise: --endorsed-by 経路の成功時は Memory-Revision と Memory-Endorsement の両方を stdout に出す', (t) => {
  const dir = makeDir(t);
  const docs = makeDir(t);
  writeRec(dir, rec({ status: 'proposed' }));
  // unlink 失敗経路（stderr に両 trailer を案内する）は root 環境で chmod による再現ができない
  // ため実装読解で担保し、このテストは成功経路の stdout 契約だけを固定する。
  const r = runRaw(dir, [
    'revise', 'mem-20260101-aaaaaa', '--author', 'a', '--summary', 's2',
    '--endorsed-by', 'human',
  ], { AGENT_MEMORY_DOCS_DIR: docs });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(String.fromCharCode(10));
  assert.match(lines[1], /^Memory-Revision: /);
  assert.match(lines[2], /^Memory-Endorsement: revise /);
});

// ---- scope 語彙 drift-guard ----

test('SCOPE_VOCAB は analyze-pr-history.js の AREA_KEYWORDS を包含する（二重語彙 drift 防止）', () => {
  for (const { area } of AREA_KEYWORDS) {
    assert.ok(SCOPE_VOCAB.has(area), `SCOPE_VOCAB に不足: ${area}`);
  }
});

// ---- records/ 不在・0件時の注意喚起（silent fail-open 対策。PR-preflight レビュー所見／
// ラウンド2敵対的 A-8／ラウンド3品質2・減算S-3・運用性10） ----
// records/ は control-only で public tree には含まれない。public tree 上で read 系コマンドを
// 実行すると常に0件が返るが、それが「public tree 相当で対象が無い」のか「control repo で
// records/ が破損した（空）」のかを stderr の注意喚起で区別できるようにする（exit code は不変）。
// 6件の近似重複テスト（validate/search/digest 不在・validate 空dir・validate 非jsonのみ・show 不在）
// を表駆動 1 テストへ統合した（ラウンド3減算 S-4/S-5）。

test('CLI 各コマンド: records/ 不在または0件時に stderr で注意喚起を出す（表駆動。exit code は不変）', (t) => {
  const MISSING_RE = /records\/ が存在しません（public tree 相当/;
  const EMPTY_RE = /records\/ は存在しますが記憶が0件です（control repo の破損疑い/;
  const cases = [
    {
      label: 'validate: records/ 不在',
      setup: (parent) => join(parent, 'records'), // 意図的に作成しない
      args: ['validate'],
      expectedStatus: 0,
      noteRe: MISSING_RE,
      extraRe: /validate: 0 件/,
    },
    {
      label: 'search: records/ 不在',
      setup: (parent) => join(parent, 'records'),
      args: ['search', 'foo', '--all'],
      expectedStatus: 0,
      noteRe: MISSING_RE,
    },
    {
      label: 'digest: records/ 不在',
      setup: (parent) => join(parent, 'records'),
      args: ['digest'],
      expectedStatus: 0,
      noteRe: MISSING_RE,
    },
    {
      label: 'show: records/ 不在（記憶が見つからず exit 1。注意喚起は exit code を変えない）',
      setup: (parent) => join(parent, 'records'),
      args: ['show', 'mem-20260101-aaaaaa'],
      expectedStatus: 1,
      noteRe: MISSING_RE,
      extraRe: /見つかりません/,
    },
    {
      label: 'validate: records/ は存在するが .json が0件（誤削除・partial clone 疑い）',
      setup: (parent) => parent, // makeDir 自体が空ディレクトリ
      args: ['validate'],
      expectedStatus: 0,
      noteRe: EMPTY_RE,
    },
    {
      label: 'validate: records/ に .json 以外のファイルしかない（0件扱い）',
      setup: (parent) => {
        writeFileSync(join(parent, 'README.md'), '# not a record');
        return parent;
      },
      args: ['validate'],
      expectedStatus: 0,
      noteRe: EMPTY_RE,
    },
  ];
  for (const { label, setup, args, expectedStatus, noteRe, extraRe } of cases) {
    const parent = makeDir(t);
    const dir = setup(parent);
    const r = run(dir, args);
    assert.equal(r.status, expectedStatus, `${label}: status`);
    assert.match(r.stderr, noteRe, `${label}: note`);
    if (extraRe) assert.match(r.stderr, extraRe, `${label}: extra`);
  }
});

test('CLI validate: records/ に .json レコードが1件以上あれば注意喚起を出さない（正例。表駆動対象外の負例確認）', (t) => {
  const dir = makeDir(t);
  writeRec(dir, rec());
  const r = run(dir, ['validate']);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /note: records\//);
});

// ---- 実 corpus 回帰ガード（PR-b3 ドッグフード。docs/agent-memory/records/ の実記憶を守る） ----
// records/ は control-only（CONTROL_ONLY_DIRS）で public tree には含まれない。生成 public tree
// でこのファイルを実行するとディレクトリが存在せず、以下のテストは意味を持たないため skip する
// （PR-preflight レビュー所見: 生成 tree でテストが fail する問題への対応）。
// また、assertion に visibility=control のレコードのタイトルを literal で書かない
// （このテストファイル自体が public tree に含まれるため、control 専用の判断タイトルが
// ソースコードに残ってしまう）。control タイトルとの照合が必要な箇所は、実行時に対象レコードを
// 読み込んで比較する（skip 済みの環境では到達しない＝records/ 不在時は読み込みも走らない）。
//
// skip 条件は「records/ だけが不在」ではなく「CONTROL_ONLY_DIRS（public-tree-policy.js）の全
// ディレクトリが不在＝public tree 相当」で判定する。docs/pr/ 等の他の control-only ディレクトリが
// 存在するのに records/ だけ無い状態は、public tree（正規に全部除外されるべき）でも control repo
// （正規に全部揃うべき）でもない壊れた中間状態であり、無言 skip すると実 corpus 回帰ガードが
// 効かなくなる（ラウンド2敵対的レビュー A-3）。
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL_RECORDS_DIR = join(REPO_ROOT, 'docs/agent-memory/records');
const CONTROL_ONLY_DIRS_PRESENT = CONTROL_ONLY_DIRS.filter((d) => existsSync(join(REPO_ROOT, d)));
const ALL_CONTROL_ONLY_DIRS_ABSENT = CONTROL_ONLY_DIRS_PRESENT.length === 0;
// public tree 相当（CONTROL_ONLY_DIRS が全て不在）のときだけ skip する。それ以外（records/ だけ
// 不在等の壊れた中間状態を含む）は skip せず実行し、records/ が読めなければテスト自体を fail させる。
const REAL_RECORDS_SKIP = ALL_CONTROL_ONLY_DIRS_ABSENT
  ? 'control-only ディレクトリ不在（CONTROL_ONLY_DIRS は public tree で除外される。#345）'
  : false;
// skip の同定が TAP の `# SKIP` 行だけに依存すると、ログ整形・要約ツールによっては見落とされる
// （ラウンド3敵対的レビュー A-16）。skip 決定の根拠を stderr へも明示的に1行出す。
// 実 corpus 回帰ガードの対象テスト（[名前, 本体] の配列）。skip note の件数はこの配列の
// length から動的に算出する（PR-preflight round6 L-5。ハードコードした件数がテスト追加/削除で
// 陳腐化するのを防ぐ）。
const REAL_CORPUS_TESTS = [
  [
    '実 corpus: docs/agent-memory/records/ は validate が全緑（手編集で壊れたら CI で検出）',
    () => {
      const { status, stderr } = run(REAL_RECORDS_DIR, ['validate']);
      assert.equal(status, 0, `validate が exit ${status}: ${stderr}`);
      // errors だけでなく warnings も 0 を守る。validate は sources 空・unclassified・
      // inline-credential 風などを warnings で出しても exit 0 のままなので、完了条件
      // 「errors 0 / warnings 0」の warnings 側もガードしないと信頼度低下を見逃す。
      assert.match(stderr, /errors 0 \/ warnings 0/);
      // 「全緑」が 0 件の空回りでないことを保証する（対象ディレクトリの取り違え等で corpus が
      // 実質空になっていても errors 0 / warnings 0 は成立してしまうため。ラウンド3敵対的 A-16）。
      const countMatch = stderr.match(/validate: (\d+) 件/);
      assert.ok(countMatch, `件数行が見つかりません: ${stderr}`);
      assert.ok(Number(countMatch[1]) >= 1, `レコード件数が0件（空回りの疑い）: ${stderr}`);
    },
  ],
  [
    '実 corpus: 設計判断が実クエリで引ける（ドッグフードの検索実用性。visibility=public の記憶のみ使用）',
    () => {
      // public 記憶（二層モデル / 信頼境界）が既定 active 検索でヒットすることを確認する。
      // control 専用の判断（promote 書込順 等）はここでは使わない（本ファイルは public tree に
      // 含まれるため、control タイトルを literal で書くと non-public な決定タイトルが露出する）。
      const layer = run(REAL_RECORDS_DIR, ['search', '二層モデル']);
      assert.equal(layer.status, 0);
      assert.match(layer.stdout, /記憶対象は検索層に限定/);
      const trust = run(REAL_RECORDS_DIR, ['search', '信頼境界']);
      assert.equal(trust.status, 0);
      assert.match(trust.stdout, /信頼境界外の入力/);
    },
  ],
  [
    '実 corpus: digest --format jsonl は全行が JSON.parse 可能（出力契約）',
    () => {
      const { status, stdout } = run(REAL_RECORDS_DIR, ['digest', '--status', 'all', '--format', 'jsonl']);
      assert.equal(status, 0);
      const lines = stdout.trim().split('\n');
      assert.ok(lines.length >= 13, `13件以上のはずが ${lines.length} 行`);
      for (const line of lines) assert.equal(typeof JSON.parse(line).id, 'string');
    },
  ],
  [
    '実 corpus: digest --visibility public は public 記憶だけを出す（control 情報の漏れ/公開落ちを防ぐ）',
    () => {
      const { status, stdout } = run(REAL_RECORDS_DIR, ['digest', '--visibility', 'public']);
      assert.equal(status, 0);
      // 既知の public 記憶（配置・二層モデル・信頼境界外）が公開対象として出ること（公開落ち防止）。
      assert.match(stdout, /control 側正本＋public 側 digest/);
      assert.match(stdout, /記憶対象は検索層に限定/);
      assert.match(stdout, /信頼境界外の入力/);
      // 既知の control 記憶が public digest に漏れていないこと（visibility 付け間違いの検出）。
      // 照合対象のタイトルはこのファイルに literal で書かず、対象レコードを実行時に読み込んで得る
      // （本ファイルは public tree に含まれるため、control 専用タイトルをソースへ残さない）。
      for (const id of ['mem-20260719-0472c1', 'mem-20260719-456175']) {
        const controlRecord = JSON.parse(readFileSync(join(REAL_RECORDS_DIR, `${id}.json`), 'utf-8'));
        assert.equal(controlRecord.visibility, 'control', `${id} が control でなくなっている（照合対象の前提が崩れている）`);
        const escaped = controlRecord.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        assert.doesNotMatch(stdout, new RegExp(escaped));
      }
      // 出力された全レコードが visibility:public であること（jsonl で機械確認）。
      const jsonl = run(REAL_RECORDS_DIR, ['digest', '--visibility', 'public', '--format', 'jsonl']);
      assert.equal(jsonl.status, 0);
      for (const line of jsonl.stdout.trim().split('\n')) {
        assert.equal(JSON.parse(line).visibility, 'public');
      }
    },
  ],
];

if (REAL_RECORDS_SKIP) {
  process.stderr.write(`note: 実 corpus 回帰ガード（docs/agent-memory/records/ の実記憶を検査する${REAL_CORPUS_TESTS.length}テスト）を skip します（${REAL_RECORDS_SKIP}）\n`);
}

// positive control: 他の control-only ディレクトリが1つでも存在するのに records/ が無いなら、
// それは「public tree 相当だから skip してよい」状態ではなく、control repo 側の破損（部分 clone・
// 誤削除等）を示す。無条件 skip でこの状態を握りつぶさないことを保証する（A-3）。
test('実 corpus 回帰ガードの skip 判定: 他の control-only ディレクトリが存在するのに records/ が無い状態は skip 対象にならない', () => {
  if (ALL_CONTROL_ONLY_DIRS_ABSENT) return; // public tree 相当（本テストの主張自体が該当しない環境）
  assert.ok(
    existsSync(REAL_RECORDS_DIR),
    `他の control-only ディレクトリ（${CONTROL_ONLY_DIRS_PRESENT.join(', ')}）は存在するのに ` +
      'docs/agent-memory/records/ が存在しません。実 corpus テストの skip 条件が壊れています',
  );
});

for (const [name, fn] of REAL_CORPUS_TESTS) {
  test(name, { skip: REAL_RECORDS_SKIP }, fn);
}

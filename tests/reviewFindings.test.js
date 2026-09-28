import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STRUCTURED_FINDINGS_AGGREGATE_FILE,
  STRUCTURED_FINDINGS_AGGREGATE_SCHEMA_VERSION,
  STRUCTURED_FINDINGS_FILE,
  buildMetricsFlags,
  formatReport,
  ingestFindings,
  runAggregate,
  runReport,
} from '../scripts/agent/review-findings.js';
import { discardLegacyFindingArtifacts } from '../scripts/agent/review-plan.js';
import { createSnapshot } from '../scripts/agent/review-snapshot.js';
import { makeTmpGitRepo, sh, write } from './helpers/tmpGitRepo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function runFindingsCli(dir, args) {
  return execFileSync('node', [join(ROOT, 'scripts/agent/review-findings.js'), ...args], {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeRepo() {
  const dir = makeTmpGitRepo('review-findings-');
  write(dir, 'a.txt', 'a\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'init']);
  return dir;
}

function baseFinding(overrides = {}) {
  return {
    file: 'src/a.js',
    line: 1,
    summary: 'summary',
    failure_scenario: 'failure',
    scope_relation: 'introduced',
    severity: 'med',
    evidence: 'strong',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
    ...overrides,
  };
}

function readArtifact(snapDir) {
  return JSON.parse(readFileSync(join(snapDir, STRUCTURED_FINDINGS_FILE), 'utf-8'));
}

function readAggregateArtifact(snapDir) {
  return JSON.parse(readFileSync(join(snapDir, STRUCTURED_FINDINGS_AGGREGATE_FILE), 'utf-8'));
}

// キー名を持たない分、同じネスト深さでも直列化後の文字数が小さく収まる（fix #2 の実際の
// 報告事例「約4160階層ネストした配列」を再現するためのヘルパー）。
function buildDeeplyNestedArray(depth) {
  let value = [];
  for (let i = 0; i < depth; i += 1) {
    value = [value];
  }
  return value;
}

test('happy path: ingest → aggregate → metrics が一貫した数値を返す', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  const findingA = baseFinding({
    summary: 'A summary',
    failure_scenario: 'A failure',
    severity: 'high',
    evidence: 'verified',
  });
  const findingB = baseFinding({
    file: 'src/b.js',
    line: 2,
    summary: 'B summary',
    failure_scenario: 'B failure',
    scope_relation: 'worsened',
  });

  const ingestResult = ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [findingA, findingB],
    cwd: dir,
  });
  assert.equal(ingestResult.added, 2);
  assert.equal(ingestResult.normalized, 2);
  assert.equal(ingestResult.invalid, 0);

  const artifact = readArtifact(snap.dir);
  assert.equal(artifact.records.length, 2);
  assert.deepEqual(
    artifact.records.map((r) => r.finding_id),
    ['f-0001', 'f-0002'],
  );
  assert.ok(artifact.records.every((r) => r.status === 'normalized'));

  const aggregate = runAggregate({ snapshotId: snap.snapshotId, cwd: dir });
  assert.equal(aggregate.canonicalFindings.length, 2);
  assert.equal(aggregate.counts.canonical, 2);
  const aggregateFile = JSON.parse(
    readFileSync(join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE), 'utf-8'),
  );
  // `aggregate` の counts.bySeverity 等は INVARIANTS.md #11 に従い Object.create(null) 基底
  // （fix #6）だが、JSON 往復はプロトタイプを保持しない。ファイル内容が実質的に一致することを
  // 検証したいので、比較対象も同じ JSON 往復を経させ、プロトタイプ差による見せかけの不一致を
  // 避ける（内容の不一致は引き続き検出する）。
  assert.deepEqual(aggregateFile, JSON.parse(JSON.stringify(aggregate)));

  const flags = buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir });
  assert.equal(flags.validMedPlus, aggregate.counts.validMedPlus);
  assert.equal(flags.uniqueValidMedPlus, aggregate.counts.actionable);
  assert.equal(flags.duplicateClusterParticipation, aggregate.counts.duplicateClusterParticipation);
  assert.match(flags.flagString, /--valid-med-plus \d+ --unique-valid-med-plus \d+/);
});

// 修正A の回帰テスト（review-adversarial A-3: 実行検証済み）: normalizeFile の基準は
// process.cwd()（CLI呼び出し元ディレクトリ）ではなく実際のリポジトリのworktree root。
// リポジトリのサブディレクトリから ingestFindings を呼び出しても、絶対パスの file が
// worktree root基準で正しく相対パス化され、同じ箇所を指すfindingが呼び出し元ディレクトリの
// 違いだけで別クラスタに分裂しないことを確認する。
test('ingest: リポジトリのサブディレクトリから呼び出しても、絶対パスの file はworktree root基準で正規化される（cwd違いでクラスタが分裂しない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  // CLI 呼び出し元が実際にリポジトリ内に存在するサブディレクトリであることを保証する
  // （存在しないパスを cwd に渡すテストにはしない）。
  const subDir = join(dir, 'scripts', 'agent');
  mkdirSync(subDir, { recursive: true });

  const absoluteFile = join(dir, 'src', 'a.js');
  const fromRoot = baseFinding({
    file: absoluteFile,
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  const fromSubDir = baseFinding({
    file: absoluteFile,
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });

  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [fromRoot], cwd: dir });
  const subDirResult = ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [fromSubDir],
    cwd: subDir,
  });
  assert.equal(subDirResult.normalized, 1);

  const artifact = readArtifact(snap.dir);
  assert.ok(
    artifact.records.every((r) => r.status === 'normalized' && r.finding.file === 'src/a.js'),
    'cwd がリポジトリルートでもサブディレクトリでも、絶対パスは同じworktree root基準の' +
      '相対パスへ正規化される',
  );

  const aggregate = runAggregate({ snapshotId: snap.snapshotId, cwd: dir });
  assert.equal(
    aggregate.counts.canonical,
    1,
    'cwd の違いだけでは別クラスタに分裂せず、同じ箇所を指すfindingとして1つのcanonicalへ統合される',
  );
});

// 修正2の回帰テスト（review-spec F1+F2）: buildMetricsFlags に angle を渡すと、その観点が
// reportedBy に含まれる canonical finding だけが対象になる。
test('buildMetricsFlags: --angle を指定すると、その観点が reportedBy に含まれる canonical finding だけが対象になる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  // finding 自身の provenance は ingest の --angle/--anchor-class 既定値より優先されるため
  // （baseFinding() 自体が既定 provenance を持つ）、対象角度は各 finding の provenance で
  // 明示する（ingestFindings 呼び出し側の angle/anchorClass 引数には頼らない）。
  const adversarialOnly = baseFinding({
    summary: 'adversarial only issue',
    failure_scenario: 'x',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  const qualityOnly = baseFinding({
    file: 'src/b.js',
    summary: 'quality only issue',
    failure_scenario: 'y',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });
  const convergedFromAdversarial = baseFinding({
    file: 'src/c.js',
    summary: 'converged issue',
    failure_scenario: 'z',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  const convergedFromQuality = baseFinding({
    file: 'src/c.js',
    summary: 'converged issue',
    failure_scenario: 'z',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });

  ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [adversarialOnly, convergedFromAdversarial],
    cwd: dir,
  });
  ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [qualityOnly, convergedFromQuality],
    cwd: dir,
  });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

  const adversarialFlags = buildMetricsFlags({
    snapshotId: snap.snapshotId,
    cwd: dir,
    angle: 'adversarial',
  });
  assert.equal(
    adversarialFlags.validMedPlus,
    2,
    'adversarialOnly と converged の2件が対象になる（quality only は含まれない）',
  );
  assert.equal(
    adversarialFlags.uniqueValidMedPlus,
    adversarialFlags.validMedPlus,
    '観点単位では validMedPlus と uniqueValidMedPlus は同じ値になる',
  );
  assert.equal(
    adversarialFlags.duplicateClusterParticipation,
    1,
    'converged（2観点が収束）のみが該当し、adversarialOnly（単独）は含まれない',
  );
  // 修正2（review-spec F2）: 観点別の flagString は --unique-valid-med-plus を含まない
  // （round全体でしか意味を持たない非加算的な値のため。record への受け渡し用の文字列だけが
  // 対象で、JS の返り値フィールド uniqueValidMedPlus 自体は残す）。
  assert.match(
    adversarialFlags.flagString,
    /--valid-med-plus 2 --duplicate-cluster-participation 1/,
  );
  assert.ok(
    !adversarialFlags.flagString.includes('--unique-valid-med-plus'),
    '観点別の flagString に --unique-valid-med-plus を含まない',
  );

  const qualityFlags = buildMetricsFlags({
    snapshotId: snap.snapshotId,
    cwd: dir,
    angle: 'quality',
  });
  assert.equal(
    qualityFlags.validMedPlus,
    2,
    'qualityOnly と converged の2件が対象になる（adversarial only は含まれない）',
  );
});

// 修正1の回帰テスト（review-spec 所見1: 実行検証済み）: 同一クラスタに非actionableな観点
// （severity=low, evidence=weak）とactionableな観点（severity=high, evidence=verified）が
// 混在する場合、cluster全体のactionable判定（1件でもactionableなmemberがあればtrue）を使うと
// 非actionableな観点にまでvalid-med-plusが誤って計上される。actionableReporters基準に修正後は
// 非actionableな観点の --valid-med-plus は0、actionableな観点は正しく計上されることを確認する。
test('buildMetricsFlags: 同一クラスタに非actionableな観点とactionableな観点が混在する場合、非actionableな観点のvalid-med-plusは0のままで、actionableな観点だけに正しく計上される', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  const qualityWeak = baseFinding({
    summary: 'mixed actionable cluster',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'low',
    evidence: 'weak',
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });
  const specStrong = baseFinding({
    summary: 'mixed actionable cluster',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'spec', anchor_class: 'contract' },
  });

  ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [qualityWeak, specStrong],
    cwd: dir,
  });
  const aggregate = runAggregate({ snapshotId: snap.snapshotId, cwd: dir });
  assert.equal(aggregate.counts.canonical, 1, '前提: 同一箇所を指すため1つのclusterへ統合される');
  assert.equal(aggregate.counts.validMedPlus, 1, '前提: round全体ではactionableなspec分だけ計上');

  const qualityFlags = buildMetricsFlags({
    snapshotId: snap.snapshotId,
    cwd: dir,
    angle: 'quality',
  });
  assert.equal(
    qualityFlags.validMedPlus,
    0,
    'qualityは自身の評価（low/weak）が非actionableなため、cluster全体がactionableでも' +
      'valid-med-plusは0のまま',
  );

  const specFlags = buildMetricsFlags({
    snapshotId: snap.snapshotId,
    cwd: dir,
    angle: 'spec',
  });
  assert.equal(
    specFlags.validMedPlus,
    1,
    'specは自身の評価（high/verified）が独立にactionableなため、valid-med-plusが正しく計上される',
  );
});

// 修正2の回帰テスト（review-spec F2）: --unique-valid-med-plus は round 全体でしか意味を持たない
// 非加算的な値であり、観点別の record 呼び出しへ渡すと summarize() の単純加算で round 全体の
// unique 数より大きくなる（実行検証済み）。観点別の flagString からは除外し、angle を省略した
// round 全体の flagString には引き続き含める。
test('buildMetricsFlags: --angle を指定した場合の flagString は --unique-valid-med-plus を含まないが、省略時（round全体）は引き続き含む', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [
      baseFinding({
        severity: 'high',
        evidence: 'verified',
        provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
      }),
    ],
    cwd: dir,
  });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

  const angleFlags = buildMetricsFlags({
    snapshotId: snap.snapshotId,
    cwd: dir,
    angle: 'adversarial',
  });
  assert.ok(
    !angleFlags.flagString.includes('--unique-valid-med-plus'),
    '観点別の flagString は --unique-valid-med-plus を含まない',
  );
  assert.ok(
    angleFlags.flagString.includes('--valid-med-plus 1'),
    '--valid-med-plus は引き続き含まれる',
  );
  assert.ok(
    angleFlags.flagString.includes('--duplicate-cluster-participation 0'),
    '--duplicate-cluster-participation は引き続き含まれる',
  );

  const roundFlags = buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir });
  assert.ok(
    roundFlags.flagString.includes('--unique-valid-med-plus'),
    'angle を省略した round 全体の flagString には引き続き --unique-valid-med-plus が含まれる（回帰確認）',
  );
});

// 修正3の回帰テスト（review-spec F3）: buildMetricsFlags は angle を isKnownAngle で検証する。
// 綴り違い・表示ラベル等の未知の観点は、黙った 0/0/0（「所見ゼロ」との区別が付かない）を返さず
// fail-loud する。
test('buildMetricsFlags: 未知の観点を指定すると "未知の観点です" を含むエラーを投げる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

  assert.throws(
    () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir, angle: 'not-a-real-angle' }),
    /未知の観点です/,
  );
  // 既存の正当な観点名での呼び出しは引き続き成功する（回帰確認）。
  assert.doesNotThrow(() =>
    buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir, angle: 'adversarial' }),
  );
});

// 修正5の回帰テスト（chatgpt-codex-connector 所見。review-pr #650、実行検証済み）: `raw`
// フィールドは `capForStorage` で直列化後サイズが上限管理されるが、隣接する未知観点の
// エラーメッセージには同等の上限が無かった。巨大な未知観点名を渡すと、エラーメッセージが
// 無制限に肥大化せず切り詰められることを確認する。
test('buildMetricsFlags: 巨大な未知の観点名を指定しても、エラーメッセージは無制限に肥大化せず切り詰められる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

  const hugeAngle = 'a'.repeat(200000);
  assert.throws(
    () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir, angle: hugeAngle }),
    (err) => {
      assert.match(err.message, /未知の観点です/);
      assert.ok(
        err.message.length < hugeAngle.length,
        `エラーメッセージが観点名の長さ（${hugeAngle.length}）未満に切り詰められているべき` +
          `（実際: ${err.message.length}）`,
      );
      assert.ok(err.message.endsWith('...(truncated)'));
      return true;
    },
  );
});

// 修正5・修正3の合成回帰テスト: ingestFindings 冒頭の --angle 検証（修正3）が投げるエラーも、
// 巨大な角度名では切り詰められる。
test('ingest: 巨大な未知の --angle を渡しても、fail-loud のエラーメッセージは切り詰められる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const hugeAngle = 'b'.repeat(200000);

  assert.throws(
    () =>
      ingestFindings({
        snapshotId: snap.snapshotId,
        angle: hugeAngle,
        anchorClass: 'attack-surface',
        rawFindings: [baseFinding()],
        cwd: dir,
      }),
    (err) => {
      assert.match(err.message, /未知の観点です（--angle）/);
      assert.ok(err.message.length < hugeAngle.length);
      assert.ok(err.message.endsWith('...(truncated)'));
      return true;
    },
  );
});

// 修正5の回帰テスト: finding 自身の provenance.angle が巨大かつ未知な場合、ingest の
// per-element errors[]（artifact に永続化され、CLI stderr にも出力される）も切り詰められる。
test('ingest: finding自身のprovenance.angleが巨大かつ未知な場合、errors[]のメッセージは切り詰められてartifactに保存される', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const hugeAngle = 'c'.repeat(200000);
  const raw = baseFinding({ provenance: { angle: hugeAngle, anchor_class: 'x' } });

  const result = ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [raw], cwd: dir });
  assert.equal(result.normalized, 0);
  assert.equal(result.invalid, 1);
  const [detail] = result.invalidDetails;
  assert.ok(detail.errors[0].includes('未知の観点です'));
  assert.ok(
    detail.errors[0].length < hugeAngle.length,
    'invalidDetails のエラーメッセージが観点名の長さ未満に切り詰められているべき',
  );
  assert.ok(detail.errors[0].endsWith('...(truncated)'));

  const artifact = readArtifact(snap.dir);
  const invalidRecord = artifact.records.find((r) => r.status === 'invalid');
  assert.ok(invalidRecord.errors[0].length < hugeAngle.length);
  assert.ok(invalidRecord.errors[0].endsWith('...(truncated)'));
});

// 修正4の回帰テスト（review-operability Finding#2 / review-adversarial N4）: writeJson は
// temp ファイル + rename によるアトミック書き込みに変わった。書き込み経路（ingestFindings /
// runAggregate）が引き続き正しく動作し、tmp ファイルが残らないことを確認する。
test('ingest: 書き込み後に tmp ファイルが残らず、structured-findings.json の内容が正しい', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });

  const entries = readdirSync(snap.dir);
  assert.ok(
    entries.every((name) => !name.includes('.tmp-')),
    `tmp ファイルが残っている: ${JSON.stringify(entries)}`,
  );
  const artifact = readArtifact(snap.dir);
  assert.equal(artifact.records.length, 1);
  assert.equal(artifact.records[0].status, 'normalized');
});

test('aggregate: 書き込み後に tmp ファイルが残らず、structured-findings-aggregate.json の内容が正しい', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });

  const aggregate = runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

  const entries = readdirSync(snap.dir);
  assert.ok(
    entries.every((name) => !name.includes('.tmp-')),
    `tmp ファイルが残っている: ${JSON.stringify(entries)}`,
  );
  const aggregateFile = JSON.parse(
    readFileSync(join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE), 'utf-8'),
  );
  assert.equal(aggregateFile.counts.totalIngested, aggregate.counts.totalIngested);
});

// tmp ファイル名が衝突しないことの間接的な確認: 同一 snapshot へ連続して ingest を繰り返しても
// （呼び出しごとに pid は同じだが Date.now()/乱数が変わる）毎回 tmp ファイルが残らず正しく
// rename されることを確認する。
test('ingest: 同一 snapshot への複数回の呼び出しでも tmp ファイルが衝突・残留しない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  for (let i = 0; i < 5; i += 1) {
    ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  }

  const entries = readdirSync(snap.dir);
  assert.ok(
    entries.every((name) => !name.includes('.tmp-')),
    `tmp ファイルが残っている: ${JSON.stringify(entries)}`,
  );
  assert.equal(readArtifact(snap.dir).records.length, 5);
});

// chatgpt-codex-connector 所見（review-pr #650）の回帰テスト: writeJson は renameSync 失敗時
// （対象パスが既にディレクトリになっている等）に、直前の writeFileSync で作成済みの tmp
// ファイルを削除せず残していた。renameSync の対象パス（structured-findings-aggregate.json）を
// 事前にディレクトリにしておくことで、writeFileSync 自体は成功するが renameSync だけが実際に
// 失敗する状況を fs レベルで再現する。
test('aggregate: renameSync が失敗しても tmp ファイルを残さず、元の例外を伝播する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  mkdirSync(join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE));

  assert.throws(() => runAggregate({ snapshotId: snap.snapshotId, cwd: dir }));

  const entries = readdirSync(snap.dir);
  assert.ok(
    entries.every((name) => !name.includes('.tmp-')),
    `tmp ファイルが残っている: ${JSON.stringify(entries)}`,
  );
});

test('部分的に不正な入力: 正常1件+不正1件を渡しても両方 records に残る（何も落とさない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  const valid = baseFinding();
  const invalid = { file: 'src/a.js' }; // 必須フィールドの大半が欠落

  const result = ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [valid, invalid],
    cwd: dir,
  });
  assert.equal(result.normalized, 1);
  assert.equal(result.invalid, 1);

  const artifact = readArtifact(snap.dir);
  assert.equal(artifact.records.length, 2, '正常/不正のどちらも records から落ちない');
  const invalidRecord = artifact.records.find((r) => r.status === 'invalid');
  assert.ok(invalidRecord, '不正 record が見つからない');
  assert.ok(Array.isArray(invalidRecord.errors) && invalidRecord.errors.length > 0);
  assert.ok('raw' in invalidRecord, '不正 record は元の生ペイロードを保持する');
});

test('CLI: --input の中身が配列でない場合は非ゼロ終了し、structured-findings.json を作らない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const inputPath = join(dir, 'not-an-array.json');
  writeFileSync(inputPath, JSON.stringify({ not: 'an array' }));

  assert.throws(
    () => runFindingsCli(dir, ['ingest', '--snapshot', snap.snapshotId, '--input', inputPath]),
    /配列である必要があります/,
  );
  assert.equal(
    existsSync(join(snap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    '構造的に不正な入力（トップレベルが配列でない）では artifact を作らない',
  );
});

test('finding_id は位置的な連番であり内容から導出されない（同一内容の再ingestでもdedupしない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap1 = createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap2 = createSnapshot({ cwd: dir, baseRef: 'main' });

  const findingA = baseFinding({ summary: 'finding A' });
  const findingZ = baseFinding({
    file: 'src/z.js',
    line: 99,
    summary: 'totally different finding Z',
    failure_scenario: 'different failure',
    scope_relation: 'worsened',
    severity: 'blocker',
    evidence: 'verified',
  });

  ingestFindings({ snapshotId: snap1.snapshotId, rawFindings: [findingA], cwd: dir });
  ingestFindings({ snapshotId: snap2.snapshotId, rawFindings: [findingZ], cwd: dir });

  assert.equal(
    readArtifact(snap1.dir).records[0].finding_id,
    'f-0001',
    '独立した snapshot はそれぞれ f-0001 から始まる',
  );
  assert.equal(
    readArtifact(snap2.dir).records[0].finding_id,
    'f-0001',
    '内容が全く違っても採番は内容に依存しない',
  );

  ingestFindings({ snapshotId: snap1.snapshotId, rawFindings: [findingA], cwd: dir });
  const artifact1After = readArtifact(snap1.dir);
  assert.equal(artifact1After.records.length, 2, 'ingest 時点ではdedupしない');
  assert.equal(artifact1After.records[1].finding_id, 'f-0002', '同一snapshot内では連番が続く');
});

test('discardLegacyFindingArtifacts は structured-findings.json を削除しない（findings.json とのファイル名衝突回避）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  assert.ok(existsSync(join(snap.dir, STRUCTURED_FINDINGS_FILE)));

  discardLegacyFindingArtifacts(dir);

  assert.ok(
    existsSync(join(snap.dir, STRUCTURED_FINDINGS_FILE)),
    'discardLegacyFindingArtifacts は厳密一致の findings.json のみを消すため衝突しない',
  );
});

test('report: aggregate 未実行の snapshot では明確に失敗し、副作用で aggregate を実行しない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  assert.throws(() => runFindingsCli(dir, ['report', '--snapshot', snap.snapshotId]), /aggregate/);
  assert.equal(
    existsSync(join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE)),
    false,
    'report が副作用で aggregate を実行していない',
  );
});

test('aggregate: 一度も ingest していない snapshot でも成功し、全て0件の集計になる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  assert.equal(existsSync(join(snap.dir, STRUCTURED_FINDINGS_FILE)), false);

  const aggregate = runAggregate({ snapshotId: snap.snapshotId, cwd: dir });
  assert.equal(aggregate.counts.totalIngested, 0);
  assert.equal(aggregate.counts.normalized, 0);
  assert.equal(aggregate.counts.canonical, 0);
  assert.deepEqual(aggregate.canonicalFindings, []);
  assert.deepEqual(aggregate.candidateGroups, []);
  assert.deepEqual(aggregate.invalid, []);
});

// 修正3の回帰テスト（review-operability round6 Finding#1）: structured-findings.json が
// 削除された（ように見える）状態で、既存の structured-findings-aggregate.json が
// totalIngested > 0 を記録していれば、aggregate は空集計で黙って上書きせずガイド付き
// エラーを投げる（過去の集計結果の不可逆な消失を防ぐ）。
test('aggregate: structured-findings.json が無くても既存 aggregate が totalIngested>0 なら、空集計での上書きを拒否する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });
  assert.equal(
    readAggregateArtifact(snap.dir).counts.totalIngested,
    1,
    '前提: 既存の aggregate は totalIngested=1 を記録している',
  );

  // 「壊れた ingest ログを削除する」復旧手順を模す。
  rmSync(join(snap.dir, STRUCTURED_FINDINGS_FILE));

  assert.throws(
    () => runAggregate({ snapshotId: snap.snapshotId, cwd: dir }),
    /ingest ログが削除された可能性/,
  );
  // 拒否された場合、既存の aggregate（過去の集計結果）はそのまま残っている（上書きされない）。
  assert.equal(readAggregateArtifact(snap.dir).counts.totalIngested, 1);
});

// 修正4の回帰テスト（review-operability round7 所見1）: runAggregate と同じガードが
// ingestFindings 側にも無いと、削除された ingest ログが「まだ一度も ingest していない」正当な
// 初回として扱われ、新規の空ログへ気づかず追記してしまう（次の aggregate が過去の集計結果を
// 警告なく上書きする経路が再発する）。ingestFindings 自身も同じ状況でガイド付きエラーを
// 投げることを確認する。
test('ingest: structured-findings.json が無くても既存 aggregate が totalIngested>0 なら、新規の空ログでの続行を拒否する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });
  assert.equal(
    readAggregateArtifact(snap.dir).counts.totalIngested,
    1,
    '前提: 既存の aggregate は totalIngested=1 を記録している',
  );

  // 「壊れた ingest ログを削除する」復旧手順を模す。
  rmSync(join(snap.dir, STRUCTURED_FINDINGS_FILE));

  assert.throws(
    () => ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
    /ingest ログが削除された可能性/,
  );
  // 拒否された場合、新規の空ログ（structured-findings.json）を作成していない
  // （黙って続行し、次の aggregate で過去の集計結果を上書きする経路に入らない）。
  assert.equal(
    existsSync(join(snap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    '拒否された場合、structured-findings.json を新規作成していない',
  );
  // 既存の aggregate（過去の集計結果）はそのまま残っている。
  assert.equal(readAggregateArtifact(snap.dir).counts.totalIngested, 1);
});

test('aggregate: records キーが無い壊れた artifact は fail-loud する（空集計に倒さない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_FILE), JSON.stringify({ schemaVersion: 1 }));

  assert.throws(() => runAggregate({ snapshotId: snap.snapshotId, cwd: dir }), /records/);
});

// fix #2 の回帰テスト: `artifact !== null` を前提にしたガードは、ファイルの中身が JSON の
// `null` である場合にすり抜けていた（`null !== null` は false のため）。
test('aggregate: structured-findings.json の中身が JSON の null だと fail-loud する（空集計に黙って倒さない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_FILE), 'null');

  assert.throws(
    () => runAggregate({ snapshotId: snap.snapshotId, cwd: dir }),
    /records が配列ではありません/,
  );
});

// runtime doc（review-findings-runtime.md）の「artifact 自体が壊れている場合...後続の
// ingest / aggregate は生の例外ではなく復旧手順を示すエラーで fail-loud する」という約束を
// 検証する。生の SyntaxError（V8 依存の "Unexpected token" 等の文言）のままではなく、
// ファイル名と復旧手順（削除）を示すエラーになっていることを確認する。
function assertGuidedCorruptionError(err, fileName) {
  assert.ok(
    !/Unexpected token/i.test(err.message),
    `生の SyntaxError 文言のままになっている: ${err.message}`,
  );
  assert.ok(err.message.includes(fileName), 'エラーメッセージにファイル名が含まれていない');
  assert.ok(err.message.includes('削除'), 'エラーメッセージに復旧手順（削除）が含まれていない');
}

test('ingest: 構文的に壊れた structured-findings.json は生の SyntaxError ではなく復旧手順を示すエラーで fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_FILE), '{not valid json,}');

  assert.throws(
    () => ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
    (err) => {
      assertGuidedCorruptionError(err, STRUCTURED_FINDINGS_FILE);
      return true;
    },
  );
});

test('aggregate: 構文的に壊れた structured-findings.json は生の SyntaxError ではなく復旧手順を示すエラーで fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_FILE), '{not valid json,}');

  assert.throws(
    () => runAggregate({ snapshotId: snap.snapshotId, cwd: dir }),
    (err) => {
      assertGuidedCorruptionError(err, STRUCTURED_FINDINGS_FILE);
      return true;
    },
  );
});

test('report/metrics: 構文的に壊れた structured-findings-aggregate.json は生の SyntaxError ではなく復旧手順を示すエラーで fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE), '{not valid json,}');

  assert.throws(
    () => runReport({ snapshotId: snap.snapshotId, cwd: dir }),
    (err) => {
      assertGuidedCorruptionError(err, STRUCTURED_FINDINGS_AGGREGATE_FILE);
      return true;
    },
  );
  assert.throws(
    () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }),
    (err) => {
      assertGuidedCorruptionError(err, STRUCTURED_FINDINGS_AGGREGATE_FILE);
      return true;
    },
  );
});

test('report/metrics: aggregate 後に structured-findings.json が壊れると、鮮度チェックの再読み込みも復旧手順を示すエラーで fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });
  writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_FILE), '{not valid json,}');

  assert.throws(
    () => runReport({ snapshotId: snap.snapshotId, cwd: dir }),
    (err) => {
      assertGuidedCorruptionError(err, STRUCTURED_FINDINGS_FILE);
      return true;
    },
  );
});

test('ingest: ロックファイルが既に存在すると、EEXIST 由来の明確なエラーを投げる（ロックパスを含み、書き込みをしない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const file = join(snap.dir, STRUCTURED_FINDINGS_FILE);
  const lockPath = `${file}.lock`;
  writeFileSync(lockPath, '');

  try {
    assert.throws(
      () => ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
      (err) => {
        assert.match(err.message, /別の ingest がこの snapshot に対して実行中です/);
        assert.ok(err.message.includes(lockPath), 'エラーメッセージにロックファイルのパスを含む');
        return true;
      },
    );
    assert.equal(existsSync(file), false, 'ロック取得に失敗した場合は artifact に書き込まない');
  } finally {
    rmSync(lockPath, { force: true });
  }
});

// fix #3 の回帰テスト: ロック取得成功時、中身が pid・取得時刻を含む JSON になっていることを
// 確認する（異常終了による残留ロックか実行中の別プロセスかを運用者が判断できるようにするため）。
test('ingest: ロック取得成功時、ロックファイルに pid と取得時刻を書き込む', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const lockPath = `${join(snap.dir, STRUCTURED_FINDINGS_FILE)}.lock`;
  let lockContentWhileHeld = null;

  ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [baseFinding()],
    cwd: dir,
    // `now()` はロック保持中（artifact 書き込み前）に1度だけ呼ばれる既存の注入ポイント。
    // ロック解放（unlinkSync）前にロックの中身を確認するために使う。
    now: () => {
      lockContentWhileHeld = JSON.parse(readFileSync(lockPath, 'utf-8'));
      return new Date();
    },
  });

  assert.ok(lockContentWhileHeld, 'ロック保持中に中身を読み取れているべき');
  assert.equal(typeof lockContentWhileHeld.pid, 'number');
  assert.equal(typeof lockContentWhileHeld.acquiredAt, 'string');
  assert.ok(
    !Number.isNaN(Date.parse(lockContentWhileHeld.acquiredAt)),
    'acquiredAt は解釈可能な ISO 文字列であるべき',
  );
});

// 修正6の回帰テスト（chatgpt-codex-connector 所見。review-pr #650、実行検証済み）:
// `openSync(lockPath, 'wx')` 成功後、ロック内容の書き込み（writeFileSync）が失敗すると、
// 例外がそのまま伝播し、直前に自分自身が作成した（空の）ロックファイルが削除されずに残って
// いた。node:fs をモックせず、ロック内容の組み立てで使われる `new Date().toISOString()` を
// 一時的に1回だけ故障させることで、fd 操作を直接モックせずに「openSync 成功後、ロック内容の
// 書き込みが完了する前に失敗する」状況を決定論的に再現する（この失敗は writeFileSync 自体が
// 呼ばれる前、引数の組み立て中に起こるため、書き込みが一切完了しない、より厳しいケースになる）。
test('ingest: ロック取得後の書き込みが失敗すると、作成済みロックファイルを残さず元の例外を伝播する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const lockPath = `${join(snap.dir, STRUCTURED_FINDINGS_FILE)}.lock`;

  const originalToISOString = Date.prototype.toISOString;
  let shouldFail = true;
  Date.prototype.toISOString = function patchedToISOString(...args) {
    if (shouldFail) {
      shouldFail = false;
      throw new Error('injected toISOString failure');
    }
    return originalToISOString.apply(this, args);
  };

  try {
    assert.throws(
      () => ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
      /injected toISOString failure/,
    );
  } finally {
    Date.prototype.toISOString = originalToISOString;
  }

  assert.equal(
    existsSync(lockPath),
    false,
    'ロック取得後の書き込み失敗後、作成済みロックファイルが残っていない',
  );
  assert.equal(
    existsSync(join(snap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    'ロック取得に失敗した場合は artifact にも書き込まない',
  );
});

test('ingest: 既存ロックに pid が記録されていると、EEXIST エラーメッセージにその pid が含まれる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const lockPath = `${join(snap.dir, STRUCTURED_FINDINGS_FILE)}.lock`;
  writeFileSync(lockPath, JSON.stringify({ pid: 12345, acquiredAt: '2026-01-01T00:00:00.000Z' }));

  try {
    assert.throws(
      () => ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
      (err) => {
        assert.match(err.message, /別の ingest がこの snapshot に対して実行中です/);
        assert.ok(err.message.includes('12345'), 'エラーメッセージに既存ロックの pid を含む');
        return true;
      },
    );
  } finally {
    rmSync(lockPath, { force: true });
  }
});

// describeLockHolder は診断目的のベストエフォートであり、ロックの中身が空・壊れていても
// それ自体が例外を投げて本来の EEXIST エラーをマスクしてはいけない（回帰テスト）。
test('ingest: 壊れたロックファイル（空文字列・不正 JSON）でも describeLockHolder に起因する例外で落ちず、ガイド付き EEXIST エラーになる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const brokenContent of ['', '{invalid']) {
    const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
    const lockPath = `${join(snap.dir, STRUCTURED_FINDINGS_FILE)}.lock`;
    writeFileSync(lockPath, brokenContent);

    try {
      assert.throws(
        () =>
          ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
        (err) => {
          assert.match(
            err.message,
            /別の ingest がこの snapshot に対して実行中です/,
            `lock content=${JSON.stringify(brokenContent)} でもガイド付きエラーになるべき`,
          );
          return true;
        },
      );
    } finally {
      rmSync(lockPath, { force: true });
    }
  }
});

// 修正6の回帰テスト（review-operability Finding#1 / review-adversarial N5）: pid が判明しない
// ロック（空・壊れている・pid 未記載）では、実行不可能な `ps -p` の案内をしない。
test('ingest: 空ロック・壊れたロック・pid 未記載のロックでは EEXIST エラーメッセージに `ps -p` の案内を含まない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const brokenContents = ['', '{invalid', '{}', JSON.stringify({ acquiredAt: '2026-01-01' })];
  for (const brokenContent of brokenContents) {
    const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
    const lockPath = `${join(snap.dir, STRUCTURED_FINDINGS_FILE)}.lock`;
    writeFileSync(lockPath, brokenContent);

    try {
      assert.throws(
        () =>
          ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
        (err) => {
          assert.match(err.message, /別の ingest がこの snapshot に対して実行中です/);
          assert.ok(
            !err.message.includes('ps -p'),
            `lock content=${JSON.stringify(brokenContent)} では pid が不明なため ps -p を案内すべきではない`,
          );
          return true;
        },
      );
    } finally {
      rmSync(lockPath, { force: true });
    }
  }
});

test('ingest: 成功後はロックが解放される（同一 snapshot への連続呼び出しが両方成功する）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const lockPath = `${join(snap.dir, STRUCTURED_FINDINGS_FILE)}.lock`;

  const first = ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [baseFinding()],
    cwd: dir,
  });
  assert.equal(first.normalized, 1);
  assert.equal(existsSync(lockPath), false, '1回目の呼び出し後にロックファイルが残っていない');

  // 1回目の finally によるロック解放が実際に行われていなければ、2回目は EEXIST で失敗するはず。
  const second = ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [baseFinding()],
    cwd: dir,
  });
  assert.equal(second.normalized, 1, '2回目の呼び出しもロックを取得できて成功する');

  const artifact = readArtifact(snap.dir);
  assert.equal(artifact.records.length, 2, '両方の呼び出しの結果が反映されている');
});

// 修正5の回帰テスト（review-adversarial N5）: ロック解放は所有権（pid一致）を確認してから
// 行う。人間が誤って残留と判断し手動削除した後、別プロセス（pid が異なる）が新しいロックを
// 取得した状況を再現し、finally 実行後もそのロックファイルが削除されずに残ることを確認する。
test('ingest: ロック解放は所有権（pid一致）を確認する。別プロセスの pid に書き換わったロックは削除しない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const lockPath = `${join(snap.dir, STRUCTURED_FINDINGS_FILE)}.lock`;

  const result = ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [baseFinding()],
    cwd: dir,
    // `now()` はロック保持中（artifact 書き込み前）に1度だけ呼ばれる既存の注入ポイント。
    // ここでロックの中身を別 pid のものへ書き換え、「人間が手動削除した後、別プロセスが
    // 新しいロックを取得した」状況を決定論的に再現する。
    now: () => {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid + 1, acquiredAt: new Date().toISOString() }),
      );
      return new Date();
    },
  });

  assert.equal(result.normalized, 1, 'ingest 自体は正常に完了する');
  assert.equal(
    existsSync(lockPath),
    true,
    '所有者 pid が一致しないロックは finally で削除されない',
  );
});

test('ingest: 呼び出し中に同じ snapshot への別の ingest 呼び出しが割り込むと、ロック取得に失敗し明確な例外を投げる（並行 ingest の検出）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  let concurrentAttemptError = null;

  const result = ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [baseFinding()],
    cwd: dir,
    // `now()` は artifact 読み取り後・書き込み前、ロック保持中に1度だけ呼ばれる（既存の
    // 注入ポイント）。ここで同じ snapshot への2つ目の ingestFindings 呼び出しを行い、
    // 「ロック保持中に別の ingest 呼び出しが同じ snapshot へ割り込む」状況を決定論的に再現する
    // （タイミング競合やモンキーパッチに頼らない）。
    now: () => {
      try {
        ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
      } catch (err) {
        concurrentAttemptError = err;
      }
      return new Date();
    },
  });

  assert.ok(concurrentAttemptError, '割り込んだ2つ目の呼び出しは例外を投げるべき');
  assert.match(concurrentAttemptError.message, /別の ingest がこの snapshot に対して実行中です/);
  assert.equal(result.normalized, 1, '外側の呼び出し自体はロックを保持したまま正常に完了する');

  const artifact = readArtifact(snap.dir);
  assert.equal(
    artifact.records.length,
    1,
    '割り込んだ呼び出しは書き込みを行わないため、外側の1件だけが残る',
  );
});

test('metrics/report: aggregate 後に ingest が増えると古い aggregate を検出して throw する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });

  assert.throws(() => runReport({ snapshotId: snap.snapshotId, cwd: dir }), /aggregate 結果が古い/);
  assert.throws(
    () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }),
    /aggregate 結果が古い/,
  );
});

// 修正3の回帰テスト（review-adversarial A1）: 件数を変えずに内容だけを書き換えた場合（例:
// 壊れた artifact を削除して同数の finding を re-ingest する復旧手順）も、件数比較ではなく
// 内容のハッシュ比較により鮮度不一致として検出される。
test('metrics/report: 件数を変えずに内容だけ変えると、古い内容ではなく鮮度不一致エラーを投げる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

  const artifact = readArtifact(snap.dir);
  assert.equal(artifact.records.length, 1, '前提: 件数は1件のまま');
  artifact.records[0].finding.severity = 'blocker';
  writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_FILE), JSON.stringify(artifact));
  assert.equal(
    readArtifact(snap.dir).records.length,
    1,
    '前提: 内容を書き換えても件数は変わっていない',
  );

  assert.throws(() => runReport({ snapshotId: snap.snapshotId, cwd: dir }), /aggregate 結果が古い/);
  assert.throws(
    () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }),
    /aggregate 結果が古い/,
  );
});

test('metrics/report: counts が欠落した aggregate ファイルは形式不正として throw する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(
    join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE),
    JSON.stringify({
      schemaVersion: STRUCTURED_FINDINGS_AGGREGATE_SCHEMA_VERSION,
      snapshotId: snap.snapshotId,
    }),
  );

  assert.throws(() => runReport({ snapshotId: snap.snapshotId, cwd: dir }), /counts/);
  assert.throws(() => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }), /counts/);
});

// 修正の回帰テスト（chatgpt-codex-connector 所見。review-pr #650）: formatReport が参照する
// counts の全フィールド（normalized/invalid/unrecognized/canonical/exactDuplicates/
// candidateGroupCount）は、readAggregateOrThrow の requiredCountFields に含まれていなかった。
// 特に counts.unrecognized が欠落すると `counts.unrecognized > 0`（undefined > 0）は常に
// false になり、直前の round で追加した unrecognized 可視化の警告表示が静かに抑止されて
// しまう。これら6フィールドが欠落・非数値の aggregate ファイルは、report/metrics（--angle
// 有無問わず）が fail-loud することを確認する。
const ADDITIONAL_REQUIRED_COUNT_FIELDS = [
  'normalized',
  'invalid',
  'unrecognized',
  'canonical',
  'exactDuplicates',
  'candidateGroupCount',
];

test('metrics/report: counts の normalized/invalid/unrecognized/canonical/exactDuplicates/candidateGroupCount が欠落・非数値だと fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const field of ADDITIONAL_REQUIRED_COUNT_FIELDS) {
    for (const mutate of [
      (counts) => {
        delete counts[field];
      },
      (counts) => {
        counts[field] = 'not-a-number';
      },
    ]) {
      const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
      ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
      runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

      const aggregateFile = join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE);
      const broken = JSON.parse(readFileSync(aggregateFile, 'utf-8'));
      mutate(broken.counts);
      writeFileSync(aggregateFile, JSON.stringify(broken));

      assert.throws(
        () => runReport({ snapshotId: snap.snapshotId, cwd: dir }),
        /counts/,
        `field=${field}: report は fail-loud するべき`,
      );
      assert.throws(
        () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }),
        /counts/,
        `field=${field}: metrics（round全体） は fail-loud するべき`,
      );
      assert.throws(
        () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir, angle: 'adversarial' }),
        /counts/,
        `field=${field}: metrics（--angle） は fail-loud するべき`,
      );
    }
  }
});

// 追加の回帰テスト（chatgpt-codex-connector 所見。review-pr #650）: counts / sourceHash が
// 揃っていても canonicalFindings 自体が欠落・非配列（部分破損・別 schema の cache 混入等）だと、
// 後続の formatReport / buildMetricsFlags の `canonicalFindings.filter(...)` が案内なしの生
// TypeError（`is not iterable` / `Cannot read properties of undefined`）になる。
// readAggregateOrThrow がこの形状を検証し、--angle 有無問わず案内付きエラーで fail-loud する
// ことを確認する。
test('report/metrics: canonicalFindings が欠落・非配列の aggregate ファイルは、--angle 有無問わず案内付きエラーで fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const brokenCanonicalFindingsValues = [undefined, 'not-an-array', { not: 'an-array' }];
  for (const value of brokenCanonicalFindingsValues) {
    const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
    ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
    runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

    const aggregateFile = join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE);
    const broken = JSON.parse(readFileSync(aggregateFile, 'utf-8'));
    if (value === undefined) {
      delete broken.canonicalFindings;
    } else {
      broken.canonicalFindings = value;
    }
    writeFileSync(aggregateFile, JSON.stringify(broken));

    const assertGuidedError = (err) => {
      assert.ok(
        !/is not iterable|Cannot read propert/i.test(err.message),
        `case=${JSON.stringify(value)}: 生の TypeError のままになっている: ${err.message}`,
      );
      assert.ok(
        /canonicalFindings/.test(err.message) && /再実行/.test(err.message),
        `case=${JSON.stringify(value)}: aggregate 再実行の案内が含まれていない: ${err.message}`,
      );
      return true;
    };

    assert.throws(() => runReport({ snapshotId: snap.snapshotId, cwd: dir }), assertGuidedError);
    assert.throws(
      () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }),
      assertGuidedError,
    );
    assert.throws(
      () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir, angle: 'adversarial' }),
      assertGuidedError,
    );
  }
});

// 修正2の回帰テスト（chatgpt-codex-connector 所見。review-pr #650、実行検証済み）: aggregate
// 済みの sourceHash が「空配列のハッシュ」である状態（= 一度も ingest せずに aggregate した
// 場合）で、後から実データを ingest したうえで、aggregate を再実行せずに
// structured-findings.json が `{}` へ破損すると、破損後の `records ?? []` も同じ「空配列の
// ハッシュ」になり、sourceHash 比較だけでは破損を検知できない（偶然の一致）。readAggregateOrThrow
// は `findingsArtifact` が非 null なのに `records` が配列でない場合、`?? []` へ fallback する前に
// 案内付きエラーで fail-loud する。
test('report/metrics: aggregate 済み sourceHash が空配列由来のまま、後から structured-findings.json が records 欠落状態へ破損すると、sourceHash 偶然一致に頼らず fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  // ①: 空の状態で一度 aggregate を実行する（sourceHash = hash([])、totalIngested = 0）。
  const emptyAggregate = runAggregate({ snapshotId: snap.snapshotId, cwd: dir });
  assert.equal(emptyAggregate.counts.totalIngested, 0, '前提: 空集計から開始する');

  // ②: 実データを ingest する（aggregate は再実行しない）。
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });

  // ③: aggregate を再実行せずに structured-findings.json が `{}` へ破損する
  // （records フィールド自体が失われる）。
  writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_FILE), JSON.stringify({}));

  // `{}`.records ?? [] は [] になり、そのハッシュは①由来の sourceHash（同じく空配列の
  // ハッシュ）と偶然一致するため、鮮度チェックだけでは破損を検知できない。
  assert.throws(
    () => runReport({ snapshotId: snap.snapshotId, cwd: dir }),
    /records が配列ではありません/,
  );
  assert.throws(
    () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }),
    /records が配列ではありません/,
  );
});

// A9-1 の回帰テスト（review-adversarial round9）: schemaVersion を検証していないと、
// canonical finding の形状が変わった（round8 で actionableReporters を追加）以前のコード版が
// 生成した aggregate 成果物を、鮮度ガード（sourceHash。ingest 内容の変化しか検知しない）が
// 素通りしてしまう。`report`/`metrics`（--angle 有無問わず）がその状態を検出し、生の例外
// ではなく「aggregate を再実行してください」という案内付きエラーで fail-loud することを
// 確認する。
function assertGuidedSchemaVersionError(err) {
  assert.ok(
    !/Cannot read propert/i.test(err.message),
    `生の TypeError のままになっている: ${err.message}`,
  );
  assert.ok(
    /aggregate/.test(err.message) && /再実行/.test(err.message),
    `aggregate 再実行の案内が含まれていない: ${err.message}`,
  );
}

// 「以前のコード版が生成した成果物」を模すヘルパー: schemaVersion を書き換え、round8 で
// canonical finding へ追加された actionableReporters を取り除く（実際に旧コードが書き込んで
// いた形状）。counts / sourceHash はそのまま保持するため、鮮度ガードはすり抜ける——
// schemaVersion 検証が無いと検出できないケースであることを保証する。
function toStaleAggregateFixture(aggregateFile, mutateSchemaVersion) {
  const stale = JSON.parse(readFileSync(aggregateFile, 'utf-8'));
  mutateSchemaVersion(stale);
  stale.canonicalFindings = stale.canonicalFindings.map((c) => {
    const { actionableReporters: _actionableReporters, ...rest } = c;
    return rest;
  });
  writeFileSync(aggregateFile, JSON.stringify(stale));
}

test('report/metrics: schemaVersion が旧い値（1）の aggregate 成果物は、--angle 有無問わず案内付きエラーで fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

  const aggregateFile = join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE);
  toStaleAggregateFixture(aggregateFile, (stale) => {
    stale.schemaVersion = 1;
  });

  assert.throws(
    () => runReport({ snapshotId: snap.snapshotId, cwd: dir }),
    (err) => {
      assertGuidedSchemaVersionError(err);
      return true;
    },
  );
  assert.throws(
    () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }),
    (err) => {
      assertGuidedSchemaVersionError(err);
      return true;
    },
  );
  assert.throws(
    () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir, angle: 'adversarial' }),
    (err) => {
      assertGuidedSchemaVersionError(err);
      return true;
    },
  );
});

test('report/metrics: schemaVersion フィールド自体が欠落した aggregate 成果物（さらに旧い版）も案内付きエラーで fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

  const aggregateFile = join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE);
  toStaleAggregateFixture(aggregateFile, (stale) => {
    delete stale.schemaVersion;
  });

  assert.throws(
    () => runReport({ snapshotId: snap.snapshotId, cwd: dir }),
    (err) => {
      assertGuidedSchemaVersionError(err);
      return true;
    },
  );
  assert.throws(
    () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }),
    (err) => {
      assertGuidedSchemaVersionError(err);
      return true;
    },
  );
  assert.throws(
    () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir, angle: 'adversarial' }),
    (err) => {
      assertGuidedSchemaVersionError(err);
      return true;
    },
  );
});

test('ingest: 極端に深い angle_fields を持つ要素があっても、他の正常な要素は失われない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  const deep = {};
  let cursor = deep;
  for (let i = 0; i < 6000; i += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  const pathological = baseFinding({ angle_fields: deep });
  const normal = baseFinding({ summary: 'normal finding untouched' });

  const result = ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [pathological, normal],
    cwd: dir,
  });
  assert.equal(result.added, 2);
  assert.equal(result.normalized, 1);
  assert.equal(result.invalid, 1);

  const artifact = readArtifact(snap.dir);
  assert.equal(artifact.records.length, 2, '病的な要素があっても他方の正常な要素は失われない');
  assert.ok(
    artifact.records.some(
      (r) => r.status === 'normalized' && r.finding.summary === 'normal finding untouched',
    ),
  );
  assert.ok(artifact.records.some((r) => r.status === 'invalid'));
});

test('ingest: angle_fields が約4160階層ネストした要素があっても writeJson まで含めてバッチ全体が失われない（実際の報告事例の回帰再現）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  // インデント付きで artifact 全体を直列化する writeJson が RangeError を投げていた、実際の
  // 報告事例と同じ深さ（約4160階層）を angle_fields に持つ要素。
  const pathological = baseFinding({ angle_fields: { deep: buildDeeplyNestedArray(4160) } });
  const normal = baseFinding({ summary: 'normal finding untouched' });

  const result = ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [pathological, normal],
    cwd: dir,
  });
  assert.equal(result.added, 2);
  assert.equal(result.normalized, 1, '深すぎる angle_fields を持つ要素は invalid 側へ回る');
  assert.equal(result.invalid, 1);

  const artifact = readArtifact(snap.dir);
  assert.equal(
    artifact.records.length,
    2,
    'writeJson が成功し、深い要素・正常な要素の両方が artifact に残る（バッチ全体は失われない）',
  );
  assert.ok(
    artifact.records.some(
      (r) => r.status === 'normalized' && r.finding.summary === 'normal finding untouched',
    ),
  );
  assert.ok(artifact.records.some((r) => r.status === 'invalid'));
});

test('ingest: 既存 artifact の finding_id が桁あふれ/非数値だと corruption として throw する（採番の衝突を防ぐ）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const file = join(snap.dir, STRUCTURED_FINDINGS_FILE);

  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      contractVersion: 1,
      snapshotId: snap.snapshotId,
      records: [
        {
          finding_id: 'f-99999999999999999999',
          status: 'normalized',
          finding: { finding_id: 'f-99999999999999999999', ...baseFinding() },
        },
      ],
    }),
  );
  assert.throws(
    () => ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
    /不正な finding_id 形式/,
  );

  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      contractVersion: 1,
      snapshotId: snap.snapshotId,
      records: [
        {
          finding_id: 'f-abc',
          status: 'normalized',
          finding: { finding_id: 'f-abc', ...baseFinding() },
        },
      ],
    }),
  );
  assert.throws(
    () => ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
    /不正な finding_id 形式/,
  );
});

test('ingest: 既存 finding_id が Number.MAX_SAFE_INTEGER ちょうどだと、次の採番で上限到達として throw する（重複IDを防ぐ）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const file = join(snap.dir, STRUCTURED_FINDINGS_FILE);
  const maxSafeId = `f-${Number.MAX_SAFE_INTEGER}`; // f-9007199254740991

  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      contractVersion: 1,
      snapshotId: snap.snapshotId,
      records: [
        {
          finding_id: maxSafeId,
          status: 'normalized',
          finding: { finding_id: maxSafeId, ...baseFinding() },
        },
      ],
    }),
  );

  assert.throws(
    () => ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
    /採番上限/,
  );
  // 上限到達で fail-loud した場合、重複 finding_id を書き込んでいないこと（元の1件のみ）を確認する。
  assert.equal(readArtifact(snap.dir).records.length, 1);
});

test('ingest: records が配列でない壊れた artifact は fail-loud する（runAggregate と同じ方針）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(
    join(snap.dir, STRUCTURED_FINDINGS_FILE),
    JSON.stringify({ schemaVersion: 1, records: {} }),
  );

  assert.throws(
    () => ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
    /records/,
  );
});

// 修正の回帰テスト（chatgpt-codex-connector 所見。review-pr #650）: 既存の
// structured-findings.json を読む際、records が配列であることしか検証していないと、別
// snapshot からコピーされた、または旧 schema/contract バージョンで生成された artifact
// （records さえ配列であれば形式上は妥当）が対象 snapshot のディレクトリに置かれていた場合、
// そのまま現在の snapshot の finding として追記されてしまい、後続の aggregate がこの混入
// record を現在の snapshot に帰属させて report/metrics を誤集計する。ingestFindings は
// 既存 artifact の schemaVersion/contractVersion/snapshotId が現在のコード・snapshot と
// 一致することを検証し、不一致なら fail-loud することを確認する（一致する場合は引き続き
// 追記に成功する）。
test('ingest: 既存 artifact の schemaVersion/contractVersion/snapshotId が一致する場合は追記に成功し、不一致の場合はそれぞれ fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });

  // 正常系: schemaVersion/contractVersion/snapshotId が現在のコード・snapshot と一致する
  // artifact への追記は引き続き成功する（回帰確認）。
  const normalResult = ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [baseFinding({ summary: 'second' })],
    cwd: dir,
  });
  assert.equal(normalResult.normalized, 1);
  assert.equal(readArtifact(snap.dir).records.length, 2);

  const pristineArtifact = readArtifact(snap.dir);
  const mismatchCases = [
    { field: 'schemaVersion', value: 999, expected: /schemaVersion が一致しません/ },
    { field: 'contractVersion', value: 999, expected: /contractVersion が一致しません/ },
    { field: 'snapshotId', value: 'other-snapshot-id', expected: /snapshotId が一致しません/ },
  ];
  for (const { field, value, expected } of mismatchCases) {
    // 毎回 pristine な状態から該当フィールドだけを書き換える
    // （前の反復での書き換えが後続の検証に影響しないようにするため）。
    const artifact = JSON.parse(JSON.stringify(pristineArtifact));
    artifact[field] = value;
    writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_FILE), JSON.stringify(artifact));

    assert.throws(
      () => ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
      expected,
      `${field} の不一致は fail-loud するべき`,
    );
  }
});

// 修正の回帰テスト（review-adversarial round16 で実行確認された抜け穴。review-pr #650）: 前段の
// ingest 側の検証（上記テスト）は `ingestFindings`（ingest コマンド経由の書き込みパス）にしか
// 適用されておらず、`runAggregate`（aggregate コマンドが structured-findings.json を直接読んで
// 集計するパス）には同じ検証が無かった。別 snapshot（snapshotId 違い）の
// structured-findings.json を、ingest を一切呼ばずに対象 snapshot のディレクトリへ直接コピーし、
// aggregate を実行すると、そのまま「異物」records を現在の snapshot の finding として受理して
// しまう（sourceHash はコピー後の内容で再計算されるため鮮度ガードもすり抜ける）。runAggregate は
// 既存 artifact の schemaVersion/contractVersion/snapshotId が現在のコード・snapshot と一致する
// ことを検証し、不一致なら fail-loud することを確認する（一致する場合は引き続き集約に成功する）。
test('aggregate: 既存 artifact の schemaVersion/contractVersion/snapshotId が一致する場合は集約に成功し、不一致の場合はそれぞれ fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });

  // 正常系: schemaVersion/contractVersion/snapshotId が現在のコード・snapshot と一致する
  // artifact への aggregate は引き続き成功する（回帰確認）。
  const normalResult = runAggregate({ snapshotId: snap.snapshotId, cwd: dir });
  assert.equal(normalResult.counts.totalIngested, 1);

  const pristineArtifact = readArtifact(snap.dir);
  const mismatchCases = [
    { field: 'schemaVersion', value: 999, expected: /schemaVersion が一致しません/ },
    { field: 'contractVersion', value: 999, expected: /contractVersion が一致しません/ },
    { field: 'snapshotId', value: 'other-snapshot-id', expected: /snapshotId が一致しません/ },
  ];
  for (const { field, value, expected } of mismatchCases) {
    // 毎回 pristine な状態から該当フィールドだけを書き換える（ingest を一切呼ばず、別
    // snapshot / 旧コード版で生成された artifact を直接配置した攻撃シナリオを模す）。
    const artifact = JSON.parse(JSON.stringify(pristineArtifact));
    artifact[field] = value;
    writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_FILE), JSON.stringify(artifact));

    assert.throws(
      () => runAggregate({ snapshotId: snap.snapshotId, cwd: dir }),
      expected,
      `${field} の不一致は fail-loud するべき`,
    );
  }
});

// 修正の回帰テスト（review-adversarial round16 confirmation で実行確認された、さらに3つ目の
// 抜け穴。review-pr #650）: 上記2テストの検証（`ingestFindings`・`runAggregate`）は書き込み
// 経路にのみ適用されており、`readAggregateOrThrow`（`report`/`metrics` が使う読み取り経路）には
// 同じ検証が無く、かつ aggregate.snapshotId 自体も検証していなかった。aggregate.snapshotId が
// 対象 snapshot と一致する場合は引き続き成功し、不一致の場合は fail-loud することを確認する。
test('report/metrics: aggregate.snapshotId が対象 snapshot と一致する場合は成功し、不一致の場合は fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

  // 正常系: snapshotId が一致する aggregate に対しては引き続き成功する（回帰確認）。
  assert.doesNotThrow(() => runReport({ snapshotId: snap.snapshotId, cwd: dir }));
  assert.doesNotThrow(() => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }));

  const mismatched = { ...readAggregateArtifact(snap.dir), snapshotId: 'other-snapshot-id' };
  writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE), JSON.stringify(mismatched));

  assert.throws(
    () => runReport({ snapshotId: snap.snapshotId, cwd: dir }),
    /snapshotId が一致しません/,
  );
  assert.throws(
    () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }),
    /snapshotId が一致しません/,
  );
});

// 上記と対になるテスト: structured-findings.json 側（findingsArtifact）の
// schemaVersion/contractVersion/snapshotId が対象 snapshot・現在のコードと一致する場合は
// 引き続き成功し、不一致の場合はそれぞれ fail-loud することを確認する。
test('report/metrics: structured-findings.json の schemaVersion/contractVersion/snapshotId が一致する場合は成功し、不一致の場合はそれぞれ fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

  // 正常系（回帰確認）。
  assert.doesNotThrow(() => runReport({ snapshotId: snap.snapshotId, cwd: dir }));
  assert.doesNotThrow(() => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }));

  const pristineArtifact = readArtifact(snap.dir);
  const mismatchCases = [
    { field: 'schemaVersion', value: 999, expected: /schemaVersion が一致しません/ },
    { field: 'contractVersion', value: 999, expected: /contractVersion が一致しません/ },
    { field: 'snapshotId', value: 'other-snapshot-id', expected: /snapshotId が一致しません/ },
  ];
  for (const { field, value, expected } of mismatchCases) {
    // 毎回 pristine な状態から該当フィールドだけを書き換える（aggregate は再実行せず、別
    // snapshot / 旧コード版で生成された artifact を直接配置した攻撃シナリオを模す）。
    const artifact = JSON.parse(JSON.stringify(pristineArtifact));
    artifact[field] = value;
    writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_FILE), JSON.stringify(artifact));

    assert.throws(
      () => runReport({ snapshotId: snap.snapshotId, cwd: dir }),
      expected,
      `${field} の不一致は report を fail-loud させるべき`,
    );
    assert.throws(
      () => buildMetricsFlags({ snapshotId: snap.snapshotId, cwd: dir }),
      expected,
      `${field} の不一致は metrics を fail-loud させるべき`,
    );
  }
});

// fix #2 の回帰テスト: `artifact !== null` を前提にしたガードは、ファイルの中身が JSON の
// `null` である場合にすり抜け、後続の `for (const record of artifact.records)` が生の
// TypeError を投げていた。
test('ingest: structured-findings.json の中身が JSON の null だと生の TypeError ではなくガイド付きエラーで fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_FILE), 'null');

  assert.throws(
    () => ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir }),
    /records が配列ではありません/,
  );
});

test('CLI: --snapshot が値なしで渡されると既定値へフォールバックせず明確なエラーで失敗する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const inputPath = join(dir, 'valid.json');
  writeFileSync(inputPath, JSON.stringify([baseFinding()]));

  assert.throws(
    () =>
      runFindingsCli(dir, [
        'ingest',
        '--snapshot',
        '--angle',
        'adversarial',
        '--anchor-class',
        'attack-surface',
        '--input',
        inputPath,
      ]),
    /--snapshot/,
  );
});

test('CLI: --snapshot=<id> の = 構文は allowlist 外のキーとして明確に失敗し、他の（最新）snapshot へ黙って書き込まない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const realSnap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const latestSnap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const inputPath = join(dir, 'valid.json');
  writeFileSync(inputPath, JSON.stringify([baseFinding()]));

  assert.throws(
    () =>
      runFindingsCli(dir, [
        'ingest',
        `--snapshot=${realSnap.snapshotId}`,
        '--angle',
        'adversarial',
        '--anchor-class',
        'attack-surface',
        '--input',
        inputPath,
      ]),
    /未知の flag です: --snapshot=/,
  );

  assert.equal(
    existsSync(join(latestSnap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    '誤解釈された --snapshot=<id> によって最新 snapshot へ黙って書き込まれていない',
  );
  assert.equal(
    existsSync(join(realSnap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    '本来指定したかった snapshot にも何も書き込まれていない（コマンド全体が失敗するため）',
  );
});

test('CLI: --snapshot-id（別スペル）は allowlist で拒否され、他の（最新）snapshot へ黙って書き込まない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const realSnap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const latestSnap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const inputPath = join(dir, 'valid.json');
  writeFileSync(inputPath, JSON.stringify([baseFinding()]));

  assert.throws(
    () =>
      runFindingsCli(dir, [
        'ingest',
        '--snapshot-id',
        realSnap.snapshotId,
        '--angle',
        'adversarial',
        '--anchor-class',
        'attack-surface',
        '--input',
        inputPath,
      ]),
    /未知の flag です: --snapshot-id/,
  );

  assert.equal(
    existsSync(join(latestSnap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    '誤ったスペルの --snapshot-id によって最新 snapshot へ黙って書き込まれていない',
  );
  assert.equal(
    existsSync(join(realSnap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    '本来指定したかった snapshot にも何も書き込まれていない（コマンド全体が失敗するため）',
  );
});

test('CLI: --Snapshot（大文字小文字違い）は allowlist で拒否され、他の（最新）snapshot へ黙って書き込まない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const realSnap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const latestSnap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const inputPath = join(dir, 'valid.json');
  writeFileSync(inputPath, JSON.stringify([baseFinding()]));

  assert.throws(
    () =>
      runFindingsCli(dir, [
        'ingest',
        '--Snapshot',
        realSnap.snapshotId,
        '--angle',
        'adversarial',
        '--anchor-class',
        'attack-surface',
        '--input',
        inputPath,
      ]),
    /未知の flag です: --Snapshot/,
  );

  assert.equal(
    existsSync(join(latestSnap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    '誤った大文字小文字の --Snapshot によって最新 snapshot へ黙って書き込まれていない',
  );
  assert.equal(
    existsSync(join(realSnap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    '本来指定したかった snapshot にも何も書き込まれていない（コマンド全体が失敗するため）',
  );
});

test('CLI: --snapshot に空文字列を渡すと最新 snapshot へフォールバックせず明確なエラーで失敗する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const latestSnap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const inputPath = join(dir, 'valid.json');
  writeFileSync(inputPath, JSON.stringify([baseFinding()]));

  assert.throws(
    () =>
      runFindingsCli(dir, [
        'ingest',
        '--snapshot',
        '',
        '--angle',
        'adversarial',
        '--anchor-class',
        'attack-surface',
        '--input',
        inputPath,
      ]),
    /--snapshot に空文字列は指定できません/,
  );
  assert.equal(
    existsSync(join(latestSnap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    '空文字列の --snapshot によって最新 snapshot へ黙って書き込まれていない',
  );
});

// 修正1の回帰テスト（review-adversarial N1）: parseArgs は ASCII "--" で始まらないトークンを
// その場で黙って無視するため、parseArgs の出力（キー名）だけを見る allowlist 検査では
// 非ASCIIダッシュ変種で始まるトークンがそもそも検査対象に現れず素通りする。assertKnownArgs は
// 生トークンを直接検査してこれを拒否する。
test('CLI: 非ASCIIダッシュ（en dash・em dash・全角ハイフン）で始まる flag トークンは拒否され、最新 snapshot へ黙って書き込まれない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inputPath = join(dir, 'valid.json');
  writeFileSync(inputPath, JSON.stringify([baseFinding()]));

  const dashVariants = [
    ['en dash', '–'],
    ['em dash', '—'],
    ['全角ハイフン', '－'],
  ];

  for (const [label, dash] of dashVariants) {
    const realSnap = createSnapshot({ cwd: dir, baseRef: 'main' });
    const latestSnap = createSnapshot({ cwd: dir, baseRef: 'main' });

    assert.throws(
      () =>
        runFindingsCli(dir, [
          'ingest',
          `${dash}snapshot`,
          realSnap.snapshotId,
          '--angle',
          'adversarial',
          '--anchor-class',
          'attack-surface',
          '--input',
          inputPath,
        ]),
      /認識できない引数です/,
      `${label} variant should be rejected`,
    );

    assert.equal(
      existsSync(join(latestSnap.dir, STRUCTURED_FINDINGS_FILE)),
      false,
      `${label}: 誤解釈されて最新 snapshot へ黙って書き込まれていない`,
    );
    assert.equal(
      existsSync(join(realSnap.dir, STRUCTURED_FINDINGS_FILE)),
      false,
      `${label}: 本来指定したかった snapshot にも何も書き込まれていない`,
    );
  }
});

test('CLI: -- を伴わない位置引数（例: ingest <snapshot-id> --input file.json）は拒否される', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const inputPath = join(dir, 'valid.json');
  writeFileSync(inputPath, JSON.stringify([baseFinding()]));

  assert.throws(
    () => runFindingsCli(dir, ['ingest', snap.snapshotId, '--input', inputPath]),
    /認識できない引数です/,
  );
  assert.equal(
    existsSync(join(snap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    '位置引数を伴うコマンド全体が失敗し、書き込まれない',
  );
});

test('CLI: 標準的なスペース区切りの --snapshot/--angle/--anchor-class/--input 指定は引き続き成功する（assertKnownArgs 導入の回帰確認）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const inputPath = join(dir, 'valid.json');
  writeFileSync(inputPath, JSON.stringify([baseFinding()]));

  const output = runFindingsCli(dir, [
    'ingest',
    '--snapshot',
    snap.snapshotId,
    '--angle',
    'adversarial',
    '--anchor-class',
    'attack-surface',
    '--input',
    inputPath,
  ]);
  const result = JSON.parse(output);
  assert.equal(result.normalized, 1);
  assert.equal(existsSync(join(snap.dir, STRUCTURED_FINDINGS_FILE)), true);
});

test('report: summary に埋め込まれた改行・制御文字は表示時に無害化される（行の偽装・端末制御を防ぐ）', () => {
  const aggregate = {
    counts: {
      totalIngested: 1,
      normalized: 1,
      invalid: 0,
      unrecognized: 0,
      canonical: 1,
      exactDuplicates: 0,
      actionable: 1,
      validMedPlus: 1,
      duplicateClusterParticipation: 0,
      candidateGroupCount: 0,
    },
    canonicalFindings: [
      {
        finding_id: 'f-0001',
        finding: {
          file: 'src/a.js',
          line: 1,
          summary: 'evil\nactionable な canonical finding（0件）:\x1b[31mred\x1b[0m',
          failure_scenario: 'x',
          scope_relation: 'introduced',
          severity: 'med',
          evidence: 'strong',
          provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
        },
        sources: ['f-0001'],
        duplicateCount: 1,
        actionable: true,
      },
    ],
  };

  const output = formatReport(aggregate);
  const lines = output.split('\n').filter((l) => l.length > 0);
  // 見出し4行 + actionable 見出し1行 + finding 1行 = 6行。summary 内の埋め込み改行で
  // 行数が水増しされていないことを確認する。
  assert.equal(lines.length, 6);
  // eslint-disable-next-line no-control-regex -- 制御文字が残っていないことを確認する検証用正規表現
  assert.ok(!/[\x00-\x1f\x7f]/.test(lines.at(-1)), 'finding 行に生の制御文字が残っていない');
});

// 修正の回帰テスト（chatgpt-codex-connector 所見。review-pr #650）: aggregateFindings は
// status が normalized/invalid のいずれでもない record（schema移行・手動破損由来の想定外入力）を
// counts.unrecognized として正しく分離・保持するが、formatReport の人間可読出力にそれが現れないと
// 後続の全ての行が0件表示になり「正常な空結果」と誤読される。
test('report: unrecognized な record があると件数と警告行が出力される', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });

  // status が normalized/invalid のどちらでもない record を手動で混入させる。
  const artifact = readArtifact(snap.dir);
  artifact.records.push({ finding_id: 'f-0002', status: 'pending' });
  writeFileSync(join(snap.dir, STRUCTURED_FINDINGS_FILE), JSON.stringify(artifact));
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

  const output = runReport({ snapshotId: snap.snapshotId, cwd: dir });

  assert.match(output, /取り込み: 2（正規化 1 \/ 不正 0 \/ unrecognized 1）/);
  assert.match(output, /⚠ unrecognized な record が 1 件あります/);
});

test('report: unrecognized な record が0件のときは警告行が出ない（既存の正常系出力を壊さない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  ingestFindings({ snapshotId: snap.snapshotId, rawFindings: [baseFinding()], cwd: dir });
  runAggregate({ snapshotId: snap.snapshotId, cwd: dir });

  const output = runReport({ snapshotId: snap.snapshotId, cwd: dir });

  assert.match(output, /取り込み: 1（正規化 1 \/ 不正 0 \/ unrecognized 0）/);
  assert.ok(!output.includes('⚠'), '既存の正常系出力に警告行が混入していない');
});

// 修正3の回帰テスト（chatgpt-codex-connector 所見。review-pr #650）: CLI の `--angle`
// 自体（個々の finding が独自の provenance.angle を持たない場合の既定値）は、要素ループへ
// 入る前に isKnownAngle で検証される。未知の場合は要素単位の invalid 格下げではなく、
// バッチ全体を fail-loud する（typo った既定値が ingestBatch.angle という監査メタデータへ
// そのまま記録され続けるのを防ぐため）。
test('ingest: --angle 自体が未知だと、要素の処理に入る前に fail-loud し、artifact を書き込まない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const raw = { ...baseFinding() };
  delete raw.provenance;

  assert.throws(
    () =>
      ingestFindings({
        snapshotId: snap.snapshotId,
        angle: 'not-a-real-angle',
        anchorClass: 'attack-surface',
        rawFindings: [raw],
        cwd: dir,
      }),
    /未知の観点です（--angle）: not-a-real-angle/,
  );
  assert.equal(
    existsSync(join(snap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    '--angle 自体が未知の場合、artifact への書き込みも行わない',
  );
});

// 修正3の回帰テスト: バッチ内の全要素が既に有効な明示 provenance.angle を持つ場合でも、
// CLI から渡された --angle 自体が未知なら（どの要素にも実際には適用されなくても）fail-loud
// する——typo った既定値が ingestBatch.angle（監査メタデータ）へ記録されるのを防ぐため。
test('ingest: 全要素が有効な明示provenance.angleを持ち --angle が実際には使われない場合でも、--angle 自体が未知なら fail-loud する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const raw = baseFinding({ provenance: { angle: 'adversarial', anchor_class: 'attack-surface' } });

  assert.throws(
    () =>
      ingestFindings({
        snapshotId: snap.snapshotId,
        angle: 'not-a-real-angle',
        anchorClass: 'attack-surface',
        rawFindings: [raw],
        cwd: dir,
      }),
    /未知の観点です（--angle）: not-a-real-angle/,
  );
  assert.equal(
    existsSync(join(snap.dir, STRUCTURED_FINDINGS_FILE)),
    false,
    'バッチ内の全要素が有効でも、--angle 自体が未知なら artifact を書き込まない',
  );
});

// --angle を省略した場合（angle === null）は、この新しい検証の対象外のまま——既存の
// 要素単位の isKnownAngle 検証（provenance.angle 自体）がそのまま効く（回帰確認）。
test('ingest: --angle を省略（null）した場合は新しい検証の対象外で、要素単位の provenance.angle 検証のみが効く', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const raw = baseFinding({ provenance: { angle: 'typo-angle', anchor_class: 'x' } });

  const result = ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [raw],
    cwd: dir,
  });
  assert.equal(result.normalized, 0);
  assert.equal(result.invalid, 1);
  assert.ok(result.invalidDetails[0].errors.some((e) => e.includes('未知の観点です')));
});

test('ingest: finding 自身の provenance.angle が未知だと、CLI 既定値が有効でも invalid になる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const raw = baseFinding({ provenance: { angle: 'typo-angle', anchor_class: 'x' } });

  const result = ingestFindings({
    snapshotId: snap.snapshotId,
    angle: 'adversarial',
    anchorClass: 'attack-surface',
    rawFindings: [raw],
    cwd: dir,
  });
  assert.equal(result.normalized, 0);
  assert.equal(result.invalid, 1);
});

test('ingest: 既知の angle（通常系統・条件起動系統）はどちらも normalized になる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const normalAngle = baseFinding({ provenance: { angle: 'adversarial', anchor_class: 'x' } });
  const conditionalAngle = baseFinding({
    summary: 'memory angle finding',
    provenance: { angle: 'memory', anchor_class: 'x' },
  });

  const result = ingestFindings({
    snapshotId: snap.snapshotId,
    rawFindings: [normalAngle, conditionalAngle],
    cwd: dir,
  });
  assert.equal(result.normalized, 2);
  assert.equal(result.invalid, 0);
});

test('CLI: --input が構文的に不正な JSON の場合は非ゼロ終了する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const inputPath = join(dir, 'invalid.json');
  writeFileSync(inputPath, '{not valid json,}');

  assert.throws(
    () => runFindingsCli(dir, ['ingest', '--snapshot', snap.snapshotId, '--input', inputPath]),
    /JSON として読めません/,
  );
});

test('CLI: ingest で invalid 要素があると finding_id とエラーを stderr へ書く', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const inputPath = join(dir, 'mixed.json');
  writeFileSync(inputPath, JSON.stringify([baseFinding(), { file: 'src/a.js' }]));
  const stderrPath = join(dir, 'stderr.txt');

  const stderrFd = openSync(stderrPath, 'w');
  try {
    execFileSync(
      'node',
      [
        join(ROOT, 'scripts/agent/review-findings.js'),
        'ingest',
        '--snapshot',
        snap.snapshotId,
        '--input',
        inputPath,
      ],
      { cwd: dir, stdio: ['ignore', 'pipe', stderrFd] },
    );
  } finally {
    closeSync(stderrFd);
  }

  const stderrContent = readFileSync(stderrPath, 'utf-8');
  assert.match(
    stderrContent,
    /f-0002/,
    '2件目（invalid 要素）の finding_id が stderr に出力される',
  );
});

test('CLI: invalid finding のエラーメッセージに埋め込まれた制御文字は stderr で無害化される', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  // 未知の provenance.angle はそのままエラーメッセージへ埋め込まれる（review-findings.js の
  // isKnownAngle チェック）。ここに ESC/CR を仕込み、report の summary と同じ攻撃面が
  // ingest の stderr 出力にも存在することを確認する。
  const maliciousAngle = 'evil\x1b[31m\rangle';
  const inputPath = join(dir, 'malicious.json');
  writeFileSync(
    inputPath,
    JSON.stringify([baseFinding({ provenance: { angle: maliciousAngle, anchor_class: 'x' } })]),
  );
  const stderrPath = join(dir, 'stderr.txt');

  const stderrFd = openSync(stderrPath, 'w');
  try {
    execFileSync(
      'node',
      [
        join(ROOT, 'scripts/agent/review-findings.js'),
        'ingest',
        '--snapshot',
        snap.snapshotId,
        '--input',
        inputPath,
      ],
      { cwd: dir, stdio: ['ignore', 'pipe', stderrFd] },
    );
  } catch (err) {
    // この finding は唯一の要素が全件 invalid（未知の provenance.angle）になるため、
    // 修正2（review-adversarial N2）により非ゼロ終了する。このテストの主眼は stderr の
    // サニタイズ検証であり、非ゼロ終了自体は意図した挙動なので許容する。
    assert.equal(err.status, 1);
  } finally {
    closeSync(stderrFd);
  }

  const stderrContent = readFileSync(stderrPath, 'utf-8');
  assert.match(stderrContent, /未知の観点です/, '前提: 未知の観点エラーが出力されている');
  assert.ok(!stderrContent.includes('\x1b'), 'ESC が生のまま出力されていない');
  assert.ok(!stderrContent.includes('\r'), 'CR が生のまま出力されていない');
});

// 修正2の回帰テスト（review-adversarial N2）: 送信件数 > 0 なのに正規化件数が 0（全件
// invalid）だと、orchestrator が exit code だけを見て次工程へ進んでしまわないよう非ゼロ終了する。
test('CLI: --angle/--anchor-class を省略し finding にも provenance が無く全件 invalid になると、非ゼロ終了する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const inputPath = join(dir, 'no-provenance.json');
  const raw = baseFinding();
  delete raw.provenance;
  writeFileSync(inputPath, JSON.stringify([raw]));

  assert.throws(
    () => runFindingsCli(dir, ['ingest', '--snapshot', snap.snapshotId, '--input', inputPath]),
    (err) => {
      assert.equal(err.status, 1, '全件 invalid の ingest は非ゼロ終了するべき');
      assert.match(err.message, /全件 invalid/);
      return true;
    },
  );
});

// 「部分的な invalid はバッチ全体を失敗させない」という既存設計の回帰テスト。
test('CLI: 一部 normalized・一部 invalid の混在バッチでは exit code は変わらず0のまま', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  const inputPath = join(dir, 'mixed.json');
  writeFileSync(inputPath, JSON.stringify([baseFinding(), { file: 'src/a.js' }]));

  const output = runFindingsCli(dir, [
    'ingest',
    '--snapshot',
    snap.snapshotId,
    '--input',
    inputPath,
  ]);
  const result = JSON.parse(output);
  assert.equal(result.normalized, 1);
  assert.equal(result.invalid, 1);
});

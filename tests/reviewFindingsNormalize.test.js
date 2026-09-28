import test from 'node:test';
import assert from 'node:assert/strict';

import { REVIEW_RAW_FINDING_SCHEMA } from '../scripts/agent/review-finding-contract.js';
import {
  MAX_ANGLE_FIELDS_DEPTH,
  MAX_SERIALIZED_CHARS,
  capForStorage,
  isActionable,
  truncateForMessage,
  validateAndNormalizeFinding,
} from '../scripts/agent/review-findings-normalize.js';

// JSON.stringify が RangeError（Maximum call stack size exceeded）を投げる程度に深い、
// ネストしたオブジェクトを作る（fix #3 の回帰テスト用）。
function buildDeeplyNestedObject(depth) {
  const root = {};
  let cursor = root;
  for (let i = 0; i < depth; i += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  return root;
}

// キー名を持たない分、同じネスト深さでも直列化後の文字数が小さく収まる配列版
// （fix #2: 深さ上限は文字数上限とは独立に検出する必要があることの再現用）。
function buildDeeplyNestedArray(depth) {
  let value = [];
  for (let i = 0; i < depth; i += 1) {
    value = [value];
  }
  return value;
}

function validFinding() {
  return {
    file: 'src/foo.js',
    line: 42,
    summary: 'summary text',
    failure_scenario: 'failure scenario text',
    scope_relation: 'introduced',
    severity: 'med',
    evidence: 'strong',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  };
}

test('正常な finding は normalized になり、finding は期待どおりに構築される', () => {
  const result = validateAndNormalizeFinding(validFinding());
  assert.equal(result.status, 'normalized');
  assert.deepEqual(result.finding, {
    file: 'src/foo.js',
    line: 42,
    summary: 'summary text',
    failure_scenario: 'failure scenario text',
    scope_relation: 'introduced',
    severity: 'med',
    evidence: 'strong',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  assert.deepEqual(Object.keys(result.finding.provenance).sort(), ['anchor_class', 'angle']);
});

test('必須フィールドが1つ欠けると invalid になり、errors が非空になる', () => {
  for (const field of REVIEW_RAW_FINDING_SCHEMA.required) {
    const raw = validFinding();
    delete raw[field];
    const result = validateAndNormalizeFinding(raw);
    assert.equal(result.status, 'invalid', `${field} 欠落時は invalid になるべき`);
    assert.ok(result.errors.length > 0, `${field} 欠落時の errors が空`);
  }
});

test('scope_relation が未知の値だと invalid になる', () => {
  const raw = { ...validFinding(), scope_relation: 'not-a-scope' };
  assert.equal(validateAndNormalizeFinding(raw).status, 'invalid');
});

test('severity が未知の値だと invalid になる', () => {
  const raw = { ...validFinding(), severity: 'not-a-severity' };
  assert.equal(validateAndNormalizeFinding(raw).status, 'invalid');
});

test('evidence が未知の値だと invalid になる', () => {
  const raw = { ...validFinding(), evidence: 'not-a-evidence' };
  assert.equal(validateAndNormalizeFinding(raw).status, 'invalid');
});

test('line: 負の値・0・小数・文字列は invalid になる', () => {
  for (const bad of [-1, 0, 1.5, '42']) {
    const raw = { ...validFinding(), line: bad };
    assert.equal(
      validateAndNormalizeFinding(raw).status,
      'invalid',
      `line=${JSON.stringify(bad)} は invalid になるべき`,
    );
  }
});

test('line: null と巨大な整数は normalized になる（上限は設けない）', () => {
  const withNull = validateAndNormalizeFinding({ ...validFinding(), line: null });
  assert.equal(withNull.status, 'normalized');
  assert.equal(withNull.finding.line, null);

  const withBig = validateAndNormalizeFinding({ ...validFinding(), line: 999999999 });
  assert.equal(withBig.status, 'normalized');
  assert.equal(withBig.finding.line, 999999999);
});

test('未知のトップレベルフィールドがあると invalid になる', () => {
  const raw = { ...validFinding(), foo: 'bar' };
  const result = validateAndNormalizeFinding(raw);
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some((e) => e.includes('foo')));
});

test('JSON.parse 由来の __proto__ own property は未知フィールドとして拒否され、プロトタイプ汚染も起きない', () => {
  const raw = JSON.parse(
    '{"__proto__":{"polluted":true},"file":"a","line":1,"summary":"s","failure_scenario":"f",' +
      '"scope_relation":"introduced","severity":"med","evidence":"strong",' +
      '"provenance":{"angle":"x","anchor_class":"y"}}',
  );
  assert.ok(
    Object.hasOwn(raw, '__proto__'),
    '前提: JSON.parse は __proto__ を own property として作る',
  );
  const result = validateAndNormalizeFinding(raw);
  assert.equal(result.status, 'invalid');
  assert.equal({}.polluted, undefined, 'Object.prototype が汚染されていない');
});

test('JSON.parse 由来の constructor / prototype も未知フィールドとして拒否され、crash しない', () => {
  for (const key of ['constructor', 'prototype']) {
    const raw = JSON.parse(
      `{"${key}":{"polluted":true},"file":"a","line":1,"summary":"s","failure_scenario":"f",` +
        '"scope_relation":"introduced","severity":"med","evidence":"strong",' +
        '"provenance":{"angle":"x","anchor_class":"y"}}',
    );
    let result;
    assert.doesNotThrow(() => {
      result = validateAndNormalizeFinding(raw);
    }, `key=${key} で throw してはいけない`);
    assert.equal(result.status, 'invalid');
  }
});

test('raw が null なら invalid になり throw しない', () => {
  let result;
  assert.doesNotThrow(() => {
    result = validateAndNormalizeFinding(null);
  });
  assert.equal(result.status, 'invalid');
});

test('raw が配列なら invalid になり throw しない', () => {
  for (const raw of [[], ['x']]) {
    let result;
    assert.doesNotThrow(() => {
      result = validateAndNormalizeFinding(raw);
    });
    assert.equal(result.status, 'invalid');
  }
});

test('provenance が配列だと invalid になる', () => {
  const raw = { ...validFinding(), provenance: ['angle', 'anchor_class'] };
  assert.equal(validateAndNormalizeFinding(raw).status, 'invalid');
});

test('provenance に未知のキーがあると invalid になる', () => {
  const raw = { ...validFinding(), provenance: { angle: 'x', anchor_class: 'y', extra: 'z' } };
  assert.equal(validateAndNormalizeFinding(raw).status, 'invalid');
});

test('angle_fields が文字列だと invalid になる', () => {
  const raw = { ...validFinding(), angle_fields: 'nope' };
  assert.equal(validateAndNormalizeFinding(raw).status, 'invalid');
});

test('angle_fields が任意形状のオブジェクトなら normalized になり、そのまま保持される', () => {
  const angleFields = { nested: { a: [1, 2, 3] }, flag: true };
  const raw = { ...validFinding(), angle_fields: angleFields };
  const result = validateAndNormalizeFinding(raw);
  assert.equal(result.status, 'normalized');
  assert.deepEqual(result.finding.angle_fields, angleFields);
});

test('angle_fields が深すぎるネストを持つ場合、throw せず invalid になる（スタックオーバーフローを避けて拒否する）', () => {
  const raw = { ...validFinding(), angle_fields: buildDeeplyNestedObject(6000) };
  let result;
  assert.doesNotThrow(() => {
    result = validateAndNormalizeFinding(raw);
  });
  assert.equal(result.status, 'invalid');
  assert.ok(
    result.errors.some((e) => e.includes('angle_fields') && e.includes('ネスト')),
    'angle_fields のネスト超過を示すエラーが含まれるべき',
  );
});

test('angle_fields: ネストがちょうど MAX_ANGLE_FIELDS_DEPTH 階層なら normalized、1階層深いと invalid になる（境界値）', () => {
  const atLimitFields = buildDeeplyNestedObject(MAX_ANGLE_FIELDS_DEPTH);
  const overLimitFields = buildDeeplyNestedObject(MAX_ANGLE_FIELDS_DEPTH + 1);

  const atLimitResult = validateAndNormalizeFinding({
    ...validFinding(),
    angle_fields: atLimitFields,
  });
  assert.equal(atLimitResult.status, 'normalized');
  assert.deepEqual(atLimitResult.finding.angle_fields, atLimitFields);

  const overLimitResult = validateAndNormalizeFinding({
    ...validFinding(),
    angle_fields: overLimitFields,
  });
  assert.equal(overLimitResult.status, 'invalid');
  assert.ok(overLimitResult.errors.some((e) => e.includes('ネスト')));
});

test('angle_fields: 循環参照を含む場合、throw せず invalid になる', () => {
  const circular = {};
  circular.self = circular;
  let result;
  assert.doesNotThrow(() => {
    result = validateAndNormalizeFinding({ ...validFinding(), angle_fields: circular });
  });
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some((e) => e.includes('ネスト')));
});

test('angle_fields: 直列化後サイズが上限を超えると invalid、上限ちょうどなら normalized になる（境界値）', () => {
  const MAX = 20000;
  // `{"blob":"` + N個の x + `"}` の JSON 長は N + 11 になる。
  const overLimitFields = { blob: 'x'.repeat(MAX - 11 + 1) };
  const atLimitFields = { blob: 'x'.repeat(MAX - 11) };
  assert.equal(JSON.stringify(overLimitFields).length, MAX + 1);
  assert.equal(JSON.stringify(atLimitFields).length, MAX);

  const overResult = validateAndNormalizeFinding({
    ...validFinding(),
    angle_fields: overLimitFields,
  });
  assert.equal(overResult.status, 'invalid');
  assert.ok(overResult.errors.some((e) => e.includes('大きすぎます')));

  const atLimitResult = validateAndNormalizeFinding({
    ...validFinding(),
    angle_fields: atLimitFields,
  });
  assert.equal(atLimitResult.status, 'normalized');
  assert.deepEqual(atLimitResult.finding.angle_fields, atLimitFields);
});

test('provenance を省略しても defaultAngle/defaultAnchorClass があれば normalized になる', () => {
  const raw = validFinding();
  delete raw.provenance;
  const result = validateAndNormalizeFinding(raw, {
    defaultAngle: 'adversarial',
    defaultAnchorClass: 'attack-surface',
  });
  assert.equal(result.status, 'normalized');
  assert.deepEqual(result.finding.provenance, {
    angle: 'adversarial',
    anchor_class: 'attack-surface',
  });
});

test('provenance を省略し既定値も無ければ invalid になる', () => {
  const raw = validFinding();
  delete raw.provenance;
  const result = validateAndNormalizeFinding(raw);
  assert.equal(result.status, 'invalid');
});

test('finding 自身の provenance は既定値より優先される', () => {
  const raw = { ...validFinding(), provenance: { angle: 'own-angle', anchor_class: 'own-anchor' } };
  const result = validateAndNormalizeFinding(raw, {
    defaultAngle: 'default-angle',
    defaultAnchorClass: 'default-anchor',
  });
  assert.equal(result.status, 'normalized');
  assert.deepEqual(result.finding.provenance, { angle: 'own-angle', anchor_class: 'own-anchor' });
});

// 修正7の回帰テスト（review-spec F1。issue #647「file / line normalization」）:
// cwd 配下を指す絶対パスはリポジトリ相対パスへ正規化される。
test('file の正規化: cwd 配下の絶対パスはリポジトリ相対パスへ変換される', () => {
  const raw = { ...validFinding(), file: '/repo/root/src/foo.js' };
  const result = validateAndNormalizeFinding(raw, { cwd: '/repo/root' });
  assert.equal(result.status, 'normalized');
  assert.equal(result.finding.file, 'src/foo.js');
});

// cwd 配下でない絶対パス（別リポジトリ・システムファイル等）は変換すると却って分かりにくく
// なるため、そのまま保持する。
test('file の正規化: cwd 配下でない絶対パスはそのまま保持される', () => {
  const raw = { ...validFinding(), file: '/other/place/foo.js' };
  const result = validateAndNormalizeFinding(raw, { cwd: '/repo/root' });
  assert.equal(result.status, 'normalized');
  assert.equal(result.finding.file, '/other/place/foo.js');
});

// 修正1の回帰テスト（chatgpt-codex-connector 所見。review-pr #650、実行検証済み）:
// `rel.startsWith('..')` だけの判定だと、`..hidden/a.js` のような「`..` で始まるが実際には
// 親ディレクトリへ脱出しない正当なファイル名」まで「リポジトリ外」と誤判定し、絶対パス表記の
// まま正規化しなかった（`relative('/repo/root','/repo/root/..hidden/a.js')` は
// `'..hidden/a.js'` を返すが、これは脱出ではない）。
test('file の正規化: cwd配下の「..」で始まるが親ディレクトリへ脱出しない正当なファイル名は相対パスへ変換される', () => {
  const raw = { ...validFinding(), file: '/repo/root/..hidden/a.js' };
  const result = validateAndNormalizeFinding(raw, { cwd: '/repo/root' });
  assert.equal(result.status, 'normalized');
  assert.equal(result.finding.file, '..hidden/a.js');
});

// 真に親ディレクトリへ脱出する絶対パス（cwd の外）は、引き続き絶対パスのまま保持される
// （変換すると誤って cwd 配下の別ファイルであるかのように見えてしまうため）。
test('file の正規化: cwd の兄弟ディレクトリを指す絶対パスは、真に脱出するため絶対パスのまま保持される', () => {
  const raw = { ...validFinding(), file: '/repo/sibling/a.js' };
  const result = validateAndNormalizeFinding(raw, { cwd: '/repo/root' });
  assert.equal(result.status, 'normalized');
  assert.equal(result.finding.file, '/repo/sibling/a.js');
});

// 境界値: rel が `'..'` そのもの（cwd の直接の親ディレクトリ自体を指す）場合も脱出として
// 扱われ、絶対パスのまま保持される。
test('file の正規化: rel が "..” そのもの（cwd の直接の親ディレクトリを指す）場合も絶対パスのまま保持される', () => {
  const raw = { ...validFinding(), file: '/repo' };
  const result = validateAndNormalizeFinding(raw, { cwd: '/repo/root' });
  assert.equal(result.status, 'normalized');
  assert.equal(result.finding.file, '/repo');
});

test('isActionable: scope_relation・severity・evidence の境界値を判定する', () => {
  assert.equal(
    isActionable({ scope_relation: 'introduced', severity: 'med', evidence: 'strong' }),
    true,
  );
  assert.equal(
    isActionable({ scope_relation: 'worsened', severity: 'high', evidence: 'verified' }),
    true,
  );
  assert.equal(
    isActionable({ scope_relation: 'introduced', severity: 'low', evidence: 'verified' }),
    false,
    'severity が minimumSeverity 未満',
  );
  assert.equal(
    isActionable({ scope_relation: 'introduced', severity: 'med', evidence: 'weak' }),
    false,
    'evidence が弱すぎる',
  );
  assert.equal(
    isActionable({ scope_relation: 'pre_existing', severity: 'blocker', evidence: 'verified' }),
    false,
    'scope_relation が対象集合に無い',
  );
  assert.equal(
    isActionable({ scope_relation: 'unrelated', severity: 'blocker', evidence: 'verified' }),
    false,
    'scope_relation が対象集合に無い',
  );
});

test('capForStorage: 直列化後サイズが上限未満ならそのまま返す', () => {
  const value = { a: 1, b: 'short string' };
  // redactDeepParts はオブジェクトを新しい（null-prototype の）オブジェクトとして再構築する
  // ため、参照同一性ではなく値の同値性で比較する（`{ ...x }` でプレーンオブジェクトへ戻す）。
  assert.deepEqual({ ...capForStorage(value) }, value);
  assert.deepEqual({ ...capForStorage(value, 20000) }, value);
});

test('capForStorage: 直列化後サイズが上限を超えると truncated 形状へ変換する', () => {
  const value = { blob: 'x'.repeat(30000) };
  const json = JSON.stringify(value);
  const result = capForStorage(value);
  assert.deepEqual(Object.keys(result).sort(), ['originalLength', 'preview', 'truncated']);
  assert.equal(result.truncated, true);
  assert.equal(result.originalLength, json.length);
  assert.equal(result.preview, json.slice(0, 2000));
  assert.equal(result.preview.length, 2000);
});

// 深いネスト（特に配列）はキー名を持たないため、直列化後の文字数が小さく収まりうる。
// 文字数の上限だけに頼ると、この「短いが極端に深い」値を素通ししてしまい、この値を
// artifact 全体へインデント付きで書き出す時点で RangeError を招きうる（fix #2 で判明した
// capForStorage 自身の抜け穴の回帰テスト）。深さ超過時の挙動自体は fix #1 により「value 全体を
// truncated 形状へ変換する」から「上限を超える部分木だけをプレースホルダへ置き換える」へ
// 変わったため、それに合わせて期待値を更新する。
test('capForStorage: 深さが上限を超えると、対象の部分木だけがプレースホルダへ置き換わる（value 全体は捨てない）', () => {
  const value = { angle_fields: buildDeeplyNestedArray(4160) };
  assert.ok(
    JSON.stringify(value).length < MAX_SERIALIZED_CHARS,
    '文字数の上限には掛からない前提（深さだけが問題であることの確認）',
  );

  const result = capForStorage(value);
  // トップレベルキー（angle_fields）自体は残る。fix #1 前は truncated/reason だけの
  // オブジェクトに置き換わっていた。
  assert.deepEqual(Object.keys(result), ['angle_fields']);
  assert.ok(
    JSON.stringify(result.angle_fields).includes('[nested value omitted: too deep]'),
    '上限を超えてネストする部分木がプレースホルダへ置き換わっているべき',
  );
});

// fix #1 の回帰テスト: angle_fields だけが深すぎる（他は妥当な）finding 全体を capForStorage に
// 渡しても、file/line/summary 等の浅いフィールドは丸ごと捨てられず元の値のまま保持される
// （修正前は `{ truncated: true, reason: '...' }` だけになり、どの finding の報告か
// 復元できなかった）。
test('capForStorage: angle_fields だけが深すぎる finding は、浅いフィールドを保持したまま angle_fields の深い部分だけが redact される', () => {
  const value = {
    file: 'src/payments.js',
    line: 120,
    summary: '決済の二重実行',
    failure_scenario: '同時押下でリクエストが2回送信される',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'strong',
    angle_fields: buildDeeplyNestedObject(MAX_ANGLE_FIELDS_DEPTH + 5),
  };

  const result = capForStorage(value);

  assert.equal(result.file, value.file);
  assert.equal(result.line, value.line);
  assert.equal(result.summary, value.summary);
  assert.equal(result.failure_scenario, value.failure_scenario);
  assert.equal(result.scope_relation, value.scope_relation);
  assert.equal(result.severity, value.severity);
  assert.equal(result.evidence, value.evidence);
  assert.notDeepEqual(result.angle_fields, value.angle_fields);
  assert.ok(
    JSON.stringify(result.angle_fields).includes('[nested value omitted: too deep]'),
    'angle_fields の深い部分がプレースホルダへ置き換わっているべき',
  );
});

// 修正5の回帰テスト（chatgpt-codex-connector 所見。review-pr #650、実行検証済み）:
// `capForStorage` は `raw` フィールドの直列化後サイズを上限管理するが、隣接する `errors[]`
// （未知フィールド名等、入力由来の文字列をそのまま埋め込むエラーメッセージ）には同等の上限が
// 無かった。`truncateForMessage` は個々のメッセージ文字列自体を上限管理する。
test('truncateForMessage: 上限以下の文字列はそのまま返す', () => {
  assert.equal(truncateForMessage('short message'), 'short message');
  assert.equal(truncateForMessage('x'.repeat(500), 500), 'x'.repeat(500));
});

test('truncateForMessage: 上限を超える文字列は切り詰められ、末尾に truncated マーカーが付く', () => {
  const huge = 'x'.repeat(600);
  const result = truncateForMessage(huge, 500);
  assert.equal(result.length, 500 + '...(truncated)'.length);
  assert.ok(result.startsWith('x'.repeat(500)));
  assert.ok(result.endsWith('...(truncated)'));
});

test('validateAndNormalizeFinding: 巨大な未知フィールド名を持つ finding の errors は無制限に肥大化せず切り詰められる', () => {
  const hugeKey = 'k'.repeat(200000);
  const raw = { ...validFinding(), [hugeKey]: 'value' };
  const result = validateAndNormalizeFinding(raw);
  assert.equal(result.status, 'invalid');
  const offending = result.errors.find((e) => e.includes('未知のフィールドです'));
  assert.ok(offending, '未知フィールドのエラーが含まれるべき');
  assert.ok(
    offending.length < hugeKey.length,
    `エラーメッセージが未知フィールド名の長さ（${hugeKey.length}）未満に切り詰められているべき` +
      `（実際: ${offending.length}）`,
  );
  assert.ok(offending.endsWith('...(truncated)'));
});

test('validateAndNormalizeFinding: provenance の巨大な未知フィールド名も errors が切り詰められる', () => {
  const hugeKey = 'p'.repeat(200000);
  const raw = {
    ...validFinding(),
    provenance: { angle: 'x', anchor_class: 'y', [hugeKey]: 'value' },
  };
  const result = validateAndNormalizeFinding(raw);
  assert.equal(result.status, 'invalid');
  const offending = result.errors.find((e) => e.includes('provenance: 未知のフィールドです'));
  assert.ok(offending, 'provenance の未知フィールドのエラーが含まれるべき');
  assert.ok(offending.length < hugeKey.length);
  assert.ok(offending.endsWith('...(truncated)'));
});

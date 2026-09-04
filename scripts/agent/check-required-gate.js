import { pathToFileURL } from 'node:url';

// CI 集約 required check の判定スクリプト（#430）。
// ci.yml の required-gate job から `NEEDS`（toJSON(needs)）を受け取り、変更分類（changes job の
// outputs: code/deps/docs）に対して「必要な job が success」「不要な job は意図した skip」を検証する。
// 必要 job の skipped / failure / cancelled、判定不能（env 欠落・不正 JSON・未知の値）はすべて失敗（fail-closed）。
// ci.yml の required-gate job の needs と、下記 RULES の job 名は常に同期させること（job 追加・rename 時は両方更新）。
// このスクリプトは npm ci なしで実行されるため、node ビルトイン以外を import しないこと（classify-changes.js と同方針）。

// 変更分類 → 必須 job の対応表（required matrix。文書正本: docs/planning/ci-split-design.md §5）
// changes / secret-scan は分類によらず常に必須（secret は docs にも混入しうる）。
const RULES = {
  'lint-test': (outputs) => outputs.code === 'true',
  'worker-test': (outputs) => outputs.code === 'true',
  'docs-links': (outputs) => outputs.docs === 'true',
  'bundle-check': (outputs) => outputs.bundle === 'true',
  audit: (outputs) => outputs.deps === 'true',
  semgrep: (outputs) => outputs.code === 'true',
  'secret-scan': () => true,
};

const CLASSIFICATION_KEYS = ['code', 'deps', 'docs', 'bundle'];

// needs コンテキストの result は success / failure / cancelled / skipped の4値（timeout は failure に含まれる）。
// 未知の値を成功扱いしないよう、成功判定は allowlist（=== 'success'）でのみ行う。

export function evaluateGate(needsJson) {
  const violations = [];

  if (needsJson == null) {
    return { ok: false, violations: ['NEEDS が未設定です。ワークフロー側の env 設定漏れの可能性があります'] };
  }
  if (typeof needsJson !== 'string') {
    return { ok: false, violations: ['NEEDS が文字列ではありません'] };
  }
  if (needsJson.trim() === '') {
    return { ok: false, violations: ['NEEDS が空です。toJSON(needs) が渡っていない可能性があります'] };
  }

  let parsed;
  try {
    parsed = JSON.parse(needsJson);
  } catch {
    return { ok: false, violations: ['NEEDS を JSON として解釈できません'] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, violations: ['NEEDS がオブジェクトではありません'] };
  }
  // IDB/CI 由来の動的キーを持つオブジェクトは null プロトタイプへ寄せる（INVARIANTS.md #11）
  const needs = Object.assign(Object.create(null), parsed);

  // 未知の job が needs に居る場合は RULES の更新漏れ（放置すると新 job が永久に非必須になる）
  const knownJobs = new Set(['changes', ...Object.keys(RULES)]);
  for (const name of Object.keys(needs)) {
    if (!knownJobs.has(name)) {
      violations.push(`未知の job "${name}" が needs に含まれています。check-required-gate.js の RULES を更新してください`);
    }
  }
  for (const name of knownJobs) {
    if (needs[name] == null || typeof needs[name] !== 'object') {
      violations.push(`job "${name}" の結果が NEEDS にありません。ci.yml の needs と RULES の同期を確認してください`);
    }
  }
  if (violations.length > 0) {
    return { ok: false, violations };
  }

  // changes が success でない場合、outputs は信用できないため分類判定に入らず失敗させる
  if (needs.changes.result !== 'success') {
    return { ok: false, violations: [`changes job が success ではありません（result: ${needs.changes.result}）`] };
  }

  const rawOutputs = needs.changes.outputs;
  if (rawOutputs === null || typeof rawOutputs !== 'object' || Array.isArray(rawOutputs)) {
    return { ok: false, violations: ['changes job の outputs がありません'] };
  }
  const outputs = Object.assign(Object.create(null), rawOutputs);
  // job 側（I5）と対称に、outputs 側の未知キーも RULES/CLASSIFICATION_KEYS の更新漏れとして検出する
  for (const key of Object.keys(outputs)) {
    if (!CLASSIFICATION_KEYS.includes(key)) {
      violations.push(`未知の分類キー "${key}" が changes outputs に含まれています。check-required-gate.js の CLASSIFICATION_KEYS / RULES を更新してください`);
    }
  }
  for (const key of CLASSIFICATION_KEYS) {
    // classify-changes.js は JS boolean 由来の小文字 'true'/'false' のみを出力する。
    // それ以外（欠落・空文字・'True' 等）を false に潰すと必須 job が非必須化される（fail-open）ため失敗させる
    if (outputs[key] !== 'true' && outputs[key] !== 'false') {
      violations.push(`changes outputs の "${key}" が 'true'/'false' ではありません（値: ${JSON.stringify(outputs[key])}）`);
    }
  }
  if (violations.length > 0) {
    return { ok: false, violations };
  }

  for (const [name, isRequired] of Object.entries(RULES)) {
    const result = needs[name].result;
    if (isRequired(outputs)) {
      if (result !== 'success') {
        violations.push(`必須 job "${name}" が success ではありません（result: ${result}）。この変更分類（code=${outputs.code}, deps=${outputs.deps}, docs=${outputs.docs}）では実行が必要です`);
      }
    } else if (result !== 'skipped' && result !== 'success') {
      // 非必須 job でも failure / cancelled を握りつぶさない（走った以上、失敗は失敗）
      violations.push(`非必須 job "${name}" が失敗しています（result: ${result}）`);
    }
  }

  return { ok: violations.length === 0, violations };
}

function main() {
  const { ok, violations } = evaluateGate(process.env.NEEDS ?? null);
  if (!ok) {
    console.error('required-gate: 必須チェックの検証に失敗しました');
    for (const v of violations) {
      console.error(`- ${v}`);
    }
    process.exit(1);
  }
  process.stdout.write('required-gate: すべての必須 job が成功、不要 job は意図した skip です\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

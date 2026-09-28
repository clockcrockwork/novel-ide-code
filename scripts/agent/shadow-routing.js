// Phase 5 §15.1 shadow routing → §15.4 authority switch 後は routing assessment の生成系。
//
// 責務: base→current の完全 review scope から machine facts を含む routing packet を作り、
// orchestrator model（現在の Claude Code 親セッション）が返した routing assessment
// （dimension 3値＋evidence、snapshot-bound）を検証し、閉じた policy から
// selection（selectedAngles / conditionalAngles / escalatedAngles / selectedSidecars）を
// 導出する。
//
// **本ファイル自身は他ファイルの関数を呼ばない（読み取り専用の生成系）が、書き出す
// `shadow-routing.json` は authority switch 後、review-plan.js の `resolveRoutingAuthority` /
// `buildPlan` が読み、valid なら通常 angle の適用集合の正本として採用する（正本:
// docs/planning/review-system-phase5-plan.md §15.4）。**「actual review 義務を一切変更しない」
// という shadow-only 期の性質は、review-plan.js 側が authority routing を実装したこの提供単位で
// 終わった** — 本ファイルの出力は現在 actual review 義務に直接影響しうる。
// - Node/JS runtime から LLM API を呼ばない。orchestrator model は現在の親セッションであり、
//   このスクリプトはその判定結果（assessment）を**受け取って**検証・合成するだけ。
// - 成果物は snapshot ディレクトリ内の別ファイル（shadow-routing-packet.json /
//   shadow-routing.json）に書き、review-plan.json / review-state.json には直接書き込まない
//   （review-plan.js 側が読みに行く一方向の依存であり、本ファイルが review-plan.json /
//   review-state.json を書くことはない）。
//
// testquality は selection の文字列 ID として使え、review-angle-tokens.js の ANGLE_TOKENS へも
// canonical normal angle として登録済み（§15.4 authority switch。ただし legacy TIER_ANGLES.Full
// には含めない — registry 登録と Tier 必須系統への追加は独立した決定）。
//
// **運用上の注意（敵対的レビュー所見）**: `npm run review:shadow`（`shadow-routing.js assess`）を
// 実行して valid な assessment を snapshot ディレクトリへ書くと、直後の `npm run review:plan` は
// authority mode へ切り替わり、通常 angle の適用集合が legacy Tier の必須集合より縮小しうる。
// これは §15.4 の「switch」そのものであり、consumer 側の明示的なフラグは存在しない —
// 実 PR のレビュー対象 snapshot に対して、意図的に switch する場合以外は実行しないこと。

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { classify, expandRenames, isKnownDepManifestPath } from './classify-changes.js';
import {
  deriveEscalatedAngles as deriveShadowEscalatedAngles,
  deriveMemoryConditional as deriveShadowMemoryConditional,
} from './review-angle-tokens.js';
import {
  loadState,
  parseArgs,
  parseMemoryHits,
  requireSnapshot,
  resolveRecordRunSnapshotId,
} from './review-plan.js';
import {
  GUARD_CONTENT_RE,
  git,
  snapshotById,
  snapshotFreshness,
  splitPatchByFile,
} from './review-snapshot.js';

const PACKET_FILE = 'shadow-routing-packet.json';
const SHADOW_FILE = 'shadow-routing.json';

export { PACKET_FILE, SHADOW_FILE };

// shadow assessment を評価できなかった理由の閉じた語彙。review-metrics.js の invalid/error 分類が
// この一覧からドリフトしないよう、reason 文字列はここを正本として export する
// （Phase 5 plan §3.5-7「assessment invalid/error は shadow failure として観測する」。敵対的レビュー所見）。
export const SHADOW_FAILURE_REASONS = {
  MISSING_ASSESSMENT_FILE: 'missing-assessment-file',
  UNREADABLE_ASSESSMENT_FILE: 'unreadable-assessment-file',
  INVALID_ASSESSMENT_JSON: 'invalid-assessment-json',
  INVALID_ASSESSMENT: 'invalid-assessment',
  STALE_SNAPSHOT: 'stale-snapshot',
};

// ---------------------------------------------------------------------------
// routing assessment スキーマ（Phase 5 plan §3.5）
// ---------------------------------------------------------------------------

export const ASSESSMENT_VERSION = 1;

// canonical semantic dimensions（Phase 5 plan §3.2 の表と一致させる。閉じた語彙）。
export const ASSESSMENT_DIMENSIONS = [
  'executableBehavior',
  'specRelevant',
  'stateful',
  'adversarialRelevant',
  'security',
  'additiveSurface',
  'qualityRelevant',
  'staleArtifactRisk',
  'semanticDocs',
  'performanceSensitive',
];

export const ASSESSMENT_VALUES = new Set(['true', 'false', 'uncertain']);

// shadow selection が使う machine ID の閉じた語彙（既存7系統＋testquality）。
// review-angle-tokens.js の ANGLE_TOKENS とは意図的に独立（actual registry へは混ぜない）。
export const SHADOW_NORMAL_ANGLES = [
  'subtractive',
  'riskmodel',
  'spec',
  'adversarial',
  'quality',
  'operability',
  'cleanup',
  'testquality',
];

/**
 * assessment（orchestrator model が返した routing assessment）を検証する。
 * 検証項目: assessmentVersion / snapshotId 一致（鮮度） / dimension の完全性（閉じた語彙、
 * 過不足なし） / value の閉じた enum / evidence の非空文字列配列。
 *
 * missing / invalid / stale はここでは throw しない — 呼び出し側（assessCommand）が
 * shadow failure として記録し、actual review 義務には影響させない（Phase 5 plan §3.5-7,8）。
 */
export function validateAssessment(assessment, { snapshotId }) {
  const errors = [];
  if (assessment === null || typeof assessment !== 'object' || Array.isArray(assessment)) {
    return { valid: false, errors: ['assessment はオブジェクトである必要があります'] };
  }
  if (assessment.assessmentVersion !== ASSESSMENT_VERSION) {
    errors.push(
      `assessmentVersion を認識できません（受理: ${ASSESSMENT_VERSION}、受け取り: ${JSON.stringify(assessment.assessmentVersion)}）`,
    );
  }
  if (typeof assessment.snapshotId !== 'string' || assessment.snapshotId === '') {
    errors.push('snapshotId が文字列で指定されていません');
  } else if (assessment.snapshotId !== snapshotId) {
    errors.push(
      `snapshotId が現在の snapshot と一致しません（assessment: ${assessment.snapshotId} / current: ${snapshotId}）— stale assessment`,
    );
  }
  const dims = assessment.dimensions;
  if (dims === null || typeof dims !== 'object' || Array.isArray(dims)) {
    errors.push('dimensions がオブジェクトではありません');
    return { valid: false, errors };
  }
  for (const key of ASSESSMENT_DIMENSIONS) {
    if (!Object.hasOwn(dims, key)) {
      errors.push(`dimension が欠落しています: ${key}`);
      continue;
    }
    const d = dims[key];
    if (d === null || typeof d !== 'object' || Array.isArray(d)) {
      errors.push(`${key}: オブジェクトである必要があります（{ value, evidence }）`);
      continue;
    }
    if (!ASSESSMENT_VALUES.has(d.value)) {
      errors.push(
        `${key}.value が未知の値です（受理: true / false / uncertain、受け取り: ${JSON.stringify(d.value)}）`,
      );
    }
    if (
      !Array.isArray(d.evidence) ||
      d.evidence.length === 0 ||
      !d.evidence.every((e) => typeof e === 'string' && e.trim() !== '')
    ) {
      errors.push(`${key}.evidence は非空の文字列配列である必要があります`);
    }
  }
  // 閉じた語彙: dimensions 側に未知 key があれば拒否する（黙って無視しない）
  for (const key of Object.keys(dims)) {
    if (!ASSESSMENT_DIMENSIONS.includes(key)) {
      errors.push(`未知の dimension です: ${key}（既知: ${ASSESSMENT_DIMENSIONS.join(' / ')}）`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// routing packet（base→current の完全 review scope から machine facts を作る）
// ---------------------------------------------------------------------------

const DEP_KEY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function depKeySet(pkgJson) {
  if (pkgJson === null || typeof pkgJson !== 'object' || Array.isArray(pkgJson)) return null;
  const keys = new Set();
  for (const field of DEP_KEY_FIELDS) {
    const section = pkgJson[field];
    if (section === null || typeof section !== 'object' || Array.isArray(section)) continue;
    for (const k of Object.keys(section)) keys.add(`${field}:${k}`);
  }
  return keys;
}

// package.json から dependency 系フィールドを除いたコピー。「dependency の**バージョンだけ**が
// 変わった」ことを証明するには、それ以外のフィールド（scripts / overrides / resolutions 等）が
// 一切変わっていないことも要る（敵対的レビュー所見: postinstall スクリプトや overrides の
// tarball 差し替えを混ぜても depKeySet だけの比較では検出できなかった）。
function stripDependencyFields(pkgJson) {
  const copy = { ...pkgJson };
  for (const field of DEP_KEY_FIELDS) delete copy[field];
  return copy;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  );
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function readJsonAt(cwd, sha, path) {
  const out = git(['show', `${sha}:${path}`], { cwd, onFail: 'null' });
  if (out == null) return null; // その sha にファイルが存在しない（追加/削除の片側）
  try {
    return JSON.parse(out);
  } catch {
    return undefined; // 存在するが JSON として読めない
  }
}

// lockfile（npm lockfileVersion 1/2/3 いずれも許容）が言及するパッケージ識別子の集合。
// **キーの集合だけ**を見て値（version/resolved/integrity）は見ない — 通常のバージョン
// 更新はキーを保ったまま値だけが変わるため false positive にならず、パッケージの
// 追加・削除（新しいキーの出現・消失）だけを検出する。
// 既知の限界（敵対的レビュー所見）: 既存キーの値（resolved/integrity の差し替え）は
// この集合比較では検出できない。これは npm レジストリの改ざん検知という別カテゴリの
// machine gate が要る領域で、本 shadow routing の scope 外として明示的に残す
// （検出できないことを「version-only」の根拠にはしない — 下記 versionOnlyProvable 参照）。
function lockfilePackageKeys(lockJson) {
  const keys = new Set();
  if (lockJson === null || typeof lockJson !== 'object' || Array.isArray(lockJson)) return null;
  const packages = lockJson.packages;
  if (packages !== undefined) {
    if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) return null;
    for (const k of Object.keys(packages)) keys.add(`packages:${k}`);
  }
  const walk = (deps, prefix) => {
    if (deps === undefined) return true;
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) return false;
    for (const [name, meta] of Object.entries(deps)) {
      keys.add(`dependencies:${prefix}${name}`);
      if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
        if (!walk(meta.dependencies, `${prefix}${name}>`)) return false;
      }
    }
    return true;
  };
  if (!walk(lockJson.dependencies, '')) return null;
  return keys;
}

/**
 * dependency key set の不変を machine が実際に確認できた場合だけ dependencyVersionOnly を
 * 立てる（Phase 5 plan §3.3。証明できない状態を「version-only」として免除しない）。
 *
 * package.json の追加・削除・改名、dependency key（dependencies / devDependencies /
 * peerDependencies / optionalDependencies）の増減、それ以外のフィールド（scripts /
 * overrides 等）の変更、または lockfile が言及するパッケージ識別子集合の変化のいずれかを
 * 確認できた場合は dependencySetChanged=true（version-only ではない）。
 */
function computeDependencyFacts(cwd, mergeBase, currentCommit, files) {
  const changedManifests = files.filter(
    (f) => isKnownDepManifestPath(f.path) && !f.path.endsWith('package-lock.json'),
  );
  const changedLockfiles = files.filter(
    (f) => isKnownDepManifestPath(f.path) && f.path.endsWith('package-lock.json'),
  );
  const dependencyChanged = changedManifests.length > 0 || changedLockfiles.length > 0;
  if (!dependencyChanged) {
    return { dependencyChanged: false, dependencySetChanged: false, dependencyVersionOnly: false };
  }

  let setChanged = false;
  let versionOnlyProvable = true;

  for (const f of changedManifests) {
    if (f.status !== 'M') {
      // 追加・削除・rename は dependency 集合の変更そのもの（証明不要で確定）
      setChanged = true;
      versionOnlyProvable = false;
      continue;
    }
    const before = readJsonAt(cwd, mergeBase, f.path);
    const after = readJsonAt(cwd, currentCommit, f.path);
    if (before == null || after == null) {
      // 読めない・パースできない package.json は version-only を証明できない
      versionOnlyProvable = false;
      continue;
    }
    const beforeKeys = depKeySet(before);
    const afterKeys = depKeySet(after);
    if (beforeKeys === null || afterKeys === null) {
      versionOnlyProvable = false;
      continue;
    }
    if (!setsEqual(beforeKeys, afterKeys)) {
      setChanged = true;
      versionOnlyProvable = false;
      continue;
    }
    // dependency フィールド以外（scripts/overrides/resolutions 等）が変わっていたら
    // 「dependency のバージョンだけ」ではない
    if (!deepEqual(stripDependencyFields(before), stripDependencyFields(after))) {
      versionOnlyProvable = false;
    }
  }

  for (const f of changedLockfiles) {
    if (f.status !== 'M') {
      // lockfile の新規追加・削除は package.json 側の判定だけでは version-only を証明できない
      versionOnlyProvable = false;
      continue;
    }
    const before = readJsonAt(cwd, mergeBase, f.path);
    const after = readJsonAt(cwd, currentCommit, f.path);
    if (before == null || after == null) {
      versionOnlyProvable = false;
      continue;
    }
    const beforeKeys = lockfilePackageKeys(before);
    const afterKeys = lockfilePackageKeys(after);
    if (beforeKeys === null || afterKeys === null) {
      versionOnlyProvable = false;
      continue;
    }
    if (!setsEqual(beforeKeys, afterKeys)) {
      // lockfile だけがパッケージを追加・削除した（package.json 側では検出できない変化）
      setChanged = true;
      versionOnlyProvable = false;
    }
  }

  return {
    dependencyChanged: true,
    dependencySetChanged: setChanged,
    dependencyVersionOnly: versionOnlyProvable && !setChanged,
  };
}

// classifyFile が返す kind のうち prose（docs）扱いのもの。guardChanged の判定範囲から
// 除外する（§3.3「既知executable...prose内の言及だけでは立てない」）。
const PROSE_KINDS = new Set(['docs-design', 'docs-record', 'docs-other']);

/**
 * guardChanged を「既知 executable」なファイルの patch 内容だけから判定する
 * （Phase 5 plan §3.3。`review-snapshot.js` の `detectGuardChange` はファイル種別を問わず
 * patch 全文を走査するため、docs-only diff が "validate" 等の語や URL 様の文字列を含むだけで
 * 誤って true になる — 仕様レビュー所見で実測）。
 *
 * `GUARD_CONTENT_RE` は `detectGuardChange` と同じ正規表現を re-export したものを使い、
 * 判定基準そのものを再実装・分岐させない。読めなかった（patch に見出しが無い）executable
 * ファイルがあれば `detectGuardChange` の `hasOpaque` と同じ理由で fail-closed にする。
 */
function computeGuardChanged(basePatch, files) {
  const executableFiles = files.filter((f) => !PROSE_KINDS.has(f.kind));
  if (executableFiles.length === 0) return false;
  const chunks = splitPatchByFile(basePatch);
  const chunkByPath = new Map(chunks.map((c) => [c.path, c]));
  for (const f of executableFiles) {
    const chunk = chunkByPath.get(f.path);
    if (!chunk) return true; // 読めない（binary 等）executable ファイルは fail-closed
    if (chunk.lines.some((line) => GUARD_CONTENT_RE.test(line))) return true;
  }
  return false;
}

/**
 * base→current の完全 review scope（snap.changedFiles.files・base-to-current.patch・
 * manifest.unreportedPaths）から shadow routing packet を作る。
 *
 * **fix delta（changedInFix / manifest.*ChangeInFix）はここでは authority として使わない**
 * （Phase 5 plan §2）。fixDeltaHint に別枠で載せるのは「今回どれを再確認するか」の shadow hint
 * のみ。selectedAngles の根拠にしない。
 *
 * path-group candidate（highRisk / guardPath / designDoc / recordDoc / specAnchor / riskTable /
 * conventionDoc）は review-snapshot.js の classifyFile が全 scope 分をすでに計算済みなので、
 * ここでは正規表現を再実装せず changedFiles.files の対応フィールドを集計するだけにする
 * （Phase 5 plan §4「既存の…をcandidate evidenceとして再利用してよい」）。
 */
export function buildRoutingPacket(snap, { cwd = process.cwd() } = {}) {
  const files = snap.changedFiles.files;
  const manifest = snap.manifest;
  const basePatch = readFileSync(join(snap.dir, 'base-to-current.patch'), 'utf-8');

  const { codeChanged, depOnly } = classify(expandRenames(files));

  const newFiles = files.filter((f) => f.status === 'A' || f.status === 'U').map((f) => f.path);
  const deletedFiles = files.filter((f) => f.status === 'D').map((f) => f.path);
  const renamedFiles = files
    .filter((f) => f.status?.[0] === 'R')
    .map((f) => ({ path: f.path, oldPath: f.oldPath }));

  const testChanged = files.some((f) => f.test);
  const configChanged = files.some((f) => f.config);

  // guardChanged は full scope（patch 全量・changedFiles 全量）の、既知 executable ファイルの
  // 内容だけから判定する。manifest.guardChangeInFix は fix-delta（previous→current）専用の値
  // なので使わない（Phase 5 plan §3.3「現行の guardChangeInFix をfull-scope factとして流用
  // しない」）。prose ファイルの言及だけで立てないため、素の detectGuardChange（ファイル種別を
  // 問わず全文を走査する）ではなく computeGuardChanged（executable ファイルへ限定）を使う。
  const guardChanged = manifest.unreportedPaths.length > 0 || computeGuardChanged(basePatch, files);

  const depFacts = computeDependencyFacts(cwd, manifest.mergeBase, manifest.currentCommit, files);

  const machineFacts = {
    executableChanged: codeChanged,
    docsOnly: !codeChanged,
    testChanged,
    configChanged,
    guardChanged,
    newFiles,
    deletedFiles,
    renamedFiles,
    dependencyOnly: depOnly,
    ...depFacts,
    riskTableCandidate: files.some((f) => f.riskTable),
  };

  return {
    version: 1,
    snapshotId: snap.snapshotId,
    createdAt: new Date().toISOString(),
    scope: 'base-to-current',
    patchPath: 'base-to-current.patch',
    unreportedPaths: manifest.unreportedPaths,
    machineFacts,
    pathGroupCandidates: {
      highRisk: files.filter((f) => f.highRisk).map((f) => f.path),
      guardPath: files.filter((f) => f.guardPath).map((f) => f.path),
      designDoc: files.filter((f) => f.designDoc).map((f) => f.path),
      recordDoc: files.filter((f) => f.recordDoc).map((f) => f.path),
      specAnchor: files.filter((f) => f.specAnchor).map((f) => f.path),
      riskTable: files.filter((f) => f.riskTable).map((f) => f.path),
      conventionDoc: files.filter((f) => f.conventionDoc).map((f) => f.path),
    },
    // 「今回どれを再確認するか」の shadow hint のみ。selectedAngles の根拠にしない
    // （Phase 5 plan §2）。
    fixDeltaHint: {
      previousSnapshotId: manifest.previousSnapshotId,
      changedSincePrevious: (snap.changedFiles.changedInFix ?? []).map((f) => f.path),
    },
    requiredDimensions: ASSESSMENT_DIMENSIONS,
    assessmentContract: 'docs/planning/review-system-phase5-plan.md §3.5',
    // 手順のハンドオフが packet の出力だけで完走できるように、次に何をどう呼ぶかをここに
    // 明記する（運用性レビュー所見: ソースコードを読まない別の実行主体が assess subcommand の
    // 存在・必須引数を packet の出力から知る手段が無かった）。
    nextStep:
      'requiredDimensions の全 key を持つ assessment JSON（{assessmentVersion, snapshotId, dimensions}）を作り、' +
      '`node scripts/agent/shadow-routing.js assess --file <assessment.json> --snapshot-id ' +
      `${snap.snapshotId}\` を実行する。--memory-hits <n> は任意（既定 0）。` +
      'assessment の snapshotId はこの packet の snapshotId と一致している必要がある（不一致は stale として shadow failure になる）。',
  };
}

// ---------------------------------------------------------------------------
// shadow selection（Phase 5 plan §4.2 の routing table）
// ---------------------------------------------------------------------------

// state.escalations のうち `kind === 'manual-escalation'` レコードだけから escalatedAngles を
// 導出する（Phase 5 plan §4.1/§4.2/§9/§15.1）。review-plan.js の `deriveEscalatedAngles` と
// 共有する唯一の実装（review-angle-tokens.js が正本。`state`・`ANGLE_TOKENS` にしか依存しない
// ため、review-plan.js ⇄ shadow-routing.js の循環 import を作らずに共有できる。減算レビュー所見:
// 従来は「循環 import を避けるための独立実装」としてここに複製していたが、実際には共有可能だった）。
// `kind === 'tier-reclassification'`・`state.addedAngles` は参照せず、`memory` は conditional kind
// のまま維持する（memory の conditional 判定は `deriveShadowMemoryConditional` が別途行う）。
// memory の conditional 判定（`--memory-hits` / `state.memoryRequired` / `escalate --angles memory`
// の3経路）。review-plan.js の `buildPlan` が使う `memoryRequired` 計算と共有する唯一の実装
// （review-angle-tokens.js が正本。`deriveShadowEscalatedAngles` と同じ理由で共有可能）。
export { deriveShadowEscalatedAngles, deriveShadowMemoryConditional };

function isTrueOrUncertain(dimensions, key) {
  const v = dimensions[key]?.value;
  return v === 'true' || v === 'uncertain';
}

/**
 * 検証済み assessment（dimensions）＋ machine facts から、Phase 5 plan §4.2 の routing table
 * どおりに shadow selection を導出する純粋関数。
 *
 * actual review-plan.js の TIER_ANGLES / ANGLE_TOKENS / buildPlan には一切触れない
 * （このファイル自体が import すらしていない）。
 */
export function computeShadowSelection({
  machineFacts,
  dimensions,
  memoryConditional = false,
  escalatedAngles = [],
}) {
  const selectedAngles = new Set();
  const selectedSidecars = new Set();
  const explanation = [];
  // docs-only fallback（下記）の判定に使う: §4.2 が名指す5専門dimension
  // （specRelevant/stateful/security/additiveSurface/qualityRelevant）のいずれかが実際に
  // 加算したか。`cleanup`（deletion/rename）や `riskmodel`（performanceSensitive）等、
  // 専門dimension以外の理由で selectedAngles が非空になっただけでは fallback を抑止しない
  // （仕様レビュー所見: `selectedAngles.size` 全体を見ると cleanup 等に握り潰されていた）。
  let specificDimensionFired = false;

  const add = (angle, reason) => {
    if (!selectedAngles.has(angle)) explanation.push(`+${angle}: ${reason}`);
    selectedAngles.add(angle);
  };

  // dependency version-only bump（key set 不変を machine が証明済み）は、executableChanged が
  // 依存 manifest 自身の変更で trivially true になるだけで riskmodel/testquality を強制しない
  // （Phase 5 plan §4.2「dependencyOnly=true AND dependencyVersionOnly=true → semantic
  // selectedAngles 追加なし」。仕様レビュー所見: 免除が model の executableBehavior 判定に
  // 委ねられ、uncertain を返すと成立しなかった）。他の dimension（specRelevant/security等）が
  // 同じ diff の別要素（docs 併記等）を理由に加算することは引き続き妨げない。
  //
  // **ただし model が executableBehavior=true を明示的な evidence 付きで返した場合は免除しない**
  // （最終独立レビュー所見: `dependencyVersionOnly` は dependency key の名前集合と package.json
  // 非依存フィールドの一致しか証明しておらず、既存キーの**値**（version specifier）が悪性の
  // URL/tarball 参照へ差し替えられるサプライチェーン攻撃を検知できない。この免除が model の
  // 明示的 `true` 判定まで無条件に握り潰すと、model が diff から検知した危険性を machine 側が
  // 一方的に取り消すことになり、§3.5-1「model→machine policy」の契約に反する。免除で吸収して
  // よいのは「machine からは version-only に見え、model も uncertain としか言えない」ケースまで）。
  const versionOnlyDependencyBump =
    machineFacts.dependencyOnly &&
    machineFacts.dependencyVersionOnly &&
    dimensions.executableBehavior?.value !== 'true';

  // このルールが発火したかを別途覚えておく。testChanged ルール（下記）は「このルールで
  // 既にカバーされなかった場合」の補完であり、`executableBehavior` の値（'false' 固定）で
  // 判定すると uncertain/true のときに何も選ばれない fail-open になる（敵対的レビュー所見:
  // 「危険側の回答をするほど起動される reviewer が減る」）。
  const executableBehaviorRuleFired =
    !versionOnlyDependencyBump &&
    machineFacts.executableChanged &&
    isTrueOrUncertain(dimensions, 'executableBehavior');
  if (executableBehaviorRuleFired) {
    add('riskmodel', 'executableChanged ∧ executableBehavior=true/uncertain');
    add('testquality', 'executableChanged ∧ executableBehavior=true/uncertain');
  }
  if (isTrueOrUncertain(dimensions, 'specRelevant')) {
    add('spec', 'specRelevant=true/uncertain');
    specificDimensionFired = true;
  }
  if (isTrueOrUncertain(dimensions, 'stateful')) {
    add('operability', 'stateful=true/uncertain');
    specificDimensionFired = true;
  }
  if (machineFacts.guardChanged || isTrueOrUncertain(dimensions, 'adversarialRelevant')) {
    add('adversarial', 'guardChanged ∨ adversarialRelevant=true/uncertain');
  }
  if (isTrueOrUncertain(dimensions, 'security')) {
    add('adversarial', 'security=true/uncertain');
    if (!selectedSidecars.has('/security-review')) {
      explanation.push('+/security-review: security=true/uncertain');
    }
    selectedSidecars.add('/security-review');
    specificDimensionFired = true;
  }
  if (isTrueOrUncertain(dimensions, 'additiveSurface')) {
    add('subtractive', 'additiveSurface=true/uncertain');
    specificDimensionFired = true;
  }
  if (isTrueOrUncertain(dimensions, 'qualityRelevant')) {
    add('quality', 'qualityRelevant=true/uncertain');
    specificDimensionFired = true;
  }
  if (isTrueOrUncertain(dimensions, 'performanceSensitive')) {
    add('riskmodel', 'performanceSensitive=true/uncertain');
  }
  if (
    isTrueOrUncertain(dimensions, 'staleArtifactRisk') ||
    machineFacts.deletedFiles.length > 0 ||
    machineFacts.renamedFiles.length > 0
  ) {
    add(
      'cleanup',
      'staleArtifactRisk=true/uncertain ∨ deletion/rename candidate（最終段階の候補）',
    );
  }
  // testChanged かつ、上の executableBehavior ルールでまだカバーされていない場合:
  // testquality を加算し、想定ケース表 mapping を触った場合のみ riskmodel も加算する。
  // `executableBehavior==='false'` の完全一致ではなく「上のルールが発火しなかったか」で
  // 判定する — executableChanged=false（テストのみの変更）のときは executableBehavior が
  // uncertain/true でもこのルールが唯一のカバレッジ源であり、fail-closed（uncertain を
  // false と同じかそれ以上に扱う）にする必要がある。
  if (machineFacts.testChanged && !executableBehaviorRuleFired) {
    add('testquality', 'testChanged=true ∧ executableBehavior ルール未発火');
    if (machineFacts.riskTableCandidate) {
      add('riskmodel', '想定ケース表 mapping の変更候補');
    }
  }
  // docs-only fallback: 5専門dimension（specRelevant/stateful/security/additiveSurface/
  // qualityRelevant）のいずれも該当しないのに semanticDocs が true/uncertain なら spec を
  // fallback として1系統だけ起動する。`cleanup`（deletion/rename candidate）や
  // `riskmodel`（performanceSensitive）等、専門dimension以外の理由での加算は fallback を
  // 抑止しない（`specificDimensionFired` で判定する。仕様レビュー所見）
  if (machineFacts.docsOnly) {
    const semanticDocs = dimensions.semanticDocs?.value;
    if (semanticDocs !== 'false' && !specificDimensionFired) {
      add('spec', 'docsOnly ∧ semanticDocs=true/uncertain（専門dimension無し→spec fallback）');
    }
  }

  return {
    selectedAngles: [...selectedAngles],
    conditionalAngles: memoryConditional ? ['memory'] : [],
    escalatedAngles: [...new Set(escalatedAngles)],
    selectedSidecars: [...selectedSidecars],
    explanation,
  };
}

// ---------------------------------------------------------------------------
// assess コマンド本体（packet 生成 → assessment 検証 → shadow selection 合成）
// ---------------------------------------------------------------------------

/**
 * `state`（review-state.json）は**読み取り専用**で使う。ここから `saveState` は一度も
 * 呼ばない — shadow 結果を actual review-state.json / review-plan.json へ混ぜない
 * （Phase 5 plan §1「shadowとactualを完全に分離する」）。
 */
// assessCommand の返り値スキーマを1箇所へ集約する（減算レビュー所見: 4箇所の return が
// 同じ形をリテラルで複製しており、フィールド追加時にどれか1箇所を直し忘れるドリフトの
// 余地があった）。
function shadowFailureResult(snap, assessment, reason, errors, machineFacts = null) {
  return {
    version: 1,
    snapshotId: snap.snapshotId,
    assessmentVersion: assessment?.assessmentVersion ?? null,
    valid: false,
    shadowFailure: { reason, errors },
    machineFacts,
    dimensions: null,
    selection: null,
  };
}

export function assessCommand({
  cwd,
  snap,
  assessment,
  assessmentLoadError = null,
  memoryHits = 0,
}) {
  // assessment ファイル自体が無い・読めない・JSON として壊れている場合も、CLI が即 throw
  // して終わると shadow-routing.json に何も残らず、missing/model-output failure を
  // 観測できない（Phase 5 plan §3.5-7「assessment invalid/error は shadow failure として
  // 観測する」。PR レビュー所見: CLI が --file 欠落・読み込み失敗時に assessCommand へ入る
  // 前に throw していた）。ファイル読み込みは呼び出し側（CLI の `loadAssessmentFile`）が行い、
  // その結果を `assessmentLoadError` として渡す — ここで構造化 shadow failure に変換する。
  if (assessmentLoadError) {
    return shadowFailureResult(snap, null, assessmentLoadError.reason, assessmentLoadError.errors);
  }
  // snapshotId の一致だけでは、その snapshot 自体が現在の作業ツリーを表しているかを検証
  // できない（敵対的レビュー所見: snapshot 取得後に作業ツリーを変更しても、同じ snapshotId の
  // assessment がそのまま valid:true で通っていた）。record-run と同じ鮮度検証
  // （`snapshotFreshness`）をここでも通す。`snapshotFreshness` が「証明できない」場合は
  // throw するため、fail-closed に shadow failure として扱う（actual には波及させない）。
  let freshness;
  try {
    freshness = snapshotFreshness(snap, cwd);
  } catch (err) {
    return shadowFailureResult(snap, assessment, SHADOW_FAILURE_REASONS.STALE_SNAPSHOT, [
      err.message,
    ]);
  }
  if (!freshness.fresh) {
    return shadowFailureResult(
      snap,
      assessment,
      SHADOW_FAILURE_REASONS.STALE_SNAPSHOT,
      freshness.stale,
    );
  }
  const packet = buildRoutingPacket(snap, { cwd });
  const { valid, errors } = validateAssessment(assessment, { snapshotId: snap.snapshotId });
  if (!valid) {
    return shadowFailureResult(
      snap,
      assessment,
      SHADOW_FAILURE_REASONS.INVALID_ASSESSMENT,
      errors,
      packet.machineFacts,
    );
  }
  const state = loadState(cwd);
  const escalatedAngles = deriveShadowEscalatedAngles(state);
  const memoryConditional = deriveShadowMemoryConditional(state, memoryHits);
  const selection = computeShadowSelection({
    machineFacts: packet.machineFacts,
    dimensions: assessment.dimensions,
    memoryConditional,
    escalatedAngles,
  });
  return {
    version: 1,
    snapshotId: snap.snapshotId,
    assessmentVersion: assessment.assessmentVersion,
    valid: true,
    shadowFailure: null,
    machineFacts: packet.machineFacts,
    dimensions: assessment.dimensions,
    selection,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function resolveSnapshot(args, cwd) {
  const snapshotId = resolveRecordRunSnapshotId(args, cwd);
  if (!snapshotId) return requireSnapshot(cwd);
  return snapshotById(cwd, snapshotId);
}

/**
 * `--file` の欠落・読み込み失敗・JSON parse 失敗を構造化して返す（throw しない）。
 * `assessCommand` がこれを shadow failure として記録できるようにするため
 * （PR レビュー所見: missing/unreadable/invalid JSON が観測されずに CLI が即 crash していた）。
 */
export function loadAssessmentFile(filePath) {
  if (typeof filePath !== 'string' || filePath === '') {
    return {
      assessment: null,
      error: {
        reason: SHADOW_FAILURE_REASONS.MISSING_ASSESSMENT_FILE,
        errors: ['assess には --file <assessment.json> が必須です'],
      },
    };
  }
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      assessment: null,
      error: { reason: SHADOW_FAILURE_REASONS.UNREADABLE_ASSESSMENT_FILE, errors: [err.message] },
    };
  }
  try {
    return { assessment: JSON.parse(raw), error: null };
  } catch (err) {
    return {
      assessment: null,
      error: { reason: SHADOW_FAILURE_REASONS.INVALID_ASSESSMENT_JSON, errors: [err.message] },
    };
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const cwd = process.cwd();

  switch (cmd) {
    case 'packet': {
      const snap = resolveSnapshot(args, cwd);
      const packet = buildRoutingPacket(snap, { cwd });
      writeFileSync(join(snap.dir, PACKET_FILE), `${JSON.stringify(packet, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
      break;
    }
    case 'assess': {
      const snap = resolveSnapshot(args, cwd);
      const { assessment, error: assessmentLoadError } = loadAssessmentFile(args.file);
      const memoryHits = parseMemoryHits(args['memory-hits']);
      const result = assessCommand({ cwd, snap, assessment, assessmentLoadError, memoryHits });
      writeFileSync(join(snap.dir, SHADOW_FILE), `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      // 運用性レビュー所見: ヘッダのソースコメントだけでは、これを実行する側（人間・orchestrator）
      // に副作用が実際には届かない。valid な assessment を書いた直後、そのことの意味（次の
      // review:plan が authority mode へ切り替わりうる）を実行結果そのものに出す（stderr —
      // stdout の JSON 出力を機械可読なまま保つ）。
      if (result.valid === true) {
        process.stderr.write(
          '\n⚠️  この assessment は valid です。次に `npm run review:plan` を実行すると' +
            ' authority mode（semantic selectedAngles が通常 angle の正本）へ切り替わり、' +
            ' legacy Tier の必須系統より少ない系統だけが起動対象になることがあります。\n' +
            '   実 PR のレビュー対象 snapshot に対して意図的に switch する場合以外は、' +
            'このまま review:plan を実行しないでください。\n',
        );
      }
      break;
    }
    default:
      throw new Error(`未知のコマンドです: ${JSON.stringify(cmd)}（packet / assess）`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])shadow-routing\.js$/.test(process.argv[1])
) {
  main();
}

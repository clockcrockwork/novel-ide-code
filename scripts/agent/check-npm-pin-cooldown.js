import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ci.yml の NPM_PIN（グローバル npm の実行時取得 pin）が「exact semver」「許容メジャー
// （NPM_PIN_ALLOWED_MAJORS）」「.npmrc の min-release-age 以上の cooldown」「root/worker 両方の
// package.json の engines.npm」を満たすかを機械検証する。各 job は setup-node 導入前（runner 同梱 npm）
// で `npm install -g "npm@${NPM_PIN}"` を実行するため、min-release-age（npm 11.10+ の機能）は
// この時点でまだ効かない。ここで代わりに検証する。ci.yml の changes ジョブから npm ci なしで
// 呼ばれるため、node ビルトイン以外を import しないこと。

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SEMVER_EXACT_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const REGISTRY_PACKAGE = 'npm';

// ci.yml の env コメント（11 系制約）を機械化した定数。メジャーを跨ぐ更新時はここも変える。
export const NPM_PIN_ALLOWED_MAJORS = [11];

// .npmrc の min-release-age がこの日数未満なら config エラー（敵対的レビュー round11 NEW-2:
// 同一 PR で .npmrc の閾値そのものを下げて cooldown 検証をバイパスする経路を閉じる）。
export const MIN_RELEASE_AGE_FLOOR_DAYS = 7;

// REMEDIATION は失敗種別＋docs 節への導線のみ（docs/SUPPLY_CHAIN.md「pin の失敗時」と逐語一致させない。
// 一致させると片方だけ更新されて drift する）。
const REMEDIATION = {
  transient: '一時的な問題の可能性があります。再実行してください（詳細: docs/SUPPLY_CHAIN.md「pin の失敗時」）。',
  value: 'NPM_PIN の値を見直してください（詳細: docs/SUPPLY_CHAIN.md「pin の失敗時」）。',
  config: '.npmrc / package.json の pin 関連設定を確認してください（詳細: docs/SUPPLY_CHAIN.md「pin の失敗時」）。',
};

function fail(kind, detail) {
  return { ok: false, kind, message: `${detail}\n${REMEDIATION[kind]}` };
}

function isCommentOrBlank(line) {
  return line === '' || line.startsWith('#') || line.startsWith(';');
}

// .npmrc の `key=value` 行を1つ抜き出す。コメント・空行はスキップ、`[section]` 行は呼び出し側で検出する。
function findKeyLines(npmrcContent, key) {
  const hits = [];
  for (const rawLine of npmrcContent.split('\n')) {
    const line = rawLine.trim();
    if (isCommentOrBlank(line)) continue;
    if (/^\[.*\]$/.test(line)) {
      hits.push({ section: true, line });
      continue;
    }
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const foundKey = line.slice(0, idx).trim();
    if (foundKey !== key) continue;
    hits.push({ section: false, value: line.slice(idx + 1).trim() });
  }
  return hits;
}

// min-release-age は正の整数のみ受理し、MIN_RELEASE_AGE_FLOOR_DAYS 未満は拒否する（round11 NEW-2）。
// 0・負数・小数・空値・重複キー・[section] 行もすべて config エラー（fail-closed。敵対的レビュー round7 F-1）。
export function parseMinReleaseAge(npmrcContent) {
  const hits = findKeyLines(npmrcContent, 'min-release-age');
  const sectionHit = hits.find((h) => h.section);
  if (sectionHit) {
    return { ok: false, reason: `.npmrc に [section] 記法が含まれています（未対応）: ${sectionHit.line}` };
  }
  const valueHits = hits.filter((h) => !h.section);
  if (valueHits.length === 0) {
    return { ok: false, reason: '.npmrc に min-release-age が見つかりません' };
  }
  if (valueHits.length > 1) {
    return { ok: false, reason: '.npmrc に min-release-age が重複しています' };
  }
  const raw = valueHits[0].value;
  if (!/^\d+$/.test(raw)) {
    return { ok: false, reason: `.npmrc の min-release-age が正の整数ではありません: ${raw || '(空)'}` };
  }
  const value = Number(raw);
  if (value < MIN_RELEASE_AGE_FLOOR_DAYS) {
    return {
      ok: false,
      reason: `.npmrc の min-release-age は${MIN_RELEASE_AGE_FLOOR_DAYS}日以上である必要があります: ${value}`,
    };
  }
  return { ok: true, value };
}

// registry= を .npmrc から読む（スコープ registry: `@scope:registry=` は対象外）。無ければ既定値。
// 敵対的レビュー round11 NEW-3: この値は検証先の変更には使わない（検証は常に公式 registry。
// 下記 assertOfficialRegistry の突合専用）。ミラー等の非公式 registry を指していれば config エラーにする。
export function parseRegistry(npmrcContent) {
  const hits = findKeyLines(npmrcContent, 'registry').filter((h) => !h.section);
  const last = hits.at(-1);
  if (last && last.value) return last.value;
  return DEFAULT_REGISTRY;
}

function normalizeRegistryUrl(url) {
  return String(url).trim().replace(/\/+$/, '');
}

// .npmrc の registry= が公式 npm registry 以外を指していないかを検査する（NEW-3）。
// 証拠源（cooldown 判定に使う packument の取得先）を repo 内容から独立させるため、検証は常に
// DEFAULT_REGISTRY を使う。.npmrc がミラー等を指す場合は人間判断が必要なため config エラーで止める。
function assertOfficialRegistry(npmrcContent) {
  const configured = parseRegistry(npmrcContent);
  if (normalizeRegistryUrl(configured) !== normalizeRegistryUrl(DEFAULT_REGISTRY)) {
    return {
      ok: false,
      reason: `.npmrc の registry が公式（${DEFAULT_REGISTRY}）以外を指しています: ${configured}（ミラー運用は人間判断。検証は常に公式 registry を使う）`,
    };
  }
  return { ok: true };
}

function buildPackumentUrl(registryBase) {
  const base = registryBase.endsWith('/') ? registryBase : `${registryBase}/`;
  return `${base}${REGISTRY_PACKAGE}`;
}

const GTE_UPPER_RE = /^>=\s*(\d+)\.(\d+)\.(\d+)\s+<\s*(\d+)(?:\.(\d+)\.(\d+))?$/;
const GTE_ONLY_RE = /^>=\s*(\d+)\.(\d+)\.(\d+)$/;
const CARET_RE = /^\^\s*(\d+)\.(\d+)\.(\d+)$/;

// engines.npm の受理形式: ">=x.y.z"、">=x.y.z <N" / ">=x.y.z <N.M.P"（上限併記）、"^x.y.z"。
// 他形式（~x.y.z 等）は未対応として config 扱いにする（呼び出し側で reason を組み立てる）。
export function parseEnginesNpmRange(rangeRaw) {
  const range = String(rangeRaw).trim();
  let m = GTE_UPPER_RE.exec(range);
  if (m) {
    const min = [Number(m[1]), Number(m[2]), Number(m[3])];
    const max = [Number(m[4]), Number(m[5] ?? 0), Number(m[6] ?? 0)];
    return { ok: true, min, max };
  }
  m = GTE_ONLY_RE.exec(range);
  if (m) {
    return { ok: true, min: [Number(m[1]), Number(m[2]), Number(m[3])], max: null };
  }
  m = CARET_RE.exec(range);
  if (m) {
    const min = [Number(m[1]), Number(m[2]), Number(m[3])];
    const max = [min[0] + 1, 0, 0];
    return { ok: true, min, max };
  }
  return { ok: false, reason: `engines.npm が未対応の range です（">=x.y.z" / "<N[.M.P]" 併記 / "^x.y.z" のみ対応）: ${range}` };
}

function compareTriples(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function pinSatisfiesRange(pinParts, range) {
  if (compareTriples(pinParts, range.min) < 0) return false;
  if (range.max && compareTriples(pinParts, range.max) >= 0) return false;
  return true;
}

// root/worker どちらの package.json でも使う共通チェック（round7 S7-3/F10-4: 両方を検査）。
function checkEnginesFile(packageJsonPath, label) {
  let content;
  try {
    content = readFileSync(packageJsonPath, 'utf-8');
  } catch {
    return { ok: false, reason: `${label}: package.json を読み込めません（${packageJsonPath}）` };
  }
  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch {
    return { ok: false, reason: `${label}: package.json を JSON として解釈できません` };
  }
  const rangeRaw = pkg?.engines?.npm;
  if (typeof rangeRaw !== 'string') {
    return { ok: false, reason: `${label}: engines.npm がありません` };
  }
  const range = parseEnginesNpmRange(rangeRaw);
  if (!range.ok) {
    return { ok: false, reason: `${label}: ${range.reason}` };
  }
  return { ok: true, range, raw: rangeRaw, label };
}

function classifyHttpStatus(status) {
  if (status === 429 || status >= 500) return 'transient';
  if (status === 404) return 'value';
  return 'config';
}

export async function checkNpmPinCooldown({
  pin,
  npmrcPath = join(REPO_ROOT, '.npmrc'),
  packageJsonPath = join(REPO_ROOT, 'package.json'),
  workerNpmrcPath = join(REPO_ROOT, 'worker', '.npmrc'),
  workerPackageJsonPath = join(REPO_ROOT, 'worker', 'package.json'),
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const semverMatch = SEMVER_EXACT_RE.exec(pin);
  if (!semverMatch) {
    return fail('value', `NPM_PIN が exact semver（x.y.z）ではありません: ${pin}`);
  }
  const pinParts = [Number(semverMatch[1]), Number(semverMatch[2]), Number(semverMatch[3])];

  if (!NPM_PIN_ALLOWED_MAJORS.includes(pinParts[0])) {
    return fail(
      'value',
      `NPM_PIN=${pin} のメジャー版（${pinParts[0]}）は許容範囲外です（NPM_PIN_ALLOWED_MAJORS=[${NPM_PIN_ALLOWED_MAJORS.join(', ')}]）`,
    );
  }

  let npmrcContent;
  try {
    npmrcContent = readFileSync(npmrcPath, 'utf-8');
  } catch {
    return fail('config', `.npmrc を読み込めません: ${npmrcPath}`);
  }
  const npmrcResult = parseMinReleaseAge(npmrcContent);
  if (!npmrcResult.ok) {
    return fail('config', npmrcResult.reason);
  }
  const thresholdDays = npmrcResult.value;

  // worker/.npmrc はファイル必須（敵対的レビュー round13 NF-3: worker を独立 npm ci する構成では
  // root と対称の cooldown 防御が worker 側にも必要。ファイル自体を削除すれば root 側の制約だけで
  // 通ってしまう経路を閉じる）。ファイルが存在する場合の min-release-age キー必須は round11 NEW-1
  // （キー削除・コメントアウト・キー名違いは parseMinReleaseAge が config エラーを返す）。
  let workerNpmrcContent;
  try {
    workerNpmrcContent = readFileSync(workerNpmrcPath, 'utf-8');
  } catch {
    return fail('config', `worker/.npmrc がありません（root と対称の cooldown 防御が必要）: ${workerNpmrcPath}`);
  }
  const workerResult = parseMinReleaseAge(workerNpmrcContent);
  if (!workerResult.ok) {
    return fail('config', `worker/.npmrc: ${workerResult.reason}`);
  }
  if (workerResult.value !== thresholdDays) {
    return fail(
      'config',
      `worker/.npmrc の min-release-age（${workerResult.value}）が root（${thresholdDays}）と一致しません`,
    );
  }

  const rootEngines = checkEnginesFile(packageJsonPath, 'root');
  if (!rootEngines.ok) {
    return fail('config', rootEngines.reason);
  }
  if (!pinSatisfiesRange(pinParts, rootEngines.range)) {
    return fail('value', `NPM_PIN=${pin} は root の engines.npm（${rootEngines.raw}）を満たしません`);
  }
  const workerEngines = checkEnginesFile(workerPackageJsonPath, 'worker');
  if (!workerEngines.ok) {
    return fail('config', workerEngines.reason);
  }
  if (!pinSatisfiesRange(pinParts, workerEngines.range)) {
    return fail('value', `NPM_PIN=${pin} は worker の engines.npm（${workerEngines.raw}）を満たしません`);
  }

  const registryCheck = assertOfficialRegistry(npmrcContent);
  if (!registryCheck.ok) {
    return fail('config', registryCheck.reason);
  }
  const registryBase = DEFAULT_REGISTRY;
  const packumentUrl = buildPackumentUrl(registryBase);
  console.error(`[check-npm-pin-cooldown] registry: ${registryBase}`);

  let res;
  try {
    res = await fetchImpl(packumentUrl, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    return fail('transient', `registry へのアクセスに失敗しました（${packumentUrl}）: ${err.message ?? err}`);
  }
  if (!res.ok) {
    return fail(classifyHttpStatus(res.status), `registry からエラー応答を受けました（${packumentUrl}）: ${res.status}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return fail('transient', `registry の応答を JSON として解釈できません: ${err.message ?? err}`);
  }

  const time = data?.time;
  if (time == null || typeof time !== 'object' || !Object.hasOwn(time, pin)) {
    return fail('value', `NPM_PIN=${pin} が registry の time map に見つかりません（registry: ${registryBase}）`);
  }
  const publishedAt = Date.parse(time[pin]);
  if (!Number.isFinite(publishedAt)) {
    return fail('value', `NPM_PIN=${pin} の公開日時が不正です: ${time[pin]}`);
  }
  const ageDays = (now() - publishedAt) / 86_400_000;
  if (!(ageDays >= thresholdDays)) {
    return fail(
      'value',
      `NPM_PIN=${pin} は公開後 ${ageDays.toFixed(2)} 日で、min-release-age=${thresholdDays} 日を満たしません`,
    );
  }

  return {
    ok: true,
    kind: null,
    message: `NPM_PIN=${pin} OK（registry=${registryBase}, 公開後 ${ageDays.toFixed(2)} 日 [min-release-age=${thresholdDays}], root engines.npm(${rootEngines.raw}) / worker engines.npm(${workerEngines.raw}) を満たす）`,
  };
}

// env NPM_PIN が未設定（undefined）のときは ci.yml に committed された値を読む
// （round7 F10-5: ローカルで `npm run check:npm-pin` を実行し、コミット済みの値を検証できるようにする）。
// shadow 検出（round11 NEW-4）: ci.yml が読める場合は常に `NPM_PIN:` キーの出現数を数える。
// workflow レベル env の1箇所だけが正当で、job/step の env: で同名キーを追加（shadow）していれば
// 2箇所以上ヒットする。env 経由で pin を受け取る場合でも、shadow の有無自体は CI 構成の健全性の
// 問題なので envPin の有無に関わらず検査する（値取得元の分岐より前に行う）。
export function resolvePin({ envPin, ciYmlPath = join(REPO_ROOT, '.github', 'workflows', 'ci.yml') } = {}) {
  let content;
  try {
    content = readFileSync(ciYmlPath, 'utf-8');
  } catch {
    content = null;
  }

  if (content !== null) {
    const npmPinKeyLines = content.match(/^\s*NPM_PIN:/gm) ?? [];
    if (npmPinKeyLines.length >= 2) {
      return {
        pin: undefined,
        source: 'ci.yml',
        error: `ci.yml に NPM_PIN: キーが${npmPinKeyLines.length}箇所あります（job/step env での shadow の可能性）: ${ciYmlPath}`,
      };
    }
  }

  if (envPin !== undefined) {
    // ci.yml が読めない場合、shadow 検査（上記）が実行できていないことを呼び出し側に伝える
    // （敵対的レビュー round13 NF-2: 検査が無音でスキップされたことが分からないと安全側に
    // 誤解される）。
    if (content === null) {
      return {
        pin: envPin,
        source: 'env',
        notice: `ci.yml を読めないため shadow 検査は行いません: ${ciYmlPath}`,
      };
    }
    return { pin: envPin, source: 'env' };
  }

  if (content === null) {
    return { pin: undefined, source: 'ci.yml', error: `ci.yml を読み込めません: ${ciYmlPath}` };
  }
  // 行末コメント（`# ...`）を許容する（round11 NEW-5）。
  const m = /^\s*NPM_PIN:\s*"([^"]*)"\s*(?:#.*)?$/m.exec(content);
  if (!m) {
    return { pin: undefined, source: 'ci.yml', error: `ci.yml に NPM_PIN が見つかりません: ${ciYmlPath}` };
  }
  return { pin: m[1], source: 'ci.yml' };
}

async function main() {
  const { pin, source, error, notice } = resolvePin({ envPin: process.env.NPM_PIN });
  if (notice) {
    console.error(notice);
  }
  if (error) {
    console.error(error);
    process.exit(1);
    return;
  }
  console.error(`[check-npm-pin-cooldown] NPM_PIN source: ${source}`);
  const result = await checkNpmPinCooldown({ pin });
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  process.stdout.write(`${result.message}\n`);
}

// process.argv[1] が本ファイルへの symlink 経由で起動された場合、import.meta.url は Node が解決した
// 実体パスを指すため URL 文字列比較（旧実装）は false になり main() が無音で呼ばれない（exit 0 の
// fail-open。敵対的レビュー round7 F-2）。realpath 同士で比較する。
// round11 NEW-7: `node --preserve-symlinks-main` では import.meta.url 側が symlink 解決されない
// （symlink パスのまま）ため、片側だけ realpath する実装だと再び不一致になり main() が無音スキップ
// されてしまう。両辺を realpath してから比較する。
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}

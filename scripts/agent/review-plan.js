// レビュー実行計画（reviewer execution）。
//
// 責務: レビュー**内容**の代行ではなく、レビュー**実行**の準備・分配・記録・起動順の制御。
//   - 初期 Tier / 実効 Tier の算出と更新（PR 内で縮小しない）
//   - 観点ごとのレビューモード選択（差分探索 / 全体再探索）
//   - fresh 起動 / 継続利用の選択
//   - 起動記録（実際に起動した invocation）と snapshot 鮮度の照合
//   - 段階の進行（減算 → 本体 → 清掃）
//
// **snapshot を跨ぐ「未消化の起動義務」を永続台帳として持たない。** ある観点をいま起動すべきか
// は、過去の snapshot が発行した pending record ではなく、**現在の repo / snapshot / これまでの
// 起動記録から毎回再計算する**（`buildPlan`）。`record-run` の「計画が要求した起動か」の照合も、
// 保存された義務ではなく**その場で再計算した計画**と突き合わせる。中断・cache 削除の後は
// 過去 attempt の pending を復元せず、現在の repo state から必要な起動を出し直す。
//
// **所見の意味・因果・裁定は扱わない。** 所見ごとの裁定（判断・理由・対応・証拠）の恒久正本は
// `docs/pr/PR-{番号}.md`（境界の正本: docs/planning/review-memory-boundary.md §3）。
// machine は「どの reviewer をまだ実行していないか」だけを見る。「所見があるからもう1周する」の
// 判断は人間・orchestrator が行い、必要なら `escalate` で起動側へ渡す。
//
// **最終独立レビュー（final independent review）も machine の起動義務ではない。** 実体は
// 「修正コンテキストを持たない1人のレビュアーが完全 diff を1回読む」であり、系統ごとの起動では
// ない。それを系統ごとの義務として持つと、1回の invocation を N 件の記録へ水増しすることに
// なる（execution state は実 invocation と一致させる）。angle に依らない起動単位を表現する
// 機構は持たないので、実施の判断・記録は
// docs/agent-workflows/review-angles/README.md「review budget（自動探索の上限）」 と docs/pr/PR-{番号}.md を正本とする
// （表現力の追加は後続の obligation state 縮小で扱う）。
//
// 各観点のレビュー自体は行わない（観点レビュアーにオーケストレーションを兼務させないのと対）。
//
// 状態は `$(git rev-parse --git-path agent-review)/review-state.json`（1つの作業ツリー内での
// ループ制御に使う作業キャッシュであり、レビュー判断の記録ではない — 同 §1(d)）。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { classify, expandRenames } from './classify-changes.js';
import {
  TIER_ANGLES,
  DESIGN_ADDON_ANGLES,
  ANGLE_TOKENS,
  CONDITIONAL_ANGLE_TOKENS,
} from './review-angle-tokens.js';
import {
  ANGLE_TRIGGERS,
  CHANGE_SIGNALS,
  REVIEW_MODES,
  resolveExecConfig,
} from './review-exec-config.js';
import {
  changedFilesBetween,
  isValidSeq,
  latestSnapshot,
  snapshotById,
  snapshotFreshness,
  reviewRoot,
} from './review-snapshot.js';

const STATE_FILE = 'review-state.json';

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

// state schema の現行版。4 = 起動義務台帳（pendingLaunches / supersededLaunches）を持たない版。
//
// **旧版からの移行経路は持たない。** state は1つの continuous attempt 中の作業キャッシュであり
// （docs/planning/review-memory-boundary.md §1(d)）、旧版の中身は「過去 attempt が発行した
// 起動義務」＝本ファイルが持たないことにした責務そのものである。忠実に変換する先が無いので、
// 認識できない版は fail-loud で拒否し、キャッシュを捨てて現在の repo state から作り直させる
// （移行のための runtime 分岐を残さない）。
// 1〜3 は旧 schema、2 は凍結中の #569 が別の schema で使用済み。いずれも再利用しない
export const STATE_VERSION = 4;

/**
 * state の全フィールドと既定値。**この関数が state の形の唯一の正本**で、構造検証
 * （配列 / boolean の型検査）もここから導出する。手書きで別の一覧を作ると、フィールド追加時に
 * 検証側だけが取り残される（`addedAngles` が検証対象から漏れた事故がある）。
 * **未知キーは検査しない** — `loadState` は `{ ...emptyState(), ...parsed }` でそのまま取り込む。
 */
export function emptyState() {
  return {
    version: STATE_VERSION,
    initialTier: null,
    // 初期 Tier の判定理由（machine が変更ファイルから導出した文字列）
    initialTierReasons: null,
    effectiveTier: null,
    // 実効 Tier に加算された系統（PR 内で縮小しない。確認済みでも履歴として保持する）
    addedAngles: [],
    escalations: [],
    // 実際に起動した invocation の記録（{ seq, snapshotId, angle, mode, fresh, status, agentId }）。
    // **未消化の起動義務ではない** — 「まだ起動していない」は記録の不在から毎回導出する
    runs: [],
    // 記憶適合（条件起動）がこの PR の必須系統として要求されたか。--memory-hits > 0 で一度
    // 立つと PR 内では降りない（実効 Tier を縮小しない不変条件と同じ扱い）。--memory-hits を
    // 渡し忘れた再計画で必須レビューの義務が消えるのを防ぐ
    memoryRequired: false,
    // 実効 Tier が広がった時点の seq。それより後の run が無い系統には再評価を要求する
    tierWidenedSeq: null,
  };
}

export function stateFile(cwd = process.cwd()) {
  return join(reviewRoot(cwd), STATE_FILE);
}

/**
 * 旧 `plan` が snapshot ディレクトリへ書いていた `findings.json`（所見の要旨・因果・裁定を
 * 含む）を削除する。書き出しを止めるだけでは、既存の作業ツリーで machine 管理領域
 * （`.git/agent-review/`）に semantic finding が無期限で残る（`review-snapshot.js` の prune は
 * 古い git ref だけを消し、snapshot ディレクトリ自体は残す）。外部レビュー Codex 指摘。
 *
 * 失敗しても計画の生成は止めない（掃除であって機能ではない）。
 */
export function discardLegacyFindingArtifacts(cwd = process.cwd()) {
  const removed = [];
  let root;
  try {
    root = reviewRoot(cwd);
    if (!existsSync(root)) return removed;
  } catch {
    return removed;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, 'findings.json');
    try {
      if (existsSync(file)) {
        rmSync(file);
        removed.push(file);
      }
    } catch {
      // 読めない・消せない snapshot ディレクトリは飛ばす
    }
  }
  return removed;
}

// state.json の配列フィールド。パース成功後の構造検証で使う（存在する場合のみ配列を要求する）。
// emptyState() の配列フィールドから動的に導出する（手書き複製すると emptyState() への
// フィールド追加時に drift する — addedAngles が検証対象から漏れていた事故の再発防止）。
const STATE_ARRAY_FIELDS = Object.entries(emptyState())
  .filter(([, v]) => Array.isArray(v))
  .map(([k]) => k);

// 同じく boolean フィールド。値の型を loadState で確定させることで、利用側が `Boolean(x)` の
// ような型強制を持たなくて済むようにする（`Boolean("false")` は true — CLAUDE.md「boolean 型
// 強制禁止」/ INVARIANTS.md #13）。必須レビューの要求フラグが文字列で入っていた場合に
// 黙って解釈するのではなく、構造不正として落とす
const STATE_BOOLEAN_FIELDS = Object.entries(emptyState())
  .filter(([, v]) => typeof v === 'boolean')
  .map(([k]) => k);

// loadState の fail-loud エラーに共通する復旧案内サフィックス。
const STATE_RECOVERY_HINT = '手動で内容を確認し、必要なら削除してから再生成してください';

export function loadState(cwd = process.cwd()) {
  const file = stateFile(cwd);
  if (!existsSync(file)) return emptyState();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    // 破損時は空状態へ黙ってフォールバックしない（レビュー台帳の取り違えは所見・起動記録の
    // 消失に直結する）。review-snapshot.js の readIndex と同じ fail-loud 方針
    throw new Error(`${file} が壊れています（${err.message}）。${STATE_RECOVERY_HINT}`, {
      cause: err,
    });
  }
  // JSON 構文としては正しいが構造が不正（配列・null・プリミティブ値）なケースを、
  // `{ ...emptyState(), ...parsed }` が黙って「空状態」へ変換してしまわないよう検証する
  // （直後の saveState 呼び出しで実際の台帳データが空状態のまま上書き・消失する事故を防ぐ）
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `${file} の構造が不正です（JSON オブジェクトである必要があります）。${STATE_RECOVERY_HINT}`,
    );
  }
  // version を検査しないと、別 schema の state を黙って現行版として読んでしまう
  // （version 番号を割り当てた意味が消える）。**受理するのは現行版だけで、移行経路は持たない** —
  // 旧版が持っていたのは過去 attempt の起動義務であり、現行 machine に変換先が無い。
  // 旧版の `runs` を素通しすると、旧 `final`（最終独立レビュー）や supersede 由来の記録が
  // 通常のレビュー完了として解釈され、未実施の系統が実施済みになる（＝偽陰性）ため受理しない
  const version = parsed.version;
  if (version !== STATE_VERSION) {
    const seen = version === undefined ? '（version フィールドなし）' : String(version);
    throw new Error(
      `${file} の version を認識できません: ${seen}（受理: ${STATE_VERSION} のみ）。` +
        'この state は1回のレビューの作業キャッシュで、旧版からの移行は行いません。' +
        `削除して \`npm run review:plan\` を実行し直してください（${STATE_RECOVERY_HINT}）`,
    );
  }
  for (const key of STATE_ARRAY_FIELDS) {
    if (Object.hasOwn(parsed, key) && !Array.isArray(parsed[key])) {
      throw new Error(
        `${file} の構造が不正です（${key} は配列である必要があります）。${STATE_RECOVERY_HINT}`,
      );
    }
  }
  for (const key of STATE_BOOLEAN_FIELDS) {
    if (Object.hasOwn(parsed, key) && typeof parsed[key] !== 'boolean') {
      throw new Error(
        `${file} の構造が不正です（${key} は boolean である必要があります）。${STATE_RECOVERY_HINT}`,
      );
    }
  }
  // seq を読む実装が受理集合で食い違うと、片方だけが見る記録を作れる（`nextSeq` は
  // `Number.isInteger` で弾くのに `latestRunOf` は生比較で採用する、など）。判定は
  // `isValidSeq` へ一本化する — 2^53 以上は整数判定を通るのに `nextSeq` の `max + 1` が
  // 飽和して同じ値へ戻り、以後どの記録も追い越せず baseline が恒久固定される。
  // `snapshotId` は累積判定の唯一のキーで、`null` を通すと `lastCompleteSnapshot` が
  // 「完了記録が無い」と同じ値を返し、fail-closed ではなく直前 hop 判定へ**降格**する
  const RECORD_FIELDS = {
    runs: { seq: isValidSeq, snapshotId: (v) => typeof v === 'string' && v !== '' },
    escalations: { seq: isValidSeq },
  };
  const REQUIREMENT = {
    seq: 'seq は 0 以上の安全な整数である必要があります',
    snapshotId: 'snapshotId は非空の文字列である必要があります',
  };
  for (const [key, fields] of Object.entries(RECORD_FIELDS)) {
    for (const rec of parsed[key] ?? []) {
      for (const [field, valid] of Object.entries(fields)) {
        if (valid(rec?.[field])) continue;
        throw new Error(
          `${file} の構造が不正です（${key} の ${REQUIREMENT[field]}: ${JSON.stringify(rec?.[field])}）。` +
            STATE_RECOVERY_HINT,
        );
      }
    }
  }
  // `tierWidenedSeq` も同じ採番を共有する（`nextSeq` の「seq を振る値を足すときはここにも足す」）
  if (parsed.tierWidenedSeq != null && !isValidSeq(parsed.tierWidenedSeq)) {
    throw new Error(
      `${file} の構造が不正です（tierWidenedSeq は 0 以上の安全な整数である必要があります: ${JSON.stringify(parsed.tierWidenedSeq)}）。` +
        STATE_RECOVERY_HINT,
    );
  }
  return { ...emptyState(), ...parsed };
}

export function saveState(state, cwd = process.cwd()) {
  const root = reviewRoot(cwd);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

// ---------------------------------------------------------------------------
// Tier 判定
// ---------------------------------------------------------------------------

// 大規模 diff の閾値（Full 判定の一材料）。README の「大規模 diff」を機械判定へ落とす。
export const LARGE_DIFF_FILES = 30;
export const LARGE_DIFF_LINES = 1000;

/**
 * 変更ファイル一覧から初期 Tier（宣言名）と必須系統を算出する。
 * 判定規則の正本は docs/agent-workflows/review-angles/README.md「Tier」。
 */
export function computeInitialTier(files) {
  // 「コード変更」「実行可能設計文書」「記憶レコード」「その他の説明文書」「依存 manifest のみか」の
  // 判定は classify-changes.js の classify() を正とする（README「Tier」／check-artifacts.js と統一。
  // #559: 本関数が file オブジェクトのフラグから独自に再構築していたため、classify() 側の分類と
  // drift し「設計文書」Tier に誤って固定される事故があった）。file オブジェクト由来のフラグは
  // classify() が持たない highRisk・大規模 diff（additions/deletions）判定にのみ使う。
  // rename エントリは oldPath も classify 入力に含める（#446 round3: rename 元が code
  // だった場合に Tier が「なし」/Docs 側へ落ちるのを防ぐ。review-snapshot.js の
  // classifyFile と同じロジックのため classify-changes.js の expandRenames へ統合済み。
  // #446 round4 観点別レビュー 減算#4）
  const { codeChanged, depOnly, designDocsChanged, recordDocsChanged, docsChanged } =
    classify(expandRenames(files));

  // depOnly は classify() 側で「変更されたコードファイルが全て既知 npm プロジェクト直下の
  // manifest/lockfile か」に限定済み（isKnownDepManifestPath）。`!docsChanged` は、docs/ 配下に
  // 置かれた lockfile 等が混在する入力で allFilesAreDep を通してしまうのを止めるために必要。
  // round6〜8 の経緯は git log 参照。
  const allFilesAreDep = files.every((f) => f.kind === 'dep');
  if (files.length === 0 || (depOnly && allFilesAreDep && !docsChanged)) {
    return {
      tier: 'なし',
      base: null,
      addon: false,
      angles: [],
      // 「変更なし」は files.length===0 のときだけ（依存 manifest のみの変更と区別する。
      // #446 round7 観点別レビュー 敵対的N2）
      reasons: [files.length === 0 ? '変更なし' : '依存 manifest のみ'],
    };
  }

  // depOnly ＋ docs 混在（下の分岐）は「コード側は依存 manifest の自動更新のみで実質的な
  // 意味を持たない」ことを前提に Tier を docs 側へ委ねる（depOnly の定義は上記参照）。
  if (!codeChanged || depOnly) {
    // docs のみ、または depOnly（コード側は依存 manifest の自動更新のみで実質的な意味を持たない）
    // ＋ docs 混在: 設計文書 > Record > Docs。NON_EXPLANATORY_PROSE_PATTERNS による除外は
    // check-artifacts.js 側の別目的の除外であり、Tier 判定に転用すると .gitignore/LICENSE のみの
    // 変更が無レビューになるため使わない
    const tier = designDocsChanged ? '設計文書' : recordDocsChanged ? 'Record' : 'Docs';
    return {
      tier,
      base: null,
      addon: false,
      angles: TIER_ANGLES[tier],
      reasons: [`docs のみの変更（${tier}）`],
    };
  }

  const reasons = [];
  const highRisk = files.some((f) => f.highRisk);
  if (highRisk) reasons.push('高リスク領域に触れる');
  const totalLines = files.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  const large = files.length >= LARGE_DIFF_FILES || totalLines >= LARGE_DIFF_LINES;
  if (large) reasons.push(`大規模 diff（${files.length} ファイル / ${totalLines} 行）`);
  const base = highRisk || large ? 'Full' : 'Light';
  if (base === 'Light') reasons.push('通常コード変更・高リスク領域外');
  const angles = new Set(TIER_ANGLES[base]);
  const addon = designDocsChanged;
  if (addon) {
    for (const a of DESIGN_ADDON_ANGLES) angles.add(a);
    reasons.push('実行可能設計文書に触れる（仕様＋運用性を加算）');
  }
  return {
    tier: addon ? `${base}＋設計文書` : base,
    base,
    addon,
    angles: [...angles],
    reasons,
  };
}

/** 宣言名 → 必須系統。加算形式（`{基礎}＋設計文書`）も解ける。 */
export function anglesForTierName(tierName) {
  // 未設定（null / undefined）と明示の「なし」だけが空集合。`''` / `0` / `false` を
  // ここで通すと、壊れた state が黙って必須系統ゼロになる（敵対的 F5）
  if (tierName === null || tierName === undefined || tierName === 'なし') return [];
  // 未知の宣言名は**空集合へ倒さず fail-loud**（外部レビュー Codex 指摘 P2）。
  // `[]` を返すと「必須系統なし」＝ `entries: []` / `stage: done` / `converged: true` になり、
  // 壊れた state が全レビュー完了として通る。素のプロパティアクセスも使わない —
  // __proto__ / constructor 等が非配列（truthy）を返して `?? []` を素通りする
  const angles = (name) => {
    if (!Object.hasOwn(TIER_ANGLES, name)) {
      throw new Error(
        `未知の Tier 宣言名です: ${JSON.stringify(name)}（既知: ${Object.keys(TIER_ANGLES).join(' / ')}）。` +
          `review-state.json が壊れている可能性があります。${STATE_RECOVERY_HINT}`,
      );
    }
    return TIER_ANGLES[name];
  };
  const m = /^(.+?)[＋+]設計文書$/.exec(tierName);
  if (m) {
    const set = new Set(angles(m[1]));
    for (const a of DESIGN_ADDON_ANGLES) set.add(a);
    return [...set];
  }
  return angles(tierName);
}

// 弱い順（必須系統が少ない順）。同じ系統集合を持つ宣言名が複数ある場合
// （Light＋設計文書 と Full は同一の7系統）、加算表記のない方を先に置いて優先する
const TIER_NAME_LADDER = [
  'Docs',
  'Record',
  'Light',
  '設計文書',
  'Light＋設計文書',
  'Full',
  'Full＋設計文書',
];

/**
 * 実効 Tier の宣言名を必須系統集合から復元する。
 * 与えられた系統をすべて含む**最も弱い**宣言名を選ぶ（不要な昇格をしない）。
 *
 * `preferBase`（現在の基礎 Tier）を渡すと、**同じ系統集合を持つ宣言名が複数ある場合**に
 * その基礎 Tier 側を優先する。Light＋設計文書 と Full は必須系統が同一（7系統）のため、
 * これが無いと Full の PR に系統が加算されたとき宣言名が Light＋設計文書 へ落ち、
 * 実効 Tier の宣言名が弱い方（Light 系）へ落ちてしまう。
 */
export function tierNameForAngles(angles, { preferBase = null } = {}) {
  const set = [...new Set(angles)];
  const covering = TIER_NAME_LADDER.filter((name) => {
    const req = new Set(anglesForTierName(name));
    return set.every((a) => req.has(a));
  });
  if (covering.length === 0) return 'Full＋設計文書';
  const smallest = new Set(anglesForTierName(covering[0])).size;
  const tied = covering.filter((n) => new Set(anglesForTierName(n)).size === smallest);
  if (preferBase) {
    const kept = tied.find((n) => n === preferBase || n.startsWith(`${preferBase}＋`));
    if (kept) return kept;
  }
  return tied[0];
}

/** 宣言名が「＋設計文書」の加算表記を持つか。 */
export function hasDesignAddon(tierName) {
  return /[＋+]設計文書$/.test(tierName ?? '');
}

/** 宣言名から基礎 Tier（Full / Light）を取り出す。docs のみ Tier では null。 */
export function baseTierOf(tierName) {
  if (!tierName) return null;
  const base = tierName.replace(/[＋+]設計文書$/, '');
  return base === 'Full' || base === 'Light' ? base : null;
}

// ---------------------------------------------------------------------------
// 変更シグナル
// ---------------------------------------------------------------------------

/**
 * snapshot（manifest + 修正 diff の変更ファイル）から、トリガー表が消費するシグナルを算出する。
 * 初回（前回 snapshot なし）は PR 全体の変更ファイルが「修正差分」として渡る。
 */
export function deriveSignals(manifest, changedInFix) {
  const signals = Object.create(null);
  for (const s of CHANGE_SIGNALS) signals[s] = false;
  for (const f of changedInFix) {
    if (f.code) signals.code = true;
    if (f.test) signals.test = true;
    if (f.config) signals.config = true;
    if (f.dep) signals.dep = true;
    if (f.designDoc) signals.designDoc = true;
    if (f.recordDoc) signals.recordDoc = true;
    if (f.kind === 'docs-other') signals.docsOther = true;
    if (f.highRisk) signals.highRisk = true;
    if (f.conventionDoc) signals.conventionDoc = true;
    if (f.specAnchor) signals.specAnchor = true;
    if (f.riskTable) signals.riskTable = true;
    if (f.status === 'A' || f.status === 'U') signals.newFile = true;
    if (f.status === 'D') signals.deletion = true;
  }
  signals.guard = Boolean(manifest.guardChangeInFix);
  signals.semanticDoc = Boolean(manifest.semanticDocChangeInFix);
  return signals;
}

// ---------------------------------------------------------------------------
// モード・fresh/継続の選択
// ---------------------------------------------------------------------------

/**
 * その観点の記録のうち seq が最大のもの（`match` を渡すと条件付き）。
 * `state.runs` は追記順で、seq は escalation / Tier 強化と共有の採番なので順序を仮定できない。
 */
function latestRunOf(state, angle, match = null) {
  let best = null;
  for (const r of state.runs) {
    if (r.angle !== angle) continue;
    if (match && !match(r)) continue;
    if (!best || r.seq > best.seq) best = r;
  }
  return best;
}

/**
 * 起動判定に**実際に使った範囲**。`review-plan.json` の読み手が「なぜこの系統が起動されるのか」を
 * 復元するための唯一の材料なので、常に範囲を名指しする。
 *
 * `null` を「直前 hop で判定した」の意味に使わない — 「一度も完了していない」「範囲を確認できな
 * かった」まで同じ値へ潰れ、**最も安全側に倒すべき系統が読み手の列挙から漏れる**（仕様レビュー
 * 所見1・運用性 所見2 が実測）。
 */
function baselineRange(base) {
  if (base?.unresolved) return { snapshotId: base.snapshotId ?? null, range: '解決不能' };
  if (base?.cumulative) return { snapshotId: base.snapshotId, range: '累積' };
  if (base?.snapshotId) return { snapshotId: base.snapshotId, range: '直前' };
  return { snapshotId: null, range: '初回' };
}

/**
 * `baselineRange` の値域 → 読み手向けの説明。**`baselineRange` が返しうる range をすべて
 * 埋める** — 手書きの分岐にすると値を増やしたときに一部が既定へ落ち、未確認範囲を誤って
 * 表示する（`初回` を「直前 snapshot からの修正差分」と表示していた。減算 F5 が実測）。
 * 逆に、ここに無い range が来ると `formatPlan` が実行時に落ちる（fail-loud）。
 * 4値の網羅は `tests/reviewPlan.test.js` の `baselineRange: 返しうる range はすべて説明を持つ`
 * が機械検査する。
 */
const RANGE_DESCRIPTIONS = {
  累積: (b) => `${b.snapshotId} 以降の累積差分`,
  解決不能: () => '基準からの差分を解決できない（最も安全側に倒すべき系統）',
  直前: () => '直前 snapshot からの修正差分',
  初回: () => 'merge-base からの完全 diff（この観点の完了記録がまだ無い）',
};

function runsFor(state, angle) {
  return state.runs.filter((r) => r.angle === angle);
}

/** その観点で「まだ解消していないエスカレーション」があるか（fresh 強制・強度引き上げの根拠）。 */
function pendingEscalation(state, angle) {
  for (const e of state.escalations) {
    if (!e.angles.includes(angle)) continue;
    // **1 escalation = 1 起動。** 消化条件は予算の消費と同じで `status` を問わない
    // （理由は `exploredCount` の JSDoc）
    const done = state.runs.some(
      (r) => r.angle === angle && r.mode === 'full-rescan' && r.fresh && r.seq > e.seq,
    );
    if (!done) return e;
  }
  return null;
}

/**
 * 観点1件の**再探索トリガー**の評価（起動可否・モード・fresh/継続）。
 * 評価順は review-exec-config.js の ANGLE_TRIGGERS のコメントを正とする。
 *
 * **これは予算を知らない。** 「この観点をもう一度探索させてよいか」は `applyBudget` が別に決める
 * （トリガーは「対象が変わったか」を、予算は「何回まで自動で探索させるか」を答える別の問い）。
 * `buildPlan` は必ず両方を通す — 片方だけで起動を決めると、トリガーが立ち続ける観点
 * （減算は追加がある限り常に立つ）で自動探索が止まらない。正本:
 * docs/agent-workflows/review-angles/README.md「review budget（自動探索の上限）」
 */
export function selectMode(state, angle, signals, { fixDiffEmpty = false } = {}) {
  // プロパティアクセス（ANGLE_TRIGGERS[angle]）は __proto__ 等のプロトタイプ鎖キーに対して
  // Object.prototype を返してしまい `!trig` を素通りする（own-property のみを見る。
  // Codex/Copilot 指摘: addFinding/recordRun で導入済みの assertKnownAngle と同じガードを
  // ここにも揃える。state.addedAngles が破損した review-state.json 経由で汚染された場合の
  // 防御線）
  if (!Object.hasOwn(ANGLE_TRIGGERS, angle)) {
    throw new Error(`トリガー定義のない観点です: ${angle}`);
  }
  const trig = ANGLE_TRIGGERS[angle];
  const runs = runsFor(state, angle);
  const esc = pendingEscalation(state, angle);

  if (esc) {
    const label =
      esc.kind === 'tier-reclassification'
        ? 'Tier 再検証によるエスカレーション'
        : '起動側の判断によるエスカレーション（理由は docs/pr/PR-{番号}.md）';
    return {
      run: true,
      mode: 'full-rescan',
      fresh: true,
      reason:
        `${label}${esc.reason ? `（${esc.reason}）` : ''}` +
        ' — 同一レビュアーの継続では見逃しが保持されるため fresh へ交代',
      escalated: true,
    };
  }

  // 未完了（maxTurns 到達等）で終わった直近の起動・起動そのものが失敗した直近の起動は、
  // 所見ゼロとして扱わず再探索する（error のまま放置すると当該観点が永久に再起動提案されず、
  // 清掃ゲート・plan.converged が恒久的にブロックされる）
  const last = runs.at(-1);
  if (last && (last.status === 'incomplete' || last.status === 'error')) {
    return {
      run: true,
      mode: 'full-rescan',
      fresh: true,
      reason:
        last.status === 'error'
          ? '直近の起動が error（起動失敗）— 所見ゼロとして収束させない'
          : '直近の起動が incomplete（未確認範囲あり）— 所見ゼロとして収束させない',
      escalated: false,
    };
  }

  if (runs.length === 0) {
    return {
      run: true,
      mode: 'full-rescan',
      fresh: true,
      reason: '初回探索（この観点をこの PR でまだ起動していない）',
      escalated: false,
    };
  }

  const hit = (list) => list.some((s) => signals[s]);
  if (hit(trig.fullRescanSignals)) {
    return {
      run: true,
      mode: 'full-rescan',
      fresh: true,
      reason: `探索対象の差分でこの観点のアンカーが動いた（${trig.fullRescanSignals.filter((s) => signals[s]).join(' / ')}）`,
      escalated: false,
    };
  }
  const exploreHit = trig.alwaysExplore ? !fixDiffEmpty : hit(trig.exploreSignals);
  if (exploreHit) {
    return {
      run: true,
      mode: 'diff-explore',
      fresh: true,
      reason: trig.alwaysExplore
        ? '探索対象の差分に追加があるため新規探索を継続する（この観点のアンカーは追加物そのもの）'
        : `探索対象の差分がこの観点の対象を変えた（${trig.exploreSignals.filter((s) => signals[s]).join(' / ')}）`,
      escalated: false,
    };
  }
  // 「前回の所見が直ったか」を確認する `所見確認` モードは machine が提案しない。所見の有無は
  // machine state に無く（裁定の正本は docs/pr/PR-{番号}.md）、起動側が review budget の範囲で
  // 判断する。machine が提案するのは「この観点をまだ実行していない」「修正差分がこの観点の
  // アンカーを動かした」という**実行義務**由来の起動だけ
  return {
    run: false,
    mode: null,
    fresh: null,
    reason: '探索対象の差分がこの観点の対象を変えていない（実施済み）',
    escalated: false,
  };
}

/**
 * モードが指す patch 成果物が**判定に使った範囲を覆っている**ことを確かめ、覆っていなければ
 * 全体再探索（`base-to-current`）へ引き上げる。
 *
 * `差分探索` の成果物は `previous-to-current.patch`（直前 snapshot → 現在）で固定なので、
 * 次の2つで対象を取りこぼす:
 * - `hasPatch: false` — 前回 snapshot が無く、修正差分そのものが存在しない
 * - `cumulative: true` — 判定に使ったのが**系統ごとの baseline からの累積差分**で、直前 hop の
 *   修正差分に収まらない。起動の根拠になった変更がレビュアーへ渡らないまま `complete` が
 *   記録され、baseline だけが前進する（＝見送った hop のすり抜けが「対応済み」の顔で再現する。
 *   敵対的 F2・運用性 F1 が実測）
 */
export function upgradeWhenPatchNarrower(sel, { hasPatch = true, cumulative = false } = {}) {
  if (!sel.run || sel.mode === 'full-rescan') return sel;
  if (hasPatch && !cumulative) return sel;
  const why = hasPatch
    ? 'この観点の最終レビュー以降の累積差分は修正差分に収まらない'
    : '前回 snapshot が無く修正差分が存在しない';
  return {
    ...sel,
    mode: 'full-rescan',
    fresh: true,
    reason: `${sel.reason}（${why}ため全体再探索へ引き上げ）`,
  };
}

// ---------------------------------------------------------------------------
// review budget（自動探索の上限）
// ---------------------------------------------------------------------------

/**
 * この観点がこの attempt で消費した自動探索の回数。
 *
 * **`status` で例外を作らない。** `error`（起動失敗）を消費から外すと、起動が恒常的に失敗する
 * 環境で `selectMode` の error 分岐が無条件に再探索を要求し続け、**最も高価な組合せ
 * （opus × 全体再探索）で自動ループが止まらない**（敵対的 F5 が6 round 連続で実測）。
 * 起動が失敗したこと自体も「1回払った」であり、続けるかどうかは人間の判断に属する
 * （`incomplete` も同じ）。この規則は escalation の消化条件と共有する。
 */
function exploredCount(state, angle) {
  return state.runs.filter((r) => r.angle === angle).length;
}

/**
 * 予算をトリガー判定へ適用する。**新しい永続 state は持たない** — 消費は既存の
 * `state.runs` から、追加割当は既存の `state.escalations` から導出する。
 *
 * 規則は1つだけ: **1観点あたり自動の新規探索は1回**。それを超える探索は「人間が
 * `escalate` で明示的に割り当てた場合」だけ起こる（未消化の escalation は selectMode が
 * `escalated: true` で返し、ここを迂回する。消化されると `runs` に1件増えるので、
 * 1 escalation = 1 起動でちょうど釣り合う）。
 *
 * 予算終了は**収束でも失敗でもない**。`run: false` だが `budgetOutcome: 'exhausted'` を立て、
 * 「予算が無ければ何を要求していたか」を `withheld` に残す。これが無いと読み手は
 * 「トリガー非該当で起動不要」と「予算切れで未確認のまま」を区別できず、
 * incomplete を所見ゼロとして収束させないという不変条件が黙って外れる。
 *
 * 結果は `budgetOutcome` の2値で表す（真偽フラグを2つ持たない — 片方が他方を包含する2フラグは、
 * 分類が増えたときに組み合わせの意味が決まらなくなる）:
 * - `'satisfied'` — この snapshot を読み終えている。未確認範囲は無い
 * - `'exhausted'` — 予算が無ければ起動していた。`withheld` を**必ず**持つ（片方だけの経路は
 *   無いので、消費側は `withheld` の欠落に備えたフォールバックを書かないこと。到達しない分岐は
 *   テストで固定できず、「欠ける経路がある」という誤った不変条件を示唆する）
 */
export function applyBudget(sel, state, angle, { snapshotId = null } = {}) {
  if (!sel.run) return sel;
  // escalate は人間が明示的に割り当てた新しい予算そのもの。予算検査で打ち消さない
  if (sel.escalated) return sel;
  // **「1 snapshot = 1 周」は予算とは独立した不変条件**（README「観点別の再探索トリガー」）。
  // 予算検査の**後ろ**に置くと、`AUTO_EXPLORATION_BUDGET` を 2 へ上げた瞬間に同じ snapshot・
  // 同じ diff へ2回目の起動が提案される（仕様レビュー 所見5 が実測）。値に依存させない。
  //
  // 判定は「**直近の**起動が complete で、それがこの snapshot だったか」。
  // 「この snapshot に complete が1件でもあるか」にすると、その後の再探索（人間が
  // escalate で割り当てたもの）が incomplete で終わっても「実施済み」に見え、
  // 未確認範囲が人間判断の列挙から漏れる
  const last = latestRunOf(state, angle);
  if (snapshotId && last?.status === 'complete' && last.snapshotId === snapshotId) {
    return {
      ...sel,
      run: false,
      mode: null,
      fresh: null,
      budgetOutcome: 'satisfied',
      reason:
        'この snapshot で実施済み — 所見があれば修正して新しい snapshot を取る' +
        '（予算内の自動再探索は行わない）',
    };
  }
  const consumed = exploredCount(state, angle);
  if (consumed < AUTO_EXPLORATION_BUDGET) return sel;
  const outstanding =
    last?.status === 'incomplete'
      ? '直近の起動が incomplete（未確認範囲あり）'
      : last?.status === 'error'
        ? '直近の起動が error（この観点はまだ一度も完走していない）'
        : 'この観点の未レビュー差分が残っている';
  return {
    ...sel,
    run: false,
    mode: null,
    fresh: null,
    budgetOutcome: 'exhausted',
    withheld: { mode: sel.mode, fresh: sel.fresh, reason: sel.reason },
    reason:
      `予算終了（自動の新規探索 ${consumed}/${AUTO_EXPLORATION_BUDGET} 回を消費済み）— ${outstanding}。` +
      '続行 / follow-up / 現状受容 / 設計へ戻す を人間が判断し、理由を docs/pr/PR-{番号}.md へ残す' +
      '（続行するなら `node scripts/agent/review-plan.js escalate --angles ' +
      `${angle} --reason "..."\` で予算を割り当てる）`,
  };
}

// 1観点あたりの自動の新規探索の上限。**上書き経路は持たない**（環境変数・CLI フラグを足すと
// 「予算を守った」が実行ごとに変わり、予算という保証が消える）。値を変える判断の根拠・条件は
// docs/agent-workflows/review-angles/README.md「review budget（自動探索の上限）」が正本。
// 追加の探索は人間の escalate で個別に割り当てる。
export const AUTO_EXPLORATION_BUDGET = 1;

// ---------------------------------------------------------------------------
// 計画生成
// ---------------------------------------------------------------------------

// machine が計画・記録できるレビューモード。
//
// `findings-check`（所見確認）は**入っていない**。所見の有無は machine state に無いため
// `selectMode` はこのモードを提案せず、提案が無い以上 `record-run` も受理できない
// （recordRunCommand は「計画が要求した起動」しか通さない）。モードの語彙自体は
// review-exec-config.js に残る — `所見確認` 1回は起動側が review budget の枠に従って手動で
// 起動し、実施と結果は docs/pr/PR-{番号}.md が持つ（machine が表現できない確認を、
// machine へ無理に記録させない）。正本:
// docs/agent-workflows/review-angles/README.md「review budget（自動探索の上限）」。
export const MACHINE_RECORDABLE_MODES = new Set(['diff-explore', 'full-rescan']);

// 起動順の段階（「どの段階を今 round で起動するか」の状態機械）。
// 正本: review-angles/README.md「レビューループ手順」3・4・7・8
export const STAGE_LABELS = {
  subtractive: '減算（入口）',
  body: '本体',
  cleanup: '清掃（最終1周）',
  done: '計画上の起動義務は消化済み',
};

/**
 * レビュー実行計画を作る。
 *
 * **段階の状態機械**（正本: review-angles/README.md「レビューループ手順」3・4・7）:
 *   減算（入口。収束するまで繰り返す） → 本体（清掃を除く残りの系統＋記憶適合）
 *   → 清掃（最終1周） → 起動義務の消化完了
 *
 * 最終独立レビューはこの状態機械に含めない（起動単位が系統ではないため。冒頭の責務コメント）。
 *
 * plan は **その round で起動すべき段階の系統だけを run:true にする**。他段階の系統も
 * 観測性のため entries には載せるが `run:false`（保留）とする。
 *
 * **state を変更しない純粋関数**であり、同じ state・同じ snapshot からは常に同じ計画が出る。
 * `record-run` の「計画が要求した起動か」の照合はこの再計算に依存しているので、ここに
 * 「前回何を提案したか」の永続記録を持ち込まない（持ち込むと、提案の履歴を復元しないと
 * 計画が決まらなくなる＝起動義務台帳の再導入になる）。
 */
export function buildPlan({
  state,
  manifest,
  changedFiles,
  changedInFix,
  memoryHits = 0,
  resolveChangedSince = null,
}) {
  const initial = state.initialTier
    ? {
        tier: state.initialTier,
        angles: anglesForTierName(state.initialTier),
        reasons: state.initialTierReasons ?? ['初期 Tier（確定済み）'],
      }
    : computeInitialTier(changedFiles);
  const effectiveAngles = new Set([...initial.angles, ...state.addedAngles]);
  const effectiveTier = state.effectiveTier ?? tierNameForAngles([...effectiveAngles]);
  for (const a of anglesForTierName(effectiveTier)) effectiveAngles.add(a);

  const signals = deriveSignals(manifest, changedInFix);
  const fixDiffEmpty = changedInFix.length === 0;

  // **系統ごとの再探索基準（baseline）**。再探索トリガー表が見るべきなのは「直前 snapshot からの
  // 修正差分」ではなく「**その系統が最後に実際にレビューした snapshot からの累積差分**」。
  // 前者だと、ある snapshot の起動提案を実行せずに次へ進んだ場合、その hop の変更をその系統が
  // 一度も見ないまま「実施済み」で収束できる（外部レビュー Codex P1・内部の仕様/敵対的/運用性が
  // 独立に検出。merge-base では `checkPendingLaunches` の fail-closed が防いでいた）。
  //
  // 基準は `state.runs`（既存の起動記録）から導出する — 「前 round で何を提案したか」は保存しない。
  // 直したのは提案の持ち越しではなく**未レビュー差分の観測範囲**である。
  const lastCompleteSnapshot = (angle) =>
    latestRunOf(state, angle, (r) => r.status === 'complete')?.snapshotId ?? null;

  // 基準からの差分を解決する。解決できない場合は**直前 snapshot へ縮めず** unresolved を返し、
  // 呼び出し側が fail-closed（全体再探索）へ倒す
  const baselineFor = (angle) => {
    const baseline = lastCompleteSnapshot(angle);
    // 完了記録が無い / この snapshot で完了済み は selectMode の既存分岐が扱う
    if (baseline === null || baseline === manifest.snapshotId) {
      return { changed: changedInFix, snapshotId: baseline };
    }
    // 直前 snapshot が基準なら、共通の修正差分がちょうど求める差分
    if (baseline === manifest.previousSnapshotId) {
      return { changed: changedInFix, snapshotId: baseline };
    }
    if (!resolveChangedSince) {
      return {
        snapshotId: baseline,
        unresolved: `${baseline} からの累積差分を解決できない（差分の解決手段が無い）`,
      };
    }
    try {
      const since = resolveChangedSince(baseline, manifest.snapshotId);
      // **累積差分は直前 hop の修正差分を必ず含む**。この仕組みは観測範囲を広げるためのもので、
      // 狭める方向へ倒れてはならない。commit 差分から再計算した値で manifest を上書きすると、
      // `unreportedPaths`（skip-worktree / assume-unchanged / submodule 未具現化 / 非通常
      // untracked）由来の「変更なしと証明できない」fail-closed が false へ降格し、無効化した
      // ガードが全系統 run:false で通る（敵対的 F3・運用性 F2 が実測）。和を採る
      return {
        changed: [...since.files, ...changedInFix],
        cumulative: true,
        snapshotId: baseline,
        overrides: {
          guardChangeInFix: since.guardChange || Boolean(manifest.guardChangeInFix),
          semanticDocChangeInFix:
            since.semanticDocChange || Boolean(manifest.semanticDocChangeInFix),
        },
      };
    } catch (err) {
      return {
        snapshotId: baseline,
        unresolved: `${baseline} からの累積差分を解決できない（${err.message}）`,
      };
    }
  };
  // 前回 snapshot が無い（初回）と、修正差分（previous-to-current.patch）は空になる。
  // この状態で差分探索を割り当てるとレビュアーへ空の patch を渡すことになるため、
  // 全体再探索へ引き上げる（探索を落とさない方向＝fail-closed）
  const hasPrevious = Boolean(manifest.previousSnapshotId);

  // 記憶適合（条件起動）の扱いは「**適用対象か**」と「**今 round 起動すべきか**」を分ける:
  // - 適用対象か: 一度でもヒットしたらこの PR では記憶適合レビューの対象である、という sticky な
  //   状態（state.memoryRequired）。--memory-hits を渡し忘れた再計画で系統ごと消えるのを防ぐ
  //   （実効 Tier を PR 内で縮小しない不変条件と同じ理由）
  // - 今 round 起動すべきか: 他系統とまったく同じく selectMode / ANGLE_TRIGGERS.memory に委ねる。
  //   「一度ヒットしたら全 snapshot で必ず1周」は再探索トリガー表より強い新ルールを持ち込み、
  //   コスト制御と衝突するため採らない（初回は未実施なので起動、記憶レコード変更で全体再探索、
  //   設計文書・コード変更で差分探索、incomplete/error は通常ルールで再起動、
  //   関係する変更がない新 snapshot では再起動しない）
  // 清掃・最終独立レビューより前に片付けるべき通常のレビュー系統である点は他と同じなので、
  // 本体段階に属させる。
  // loadState が boolean を保証するため型強制はしない（`Boolean("false")` は true になる）
  const memoryRequired = memoryHits > 0 || state.memoryRequired === true;
  const bodyAngles = [...effectiveAngles].filter((a) => a !== 'subtractive' && a !== 'cleanup');
  const stageAngles = {
    subtractive: effectiveAngles.has('subtractive') ? ['subtractive'] : [],
    // 記憶適合が外部所見で addedAngles にも入っている場合 bodyAngles と重複しうる。
    // **段階配列そのもの**を重複排除する — entries は stageAngles を直接走査するため、
    // plannedAngles 側だけの重複排除では同一系統の run:true エントリが2件生成される。
    // 1件目を記録した時点で計画がその系統を実施済みへ倒すので、2件目は「計画が要求して
    // いない起動」として拒否され、計画どおりに起動・記録できない（外部レビュー Codex 指摘）
    body: [...new Set([...bodyAngles, ...(memoryRequired ? ['memory'] : [])])],
    cleanup: effectiveAngles.has('cleanup') ? ['cleanup'] : [],
  };
  const plannedAngles = [
    ...new Set([...stageAngles.subtractive, ...stageAngles.body, ...stageAngles.cleanup]),
  ];

  // 各系統の選択結果は1系統につき一度だけ計算し、段階判定と entries 構築で共有する
  // Tier が強化された round では、以前から必須集合にあった系統も**今回 Full 対象になった
  // 新しい材料（高リスクコード等）を一度も見ていない**。新しく集合へ加わる系統だけを起動
  // 対象にすると、既存系統はその観点の通常トリガーに該当しない限り run:false のままになる
  // （例: worker/ 追加で Light → Full へ再分類されたとき、operability は以前の文書レビュー
  // 実績があるため未実施扱いにならず、コード変更は operability の探索トリガーでもない）。
  // Tier 強化時点の seq を記録し、それより後の通常 run が無い系統には再評価を要求する
  const tierWidenedSeq = state.tierWidenedSeq ?? -1;
  const lastRunSeqOf = (angle) => latestRunOf(state, angle)?.seq ?? -1;

  const selections = new Map();
  const baselines = new Map();
  for (const angle of plannedAngles) {
    const base = baselineFor(angle);
    baselines.set(angle, base);
    // 出口復元（下記 humanAllocated && !sel.escalated）の対象は `manual-escalation`
    // （人間が明示的に割り当てた予算）だけにする。`tier-reclassification` は自動発火のため
    // 対象外＝人間の判断を経ずに既存系統ぶんの予算が一括リセットされるのを防ぐ（敵対的 F3 実測）。
    // この厳密一致が効くのは復元経路だけで、`selectMode` は kind を見ないため通常経路の迂回は
    // この判定の管轄外。
    const humanAllocated = pendingEscalation(state, angle)?.kind === 'manual-escalation';
    let sel;
    if (base.unresolved) {
      // 未レビューの累積差分があるのにその範囲を確かめられない。安全側（全体再探索）へ倒す
      sel = {
        run: true,
        mode: 'full-rescan',
        fresh: true,
        reason: `この観点の最終レビュー以降の差分を確認できない（${base.unresolved}）— 全体再探索`,
        escalated: false,
      };
    } else {
      const baseSignals = base.overrides
        ? deriveSignals({ ...manifest, ...base.overrides }, base.changed)
        : signals;
      sel = upgradeWhenPatchNarrower(
        selectMode(state, angle, baseSignals, { fixDiffEmpty: base.changed.length === 0 }),
        { hasPatch: hasPrevious, cumulative: Boolean(base.cumulative) },
      );
    }
    // Tier 強化後の再評価は最強の探索なので、通常の選択がこれより強くなることはない
    if (tierWidenedSeq >= 0 && lastRunSeqOf(angle) < tierWidenedSeq) {
      // この分岐自身は escalated を立てない（人間が割り当てた予算は出口で復元する）
      sel = {
        run: true,
        mode: 'full-rescan',
        fresh: true,
        reason: 'Tier 強化により対象が広がった（今回の対象を未確認のため全体再探索）',
        escalated: false,
      };
    }
    // 分岐の中で escalated を書き足す規約にすると、分岐が増えたときの書き忘れで同じ欠陥が
    // 再発する（この PR が直したのがまさにそれ）ため、**出口1箇所で復元する**。
    // ただし対象判定は `pendingEscalation` が返す先頭1件（同系統で未消化のうち最古）のみに
    // 依存する — 手前に tier 由来の未消化 escalation が積まれていれば humanAllocated は false になる。
    if (humanAllocated && !sel.escalated) {
      sel = {
        ...sel,
        escalated: true,
        reason: `${sel.reason}／起動側の判断によるエスカレーションを保持`,
      };
    }
    // **予算は全経路の出口で一度だけ適用する。** 上の分岐（累積差分の解決不能・トリガー・
    // Tier 強化）はどれも「起動してよいか」を独立に決めており、どれか1つにだけ予算を掛けると
    // 残りの経路から自動探索が漏れ出す（fail-closed 経路は毎 round 立ちうるので特に）
    selections.set(angle, applyBudget(sel, state, angle, { snapshotId: manifest.snapshotId }));
  }

  // 「この観点のレビュー義務が今 dirty か」。dirty な義務のうち最も早い段階のものだけを
  // 実行する（順序保証は currentStage の段階順スキャンが持つ）。
  //
  // dirty の条件は「計画がその系統に run:true を返したこと」**だけ**（トリガー該当 ＋ 予算あり）。
  // **予算終了・この snapshot で実施済みは dirty ではない** — 段階を止めると人間が来るまで
  // 入口で固まるため。ただし「段階が進む」は「全部見た」ではないので、予算終了は上の
  // blockers 表が converged 側で捕まえる（両者を同じ条件で表さない）。
  // 「未解消の所見が残っている」は所見の意味を machine が持たなくなったため条件から外れた
  // （裁定は docs/pr/PR-{番号}.md 側。所見に対応するための再起動が必要なら起動側が
  // `escalate` で要求する）。**必須なのに未達**（一度も完了していない・直近が error /
  // incomplete）は selectMode が run:true を返すのでこの条件に含まれる。同じ条件をここへ
  // 二重に書くと、片方だけ更新したときに判定が食い違う（PR1 で、重複した条件が実際に片方だけ
  // 効かなくなる事故を出している）。
  // dirty にだけ条件を足すと「dirty だが起動提案なし」＝解除経路の無い恒久停止を作る
  const dirty = (angle) => selections.get(angle).run;

  const STAGE_ORDER = ['subtractive', 'body', 'cleanup'];
  // 現在の段階 ＝「まだ片付いていない」最初の段階。段階の評価は毎 round 入口から行う
  // （「清掃の所見を直した round は清掃のみ」の段階スキップは持たない — 修正差分が清掃所見への
  // 対応だけであることは成果物から検証できないため。正本 review-angles/README.md 手順7）。
  // 各系統を実際に起動するかは selections（再探索トリガー表）が決める
  const currentStage = (() => {
    for (const st of STAGE_ORDER) {
      if (stageAngles[st].some((a) => dirty(a))) return st;
    }
    return 'done';
  })();

  const entries = [];
  for (const stage of ['subtractive', 'body', 'cleanup']) {
    for (const angle of stageAngles[stage]) {
      const sel = selections.get(angle);
      // 自段階でない系統は起動しない。**順序は計画そのもので表現し、台帳側で補正しない**
      const gated = stage !== currentStage;
      const isDirty = dirty(angle);
      const run = sel.run && !gated;
      const base = baselines.get(angle);
      entries.push({
        angle,
        stage: angle === 'memory' ? `${STAGE_LABELS.body}（条件起動）` : STAGE_LABELS[stage],
        // どの範囲を見て起動を決めたか。これが成果物に出ないと、読み手は「なぜこの系統が
        // 起動されるのか」を復元できず、`シグナル:`（直前 hop）と理由（累積）の食い違いを
        // 計画のバグと誤読する（運用性 F4）。
        // **解決不能（fail-closed）を null にしない** — null は「直前 hop で判定した」の意味で、
        // 同じ値にすると最も安全側に倒すべき系統が読み手の列挙から漏れる（仕様レビュー所見1）
        baseline: baselineRange(base),
        ...sel,
        run,
        mode: run ? sel.mode : null,
        fresh: run ? sel.fresh : null,
        dirty: isDirty,
        // dirty でない義務は「今の段階ではないから待っている」のではなく**果たされている**。
        // 両者を同じ「保留」で表すと、無関係な系統まで毎 round やり直す運用に見える。
        // **予算終了は「満たされている」に含めない** — トリガーは立っており、見送ったのは
        // 予算の判断であって「対象が変わっていない」ではない。同じ文言に畳むと、未確認の
        // 累積差分を抱えた系統が「実施済み」の顔で収束記録に載る
        reason: sel.budgetOutcome
          ? sel.reason
          : !isDirty
            ? 'この観点の義務は満たされている（再探索トリガー該当なし・実施済み）'
            : gated
              ? `保留（dirty だが現在の段階は ${STAGE_LABELS[currentStage]}）— 起動順は ${STAGE_LABELS.subtractive} → ${STAGE_LABELS.body} → ${STAGE_LABELS.cleanup}`
              : sel.reason,
        patch: run ? REVIEW_MODES[sel.mode].patch : null,
        exec: run ? resolveExecConfig(angle, sel.mode, { escalated: sel.escalated }) : null,
      });
    }
  }

  // 収束をブロックする条件と、それを解除する行動を**同じ表**で定義する。
  //
  // 「収束していないのに次にできることが1つも無い」は恒久停止であって計画ではない。
  // ブロック条件と行動を別々に手書き列挙すると、条件だけ増えて行動が欠ける。
  // **収束のブロックはこの表以外の場所に書かない**。行動を足すときは、それが実際に
  // 打てる手であることを確認する（打てない手を並べても停止は停止のまま）
  const exhausted = entries.filter((e) => e.budgetOutcome === 'exhausted');
  const blockers = [
    {
      // **予算終了は収束させない。** 段階機械は進める（そこを止めると人間が来るまで入口で
      // 固まる）が、`converged` まで true にすると「未確認範囲を残したまま収束」が
      // **各系統1回起動した後の既定**になり、PR 本文の閉じた収束文法（`0` ＋ `収束`）で
      // そのまま通せる（敵対的 F1 が実測）。「段階が進んだか」と「全部見たか」は別の問い
      blocked: exhausted.length > 0,
      actions: [
        `予算終了した系統（${exhausted
          .map((e) => ANGLE_TOKENS[e.angle]?.label ?? e.angle)
          .join(' / ')}）について、続行 / follow-up / 現状受容 / 設計へ戻す を人間が判断する` +
          '（続行するなら `node scripts/agent/review-plan.js escalate --angles <系統> --reason "..."`。' +
          '現状受容なら判断と理由を docs/pr/PR-{番号}.md に残し、PR 本文のループ記録は' +
          '「残所見: {系統}の未確認範囲（予算終了）」で閉じる）',
      ],
    },
    {
      blocked: currentStage !== 'done',
      actions: [
        ...(entries.some((e) => e.run)
          ? [
              '提案された起動を実行し、record-run で記録する' +
                '（snapshot が現在の作業ツリーと一致せず record-run が拒否される場合は、' +
                '`npm run review:snapshot` で snapshot を取り直して計画からやり直す）',
            ]
          : []),
      ],
    },
  ];
  const nextActions = [...new Set(blockers.filter((b) => b.blocked).flatMap((b) => b.actions))];

  return {
    version: 1,
    snapshotId: manifest.snapshotId,
    initialTier: initial.tier,
    initialTierReasons: initial.reasons,
    effectiveTier,
    effectiveAngles: [...effectiveAngles],
    addedAngles: state.addedAngles,
    escalations: state.escalations,
    signals,
    fixDiffEmpty,
    stage: currentStage,
    entries,
    nextActions,
    // 収束＝ブロック表のどの条件も立っていない状態。条件の内訳は blockers の定義を参照
    // （段階通過）。ここで条件を再掲すると、表と収束判定が別々に育って片方だけ効かなくなる。
    // **これは「所見が無いことの証明」でも「レビュー完了」でもない**。machine が言えるのは
    // 「計画した起動をすべて記録した」までで、所見の裁定と最終独立レビューの実施は
    // docs/pr/PR-{番号}.md と review budget の手順が持つ
    converged: blockers.every((b) => !b.blocked),
  };
}

// ---------------------------------------------------------------------------
// 実効 Tier の拡大（起動側の判断）
// ---------------------------------------------------------------------------

// プロパティアクセス（ANGLE_TRIGGERS[angle]）は __proto__/constructor/toString 等の
// プロトタイプ鎖キーを「有効な観点」として誤受理する。own-property のみを見る
function assertKnownAngle(angle) {
  if (!Object.hasOwn(ANGLE_TRIGGERS, angle)) throw new Error(`未知の観点です: ${angle}`);
}

// seq は「起動・エスカレーションの発生順」を表す単調増加値。エスカレーションの消化判定
// （pendingEscalation）と Tier 強化後の再評価が seq の大小比較に依存する。
// 配列長から導出すると、破損復旧などで要素を削除した際に採番が巻き戻り既存 seq と重複する
// ため、既存の最大値から採る
function nextSeq(state) {
  let max = 0;
  // seq を振るすべての記録を走査する。一部だけを見ると **異なるレコードに同じ seq** が付き、
  // seq を参照する関係が別のレコードを指す。seq を振る値を足すときはここにも足す。
  // 受理条件は `isValidSeq` に揃える — ここだけ緩いと「採番は無視するが baseline は採用する」
  // 記録が作れる（受理集合を割らない）
  for (const r of [...state.runs, ...state.escalations]) {
    if (isValidSeq(r?.seq) && r.seq > max) max = r.seq;
  }
  // `tierWidenedSeq` も nextSeq() から採番されるので走査対象に含める。外すと
  // `reclassifyTier` が採った seq と直後の escalation の seq が**必ず衝突する**（敵対的 F7）
  if (isValidSeq(state.tierWidenedSeq) && state.tierWidenedSeq > max) {
    max = state.tierWidenedSeq;
  }
  return max + 1;
}

/**
 * 実効 Tier を「縮小させず常に超集合を採る」形で広げる共通コア。
 * escalateAngles（起動側の判断）と reclassifyTier（Tier の毎回再検証）の両方から呼ばれる。
 * `kind` は state.escalations の由来区別（'manual-escalation' / 'tier-reclassification'）。
 * `reasons` は **machine が変更ファイルから導出した**加算理由（reclassifyTier のみが渡す）。
 * 人間・レビュアー由来のテキストはここへ入れない（escalateAngles は渡さない — 所見の内容を
 * state へ持ち込まないため）。
 */
function widenEffectiveTier(state, { targets, reasons = [], kind, preferBase = null }) {
  const initialAngles = new Set(anglesForTierName(state.initialTier));
  const added = targets.filter((a) => !initialAngles.has(a) && !state.addedAngles.includes(a));
  for (const a of added) state.addedAngles.push(a);

  // 実効 Tier の再計算（縮小させない = 常に超集合を採る）。
  // **条件起動系統（記憶適合）は宣言 Tier 名の計算から外す** — Tier 表に属さないため
  // tierNameForAngles がどの宣言名でも被覆できず、フォールバックの最強 Tier
  // （Full＋設計文書）へ倒れる。記憶適合だけを再確認したい Light の PR が全7系統と重い予算を
  // 要求されることになるので、条件起動系統は addedAngles と再起動義務にのみ反映する
  // （外部レビュー Codex 指摘）
  const prevTier = state.effectiveTier ?? state.initialTier;
  const current = new Set([...anglesForTierName(prevTier), ...state.addedAngles]);
  for (const a of targets) current.add(a);
  for (const a of Object.keys(CONDITIONAL_ANGLE_TOKENS)) current.delete(a);
  // 基礎 Tier のヒントを渡す: Light＋設計文書 と Full は必須系統が同一のため、
  // ヒント無しでは Full の PR が Light＋設計文書 へ落ちて基礎 Tier が縮小する。
  // 呼び出し側が最新の基礎 Tier（例: reclassifyTier が computeInitialTier で再計算した
  // 基礎 Tier）を preferBase で渡した場合はそちらを優先する（外部レビュー Codex 指摘: 常に
  // prevTier の基礎 Tier を使うと、高リスクファイル追加で Full 相当になった変更集合でも
  // 系統集合が Light＋設計文書 と一致してしまい Full ではなく Light＋設計文書 が選ばれる）。
  // 誤って弱い方を渡しても、下の縮小禁止チェックが shrinksBase を検出して prevTier へ戻すため
  // 安全側に倒れる
  let nextTier = tierNameForAngles([...current], {
    preferBase: preferBase ?? baseTierOf(prevTier),
  });
  // 「＋設計文書」の加算表記を維持する。Full と Full＋設計文書 は必須系統が同一のため
  // 系統集合の包含だけでは落ちるが、宣言名としては別物 — 実行可能設計文書に触れる PR で
  // 加算表記を落とすと check-artifacts が「Tier 宣言は {基礎}＋設計文書 としてください」で落ちる
  if (hasDesignAddon(prevTier) && baseTierOf(nextTier) && !hasDesignAddon(nextTier)) {
    nextTier = `${baseTierOf(nextTier)}＋設計文書`;
  }
  // 縮小禁止: 現在の実効 Tier の必須系統を包含しない宣言名、および
  // 基礎 Tier を弱める宣言名（Full → Light）は採らない
  const prevRequired = new Set(anglesForTierName(prevTier));
  const nextRequired = new Set(anglesForTierName(nextTier));
  const shrinksAngles = ![...prevRequired].every((a) => nextRequired.has(a));
  const shrinksBase = baseTierOf(prevTier) === 'Full' && baseTierOf(nextTier) === 'Light';
  const shrinksAddon = hasDesignAddon(prevTier) && !hasDesignAddon(nextTier);
  if (shrinksAngles || shrinksBase || shrinksAddon) nextTier = prevTier;
  state.effectiveTier = nextTier;

  // エスカレーション（起動側の判断・Tier 再検証）は探索をやり直す指示。加算された系統は
  // 減算から順に回し直す（段階は毎 round 入口から評価されるため追加の状態操作は要らない）。
  // reason は machine が導出した文字列だけを持つ（`kind: 'manual-escalation'` では空 —
  // 判断の理由は docs/pr/PR-{番号}.md 側）
  state.escalations.push({
    seq: nextSeq(state),
    kind,
    angles: targets,
    reason: reasons.join('／') || null,
    effectiveTier: nextTier,
  });
  return nextTier;
}

/**
 * 起動側の判断で観点を実効 Tier へ加算し、その系統を fresh・全体再探索でやり直させる
 * （execution 側の escape hatch）。
 *
 * 典型的な用途は、外部レビュー（GitHub / 別モデル）が初期 Tier 対象外の観点で欠陥を挙げた
 * ケース。**なぜ加算するのかを machine は判定も保持もしない** — 所見の実在・因果・重大度の
 * 判断は人間・orchestrator が行い、その裁定（判断・理由・対応・証拠）は
 * `docs/pr/PR-{番号}.md` にのみ残す。
 *
 * `reason` は**呼び出し側に理由の言語化を要求するためだけ**に必須で、state には保存しない。
 * 自由記述で保存すると所見の内容が machine state へ戻り、裁定の記録先が2つに割れる
 * （`docs/pr/PR-{番号}.md` と、push されない作業キャッシュ）。state に残すのは
 * 「どの系統を、いつ、どの由来でやり直すことにしたか」だけ。
 *
 * 実効 Tier は PR 内で縮小させない（加算された観点は確認済みでも履歴として保持する）。
 */
export function escalateAngles(state, { angles, reason }) {
  const targets = [...new Set(angles ?? [])];
  if (targets.length === 0) throw new Error('escalate には --angles が必須です');
  for (const a of targets) assertKnownAngle(a);
  if (!reason) {
    throw new Error(
      'escalate には理由（--reason）が必須です' +
        '（理由の本文は state に保存しません。docs/pr/PR-{番号}.md の裁定として残してください）',
    );
  }
  widenEffectiveTier(state, { targets, kind: 'manual-escalation' });
  return state;
}

/**
 * Tier の毎回再検証（widen-only）。`review:plan` を呼ぶたびに変更ファイル一覧から
 * 必須系統を再計算し、キャッシュされた実効 Tier の必須系統集合の**部分集合でない**場合
 * （＝拡大が必要な場合）にのみ、escalateAngles と同じ縮小禁止ロジックで実効 Tier を広げる。
 * `state.initialTier` 自体は書き換えない（初期 Tier の意味を保つ）。
 *
 * #559: 修正差分によって Tier 判定に影響するファイルが増えても、`state.initialTier` は
 * 一度確定すると再検証されず、古い Tier のまま計画が作られ続けていた
 * （誤って「設計文書」Tier に固定され、Light Tier 必須の3系統が長時間起動されなかった）。
 */
export function reclassifyTier(state, changedFiles) {
  if (!state.initialTier) return null; // 初期 Tier 未確定は呼び出し側（plan）が先に確定させる
  const recomputed = computeInitialTier(changedFiles);
  const prevTier = state.effectiveTier ?? state.initialTier;
  const currentRequired = new Set([...anglesForTierName(prevTier), ...state.addedAngles]);
  const missing = recomputed.angles.filter((a) => !currentRequired.has(a));
  // 必須系統集合が変わらなくても、基礎 Tier・設計文書 addon が強化されていれば widen する
  // （外部レビュー Codex 指摘）: Light＋設計文書 と Full は必須系統が同一（7系統）のため、
  // 高リスクファイル追加で Full 相当になっても missing=[] で早期 return してしまうと、実効
  // 実効 Tier が Light のまま残る。同様に Full（既に7系統）へ設計文書が加わっても
  // Full＋設計文書 へ更新されない（宣言名としては別物 — check-artifacts の宣言要件が異なる）
  const strongerBase = recomputed.base === 'Full' && baseTierOf(prevTier) !== 'Full';
  const strongerAddon = recomputed.addon && !hasDesignAddon(prevTier);
  if (missing.length === 0 && !strongerBase && !strongerAddon) return null;
  // 既存系統にも今回広がった対象の再評価を要求する（buildPlan の tierWidenedSeq 参照）
  state.tierWidenedSeq = nextSeq(state);
  const reasons = [];
  if (missing.length > 0) {
    reasons.push(
      `変更ファイルの再分類により必須系統が拡大（再計算 Tier: ${recomputed.tier} / 追加: ${missing.join(' / ')}）`,
    );
  }
  if (strongerBase) reasons.push(`高リスク領域・大規模diffにより基礎Tierが強化（→ Full）`);
  if (strongerAddon) reasons.push('実行可能設計文書に触れる変更が追加された（＋設計文書）');
  // 再計算した基礎 Tier（例: 高リスクファイル追加による Full）を優先する。渡さないと
  // widenEffectiveTier は常に「変更前の」基礎 Tier をヒントに使うため、Light から Full 相当へ
  // 拡大したケースで Full と Light＋設計文書（必須系統が同一）のタイブレークが Light 側へ
  // 倒れ、design doc が無いのに「Light＋設計文書」という誤った実効 Tier になる。
  // ただし recomputed.base は「今回の diff のファイル特性だけ」から出た値であり、`escalate`
  // （起動側の判断による加算）で既に Full 相当へ広がっている実効 Tier より弱い場合がある。
  // recomputed.base をそのまま preferBase にすると、widenEffectiveTier 内の
  // 縮小禁止チェック（shrinksBase）が nextTier を prevTier（Full）へ差し戻す際、今回検出した
  // addon ごと失われる（Full＋設計文書 ではなく Full になってしまう）。prevTier の基礎 Tier と
  // recomputed.base の**より強い方**を採用し、addon は今回検出分と prevTier 既存分の両方を
  // 合成する（外部レビュー Codex 指摘・8ラウンド目）
  const strongestBase =
    baseTierOf(prevTier) === 'Full' || recomputed.base === 'Full'
      ? 'Full'
      : (recomputed.base ?? baseTierOf(prevTier));
  const mergedAddon = recomputed.addon || hasDesignAddon(prevTier);
  // recomputed.addon が true の場合は加算表記込みの宣言名を渡す — tierNameForAngles の
  // タイブレークは `preferBase` との完全一致／`{preferBase}＋` 前方一致のどちらでもヒットする
  // ため、preferBase を素の 'Full' のまま渡すと（TIER_NAME_LADDER の並び順で 'Full' が
  // 'Full＋設計文書' より先に現れるため）'Full' が先に一致してしまい、真に必要な
  // 'Full＋設計文書' が選ばれない
  const preferBase = mergedAddon ? `${strongestBase}＋設計文書` : strongestBase;
  const nextTier = widenEffectiveTier(state, {
    targets: missing,
    reasons,
    kind: 'tier-reclassification',
    preferBase,
  });
  return { recomputedTier: recomputed.tier, added: missing, effectiveTier: nextTier };
}

/** 起動記録の正規化と検証（seq の採番を除く）。記録の追加前照合でも使う。 */
function normalizeRun(run) {
  const rec = {
    snapshotId: run.snapshotId ?? null,
    angle: run.angle,
    mode: run.mode,
    fresh: Boolean(run.fresh),
    status: run.status ?? 'complete', // complete | incomplete | error
    agentId: run.agentId ?? null,
  };
  assertKnownAngle(rec.angle);
  // own-property のみを見る（`assertKnownAngle` と同じ規律。素のアクセスは __proto__ /
  // constructor 等のプロトタイプ鎖キーを「既知のモード」として素通りさせる）
  if (!Object.hasOwn(REVIEW_MODES, rec.mode)) {
    throw new Error(`未知のレビューモードです: ${rec.mode}`);
  }
  if (!MACHINE_RECORDABLE_MODES.has(rec.mode)) {
    throw new Error(
      `${REVIEW_MODES[rec.mode].label}（${rec.mode}）は machine の起動記録の対象外です。\n` +
        '前回所見が直ったかだけを確認する周回は、machine が所見の有無を持たないため計画にも' +
        '台帳にも載りません（起動側が docs/agent-workflows/review-angles/README.md の' +
        '「review budget（自動探索の上限）」に従って' +
        '手動で起動します）。実施と結果は docs/pr/PR-{番号}.md へ、計数が要るなら ' +
        '`node scripts/agent/review-metrics.js record` へ記録してください',
    );
  }
  if (!['complete', 'incomplete', 'error'].includes(rec.status)) {
    throw new Error(`未知の status です: ${rec.status}（complete / incomplete / error）`);
  }
  return rec;
}

export function recordRun(state, run) {
  const rec = { seq: nextSeq(state), ...normalizeRun(run) };
  state.runs.push(rec);
  return rec;
}

// ---------------------------------------------------------------------------
// 起動記録（record-run）
// ---------------------------------------------------------------------------

// 起動の同一性（何を起動したか）。status は**結果**なので identity に含めない — 含めると
// 同じ起動の異なる結果が別物になり、矛盾した二重記録を検出できない
function launchIdentity(r) {
  return `${r.angle}\0${r.snapshotId}\0${r.mode}\0${Boolean(r.fresh)}`;
}

/**
 * `record-run` が読む snapshot を解決する。鮮度検証と計画の再計算の**両方**がこの読み出しに
 * 依存する。台帳に無い・成果物が読めない場合は**受理しない**（証明できないものを通すと、
 * 古い snapshot ID を指定するだけで検証を迂回できる）。詰まったときの逃げ道は「検査を飛ばす」
 * ことではなく、snapshot を取り直して計画からやり直すこと。
 */
function loadRecordRunSnapshot(cwd, snapshotId) {
  if (!snapshotId) {
    throw new Error(
      'snapshot がありません。先に `npm run review:snapshot` を実行してください' +
        '（record-run は snapshot に対する鮮度と計画を検証します）',
    );
  }
  // **latest だけを見ない**。`--snapshot-id <古い ID>` を指定すれば検査を迂回できてしまう。
  // 指定された snapshot 自体を読み、証明できなければ受理しない（「検査できないので通す」禁止）
  try {
    return snapshotById(cwd, snapshotId);
  } catch (err) {
    throw new Error(
      `${err.message}\n\n` +
        'この snapshot に対する結果は受理できません。' +
        '`npm run review:snapshot` で snapshot を取り直し、`npm run review:plan` から' +
        'やり直してください',
      { cause: err },
    );
  }
}

/**
 * この snapshot に対して**計画が今まさに要求している起動**を再計算する。
 *
 * 過去に発行した起動義務を永続台帳から復元するのではなく、現在の state（実効 Tier・起動記録）と
 * 現在の snapshot（manifest・変更ファイル・修正差分）から `buildPlan` をやり直して求める。
 *
 * **`plan` と完全に同じではない**: `plan` は `reclassifyTier`（Tier の毎回再検証・widen）を経てから
 * `buildPlan` を呼ぶが、ここは `buildPlan` だけを呼ぶ（記録が state を書き換えないため）。Tier が
 * 広がるべき snapshot では両者の計画が食い違うので、**手順どおり先に `npm run review:plan` を
 * 実行すること**（README「レビューループ手順」2）。plan を経ていれば widen 後の state が
 * 永続化されており、ここでの再計算も同じ計画になる。
 */
export function plannedLaunches(state, snap, { resolveChangedSince = null } = {}) {
  const plan = buildPlan({
    state,
    manifest: snap.manifest,
    changedFiles: snap.changedFiles.files,
    changedInFix: snap.changedFiles.changedInFix,
    resolveChangedSince,
  });
  return plan.entries
    .filter((e) => e.run)
    .map((e) => ({ angle: e.angle, mode: e.mode, fresh: Boolean(e.fresh) }));
}

/**
 * `record-run` サブコマンドの本体（引数のパースを除く）。**計画が要求した起動と一致すること**を
 * 確認したうえで記録を追加する。
 *
 * 一致する要求が無い記録を受理してはならない（外部レビュー Codex 指摘）: 段階機械は
 * 「この snapshot でその観点が完了しているか」を `state.runs` から判定するため、計画が要求して
 * いない起動を先回りで記録できると、段階順そのものを CLI から迂回できる（例: 減算段階のうちに
 * 本体系統を記録しておくと、減算完了後に本体段階が丸ごと「実施済み」として飛ばされる）。
 * 記録は常に「計画 → 起動 → 記録」の順でのみ成立する。
 *
 * 照合相手は**保存された起動義務ではなく、その場で再計算した計画**（`plannedLaunches`）。
 * 計画を毎回引き直すので、提案と異なる mode / fresh の記録は「計画が要求していない起動」として
 * その場で落ちる。台帳側に「未消化の要求」を持ち越して次 round で辻褄を合わせる必要がない。
 *
 * `resolveSnapshot` は必須（省略は受理しない — 照合できないまま通すと記録側から段階順を
 * 迂回できる）。**遅延解決**なのは、snapshot が読めなくなった後でも記録済みの起動の再実行が
 * no-op として成立する必要があるため（下記）。
 *
 * `resolveFreshness` は**任意**で、鮮度と計画が同じ snapshot を指すことは呼び出し側の責任。
 */
export function recordRunCommand(
  state,
  runArgs,
  { resolveSnapshot = null, resolveFreshness = null, resolveChangedSince = null } = {},
) {
  const rec = normalizeRun(runArgs);
  if (!resolveSnapshot) {
    throw new Error(
      'record-run には snapshot が必要です（計画との照合と鮮度検証ができません）。' +
        '先に `npm run review:snapshot` を実行してください',
    );
  }
  // 冪等性と conflict は別物。完全に同一の記録は no-op（再実行・リトライで壊れない）だが、
  // 同じ起動に**異なる結果**が来たら黙って後勝ちにしない（complete と error のどちらが
  // 真実かは機械には決められない。取り違えると未実施の系統が実施済みになる）
  const already = state.runs.findLast((r) => launchIdentity(r) === launchIdentity(rec));

  // snapshot が読めない（整理済み・成果物が消えた）場合は**常に fail-loud**。同一 identity・
  // 同一 status でも「重複」と断定してはいけない — `escalate` / Tier 強化が同じ起動を再要求して
  // いる最中なら、それは新しい invocation の結果であり、no-op で旧 `seq` を返すと記録成功を
  // 表示したままエスカレーションが未消化で残る（外部レビュー Codex 指摘 P2・敵対的レビュー F4）。
  // 計画を再計算できない以上どちらかを判定できないので、snapshot の取り直しを要求する
  const snapshot = resolveSnapshot();
  if (snapshot.snapshotId !== rec.snapshotId) {
    throw new Error(
      `record-run の --snapshot-id（${rec.snapshotId}）と読み込んだ snapshot` +
        `（${snapshot.snapshotId}）が一致しません`,
    );
  }

  const planned = plannedLaunches(state, snapshot, { resolveChangedSince });
  // **計画がこの観点の起動をいま要求しているか。** 要求しているなら、この記録は
  // **新しい invocation の結果**である。要求していないなら、過去の invocation についての
  // 再記録（重複）か矛盾した二重報告のいずれかでしかない。
  //
  // 下の2つの判定（冪等 no-op / conflict）はどちらも**後者にだけ意味を持つ**ので、同じ条件で
  // 括る。片方だけに条件を付けると、同じ「新しい invocation」が一方では通り他方では拒否される
  // （外部レビュー Codex 指摘 P1・P2 はどちらもこの非対称から出た）。
  //
  // `escalate` や Tier 強化は、直前の記録と**同じ identity**（同じ観点・snapshot・全体再探索・
  // fresh）を改めて要求しうる。ここで冪等 no-op や conflict で弾くと、新しい `seq` が付かず
  // `pendingEscalation` / `tierWidenedSeq` の「要求の発生より後の run があるか」という条件を
  // 永久に満たせないため、計画が同じ起動を要求し続けて収束しない。
  //
  // 要求はあるが**別の形**の起動だった場合も no-op・conflict にはせず、下の「計画が要求して
  // いない起動」で候補一覧つきに落とす（取り違えたまま「記録できたつもり」にさせない）
  const requestsAngle = planned.some((e) => e.angle === rec.angle);
  if (already && already.status === rec.status && !requestsAngle) return already;

  // ここから先は新規記録・再要求された起動・retry・conflict 候補のいずれか。記録の中身だけでは
  // 「今の作業ツリーに対する結果か」を答えられない
  if (resolveFreshness) {
    const freshness = resolveFreshness();
    if (freshness && freshness.fresh === false) {
      throw new Error(
        `snapshot=${rec.snapshotId} は現在の作業ツリーと一致しません（${freshness.stale.join(' / ')}）。\n` +
          'この結果は既に変わった内容に対するレビューなので受理できません。\n\n' +
          '**所見は捨てないでください** — 記録できないのは起動記録であって所見ではありません。\n' +
          '所見は docs/pr/PR-{番号}.md へ裁定してから、次のいずれかで進めます:\n' +
          '  - この起動の記録は諦め、新しい snapshot を取って計画からやり直す（通常はこれ）:\n' +
          '      npm run review:snapshot → npm run review:plan\n' +
          '  - 変更を巻き戻して snapshot 時点の状態に戻してから記録する（修正を失うので通常は選ばない）',
      );
    }
  }
  // 完了したと記録済みの**同じ invocation**を、別の結果で覆さない（complete と error のどちらが
  // 真実かは機械には決められない。取り違えると未実施の系統が実施済みになる）。
  // 計画が改めて起動を要求している場合は別 invocation なので対象外（上の `requestsAngle` 参照。
  // ここを除外しないと、再要求された起動が error / incomplete で終わったとき実際の失敗を記録
  // できず、state に古い成功だけが残る — 外部レビュー Codex 指摘 P2）
  if (!requestsAngle && already && already.status === 'complete' && already.status !== rec.status) {
    throw new Error(
      `同じ起動に異なる結果が記録されています: angle=${rec.angle} snapshot=${rec.snapshotId} ` +
        `mode=${rec.mode} fresh=${Boolean(rec.fresh)}\n` +
        `  記録済み: status=${already.status}（seq=${already.seq}）\n` +
        `  今回: status=${rec.status}\n\n` +
        'どちらが実際の結果かを確認してください。結果が変わったのであれば、' +
        '新しい snapshot を取り直して計画からやり直します（同じ起動の結果を上書きはしません）',
    );
  }
  // `error` / `incomplete` からの retry もここを必ず通す。先に受理してしまうと、過去に error を
  // 記録した起動と同じ identity を持つ記録で段階機械を迂回できる
  const matched = planned.some(
    (e) => e.angle === rec.angle && e.mode === rec.mode && e.fresh === Boolean(rec.fresh),
  );
  if (!matched) {
    const listed =
      planned.length > 0
        ? planned
            .map((e) => `  - angle=${e.angle} mode=${e.mode} ${e.fresh ? '--fresh' : '--continue'}`)
            .join('\n')
        : '  （この snapshot に対する起動要求はありません）';
    throw new Error(
      `計画が要求していない起動を記録しようとしています: angle=${rec.angle} ` +
        `snapshot=${rec.snapshotId} mode=${rec.mode} fresh=${Boolean(rec.fresh)}\n` +
        `この snapshot で記録できる起動:\n${listed}\n\n` +
        '先に npm run review:plan を実行し、計画が要求した内容どおりに起動・記録してください' +
        '（段階順〔減算 → 本体 → 清掃〕は計画が決めます）',
    );
  }
  return recordRun(state, runArgs);
}

/**
 * `plan` サブコマンドの状態遷移ロジック本体（ファイル I/O を除く）。
 * 初期 / 再検証 Tier → buildPlan → state 更新（effectiveTier の反映）までを行う。
 * `state` を変更し `plan` を返す。ファイル書き込み（review-plan.json）と saveState は CLI
 * ハンドラ側に残す。
 * `snap` は `{ snapshotId, manifest, changedFiles: { files, changedInFix } }` 相当
 * （`latestSnapshot()` の戻り値。テストでは同じ形の値を渡す）。
 *
 * **前 snapshot の起動提案が記録されていないことを理由に停止しない。** 起動しなかった系統は
 * 「未消化の義務」としてではなく、この snapshot の state（起動記録の不在・直近 run の status）
 * から `selectMode` が再び run:true として拾う。過去に何を提案したかを保持しないので、
 * 中断・cache 削除の後も現在の repo state から同じ計画が出る。
 */
export function planCommand(state, snap, { memoryHits = 0, resolveChangedSince = null } = {}) {
  if (!state.initialTier) {
    const initial = computeInitialTier(snap.changedFiles.files);
    state.initialTier = initial.tier;
    state.initialTierReasons = initial.reasons;
    state.effectiveTier = state.effectiveTier ?? initial.tier;
  } else {
    // Tier の毎回再検証（widen-only）。#559: 修正差分によって Tier 判定に影響するファイルが
    // 増えても、キャッシュされた state.initialTier のまま計画が作られ続けるのを防ぐ
    reclassifyTier(state, snap.changedFiles.files);
  }
  // 記憶適合レビューは、一度ヒットで要求されたらその PR の必須系統として state に固定する
  // （実効 Tier を PR 内で縮小しない不変条件と同じ扱い）。--memory-hits は「今 round のヒット
  // 件数」であって義務の有無ではないため、これを渡し忘れた再計画で義務が消えてはならない。
  // 義務の解消は「記憶適合が最終段階まで収束すること」であって、ヒット件数の消失ではない
  const requestedMemoryHits = Number.isInteger(memoryHits) ? memoryHits : 0;
  if (requestedMemoryHits > 0) state.memoryRequired = true;
  const plan = buildPlan({
    state,
    manifest: snap.manifest,
    changedFiles: snap.changedFiles.files,
    changedInFix: snap.changedFiles.changedInFix,
    memoryHits: requestedMemoryHits,
    resolveChangedSince,
  });
  state.effectiveTier = plan.effectiveTier;
  return plan;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * `--memory-hits` の値を非負整数として解釈する。未指定は 0（条件起動なし）。
 * 指定されたのに整数として読めない場合は fail-loud する（`Number.parseInt` は
 * `--memory-hits --fresh` を `NaN`、`0x10` を `0`、全角数字を `NaN` にするため、
 * 黙って「ヒット0」へ潰すと必須の記憶適合レビューがタイポひとつで消える）。
 */
export function parseMemoryHits(raw) {
  if (raw === undefined) return 0;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new Error(
      `--memory-hits には非負整数を渡してください（受け取った値: ${JSON.stringify(raw)}）。` +
        '記憶検索のヒット件数が 0 なら --memory-hits 0 か、オプション自体を省略します',
    );
  }
  return Number.parseInt(raw, 10);
}

export function parseArgs(argv) {
  const out = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function requireSnapshot(cwd) {
  const snap = latestSnapshot(cwd);
  if (!snap) {
    throw new Error(
      'snapshot がありません。先に `npm run review:snapshot` を実行してください（共通成果物の生成）',
    );
  }
  return snap;
}

/**
 * `record-run` の snapshotId 解決。`--snapshot-id` の明示があればそれを優先し、
 * 無指定なら latestSnapshot(cwd) の snapshotId にフォールバックする。
 *
 * 明示指定を残す理由は「どの snapshot を読んだレビューか」を記録するため。**machine が真偽を
 * 検証できない自己申告**であり、実効的な保護は `loadRecordRunSnapshot` の鮮度検証と計画照合。
 */
export function resolveRecordRunSnapshotId(args, cwd = process.cwd()) {
  if (typeof args['snapshot-id'] === 'string') return args['snapshot-id'];
  return latestSnapshot(cwd)?.snapshotId ?? null;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const cwd = process.cwd();
  const state = loadState(cwd);

  switch (cmd) {
    case 'plan': {
      const snap = requireSnapshot(cwd);
      // 値欠落（`--memory-hits --other`）・非10進・全角数字を黙って0（＝記憶適合の義務なし）へ
      // 潰すと、必須レビューがタイポひとつで消える。渡されたなら非負整数であることを要求する
      const memoryHits = parseMemoryHits(args['memory-hits']);
      const plan = planCommand(state, snap, {
        memoryHits,
        // 系統ごとの再探索基準（その系統が最後にレビューした snapshot → 現在）の差分を解決する
        resolveChangedSince: (from, to) => changedFilesBetween(cwd, from, to),
      });
      saveState(state, cwd);
      writeFileSync(join(snap.dir, 'review-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
      // 旧 plan が書いた semantic finding の成果物が残っていれば同時に片付ける
      discardLegacyFindingArtifacts(cwd);
      process.stdout.write(formatPlan(plan, snap.dir));
      // 成果物を書き出した**後**に fail-loud する（診断材料を失わせない）。黙って「収束: いいえ」
      // を出し続けると、止まっていること自体が誰にも見えない
      if (!plan.converged && plan.nextActions.length === 0) {
        throw new Error(
          '収束していないのに、次にできる行動が1つもありません（レビュー状態が恒久停止しています）。\n' +
            'ブロックしている条件と、その解除経路のどちらかが壊れています。' +
            '状態は `node scripts/agent/review-plan.js state` で確認できます',
        );
      }
      break;
    }
    case 'escalate': {
      // 初期 Tier が未確定のまま加算すると、加算判定（初期 Tier 対象外か）が空集合との比較に
      // なり誤った Tier へ倒れる。fail-loud で plan を先に要求する
      if (!state.initialTier) {
        throw new Error(
          '初期 Tier が未確定です。先に `npm run review:plan` を実行してください（実効 Tier の加算は初期 Tier との差分で決まります）',
        );
      }
      escalateAngles(state, {
        angles:
          typeof args.angles === 'string'
            ? args.angles
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        reason: typeof args.reason === 'string' ? args.reason : '',
      });
      saveState(state, cwd);
      process.stdout.write(
        `実効 Tier: ${state.effectiveTier}\n` +
          '理由は state に保存していません。docs/pr/PR-{番号}.md の裁定として記録してください\n',
      );
      break;
    }
    case 'record-run': {
      // 削除したフラグを黙って無視すると、旧手順どおりに叩いた側は「最終独立レビューを
      // 記録した」つもりで通常 run を1本記録することになる（fail-quiet）。受理しない
      if (args.final !== undefined) {
        throw new Error(
          'record-run は --final を受理しません。最終独立レビューは machine の起動義務ではなく、' +
            'docs/agent-workflows/review-angles/README.md「review budget」と ' +
            'docs/pr/PR-{番号}.md が正本です' +
            '（1回の invocation を系統ごとの記録へ分解しないため）',
        );
      }
      if (args['new-findings'] !== undefined) {
        throw new Error(
          'record-run は --new-findings を受理しません。所見の計数は ' +
            '`node scripts/agent/review-metrics.js record --new-findings ...` へ渡してください',
        );
      }
      const snapshotId = resolveRecordRunSnapshotId(args, cwd);
      // fresh / 継続 は明示を要求する。省略を「継続」に倒すと、fresh 起動が継続として
      // 記録され、独立レビュアーへの交代要求を満たさない記録が通ってしまう
      const freshFlag = args.fresh === true || args.fresh === 'true';
      const continueFlag = args.continue === true || args.continue === 'true';
      if (freshFlag === continueFlag) {
        throw new Error(
          'record-run には --fresh または --continue のどちらか一方を指定してください',
        );
      }
      // 鮮度の材料と計画の材料は同じ読み出しから採る（両者が別の snapshot を指す取り違えを防ぐ）
      let loaded = null;
      const resolveSnapshot = () => (loaded ??= loadRecordRunSnapshot(cwd, snapshotId));
      const runsBefore = state.runs.length;
      const rec = recordRunCommand(
        state,
        {
          snapshotId,
          angle: args.angle,
          mode: args.mode,
          fresh: freshFlag,
          status: typeof args.status === 'string' ? args.status : 'complete',
          agentId: typeof args['agent-id'] === 'string' ? args['agent-id'] : null,
        },
        {
          resolveSnapshot,
          resolveFreshness: () => snapshotFreshness(resolveSnapshot(), cwd),
          resolveChangedSince: (from, to) => changedFilesBetween(cwd, from, to),
        },
      );
      saveState(state, cwd);
      // 同一コマンドでも、計画が改めて要求していれば新規記録・していなければ no-op になる。
      // どちらだったかを出力で区別しないと、レビュアーを起動せずに再実行した場合に
      // 「エスカレーションを消化した」ことに気づけない（運用性レビュー F5）
      const added = state.runs.length > runsBefore;
      process.stdout.write(
        `${added ? '記録' : '記録済み（no-op）'}: ${rec.angle} ${rec.mode} ` +
          `${rec.fresh ? 'fresh' : '継続'} ${rec.status}（seq=${rec.seq}）\n` +
          (added
            ? ''
            : '  この起動は既に記録済みで、計画も新しい起動を要求していません' +
              '（レビュアーを起動した結果を記録したい場合は、先に npm run review:plan で要求を確認してください）\n'),
      );
      break;
    }
    case 'state': {
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
      break;
    }
    default:
      process.stderr.write('usage: review-plan.js <plan|escalate|record-run|state> [options]\n');
      process.exit(1);
  }
}

export function formatPlan(plan, dir) {
  const lines = [];
  lines.push(`snapshot: ${plan.snapshotId}`);
  lines.push(`初期 Tier: ${plan.initialTier}（${plan.initialTierReasons.join('／')}）`);
  lines.push(
    `実効 Tier: ${plan.effectiveTier}${plan.addedAngles.length > 0 ? `（加算: ${plan.addedAngles.join(' / ')}）` : ''}`,
  );
  // このシグナルは**直前 snapshot からの修正差分**のもの。系統ごとの baseline が直前より
  // 古い場合、その系統は累積差分で判定されるので値が食い違う。どちらが正かを読み手が
  // 決められるよう、範囲を明記して累積判定の系統を併記する（運用性 F4）
  lines.push(
    `シグナル（直前 snapshot からの修正差分）: ${
      Object.entries(plan.signals)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(' / ') || '(なし)'
    }`,
  );
  const label = (e) => ANGLE_TOKENS[e.angle]?.label ?? e.angle;
  // 起動の有無を併記する。範囲の情報だけを並べると、起動されない系統が列挙され
  // 起動される系統が載らない組み合わせで読み手が取り違える（運用性 所見2 が実測）
  const mark = (e) => `${label(e)}${e.run ? '' : '（起動なし）'}`;
  const cumulative = plan.entries.filter((e) => e.baseline.range === '累積');
  if (cumulative.length > 0) {
    lines.push(
      `累積差分で判定した系統: ${cumulative
        .map((e) => `${mark(e)}（${e.baseline.snapshotId} 以降）`)
        .join(' / ')}`,
    );
  }
  const unresolved = plan.entries.filter((e) => e.baseline.range === '解決不能');
  if (unresolved.length > 0) {
    lines.push(
      `基準からの差分を解決できず全体再探索へ倒した系統: ${unresolved
        .map((e) => `${mark(e)}（基準 ${e.baseline.snapshotId ?? '不明'}）`)
        .join(' / ')}`,
    );
  }
  // 現在の段階は「今 round で何を起動すべきか」を決める中心的な状態なので明示する
  // （表の各行の「段階」列はその系統が属する段階であって、現在の段階ではない）
  lines.push(
    `現在の段階: ${STAGE_LABELS[plan.stage]}（起動順: ${STAGE_LABELS.subtractive} → ${STAGE_LABELS.body} → ${STAGE_LABELS.cleanup}）`,
  );
  lines.push('');
  lines.push('| 系統 | 段階 | 起動 | モード | レビュアー | model | 理由 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const e of plan.entries) {
    lines.push(
      `| ${ANGLE_TOKENS[e.angle]?.label ?? e.angle} | ${e.stage} | ${e.run ? '✅' : '⏭️'} | ` +
        `${e.mode ? REVIEW_MODES[e.mode].label : '―'} | ${e.run ? (e.fresh ? 'fresh' : '継続') : '―'} | ` +
        `${e.exec?.model ?? '―'} | ${e.reason} |`,
    );
  }
  lines.push('');
  const pending = plan.entries
    .filter((e) => e.run)
    .map((e) => ANGLE_TOKENS[e.angle]?.label ?? e.angle);
  // 「収束: はい」は**計画した起動をすべて記録した**の意味であって、所見が無いことの宣言では
  // ない（所見の裁定は docs/pr/PR-{番号}.md）。読み手が後者と取り違えないよう明記する
  lines.push(
    plan.converged
      ? '計画が要求した起動: すべて記録済み' +
          '（所見の裁定は docs/pr/PR-{番号}.md、最終独立レビューは review budget の手順）'
      : `未記録の起動要求あり（起動待ち: ${pending.join(' / ') || '(なし)'}）`,
  );
  if (!plan.converged) {
    lines.push(
      plan.nextActions.length > 0
        ? `次の行動: ${plan.nextActions.join(' / ')}`
        : '次の行動: なし — 収束していないのに打てる手がありません（恒久停止）',
    );
  }
  // 予算終了は収束の可否と**別の行**に出す。「収束: はい」の直後に出すのは、その行だけを
  // 読んで「レビュー完了」と判断されるのを防ぐため（判断が要る事項が残っていることは、
  // 収束したかどうかより先に目に入る必要がある）
  // 導出値なので成果物には持たない（entries が同じ事実を持つ。フィールドを増やすと
  // 読み手がどちらを正とするかで判定が分かれる）
  const exhausted = plan.entries.filter((e) => e.budgetOutcome === 'exhausted');
  if (exhausted.length > 0) {
    lines.push('');
    lines.push('⚠️ 予算終了（人間判断が要る。自動探索はここで止まる）:');
    for (const e of exhausted) {
      // `budgetOutcome: 'exhausted'` のエントリは必ず `withheld` を持つので、
      // 欠落に備えたフォールバックは書かない（applyBudget の JSDoc）
      lines.push(
        `- ${label(e)}: 未確認範囲: ${RANGE_DESCRIPTIONS[e.baseline.range](e.baseline)}` +
          ` ／ 予算が無ければ要求していた探索: ` +
          `${REVIEW_MODES[e.withheld.mode].label}（${e.withheld.reason}）`,
      );
    }
    lines.push(
      '  → 続行 / follow-up / 現状受容 / 設計へ戻す のいずれかを人間が判断し、理由を ' +
        'docs/pr/PR-{番号}.md へ残す。続行するなら ' +
        '`node scripts/agent/review-plan.js escalate --angles <系統> --reason "..."`',
    );
  }
  if (dir) lines.push(`成果物: ${dir}`);
  return `${lines.join('\n')}\n`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])review-plan\.js$/.test(process.argv[1])
) {
  main();
}

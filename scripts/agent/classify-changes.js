import { pathToFileURL } from 'node:url';

// 変更ファイルの分類（prose / code / 依存 manifest）。
// CI の changes ジョブ（.github/workflows/ci.yml）が npm ci なしで直接実行するため、
// このファイルは node ビルトイン以外を import しないこと（check-artifacts.js 本体は
// mdast 依存を持つため、分類だけを依存フリーで提供する #403）。

// docs/prose 扱いのパス（これらだけの変更は「コード変更」ではない）
const PROSE_PATTERNS = [
  /\.md$/i,
  /^docs\//,
  /^\.claude\//,
  /^\.agents\//,
  /^\.gemini\//,
  /^LICENSE$/,
  /^\.gitignore$/,
];

// 実行可能設計文書（後続の実装・運用を拘束する docs・エージェント設定。prose の部分集合）。
// これらに触れる変更は Tier に「仕様＋運用性・状態遷移」を加算する（#452。加算規則の prose 側は
// docs/agent-workflows/review-angles/README.md — 判定の正は本列挙で、README とのずれは
// tests/reviewAngleTokens.test.js が検出する）。大文字小文字を区別しない（`i` フラグ。
// `.claude/settings.JSON` 等の大小変種で加算判定を落とさない — 加算方向のみの変更で
// fail-closed 側〔PROSE_PATTERNS 等〕は据え置く。#446 round7 観点別レビュー 敵対的N1）
export const DESIGN_DOC_PATTERNS = [
  /^docs\/agent-workflows\//i,
  /^docs\/planning\//i,
  /^docs\/data-model\//i,
  /^docs\/security\//i,
  /^docs\/ai\//i,
  /^docs\/maintenance\//i,
  /^\.claude\/agents\//i,
  /^\.claude\/commands\//i,
  /^\.claude\/skills\//i,
  /^\.agents\/skills\//i,
  /^agent-manifest\.json$/i,
  // projection の受領証。信頼の起点なので、単体変更でも設計文書として Tier を加算する。
  /^agent-commons\.lock\.json$/i,
  /^CLAUDE\.md$/i,
  /^AGENTS\.md$/i,
  /^GEMINI\.md$/i,
  /^\.claude\/settings\.json$/i,
  /^\.github\/pull_request_template\.md$/i,
  /^\.github\/copilot-instructions\.md$/i,
];

// 記憶レコード・構造化記録（Record Tier。prose の部分集合）。
// 減算＋清掃レビューの対象（Phase 2）。判定の正は本列挙で、README とのずれは
// tests/reviewAngleTokens.test.js が検出する。大文字小文字を区別しない（#446 round7 敵対的N1。
// DESIGN_DOC_PATTERNS と同じ理由）
export const RECORD_DOC_PATTERNS = [/^docs\/agent-memory\/records\//i];

// PROSE だが「説明・履歴文書」ではない（拘束力のない設定・ライセンスファイル）。
// Docs Tier（mandate='docs'）は「後続の実装・運用に関わる説明文書」を対象とする趣旨のため、
// これらのみの変更で Docs mandate を誤トリガーしない（外部レビュー Codex #539 指摘:
// LICENSE/.gitignore だけの PR でも artifact 必須化されてしまっていた）。
// ルート直下限定（`^LICENSE$` 等）で PROSE_INERT_PATTERNS とは目的が異なる
// （こちらは Docs Tier 除外専用。code/非 code 判定には使わない。#446 round2）。
const NON_EXPLANATORY_PROSE_PATTERNS = [/^LICENSE$/, /^\.gitignore$/];

// 依存 manifest のみの変更（Dependabot 等）は artifact を必須化しない
const DEP_MANIFEST_PATTERNS = [
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /^\.github\/dependabot\.ya?ml$/,
];

// lockfile の変更を伴わない package.json 単体変更は「依存のみ」とみなさない
// （scripts / engines 等の非依存変更が artifact 必須を免れるのを防ぐ）
const LOCKFILE_PATTERNS = [/(^|\/)package-lock\.json$/];

// 既知の npm プロジェクト（root と `worker/`。npm workspaces ではなく独立した lockfile を
// 持つ）直下。「純粋な依存 manifest」の判定はここへ寄せる（#446 round8）。パスパターン
// （例: HIGH_RISK_PATTERNS）で判定すると、対象プロジェクト外に置かれた「たまたま
// package.json という名前のファイル」（bundled action の dist/package.json 等）を路みに
// 混ぜてしまい、逆に正当な Dependabot の対象プロジェクト直下バンプを誤って高リスク側へ
// 引っ張る回帰を招く（#446 round7 で実際に発生）。新しいプロジェクトを追加したら PR で
// この配列へ 1 行足す運用にする。
export const KNOWN_DEP_MANIFEST_DIRS = ['', 'worker/'];

// path が既知 npm プロジェクト直下の package.json / package-lock.json かどうか
// （review-plan.js の pure-dep 判定・classify() の depOnly 判定の両方から使う）
export function isKnownDepManifestPath(path) {
  return KNOWN_DEP_MANIFEST_DIRS.some(
    (dir) => path === `${dir}package.json` || path === `${dir}package-lock.json`,
  );
}

// Artifacts Gate の bundled action（.github/actions/artifacts-gate/dist）へ束ねられる source と、
// その再ビルド結果を変えうるパス。ci.yml の bundle-check ジョブの起動判定に使う（#551）。
// 先頭 7 パターン（action・check-artifacts.js 系・依存 manifest）は旧 artifacts-gate-bundle.yml の
// paths フィルタと等価。依存 manifest を含むのは、mdast 系 / @vercel/ncc の更新が dist の中身を
// 変えるため。最後の 1 パターン（ci.yml 自体）は旧 workflow には無かった追加分で、旧 paths の
// 「自 workflow ファイルの変更でも再検証する」自己参照エントリ（artifacts-gate-bundle.yml 自身）を
// 統合先の ci.yml へ機械的に置き換えたもの。ただし ci.yml は bundle-check 以外の job も含む単一
// workflow のため、この置き換えは equivalent ではなく **over-inclusive**（bundle と無関係な ci.yml
// 変更でも bundle-check が起動する）。安全側（過剰実行）として意図的に許容している —
// bundle-check 自体の steps・checkout ref・npm バージョン等が ci.yml 内にあり、それらの変更も
// 「bundle-check が壊れていないか」を再検証したい対象であるため、狭めるより広く倒す方を選んだ。
// ci.yml を bundle 関連 job とそれ以外に分割すればこの過剰実行は無くせるが、その分割自体が
// workflow 数を増やす新しい抽象化になるため本 issue の範囲では行わない。
const BUNDLE_SOURCE_PATTERNS = [
  /^\.github\/actions\/artifacts-gate\//,
  /^scripts\/agent\/check-artifacts\.js$/,
  /^scripts\/agent\/mdast-body\.js$/,
  /^scripts\/agent\/classify-changes\.js$/,
  /^scripts\/agent\/review-angle-tokens\.js$/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^\.github\/workflows\/ci\.yml$/,
];

// prose ディレクトリ配下でも「データとして不活性」な形式だけを prose のままとし、それ以外
// （未知拡張子・拡張子なし・.sh/.py/.html/.bash/Makefile 等）はすべて code 扱いにする allowlist
// 方式（#446）。denylist（実行可能拡張子の列挙）だと新しい実行系拡張子の追加漏れが緩み側
// バイパスになるため、安全側の allowlist に反転した（#446 観点別レビュー 減算#2・敵対的F2/F10）。
// docs/evil.js や .claude/skills/x/run のような配置で prose 判定に紛れ込み、lint-test /
// worker-test / semgrep が誤って skip される問題（docs/planning/ci-split-design.md §7）の対策。
// 列挙は実在する用途があるものだけに絞る（長いほど密輸経路の候補語彙が増えるため）。
// .svg は script を含みうる能動形式のため対象外。.txt/.markdown/.ico/.csv/.tsv は実在 0 件
// のため削除済み — 必要になったら PR で 1 行追加する（#446 round2 観点別レビュー 品質#2・減算）。
const PROSE_INERT_PATTERNS = [
  /\.md$/i,
  /\.json$/i,
  /\.ya?ml$/i,
  /\.png$/i,
  /\.jpe?g$/i,
  /\.gif$/i,
  /\.webp$/i,
  // .gitkeep はどの階層でも不活性（basename 完全一致）。LICENSE / .gitignore はルート限定
  // （ネストした同名ファイルは通常の docs content であり、拡張子なしで code 密輸経路に
  // なりうるため対象外。#446 round3 で round2 の (^|/) 一般化を戻した）
  /(^|\/)\.gitkeep$/,
  /^LICENSE$/,
  /^\.gitignore$/,
];

// .claude/ 配下の機械可読設定（.json / .yaml。hook 実行コマンド等、Claude Code の挙動・
// 機械ゲートを宣言しうるファイル）は拡張子に関わらず code 扱いにする（#446 観点別レビュー
// 仕様#1。round3: .gemini/config.yaml は TRUST-BOUNDARY の実行境界に無い外部サービス設定
// のため対象から外した — round1 の結論に戻す）。現存するのは .claude/settings.json のみ
// だが、.claude/skills/*/hooks.json 等の追加も同じ理由で code 扱いにすべきため denylist
// ではなくパターンで持つ。DESIGN_DOC_PATTERNS には settings.json のみが個別に載っており、
// 本パターンにマッチする他の .claude/*.json|yaml が自動的に設計文書 Tier 対象になるわけ
// ではない（両者は独立した判定）。
const CODE_FORCE_PATTERNS = [/^\.claude\/.*\.(json|ya?ml)$/i];

function isProse(path) {
  return PROSE_PATTERNS.some((re) => re.test(path));
}

// isProse とは独立に code 判定を広げるための関数（#446）。docsChanged 等は isProse を
// そのまま使い続けるため意味を変えない。codeChanged の算出のみ isCode を使う。
function isCode(path) {
  if (CODE_FORCE_PATTERNS.some((re) => re.test(path))) return true;
  if (!isProse(path)) return true;
  return !PROSE_INERT_PATTERNS.some((re) => re.test(path));
}

function isDepManifest(path) {
  return DEP_MANIFEST_PATTERNS.some((re) => re.test(path));
}

// rename エントリ（{path, oldPath}）の配列から classify() の入力パス配列を作る。oldPath が
// あれば path と両方を含める — rename 元が code だった場合に、新パスだけを見ると分類が軽く
// 見えてしまう密輸経路を塞ぐ（#446）。review-plan.js の computeInitialTier と
// review-snapshot.js の classifyFile が同じロジックを別々に持っていたため、この1本へ統合した
// （#446 round4 観点別レビュー 減算#4。両呼び出し側のテストは配線確認のみをそれぞれのファイルに
// 残し、拡張子・パターンのケース網羅はこのファイルのテストに集約する）。
export function expandRenames(files) {
  return files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]));
}

export function classify(changedFiles) {
  const files = changedFiles.filter(Boolean);
  const codeFiles = files.filter((f) => isCode(f));
  const codeChanged = codeFiles.length > 0;
  // lockfile 変更は既知 npm プロジェクト直下のものに限定する（任意階層の
  // docs/legacy/package-lock.json 等が depOnly を誤って立てないようにする。#446 round9）
  const hasLockfileChange = files.some(
    (f) => LOCKFILE_PATTERNS.some((re) => re.test(f)) && isKnownDepManifestPath(f),
  );
  // package.json のみ（lockfile 変更なし）は scripts/engines 等の非依存変更の可能性があるため
  // 「依存のみ」とはみなさない。lockfile が動いている場合のみ免除する。
  // depOnly は「変更されたコードファイルが全て既知 npm プロジェクト直下の依存 manifest か」
  // （#446 round8: isDepManifest〔パスパターンのみ〕から isKnownDepManifestPath へ変更。
  // bundled action の dist/package.json 等、対象プロジェクト外の package.json 変更は
  // depOnly と見なさず mandate='full' のまま検査対象にする — check-artifacts.js の
  // mandate 判定はこの depOnly を直接使うため、この1箇所の変更で両方に効く）
  const depOnly = codeChanged && codeFiles.every((f) => isKnownDepManifestPath(f)) && hasLockfileChange;
  const depsChanged = files.some((f) => isDepManifest(f));
  // docs リンクチェック（scripts/check-doc-links.js）の起動判定。
  // .md 変更、または docs/ 配下の非 md（リンク先の json 等）変更で走らせる（#426）。
  const docsChanged = files.some((f) => isProse(f));
  // Docs Tier（mandate='docs'）専用の判定。isProse のうち config/ライセンスを除く
  // （docsChanged 自体は docs-links CI ジョブのトリガー判定にも使うため広いまま維持する）
  const explanatoryDocsChanged = files.some(
    (f) => isProse(f) && !NON_EXPLANATORY_PROSE_PATTERNS.some((re) => re.test(f)),
  );
  // 実行可能設計文書に触れているか（Tier 加算判定 #452）。CLI 出力（code/deps）には含めない
  // — ci.yml の changes ジョブは既存キーのみ消費するため出力形式を変えない
  const designDocsChanged = files.some((f) => DESIGN_DOC_PATTERNS.some((re) => re.test(f)));
  // 記憶レコード・構造化記録に触れているか（Record Tier 判定。Phase 2）
  const recordDocsChanged = files.some((f) => RECORD_DOC_PATTERNS.some((re) => re.test(f)));
  // bundled action の再ビルド結果を変えうる変更か（ci.yml の bundle-check 起動判定 #551）
  const bundleSourceChanged = files.some((f) => BUNDLE_SOURCE_PATTERNS.some((re) => re.test(f)));
  return {
    codeChanged,
    depOnly,
    depsChanged,
    docsChanged,
    explanatoryDocsChanged,
    designDocsChanged,
    recordDocsChanged,
    bundleSourceChanged,
    codeFiles,
  };
}

// CLI: CHANGED_FILES 環境変数を分類し GITHUB_OUTPUT 形式で出力する（CI のジョブスキップ判定用）。
// 環境変数が未設定（呼び出し側の設定漏れ）を「変更なし」と区別せずサイレントに
// code=false/deps=false を返すと、重い lint-test 等のジョブが誤ってスキップされる
// （check-artifacts.js の resolveChangedFiles と同じ fail-loud 原則。#396 round19 の再発防止）
function main() {
  if (process.env.CHANGED_FILES == null) {
    console.error(
      'classify-changes: CHANGED_FILES 環境変数が設定されていません（ワークフロー側の設定漏れの可能性）',
    );
    process.exit(1);
  }
  // 改行のみで分割する（空白区切りは廃止）。ファイル名に空白を含みうる（#446 round3
  // 敵対的: `docs/two words.png` のような正当なファイル名を誤って複数トークンに割ってしまい、
  // 分類を誤らせる）。全 producer（ci.yml / artifacts-gate.yml / hooks）は改行区切りで
  // CHANGED_FILES を渡す。
  const files = process.env.CHANGED_FILES.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (files.length === 0) {
    // CHANGED_FILES は設定済みだが trim 後 0 件（空文字列・空白のみ）。「本当に変更ファイルが
    // 無かった」のか「差分取得に失敗して空になった」のかをここでは区別できないため、
    // 全ジョブ実行の fail-closed へ倒す（#446 観点別レビュー 敵対的F7/F8。旧実装は全 false を
    // 返し重い検査を誤って skip していた）。
    console.error(
      'classify-changes: CHANGED_FILES に変更ファイルが含まれていません（差分取得失敗の可能性）。fail-closed で全ジョブを実行対象にします',
    );
    process.stdout.write('code=true\ndeps=true\ndocs=true\nbundle=true\n');
    return;
  }
  const { codeChanged, depsChanged, docsChanged, bundleSourceChanged, codeFiles } =
    classify(files);
  if (codeChanged) {
    // 著者が「どのファイルで Full Tier（lint-test 等の起動）になったか」を確認できるように、
    // 全件を stderr へ出す（#446 round2 観点別レビュー 品質）。stdout は GITHUB_OUTPUT 形式を
    // 崩さないため使わない。
    console.error(`classify-changes: code と判定したファイル: ${codeFiles.join(', ')}`);
  }
  process.stdout.write(
    `code=${codeChanged}\ndeps=${depsChanged}\ndocs=${docsChanged}\nbundle=${bundleSourceChanged}\n`,
  );
}

// 自己起動ガード。basename も併せて判定するのは ncc バンドル対策（check-artifacts.js が本ファイルを
// import して .github/actions/artifacts-gate/dist へ束ねるため。バンドル内では import.meta.url が
// entry と一致し main() が誤発火するのを basename 判定で防ぐ #428）。パス区切りは / と \ の両方を
// 許容し、`another-classify-changes.js` 等の部分一致を弾く（末尾完全一致）。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])classify-changes\.js$/.test(process.argv[1])
) {
  main();
}

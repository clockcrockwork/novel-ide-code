import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
// Markdown 構造解析（mdast + GFM 拡張）は mdast-body.js に分離（#403 で導入、#409 で
// plan ゲート check-plan.js と共有するため抽出。方針コメントの正本も同ファイル）
import {
  parseBody,
  resourceGuardErrors,
  hasUnclosedHtmlComment,
  findSection,
  sectionSourceLines,
} from './mdast-body.js';
// 分類は classify-changes.js に分離（CI の changes ジョブが依存フリーで直接実行するため）。
// 既存の import 互換のため再 export する
import { classify } from './classify-changes.js';
export { classify };
// Tier 宣言×系統列の突き合わせ（#452）。トークンの正本は review-angle-tokens.js（依存フリー）
import {
  ANGLE_TOKENS,
  CONDITIONAL_ANGLE_TOKENS,
  TIER_ANGLES,
  DESIGN_ADDON_ANGLES,
  TIER_DECL_NAMES,
  BASE_TIER_NAMES,
  DOCS_ONLY_TIER_NAMES,
} from './review-angle-tokens.js';

// docs のみ PR で使う非基礎 Tier（mandate 名 → 宣言名・エラー文言用ラベル）。Phase 2 で
// 設計文書 Tier（#452）に Record（記憶レコード）・Docs（説明文書）を追加した。
// tierName は DOCS_ONLY_TIER_NAMES（review-angle-tokens.js が正本）から位置対応で取る
// （文字列の複製禁止。DOCS_ONLY_TIER_NAMES = ['設計文書', 'Record', 'Docs']）。
// 優先順位（mandate 解決）は design > record > docs（check-artifacts の mandate 算出を参照）
const [DESIGN_TIER_NAME, RECORD_TIER_NAME, DOCS_TIER_NAME] = DOCS_ONLY_TIER_NAMES;
const DOCS_ONLY_MANDATE_INFO = {
  design: { tierName: DESIGN_TIER_NAME, label: '設計文書' },
  record: { tierName: RECORD_TIER_NAME, label: '記憶レコード' },
  docs: { tierName: DOCS_TIER_NAME, label: '説明文書' },
};

// 「完了主張チェックの機械的下限ゲート」。
// 目的: 完了条件表・想定ケース表・証拠表が「未作成のままチェック済み」になるのを塞ぐ。
// 検証できるのは存在・形式まで。証拠の真偽は cross-model の evidence-check に残す
// （docs/agent-workflows/evidence-check.md）。
// 詳細: docs/agent-workflows/subagent-roles.md / docs/ai/rules/verification-gates.md

// 必須セクション（コード変更時）。name=表示名, keywords=見出しに含まれ得る語
// 順序は標準フローの成果物順（完了条件→想定ケース→既存実装調査→証拠表→レビューループ記録）に
// 合わせる（requirement-probe → risk-modeling → codebase-recon → evidence-check → pre-commit-review）。
const LOOP_SECTION = { name: 'レビューループ記録', keywords: ['レビューループ', 'ループ記録'] };
const REQUIRED_SECTIONS = [
  { name: '完了条件', keywords: ['完了条件'] },
  { name: '想定ケース', keywords: ['想定ケース', 'リスクモデリング', 'リスク'] },
  // keywords は「既存実装調査」単独に限定する。「既存実装」等の短縮語を含めると
  // 「## 既存実装への影響」のような無関係な見出しに部分一致し、実際の既存実装調査
  // セクションが無くてもゲートを素通りしてしまう（#399 Codex 指摘）。
  { name: '既存実装調査', keywords: ['既存実装調査'] },
  // 証拠表も「証拠表」単独に限定する。「証拠」を含めると、既存実装調査など先行
  // セクション配下の「### 新規作成の証拠」等のサブ見出しを証拠表として拾い、
  // 実際の証拠表が無くてもゲートを素通りしてしまう（#399 Codex 指摘）。
  { name: '証拠表', keywords: ['証拠表'] },
  LOOP_SECTION,
];

// 証拠にならない skip 語（チェック済み or ✅ 判定なのにこれだと違反）。2クラスに分ける:
// hard（未実施・先送りの宣言）は証拠トークンが並記されていても「やっていない」宣言なので常に違反。
// soft（実施した、という宣言だけの語）は強い証拠ポインタの併記があれば通す（#395 の偽陽性修正）。
// 「―」「—」「-」「?」「？」「…」は単独の空値プレースホルダとしてのみ hard deferral とする。
// 終端アンカーなしだと「- tests/foo.test.js」のような先頭ハイフン付きの正当な証拠が
// 常に違反扱いになってしまうため（プレースホルダ記号は記号+空白のみで完全一致に限定）
const HARD_DEFERRAL =
  /^(n\/?a|なし|無し|todo|skip|未(実施|対応|検証)?|記入|（記入）)|^[―—\-?？…]\s*$/i;
// 実施した、という宣言語。「ローカルで」「手動で」等の接頭辞が付いても宣言語として扱う
const SOFT_CLAIM =
  /^(ローカルで|手元で|手動で|実機で|目視で)?(確認(済み?|した)?|目視|動作確認(済み)?|手動確認(済み)?|実施済み?|対応済み?|修正済み?|テスト(パス|通過|成功|完了)?|ビルド(成功|完了)?|パス(した|しました)?|成功(した|しました)?|checked|done|verified|tested|passed|完了|ok)/i;

// 強い証拠ポインタ: 拡張子付きパス（行番号任意）または npm/node コマンドのみ。
// 日付（2026/07/09）・時刻（14:30）・ライブラリ名（Node.js）・任意のバッククォート語を
// 証拠と誤認しないよう、緩いトークン（裸の :\d+ / \.js\b / `...`）は含めず、
// 拡張子には英字を要求する（「1/2.3」等の数値のみをパスと誤認しない）。
// パス区切りは / と \ の両方を許容する（PR 本文は自由記述テキストで Git のパス正規化を
// 経ないため、Windows 環境で手動記入されると tests\foo.test.js 形式になりうる）。
// パスセグメントは \w 限定ではなく非空白・非区切り文字（空白・パイプ・コロン・スラッシュ類）を
// 許容し、全角文字を含むファイル名（docs/マニュアル.md 等）も証拠ポインタとして認識する。
// 拡張子部分のみ \w に限定する（実在する拡張子は常に ASCII のため）。
// 量指定子はすべて上限付き（{1,300} 等）にする。無上限だと長大な単一トークン
// （GitHub の PR 本文上限 64KB）で seg+ / (--\S+\s+)* のバックトラックが二次増大し、
// 65KB 入力で約5秒かかる ReDoS になる（実測）。上限付きで同入力が ~84ms に線形化される。
// node コマンドは中間フラグ限定をやめ「node …(300文字以内)… --test」を許容する
// （旧 (--\S+\s+)* が二次バックトラックの一因。実効的な判定材料は --test トークン自体）
// ルート直下ファイル（package.json:16 等）はパス区切りを持たないため、単一セグメントは
// 行番号付き（:\d+）に限って許容する。行番号なしの単一セグメント（README.md 単体等）は
// ライブラリ名（Node.js）と構造的に区別できず、裸拡張子ロンダリングを再導入するため許容しない
// `npm run` は script 名を要求する（`確認済み npm run` のように run 単体だと検証対象が
// 特定できず証拠にならない #396 Codex 指摘）。script 名はオプション（`-` 始まり）を除外する
// （`npm run --if-present` は script 一覧を出して exit 0 するだけで検証しない #396 Codex 指摘）。
// 単体で完結するコマンドは `npm test` / `npm ci` のみ許容。script 名が実在の検証 script かは
// floor の範囲外（cross-model の evidence-check が担う）
const EVIDENCE_POINTER =
  /[^\s|：:/\\]{1,300}[/\\][^\s|：:/\\]{0,300}\.(?=\w*[a-z])\w{1,6}(:\d+)?|[^\s|：:/\\]{1,300}\.(?=\w*[a-z])\w{1,6}:\d+\b|npm\s+run\s+(?!-)\S+|npm\s+(test|ci)\b|node\s+[^\n]{0,300}?--test\b/i;

function lacksEvidence(evidence) {
  if (HARD_DEFERRAL.test(evidence)) return true;
  return SOFT_CLAIM.test(evidence) && !EVIDENCE_POINTER.test(evidence);
}

// 関連 issue 参照。裸の #\d+ は色コード（#333）等と区別できないため、
// キーワードが # に直接かかる形（間は区切り記号・"issue" のみ許容）だけを参照とみなす。
// 「fix color #333」のような 20 文字近傍一致は素通りの穴になるため採らない。
// 意図的に issue なしの場合は宣言でのみ免除する
const ISSUE_REF =
  /\b(closes?|fix(es)?|resolves?|refs?)\s*[:：]?\s*#\d+|(関連|対応)\s*(issues?)?\s*[:：]?\s*#\d+|\/issues\/\d+/i;
// 括弧内の理由は非空を要する（`関連issue: なし（ ）` や全角空白だけを skip マーカーと同様に
// 拒否する #396 Codex 指摘）。括弧内に少なくとも1つの非空白文字（全角空白 U+3000 も \s に含む）
const NO_ISSUE_DECL = /関連\s*issue\s*[:：]\s*なし\s*[（(][^）)]*\S[^）)]*[）)]/i;

// GitHub 上で連続描画される「インライン run」単位の可視テキストを収集する（#417）。
// 判定は run 単位で行い、GitHub 上で視覚的に分離される境界をまたいだ連結が偽の参照を
// 捏造するのを防ぐ。境界は 2 種類:
// - ブロック境界（テーブルセル/行・リスト項目・引用・段落等）: 構造的に分離されるため別 run。
//   `| refs | #1 |` や `- ref` / `- #1` が `refs#1` に潰れるのを防ぐ。
// - インライン境界（フロー系以外のインライン html〔`<br>`・`<img>`・`<input>`・`<svg>` 等〕・
//   markdown 画像・ハード改行）: GitHub 上で改行・置換要素として描画され連続テキストを分断する
//   ため別 run。`re<br>fs #1` を防ぐ。フロー系タグの判定は下の allowlist（fail-safe）。
// フロー系のインライン HTML（`<b>`/`<i>`/`<span>` 等）とインラインコードは同一 run 内で連結を
// 保持する（`closes <b>#1</b>` → `closes #1`）。html ノード（属性値・DOCTYPE/宣言・PI・CDATA・
// script/style 本体）は GitHub 不可視のため run に含めない
const RUN_BLOCK_CONTAINERS = new Set([
  'root',
  'blockquote',
  'list',
  'listItem',
  'table',
  'tableRow',
  'footnoteDefinition',
]);
// テキストを分断せず「子テキストを読み順どおり・追加グリフなし」で連続描画するフロー系
// インライン html タグ（純粋な視覚装飾のみ）。ここに無いタグ（`<br>`・`<img>`・`<input>`・
// `<svg>` 等の分断/置換/void/未知タグ）は GitHub 上で改行/置換要素/除去として連続テキストを
// 分断するものとして run 境界に倒す（allowlist 方式で fail-safe。分断タグを列挙し続ける
// blocklist 方式だと未知の void 要素で偽陰性が漏れるため）。
// 除外: `<q>`（引用符を描画）・`<ruby>`/`<rt>`/`<rp>`（ルビ注釈を描画）・`<bdi>`/`<bdo>`（双方向
// テキストの並び替え）など、追加グリフを挿入するか読み順を変える要素はテキストを分断しうるため
// allowlist に含めない（`re<q>fs #1</q>` は GitHub 上 `re“fs #1”` で連続参照が無い。Codex 指摘）。
// `<!-- -->`・`<!DOCTYPE>`・`<?...?>` はタグ名を持たず GitHub 上で不可視（除去され前後が連結）
// のため透過扱い（run を分断しない）
// 既知の限界（#419・意図的に非対応 / wontfix）: 上記は参照が読み順変更/非表示要素を「またいで
// 分断」されるケース（`re<q>fs #1</q>` → `re“fs #1”`）を弾くが、参照が `<bdo dir=rtl>refs #1</bdo>`
// のように要素配下へ「丸ごと内包」される場合は、内包テキストがそのまま 1 run として残り偽装充足
// しうる（開始/終了タグで flush するのみで、間の text ノードは source 順で積まれるため）。これは
// 対応しない: 本ゲートは外部の敵対者ではなく PR 作成者自身の雑な充足を防ぐ self-discipline チェック
// であり、逆順表示要素で自分のトレース要件を偽装しても `closes #N` と書けば済むため実益がない。
// 根本対応はフラットな mdast html ノード列（開始/終了タグは兄弟リーフ）からタグのネスト構造を復元
// する実質 HTML トークナイザ化を要し、GitHub 描画セマンティクスの手書き再現は列挙が収束しない。
const FLOW_INLINE_HTML_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'ins',
  'kbd',
  'mark',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
]);
const HTML_TAG_NAME = /^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/;
function collectVisibleRuns(node, runs = []) {
  if (RUN_BLOCK_CONTAINERS.has(node.type)) {
    for (const child of node.children ?? []) collectVisibleRuns(child, runs);
    return runs;
  }
  // インラインコンテナ/リーフ: インライン境界で分割しながら可視テキストを run 化する
  let cur = '';
  const flush = () => {
    if (cur) runs.push(cur);
    cur = '';
  };
  const walk = (n) => {
    if (n.type === 'html') {
      const tag = HTML_TAG_NAME.exec(n.value);
      // フロー系タグ（`<b>` 等）とタグ名を持たない不可視構文（コメント・宣言・PI）は透過。
      // それ以外（分断/置換/void/未知タグ）は run 境界にする
      if (tag && !FLOW_INLINE_HTML_TAGS.has(tag[1].toLowerCase())) flush();
      return;
    }
    // markdown 画像・ハード改行は GitHub 上で置換要素/改行として連続テキストを分断する
    if (n.type === 'image' || n.type === 'imageReference' || n.type === 'break') {
      flush();
      return;
    }
    if (typeof n.value === 'string') {
      cur += n.value;
      return;
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  flush();
  return runs;
}

// 収束宣言の受理文法（最終テーブル行のみ検査。閉じた文法にする）:
//   対応セル   = 「収束」単独（前後の強調記号・句点のみ許容）、または「残所見: 内容」の列挙
//   新規所見セル = 数字のみ（任意で「件」）。収束時は 0 であること
// 「未収束」「0件（説明…）」「なし」等の自由記述は受理しない。#396 のレビュー32件の大半は
// 自由記述をブロックリスト（禁止パターン列挙）で守る設計から生じた境界の穴であり、
// パターン追加ではなく受理側の文法を閉じることで同クラスの穴を構造的に塞ぐ。
// 説明文はセル外（周回セル・表外の本文）に書く。
// 許容する装飾は太字/斜体/コード（* _ ` のみ）。打ち消し線（GFM の ~~…~~）は「取り消された値」を
// 意味するため許容しない — `~~収束~~` `~~0件~~` を正式な宣言として通すと取り消し表示で PR が通る（#396）
const EMPHASIS = '[*_`\\s]*';
const ACTION_CONVERGED = new RegExp(`^${EMPHASIS}収束[。.]?${EMPHASIS}$`);
// 上限超過時の残所見列挙。コロンの後に「実質的な内容」を要する。空だけでなく、
// `なし`/`-`/`N/A`/`TODO` 等のプレースホルダ語も証拠欄の HARD_DEFERRAL と同じく
// 「形式上は空」として列挙とみなさない（上限超過なら残件を明示させるのがゲートの目的。
// `残所見: なし` は「非ゼロ所見を残したのに列挙なし」の内部矛盾で、真偽ではなく形式で落とせる）
const REMAINING_DECL = /残所見\s*[:：]\s*(.+)$/;
function hasRemainingList(action) {
  const m = REMAINING_DECL.exec(action);
  if (!m) return false;
  const content = m[1].trim();
  return content !== '' && !HARD_DEFERRAL.test(content);
}
const FINDINGS_COUNT = new RegExp(`^${EMPHASIS}(\\d+)\\s*件?${EMPHASIS}$`);
// 途中行の新規所見セルは自由記述可（「4件（stale ref ほか）」等）のため、FINDINGS_COUNT の
// 完全一致（^...$）ではなく先頭の数字だけを緩く拾う（系統別の直近収束確認用。#452 Phase2 外部レビュー）
const LEADING_COUNT = new RegExp(`^${EMPHASIS}(\\d+)`);

const SKIP_MARKER = /<!--\s*artifacts-check:\s*skip\b([^>]*)-->/i;

// PR 本文由来の自由記述（skip 理由・系統セルの未知トークン等）を警告文へ埋め込む前に、
// 埋め込まれた改行を除去する。escapeWorkflowData は `\n` を `%0A` にエスケープするが、
// GitHub Actions の annotation はこれを表示時に改行として復元し、ログ上ではタイムスタンプの
// 付かない別の物理行として現れる。証明行の照合（parseProofLine）はタイムスタンプの無い行を
// 「実際の証明行」として受理するため、攻撃者が skip 理由等に偽の証明行を改行区切りで
// 混入させると、単独行化を経由して受理されてしまう（敵対的レビュー ADV-1）。escape 前に
// 改行を1箇所で潰すことで、annotation の複数物理行化そのものを起こさせない。
function sanitizeForLogLine(s) {
  return String(s ?? '').replace(/\r\n|\r|\n/g, ' ');
}

// Tier 宣言行（閉じた文法 #452）: `Tier: {宣言名}（判定理由1行）`。宣言名の語彙は
// review-angle-tokens.js の TIER_DECL_NAMES から生成する（複製禁止。長い選択肢が先 = 選択順を保つ）。
// ＋連結は全角半角どちらも受理する（系統セルの区切りと同じ許容度）。
// 理由の量指定子は上限付き（EVIDENCE_POINTER と同じ ReDoS 方針）。
// 宣言は「行として書かれたもの」のみ受理する（行頭アンカー＋行末まで）— 地の文中の言及
// （「1周目の判定は Tier: Full（…）だった」）を宣言・競合として誤認しない
const TIER_NAME_ALT = TIER_DECL_NAMES.map((n) => n.replace('＋', '[＋+]')).join('|');
const TIER_DECL = new RegExp(
  `(?:^|\\n)[ \\t]*Tier\\s*[:：]\\s*(${TIER_NAME_ALT})\\s*[（(]([^（）()\\n]{0,300})[）)][ \\t]*(?=\\n|$)`,
  'g',
);
// 書式外検出用（宣言行を書こうとした痕跡）。「行がありません」と誤診断せず書式エラーへ誘導する。
// 段落内は行頭のみ（地の文言及を巻き込まない）、非段落文脈（箇条書き・見出し化）は broad 検出で
// 「段落の行として単独で書く」誘導に載せる（誤診断循環の回避が目的で、宣言としては数えない）
const TIER_MENTION = /(?:^|\n)[ \t]*Tier\s*[:：]/;
// 実効 Tier 宣言（別の行）を初期 Tier 宣言の書式エラーと誤診断しないよう除外する
const TIER_MENTION_BROAD = /(?<!実効\s?)Tier\s*[:：]/;

// 実効 Tier 宣言行: `実効Tier: {宣言名}（{昇格理由1行}）`。
// 初期 Tier は PR の変更内容から決まるが、外部レビュー由来の正当な新規所見で観点が加算された
// 場合は実効 Tier が上がる。両者を区別して記録し、**実効 Tier を必須系統の基準**にする。
// 省略可（省略時は実効 Tier = 初期 Tier）。宣言する場合は初期 Tier の必須系統の**超集合**に限る
// （PR 内での縮小を禁止する fail-closed）
const EFFECTIVE_TIER_DECL = new RegExp(
  `(?:^|\\n)[ \\t]*実効\\s?Tier\\s*[:：]\\s*(${TIER_NAME_ALT})\\s*[（(]([^（）()\\n]{0,300})[）)][ \\t]*(?=\\n|$)`,
  'g',
);
// 除外ノード（inlineCode/html/delete）の境界マーカー（U+FFFC）。理由 substance 判定では
// これを取り除いてから空・プレースホルダを見る（マーカーで理由を偽装する回帰を塞ぐ — 3周目 A-r3-1）
const RUN_MARKER = '￼';
// Tier 宣言の理由のプレースホルダ判定は**全文一致**で行う（HARD_DEFERRAL は前方一致のため
// 「未使用コード削除のみ」「なしにした理由…」等の正当な理由文まで巻き込む — 2周目 A-3）。
// 「未着手」等 HARD_DEFERRAL が捕捉していた語を漏らさない（3周目 S-r3-1）
const TIER_REASON_PLACEHOLDER =
  /^(n\/?a|なし|無し|todo|skip|未(着手|実施|対応|検証)?|記入|（記入）|理由|理由1行|[―—\-?？…]+)$/i;
// 「見た目は空」の理由偽装を塞ぐ substance 判定（3周目 A-r4-1 / 5周目 A-r5-1）。
// 個別コードポイントのブラックリストは追い切れない（ゼロ幅・点字空白 U+2800・ハングル
// フィラー・soft hyphen 等が次々出る）。空白（\s = NBSP・全角含む）・フォーマット文字
// （\p{Cf}: ゼロ幅・BOM 等）・制御（\p{Cc}）・default-ignorable（フィラー・CGJ・soft hyphen 等）・
// 点字空白を一括除去し、可視グリフが1つも残らなければ実質なしと判定する（肯定的不変条件）
// 結合文字（\p{Mn}/\p{Me}）も除去する — 単独では自立グリフを持たず（浮遊アクセント・
// dotted-circle）実質のある理由にならない。ベース文字を伴う正当な理由（café の分解形等）は
// ベース文字が残るため受理される（6周目 A-r6-1）
const INVISIBLE_CHARS = /[\s⠀]|\p{Cf}|\p{Cc}|\p{Default_Ignorable_Code_Point}|\p{Mn}|\p{Me}/gu;
function isPlaceholderReason(reason) {
  const stripped = reason.replaceAll(RUN_MARKER, '').replace(INVISIBLE_CHARS, '');
  return stripped === '' || TIER_REASON_PLACEHOLDER.test(stripped);
}
// docs のみ PR の過剰トリガー免除: 理由が「説明・記録文書: {実質的な理由}」の「なし」宣言のみ受理。
// 接頭辞の後ろがプレースホルダなら免除と認めない
const EXEMPT_REASON = /^説明・記録文書\s*[:：]\s*(.+)$/;
function isExemptReason(reason) {
  const m = EXEMPT_REASON.exec(reason);
  if (!m) return false;
  return !isPlaceholderReason(m[1].trim());
}
// GitHub Actions ワークフローコマンドの data 部エスケープ（`@actions/core` 準拠）。
// 警告文字列に PR 本文由来の改行が含まれると `::error::` 等の注入が成立するため必須（3周目 A-r3-2）
function escapeWorkflowData(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

// Tier 宣言はループセクション**直下の段落**からのみ読む。コードフェンス・インラインコード・
// 引用・表セル・HTML・打ち消し線の中の `Tier: …` は例示・引用・取り消しであり宣言と数えない
// （収束セルの containsDelete と同じ「取り消された値」境界。宣言だけ透過だと非対称の穴になる）。
// 除外ノードは**除去でなく境界マーカー（U+FFFC）に置換**する — 除去して連結すると
// `` `補足` Tier: Full（…） `` の行頭アンカーが偽装でき、地の文が宣言化・偽競合する（2周目 A-1）
function tierDeclRuns(loopNodes) {
  const runs = [];
  for (const node of loopNodes) {
    if (node.type !== 'paragraph') continue;
    let cur = '';
    (function walk(n) {
      if (n.type === 'html' || n.type === 'inlineCode' || n.type === 'delete') {
        cur += RUN_MARKER;
        return;
      }
      // ハード改行（GitHub 上の視覚的改行）は \n 化する。連結すると改行後の `Tier: …` の
      // 行アンカーが立たず宣言を取りこぼす（3周目 A-r3-3）
      if (n.type === 'break') {
        cur += '\n';
        return;
      }
      if (typeof n.value === 'string') {
        cur += n.value;
        return;
      }
      for (const child of n.children ?? []) walk(child);
    })(node);
    runs.push(cur);
  }
  return runs;
}

// 実効 Tier 宣言を集める（初期 Tier と同じ run 抽出＝コードフェンス・引用・表セル・
// 打ち消し線の中は宣言と数えない境界を共有する）
function findEffectiveTierDecls(loopNodes) {
  const decls = [];
  for (const run of tierDeclRuns(loopNodes)) {
    for (const m of run.matchAll(EFFECTIVE_TIER_DECL)) {
      decls.push({ tier: m[1].replace('+', '＋'), reason: m[2].trim() });
    }
  }
  return decls;
}

function findTierDecls(loopNodes) {
  const decls = [];
  let mention = false;
  for (const run of tierDeclRuns(loopNodes)) {
    if (TIER_MENTION.test(run)) mention = true;
    for (const m of run.matchAll(TIER_DECL)) {
      decls.push({ tier: m[1].replace('+', '＋'), reason: m[2].trim() });
    }
  }
  if (!mention) {
    // 非段落文脈のうち「本物の宣言意図」がありがちな箇条書き・見出し（setext 分断を含む）のみ
    // broad 検出し、「ありません」でなく書式誘導エラーに載せる（2周目 O-1）。引用・表セル・
    // コードは例示・引用であり従来どおり「ありません」side に倒す
    (function walk(n) {
      if (mention) return;
      if (n.type === 'listItem' || n.type === 'heading') {
        let txt = '';
        (function collect(m) {
          if (m.type === 'code' || m.type === 'inlineCode' || m.type === 'html') return;
          if (typeof m.value === 'string') txt += m.value;
          for (const c of m.children ?? []) collect(c);
        })(n);
        if (TIER_MENTION_BROAD.test(txt)) {
          mention = true;
          return;
        }
      }
      for (const child of n.children ?? []) walk(child);
    })({ children: loopNodes });
  }
  return { decls, mention };
}

// 系統セルのトークン照合。セルは「＋」等で複数系統を連結できる。装飾はトークンの外側の
// * _ ` のみ除去する（トークン内部の装飾文字は不受理 — 収束文法の EMPHASIS が端のみ許容
// するのと同じ境界）。ホワイトリスト外トークン（/security-review 等の系統外レビュー名）は
// エラーにせず unknown として返す（呼び出し側が警告に載せ、語彙の拡張需要を観測可能にする。
// フロア充足には数えない）。打ち消し線セルは「取り消された記録」＝実施記録なし
function recordedAngles(dataRows, angleCol, findingsCol) {
  const found = new Set();
  const unknown = new Set();
  // 系統ごとの「直近（文書順で最後）の実施行」の新規所見件数。上書きしていくため
  // 最終的に各キーには最後に登場した行の値が残る（系統別の収束確認用。#452 Phase2）
  const lastCount = new Map();
  for (const row of dataRows) {
    const cell = (row.children ?? [])[angleCol];
    if (!cell || containsDelete(cell)) continue;
    const findingsCell = findingsCol >= 0 ? (row.children ?? [])[findingsCol] : null;
    const findingsText =
      findingsCell && !containsDelete(findingsCell) ? cellText(findingsCell) : '';
    const countMatch = LEADING_COUNT.exec(findingsText);
    const rowCount = countMatch ? countMatch[1] : null; // 数字で始まらない自由記述は null（未確認）
    for (const part of cellText(cell).split(/[＋+、,]/)) {
      const tok = part
        .trim()
        .replace(/^[*_`]+|[*_`]+$/g, '')
        .trim();
      if (!tok) continue;
      let matched = false;
      for (const [key, def] of Object.entries(ANGLE_TOKENS)) {
        if (def.accept.includes(tok)) {
          found.add(key);
          matched = true;
          lastCount.set(key, rowCount);
        }
      }
      // 条件起動系統（記憶適合等）は Tier 必須集合に含めないため found には加えないが、
      // 既知トークンとして扱い unknown 警告を出さない（docs/agent-workflows/review-angles/README.md「条件起動系統」）
      if (
        !matched &&
        Object.values(CONDITIONAL_ANGLE_TOKENS).some((def) => def.accept.includes(tok))
      ) {
        matched = true;
      }
      if (!matched) unknown.add(tok);
    }
  }
  return { found, unknown, lastCount };
}

// Tier 宣言の検証と、宣言 Tier（＋設計文書加算）に必須の系統集合の導出。
// 返り値: { errors, exempt, requiredAngles }。exempt=true は docs のみ PR の免除宣言
// （呼び出し側はループ表の検査を省略してよい）
function checkTierDecl({ loopNodes, mandate, designDocsChanged, docsOnly }) {
  const errors = [];
  const { decls, mention } = findTierDecls(loopNodes);
  if (decls.length === 0) {
    errors.push(
      mention
        ? `Tier 宣言行が受理文法外です（\`Tier: {宣言名}（判定理由1行）\`。宣言名は ${TIER_DECL_NAMES.join(' / ')} のみ〔＋は全角半角どちらも可〕、理由は括弧・改行を含まない300字以内の1行、宣言は箇条書き・見出しでなく段落の行として単独で書く）`
        : `Tier 宣言行がありません（「レビューループ記録」セクション内・表の直前に \`Tier: {宣言名}（判定理由1行）\`。宣言名: ${TIER_DECL_NAMES.join(' / ')}。正本: docs/agent-workflows/review-angles/README.md「収束と記録」）`,
    );
    return { errors, exempt: false, requiredAngles: [] };
  }
  const tiers = [...new Set(decls.map((d) => d.tier))];
  if (tiers.length > 1) {
    errors.push(`Tier 宣言が競合しています（${tiers.join(' / ')}）。宣言は1つにしてください`);
    return { errors, exempt: false, requiredAngles: [] };
  }
  const { tier } = decls[0];
  // 理由は全宣言で非空・非プレースホルダを要求（skip マーカーの理由必須と同じ方針）
  if (decls.some((d) => isPlaceholderReason(d.reason))) {
    errors.push('Tier 宣言の判定理由が空またはプレースホルダです（`Tier: 宣言名（理由1行）`）');
  }
  if (mandate in DOCS_ONLY_MANDATE_INFO) {
    const { tierName, label } = DOCS_ONLY_MANDATE_INFO[mandate];
    const required = TIER_ANGLES[tierName];
    if (tier === 'なし') {
      // 免除は docs のみの PR に限る（README 加算規則）。depOnly 混在は免除不可。
      // 理由の実質もここで検査する（接頭辞がプレースホルダ検査を無効化しないように）
      if (!docsOnly) {
        errors.push(
          `免除（Tier: なし）は docs のみの PR に限ります。依存 manifest と混在する PR の宣言名は「${tierName}」です（必須系統は Tier 表を参照）`,
        );
        return { errors, exempt: false, requiredAngles: required };
      }
      if (decls.every((d) => isExemptReason(d.reason))) {
        return { errors, exempt: true, requiredAngles: [] };
      }
      errors.push(
        `${label}パスに触れる docs のみ PR で \`Tier: なし\` を宣言する場合、理由は「説明・記録文書: {実質的な理由}」の形式で書いてください（過剰トリガー免除の閉じた書式。プレースホルダ不可）`,
      );
      return { errors, exempt: false, requiredAngles: [] };
    }
    if (tier !== tierName) {
      // 列挙・自動判定より厳しい Tier への自主的な引き上げは受理する（README「広げる方向の
      // 裁量は常に可」と同じ思想。例: Docs 判定の変更が新しい規則・拘束力を追加すると著者が
      // 判断した場合、Record を宣言して減算を加算できる）。判定は必須系統の包含関係（超集合）
      const declaredAngles = DOCS_ONLY_TIER_NAMES.includes(tier)
        ? new Set(TIER_ANGLES[tier])
        : null;
      const isUpgrade = declaredAngles && required.every((a) => declaredAngles.has(a));
      if (!isUpgrade) {
        errors.push(
          `${label}パスに触れる docs のみ PR の Tier 宣言は「${tierName}」（免除時は「なし（説明・記録文書: 理由）」。より拘束力の強い Tier — ${DOCS_ONLY_TIER_NAMES.join(' / ')} — への自主的な引き上げは受理します）です（宣言: ${tier}）`,
        );
        return { errors, exempt: false, requiredAngles: required };
      }
      return { errors, exempt: false, requiredAngles: [...declaredAngles] };
    }
    return { errors, exempt: false, requiredAngles: required };
  }
  // mandate === 'full'（コード変更）
  const base = BASE_TIER_NAMES.find((b) => tier === b || tier === `${b}＋設計文書`) ?? null;
  if (base === null) {
    errors.push(
      `コード変更 PR の Tier 宣言は ${BASE_TIER_NAMES.join(' / ')}（設計文書と混在する場合は ${BASE_TIER_NAMES.map((b) => `${b}＋設計文書`).join(' / ')}）です（宣言: ${tier}）`,
    );
    return { errors, exempt: false, requiredAngles: [] };
  }
  const declaredAddon = tier.endsWith('＋設計文書');
  if (designDocsChanged && !declaredAddon) {
    errors.push(
      `実行可能設計文書に触れる変更を含むため、Tier 宣言は「${base}＋設計文書」としてください（宣言: ${tier}。パス列挙の正: scripts/agent/classify-changes.js）`,
    );
  }
  // 列挙外の宣言（designDocsChanged=false で ＋設計文書 宣言）はエラーにしない —
  // README 加算規則の「列挙外の成果物でも拘束的と判断したら加算してよい（広げる方向の
  // 裁量は常に可）」を封鎖しないため。宣言した以上、加算系統の実施は要求する（fail-closed）
  const required = new Set(TIER_ANGLES[base]);
  if (designDocsChanged || declaredAddon) {
    for (const a of DESIGN_ADDON_ANGLES) required.add(a);
  }
  return { errors, exempt: false, requiredAngles: [...required] };
}

// 宣言名 → 必須系統（加算形式 `{基礎}＋設計文書` も解く）。
// review-plan.js の anglesForTierName と同じ規則（判定の正は本ファイルと review-angle-tokens.js）
function anglesForTierName(tierName) {
  if (!tierName || tierName === 'なし') return [];
  const m = /^(.+?)[＋+]設計文書$/.exec(tierName);
  if (!m) return TIER_ANGLES[tierName] ?? [];
  const set = new Set(TIER_ANGLES[m[1]] ?? []);
  for (const a of DESIGN_ADDON_ANGLES) set.add(a);
  return [...set];
}

/**
 * 実効 Tier 宣言の検証。
 * 初期 Tier は PR の変更内容から決まり、実効 Tier は外部レビュー由来の正当な新規所見等で
 * 加算された結果を表す。宣言があれば**実効 Tier を必須系統の基準**にする。
 * PR 内での縮小は禁止（初期 Tier の必須系統を包含しない宣言は拒否する）。
 */
function applyEffectiveTier({ loopNodes, initialRequired, exempt }) {
  const decls = findEffectiveTierDecls(loopNodes);
  if (decls.length === 0) return { errors: [], warnings: [], requiredAngles: initialRequired };
  const errors = [];
  const warnings = [];
  if (exempt) {
    errors.push(
      '免除宣言（Tier: なし（説明・記録文書: …））と実効 Tier 宣言が併存しています（実効 Tier を宣言するなら免除を取り下げ、実施した系統を記録してください）',
    );
    return { errors, warnings, requiredAngles: initialRequired };
  }
  const tiers = [...new Set(decls.map((d) => d.tier))];
  if (tiers.length > 1) {
    errors.push(`実効 Tier 宣言が競合しています（${tiers.join(' / ')}）。宣言は1つにしてください`);
    return { errors, warnings, requiredAngles: initialRequired };
  }
  if (decls.some((d) => isPlaceholderReason(d.reason))) {
    errors.push(
      '実効 Tier 宣言の昇格理由が空またはプレースホルダです（`実効Tier: 宣言名（昇格理由1行）`。外部新規所見・高影響所見など、初期 Tier から変えた根拠を書いてください）',
    );
  }
  const tier = tiers[0];
  const required = new Set(anglesForTierName(tier));
  const shrunk = initialRequired.filter((a) => !required.has(a));
  if (shrunk.length > 0) {
    const labels = shrunk.map((a) => ANGLE_TOKENS[a]?.label ?? a);
    errors.push(
      `実効 Tier「${tier}」は初期 Tier の必須系統を縮小しています（欠落: ${labels.join(' / ')}）。実効 Tier は PR 内で縮小できません（正本: docs/agent-workflows/review-angles/README.md「実効 Tier の更新」）`,
    );
    return { errors, warnings, requiredAngles: initialRequired };
  }
  const added = [...required].filter((a) => !initialRequired.includes(a));
  if (added.length === 0) {
    warnings.push(
      `実効 Tier「${tier}」は初期 Tier と同じ必須系統です（加算が無い場合は実効 Tier 宣言を省略できます）`,
    );
  }
  return { errors, warnings, requiredAngles: [...required] };
}

// 宣言 Tier の必須系統がループ表の系統列に1行以上あり、かつその**直近の実施行**が
// 新規所見ゼロ（収束）を示しているかを検査する。存在するだけで満たしたことにすると、
// 「1周目に所見あり→放置→無関係な系統の収束行で最終行を満たす」偽装が成立してしまう
// （#452 Phase2 外部レビュー Codex 指摘）
function checkRequiredAngles({
  requiredAngles,
  angleCol,
  findingsCol,
  dataRows,
  requireZero = true,
}) {
  const errors = [];
  const warnings = [];
  if (requiredAngles.length === 0) return { errors, warnings };
  if (angleCol < 0) {
    errors.push(
      '「レビューループ記録」の表に系統列がありません（| 周回 | 系統 | 新規所見 | 対応 |。系統セルの受理トークンの正本: scripts/agent/review-angle-tokens.js）',
    );
    return { errors, warnings };
  }
  const { found, unknown, lastCount } = recordedAngles(dataRows, angleCol, findingsCol);
  for (const angle of requiredAngles) {
    const { label, accept } = ANGLE_TOKENS[angle];
    if (!found.has(angle)) {
      errors.push(
        `宣言 Tier に必須の系統「${label}」の実施行がレビューループ記録にありません（受理トークン: ${accept.join(' / ')}）`,
      );
      continue;
    }
    if (!requireZero) continue; // 上限超過（残所見: 列挙）時は系統別の収束までは要求しない
    const count = lastCount.get(angle);
    if (count === null || count === undefined || !/^0+$/.test(count)) {
      errors.push(
        `宣言 Tier に必須の系統「${label}」の直近の実施行が新規所見ゼロ（収束）を示していません（新規所見セルの先頭を数字で始め、解消したら 0 にしてください。系統が確認済みの過去の行のまま放置されています）`,
      );
    }
  }
  if (unknown.size > 0) {
    // 語彙の拡張需要（新レビュー名・タイポ）を観測可能にする。エラーにはしない
    warnings.push(
      `系統セルに受理トークン外の値があります（フロア充足には数えません）: ${[...unknown].map(sanitizeForLogLine).join(' / ')}（受理トークンの正本: scripts/agent/review-angle-tokens.js）`,
    );
  }
  return { errors, warnings };
}

// セル値（GitHub レンダリング後のテキスト）。html ノード（コメント・タグ）は描画テキストで
// ないため含めない（インラインコメントに証拠ポインタを隠す偽装を塞ぐ。旧 stripComments の
// 全文除去と同じ境界）。リンク・画像は URL も値に含める — `[確認済み](tests/foo.test.js)` の
// URL 部が証拠ポインタとして機能する旧挙動（raw セル文字列に URL が見えていた）を維持する
function cellText(cell) {
  const parts = [];
  (function walk(node) {
    if (node.type === 'html') return;
    if (node.type === 'text' || node.type === 'inlineCode') {
      parts.push(node.value);
      return;
    }
    if (node.type === 'image') {
      if (node.alt) parts.push(node.alt);
      if (node.url) parts.push(` ${node.url}`);
      return;
    }
    for (const child of node.children ?? []) walk(child);
    if (node.type === 'link' && node.url) parts.push(` ${node.url}`);
  })(cell);
  return parts.join('').trim();
}

// 打ち消し線（GFM の ~~…~~ = delete ノード）は「取り消された値」を意味する。
// 収束文法セルでは構造的に不合格とする（`~~収束~~` `~~0件~~` を正式な宣言として通さない #396）
function containsDelete(node) {
  if (node.type === 'delete') return true;
  return (node.children ?? []).some(containsDelete);
}

// テンプレの未記入プレースホルダ行（`|  |  |  |` 等、全セル空）でない行
function isNonBlankRow(row) {
  return (row.children ?? []).some((c) => cellText(c) !== '');
}

// ノード列から table ノードを文書順に収集する（リスト内にネストした表も対象。
// 旧実装の行走査はインデントされた表行も拾っていたため、直下のみだと「リスト内の
// 未収束表」が候補から漏れて #44 類の偽装が再発する）。引用（blockquote）中の表は
// 引用された他者の記録であり本人の宣言ではないため対象外（旧実装も `>` 行を拾わない）
function collectTables(nodes) {
  const out = [];
  (function walk(node) {
    if (node.type === 'blockquote') return;
    if (node.type === 'table') {
      out.push(node);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  })({ children: nodes });
  return out;
}

// レビューループ記録の対象テーブルを特定し、列位置と「そのテーブル内の最終データ行」を返す。
// テーブルの塊の境界判定は GFM 拡張の table ノードに委ねる（手書きのブロック分割近似が不要になり、
// 別表隣接・空行なし連結による境界ずらしクラスは構造的に再発しない #403）。
// テーブルが「ループ表候補」となる条件（閉じた選択規則。#38/#42/#44/#45/#46 を一括で塞ぐ）:
//   (1) ヘッダに標準形式の3列「周回」「所見」「対応」がすべてある
//       （周回列も必須。所見＋対応だけの詳細表を末尾に貼ってループ表を上書きする偽装 #46 を排除。
//        片方だけの不完全表を候補にしない #45 も同時に満たす）
//   (2) 非空のデータ行が1つ以上ある（空テンプレ表はスキップ #42）
// ヘッダ語は「周回」「所見」「対応」のみ（「指摘」「問題」等はデータセル「Codex 指摘」に頻出し誤採用するため不可）。
// 複数の候補表がある場合は**最後の候補表**を採る（ゲート目的＝「最後に収束したか」。旧収束表を残して
// 下に未収束表を貼る偽装 #44、ループ表の後に別表を置く偽装 #38 の両方をこれで排除）。
// 候補が1つもなければ呼び出し側で厳格側に倒す（ヘッダなし表の末尾セル後置による迂回 #30 を防ぐ）。
function loopTable(sectionNodes) {
  let result = { findingsCol: -1, actionCol: -1, angleCol: -1, dataRows: [], lastRow: null };
  for (const node of collectTables(sectionNodes)) {
    const rows = node.children ?? [];
    if (rows.length === 0) continue;
    const header = (rows[0].children ?? []).map(cellText);
    const roundCol = header.findIndex((c) => c.includes('周回'));
    const findingsCol = header.findIndex((c) => c.includes('所見'));
    const actionCol = header.findIndex((c) => c.includes('対応'));
    if (roundCol < 0 || findingsCol < 0 || actionCol < 0) continue; // (1) 標準3列が揃う表のみ候補
    const dataRows = rows.slice(1).filter(isNonBlankRow);
    if (dataRows.length === 0) continue; // (2) 非空データ行が必要
    // 系統列は Tier×系統検査（#452）用。候補条件には含めない（旧3列形式の表も候補にした上で
    // 系統列の欠落自体を checkRequiredAngles がエラーにする — 候補から外すと標準形式エラーに
    // 化けて誘導メッセージがずれる）
    const angleCol = header.findIndex((c) => c.includes('系統'));
    result = { findingsCol, actionCol, angleCol, dataRows, lastRow: dataRows[dataRows.length - 1] }; // 最後の候補で上書き
  }
  return result;
}

// レビューループ記録の収束宣言＋Tier 宣言×系統列の検査（full / design / record / docs の全 mandate で共用 #452）
function checkLoopSection({ loopNodes, src, mandate, designDocsChanged, docsOnly }) {
  const errors = [];
  const warnings = [];
  const tierResult = checkTierDecl({ loopNodes, mandate, designDocsChanged, docsOnly });
  errors.push(...tierResult.errors);
  if (tierResult.exempt) {
    // 免除と実効 Tier 宣言の併存は矛盾（レビューを実施した記録があるのに免除を主張する脱出路）
    const effExempt = applyEffectiveTier({
      loopNodes,
      initialRequired: tierResult.requiredAngles,
      exempt: true,
    });
    if (effExempt.errors.length > 0) {
      errors.push(...effExempt.errors);
      return { errors, warnings, exempt: false };
    }
    // docs のみ PR の過剰トリガー免除（Tier: なし（説明・記録文書: 理由））: ループ表は省略可。
    // ただし実施記録の表が併存している場合は矛盾状態として拒否する（レビューを始めて所見が
    // 出た後に免除へ「降格」する脱出路を塞ぐ — 2周目 A-2）。判定は正準ヘッダに依存させず
    // 「非空データ行を持つ表の存在」で行う（`周回`→`回` 等の非正準ヘッダで併存を再開させない
    // — 3周目 O-r3-1。引用ブロック内の表は他者記録として collectTables が既に除外）
    const hasRecordTable = collectTables(loopNodes).some((t) =>
      (t.children ?? []).slice(1).some(isNonBlankRow),
    );
    if (hasRecordTable) {
      const exemptTierName = DOCS_ONLY_MANDATE_INFO[mandate]?.tierName ?? DESIGN_TIER_NAME;
      errors.push(
        `免除宣言（Tier: なし（説明・記録文書: …））とレビューループ表が併存しています（免除するなら表を削除、実施したなら \`Tier: ${exemptTierName}\` で宣言して収束まで記録）`,
      );
      return { errors, warnings, exempt: false };
    }
    return { errors, warnings, exempt: true };
  }
  if (!hasSubstance(sectionSourceLines(src, loopNodes))) {
    // full mandate では REQUIRED_SECTIONS 検査が同じ空エラーを出すため二重報告しない。
    // docs 系 mandate（design/record/docs）は REQUIRED_SECTIONS を通らないためここで報告する
    if (mandate !== 'full') {
      errors.push('必須セクション「レビューループ記録」が空（またはプレースホルダのみ）です');
    }
    return { errors, warnings, exempt: false };
  }
  const { findingsCol, actionCol, angleCol, dataRows, lastRow } = loopTable(loopNodes);
  if (!lastRow) {
    errors.push(
      '「レビューループ記録」は標準形式（| 周回 | 系統 | 新規所見 | 対応 |）のテーブルで記録してください（ヘッダから新規所見・対応列を特定できません）',
    );
    return { errors, warnings, exempt: false };
  }
  const cells = lastRow.children ?? [];
  // 打ち消し線セルは「取り消された値」＝宣言なしとして扱う（構造判定）
  const cellValue = (c) => (c && !containsDelete(c) ? cellText(c) : '');
  const action = cellValue(cells[actionCol]);
  const findings = cellValue(cells[findingsCol]);
  const count = FINDINGS_COUNT.exec(findings);
  if (hasRemainingList(action)) {
    // 上限超過: 残所見の非空・非プレースホルダ列挙があれば収束は要求しない
  } else if (!ACTION_CONVERGED.test(action)) {
    errors.push(
      '「レビューループ記録」に収束宣言がありません（最終行の対応セルに「収束」単独、上限超過時は「残所見: 内容」を列挙）',
    );
  } else if (!count || !/^0+$/.test(count[1])) {
    errors.push(
      '「レビューループ記録」の最終行が「収束」ですが、新規所見がゼロ表記（数字のみ。`0` または `0件`）ではありません（説明はセル外に書き、所見が残る場合は「残所見:」で列挙）',
    );
  }
  // 実効 Tier 宣言があれば必須系統の基準を差し替える（初期 Tier より縮小はできない）
  const effResult = applyEffectiveTier({
    loopNodes,
    initialRequired: tierResult.requiredAngles,
    exempt: false,
  });
  errors.push(...effResult.errors);
  warnings.push(...effResult.warnings);
  const angleResult = checkRequiredAngles({
    requiredAngles: effResult.requiredAngles,
    angleCol,
    findingsCol,
    dataRows,
    // 上限超過（残所見: 列挙）は LIMIT の正規の逃し弁であり、系統別の収束（0件）までは
    // 要求しない（人間判断への申し送りが済んでいるため）。要求するのは通常の収束宣言時のみ
    requireZero: !hasRemainingList(action),
  });
  errors.push(...angleResult.errors);
  warnings.push(...angleResult.warnings);
  return { errors, warnings, exempt: false };
}

const HEADING = /^(#{1,6})\s+(.*)$/;

// 実質的な本文があるか（コメント・プレースホルダ・空行・空テーブルを除く）。
// 判定対象は sectionSourceLines の原文行（プレースホルダ・チェックリストは行構文のため）
// テーブルはヘッダ/区切り行を実質と数えず、区切り行より後の非空データ行のみを実質とする
function hasSubstance(bodyLines) {
  let seenSeparator = false;
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (!line) {
      seenSeparator = false; // 空行でテーブルブロック終端
      continue;
    }
    if (/^<!--.*-->$/.test(line)) continue; // HTMLコメント
    if (/^`{3}/.test(line)) continue; // コードフェンス境界
    if (line === '...' || line === '…') continue;
    if (HEADING.test(line)) continue; // 見出しだけのサブセクションは実質と数えない
    if (/^-\s*\[ \]\s*(\.\.\.|…|（記入）)?$/.test(line)) continue; // 空チェック行プレースホルダ
    if (line.startsWith('|')) {
      const inner = line.replace(/^\|/, '').replace(/\|$/, '').split('|').join('');
      if (/^[-:\s]+$/.test(inner)) {
        seenSeparator = true; // 区切り行
        continue;
      }
      if (inner.replace(/\s/g, '') === '') continue; // 全セル空
      if (!seenSeparator) continue; // 区切り行より前＝ヘッダ行は実質と数えない
      return true; // 非空のデータ行
    }
    return true;
  }
  return false;
}

// 判定欄が「未完了」を示すマーカーのみ、証拠検査から除外する（それ以外の判定値は
// ✅ に限らずすべて「完了主張」とみなし証拠を要求する。「OK」「完了」等での回避を防ぐ）。
const PENDING_VERDICT = /^(|⬜|todo|未(着手|実施|対応|検証)?|―|—|-|\?|？|…)$/i;

// 証拠表セクション内の整合性を検査する
function checkEvidenceIntegrity(tree, src) {
  const errors = [];
  const { found, nodes } = findSection(tree, ['証拠表']);
  if (!found) return errors;

  // 1) チェック済み `- [x]` は証拠ポインタを要する（チェックリストは行構文のため原文行を走査）
  for (const raw of sectionSourceLines(src, nodes)) {
    const m = /^\s*-\s*\[[xX]\]\s*(.*)$/.exec(raw);
    if (!m) continue;
    const text = m[1];
    // 最初の区切り（— / :）以降を証拠とみなす。split+join だと証拠内の区切り文字が
    // 空白へ潰れてパス（file:line 等）が壊れるため、最初の一致位置で切り出す。
    // 半角コロンは後続スペース必須（`src/db.js:42` の行番号コロンをラベル区切りと誤認せず、
    // 区切りなし＝自己証明行を確実に違反にする）。全角コロンはスペース任意
    const dm = text.match(/\s[—–―-]\s|:\s+|：\s?/);
    const evidence = dm ? text.slice(dm.index + dm[0].length).trim() : '';
    // 区切りなしは常に違反とする。緩和（行全体のトークン判定）はラベル内のパスで
    // 自己証明できてしまうため採らない（「- [x] src/lib/db.js を修正済み」が素通りする）
    if (!evidence || lacksEvidence(evidence)) {
      errors.push(
        `証拠表: チェック済み項目に証拠がありません（「- [x] 項目 — 証拠」形式で記載） → 「${text.trim()}」`,
      );
    }
  }

  // 2) テーブル「| 宣言 | 証拠 | 判定 |」: 未完了マーカー以外の判定行は証拠セルが必要
  //    （✅ に限定すると「OK」「完了」等の別表記で証拠なしチェックが通ってしまうため）。
  //    列位置はテーブルごとに独立して検出する（証拠表セクション内に無関係な別テーブルが
  //    併記された場合、その表の行が前段テーブルの列インデックスで誤検査されるのを防ぐ）
  for (const node of collectTables(nodes)) {
    let declCol = -1;
    let evidenceCol = -1;
    let verdictCol = -1;
    for (const row of node.children ?? []) {
      const cells = (row.children ?? []).map(cellText);
      if (evidenceCol === -1 && cells.some((c) => c.includes('証拠'))) {
        declCol = cells.findIndex((c) => c.includes('宣言'));
        evidenceCol = cells.findIndex((c) => c.includes('証拠'));
        verdictCol = cells.findIndex((c) => c.includes('判定'));
        continue; // ヘッダ行
      }
      if (verdictCol === -1 || evidenceCol === -1) continue;
      const decl = declCol >= 0 ? (cells[declCol] ?? '') : '';
      if (declCol >= 0 && !decl) continue; // 宣言列が空の行（テンプレの未記入行）は対象外
      const verdict = cells[verdictCol] ?? '';
      if (PENDING_VERDICT.test(verdict)) continue; // 未完了マーカーは証拠不要
      const ev = cells[evidenceCol] ?? '';
      if (!ev || lacksEvidence(ev)) {
        const start = row.position?.start?.offset;
        const end = row.position?.end?.offset;
        const line =
          start != null && end != null ? src.slice(start, end).trim() : cells.join(' | ');
        errors.push(`証拠表: 完了主張の行に証拠がありません → 「${line}」`);
      }
    }
  }
  return errors;
}

export function checkArtifacts({ changedFiles = [], body = '' }) {
  const errors = [];
  const warnings = [];

  const skip = SKIP_MARKER.exec(body);
  const { codeChanged, depOnly, designDocsChanged, recordDocsChanged, explanatoryDocsChanged } =
    classify(changedFiles);

  if (skip) {
    const reason = (skip[1] || '')
      .trim()
      .replace(/^\(|\)$/g, '')
      .trim();
    if (!reason) {
      errors.push(
        'artifacts-check: skip マーカーに理由がありません（<!-- artifacts-check: skip (理由) -->）',
      );
    } else {
      warnings.push(`artifacts-check をスキップしました（理由: ${sanitizeForLogLine(reason)}）`);
    }
    return { errors, warnings, mandated: false, mandate: 'none' };
  }

  // PR 本文を mdast（GFM テーブル・打ち消し線拡張）で1回だけ構文解析し、以降は AST 走査で
  // 判定する。PR テンプレの説明コメント（例示の「収束」「残所見」「関連issue: なし」等）は
  // コメントノードとして全判定から除外する（#396 の strip-then-parse 方式から #403 で移行）
  const src = body.replace(/\r\n?/g, '\n');
  // mandate 5値（#452・Phase 2）: full=コード変更（従来の必須セット）/ design=実行可能設計文書のみ
  // / record=記憶レコード・構造化記録のみ / docs=その他の説明・履歴文書のみ（design/record/docs は
  // いずれもレビューループ記録＋Tier 宣言のみ必須）/ none=依存 manifest のみ・変更なし（非必須）。
  // docs-only 系の優先順位は design > record > docs（設計文書が最も広い拘束力を持つため）
  const mandate =
    codeChanged && !depOnly
      ? 'full'
      : designDocsChanged
        ? 'design'
        : recordDocsChanged
          ? 'record'
          : explanatoryDocsChanged
            ? 'docs'
            : 'none';
  const mandated = mandate !== 'none';
  const guard = resourceGuardErrors(src);
  if (guard.length > 0) {
    // mandated（full/design/record/docs のいずれか）は資源上限超過を fail-loud にする（迂回させない）。
    // HTML コメント内に本文を隠しても行数・引用ネスト深度は生テキストに対してカウントされるため、
    // ここを警告止まりにすると「必須セクションが空でも exit 0」の回避経路になる（敵対的レビューで検出）
    if (mandated) {
      errors.push(...guard);
    } else {
      // mandate==='none' の内訳（depOnly か真の変更なしか）の文言は下記 depOnly 分岐（880行）と揃える
      const reason = depOnly ? '依存 manifest のみの変更' : '変更なし';
      warnings.push(...guard.map((g) => `${g} — ${reason}のため検査をスキップしました`));
    }
    return { errors, warnings, mandated, mandate };
  }
  const tree = parseBody(src);

  if (mandated) {
    // 未クローズ HTML コメントは文書末まで不可視化し後続の table/list を飲み込むため構造ゲートを回避できる（#415）
    if (hasUnclosedHtmlComment(tree)) {
      errors.push(
        '未クローズの HTML コメント（`<!--`）があります。`-->` で閉じてください（未クローズだと GitHub 上で以降が不可視化され、テーブル等の必須要素が検査から漏れます）',
      );
      // 飲み込まれた本文で必須セクション欠落等の二次エラーが大量に出るため早期リターンで本質エラーのみ提示
      return { errors, warnings, mandated, mandate };
    }
  }
  if (mandate === 'full') {
    // ループセクションは REQUIRED_SECTIONS 検査と収束検査の両方で使うため結果を保持する
    let loop = null;
    for (const sec of REQUIRED_SECTIONS) {
      const { found, nodes } = findSection(tree, sec.keywords);
      if (sec === LOOP_SECTION) loop = { found, nodes };
      if (!found) {
        errors.push(`必須セクション「${sec.name}」が PR 本文にありません`);
      } else if (!hasSubstance(sectionSourceLines(src, nodes))) {
        errors.push(`必須セクション「${sec.name}」が空（またはプレースホルダのみ）です`);
      }
    }
    // 関連 issue（トレーサビリティの下限。closes 漏れによる stale-open を塞ぐ #330 の再発防止）。
    // GitHub 上で連続描画される可視 run 単位で判定する（#417）。属性値・DOCTYPE/宣言・PI・
    // CDATA・script/style 本体など不可視マークアップに `refs #N` を隠す偽装、およびセル/項目
    // 境界をまたいだ連結による偽の参照捏造（`| refs | #1 |`）の双方を塞ぐ
    const visibleRuns = collectVisibleRuns(tree);
    const hasIssueRef = visibleRuns.some((run) => ISSUE_REF.test(run) || NO_ISSUE_DECL.test(run));
    if (!hasIssueRef) {
      errors.push(
        '関連 issue への参照（closes #番号 / refs #番号 形式）が PR 本文にありません（対応 issue がない場合は「関連issue: なし（理由）」を明記）',
      );
    }
    // レビューループ記録は収束宣言＋Tier 宣言×系統列を要する（1回レビューして終わりの黙認と
    // Tier で定義した系統の起動漏れ #448 クラスの双方を塞ぐ #452）。
    // 旧ラウンドの「収束」セルが残ったまま新ラウンド行を追記しても通らないよう最終実質行のみを
    // 判定対象にし、判定は raw 行の正規表現ではなくヘッダで特定した列のセル値に対して行う
    // （raw 行マッチはエスケープ済みパイプ（未\|収束）や別セルの「収束」で偽装できる）
    if (loop.found) {
      const loopResult = checkLoopSection({
        loopNodes: loop.nodes,
        src,
        mandate,
        designDocsChanged,
        docsOnly: !codeChanged,
      });
      errors.push(...loopResult.errors);
      warnings.push(...loopResult.warnings);
    }
  } else if (mandate in DOCS_ONLY_MANDATE_INFO) {
    // docs のみの変更（design/record/docs）: レビューループ記録（Tier 宣言＋当該 Tier の必須系統の
    // 実施記録）のみを必須化する。完了条件・想定ケース等はコード実装の artifact のため要求しない
    // （#452。Record/Docs は Phase 2 で追加）。免除は Tier: なし（説明・記録文書: 理由）の宣言で行う
    // （skip マーカーは全検査を消すため過大）
    const { label, tierName } = DOCS_ONLY_MANDATE_INFO[mandate];
    const requiredLabel = TIER_ANGLES[tierName].map((a) => ANGLE_TOKENS[a].label).join('・');
    const { found, nodes } = findSection(tree, LOOP_SECTION.keywords);
    if (!found) {
      errors.push(
        `${label}に触れる変更のため「レビューループ記録」（Tier 宣言＋${requiredLabel}の実施記録）が必須です（免除は \`Tier: なし（説明・記録文書: 理由）\` を同セクションに記載。正本: docs/agent-workflows/review-angles/README.md「Tier（対象系統の判定・コスト制御）」）`,
      );
    } else {
      const loopResult = checkLoopSection({
        loopNodes: nodes,
        src,
        mandate,
        designDocsChanged,
        docsOnly: !codeChanged,
      });
      errors.push(...loopResult.errors);
      warnings.push(...loopResult.warnings);
      if (loopResult.exempt) {
        warnings.push(`${tierName} Tier を免除しました（Tier: なし（説明・記録文書: …）宣言）`);
      }
    }
  } else if (depOnly) {
    warnings.push(
      '依存 manifest のみの変更のため artifact を必須化しません（依存レビューは別途実施）',
    );
  } else {
    warnings.push('変更なしのため artifact を必須化しません');
  }

  // 証拠表があれば（必須でなくても）整合性は検査する
  errors.push(...checkEvidenceIntegrity(tree, src));

  return { errors, warnings, mandated, mandate };
}

// --- 証明行（proof line） ---
// artifacts-gate の実行結果が「どの PR の・どの head SHA の・どの本文に対する・どういう
// 判定結果の検証か」を run の出力自体に埋め込む。ci-run.md の merge 前必須確認は、GitHub の
// check-run がテストマージコミットに紐づき head SHA と一致しない場合があるため（GitHub 仕様）、
// check-run のメタデータではなく run 出力内のこの行を根拠に照合する。設計根拠・不採用案は
// docs/planning/ci-split-design.md §11 を正本とする（ここには複製しない）。
//
// PROOF_LINE_RE は行全体との完全一致のみ受理する（部分一致・埋め込みは受理しない）が、これは
// check-artifacts.js 自身が組み立てる出力（警告・エラー文言）を対象にした対策に過ぎない。
// 敵対的レビュー3周目で、GitHub Actions runner 自身が step の `with:` 入力（`changed-files`/
// `pr-body`）をジョブログへ列0・逐語で出力する（Print Action Details。check-artifacts.js の
// 出力経路を一切通らない）ことを悪用し、証明行と同じ書式の**ファイル名**を1つ commit へ混入
// させるだけで「行全体一致する偽の証明行」をログに恒久的に注入できることが実証された（PR 本文
// 経由は body-sha256 が自己参照になり固定点問題で不成立だが、ファイル名にはその制約が無い）。
// この経路は行全体一致・改行除去のいずれでも防げない（攻撃者の入力自体が単独行として渡される
// ため）。対策として、証明行に **run=<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>** を含める。この値は
// GitHub がその run を実際にスケジュールした時点で初めて確定する（commit を作る時点の攻撃者は
// 将来どの run_id が割り当たるか予測できない）ため、事前に用意したファイル名では正しい run= を
// 埋め込めない。検証側は run_id を証明行のテキストからではなく Actions API から独立に取得して
// 突き合わせる（ci-run.md §3a）。
const PROOF_LINE_PREFIX = 'check-artifacts: proof';
const PROOF_LINE_ESCAPED_PREFIX = PROOF_LINE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// pr= は '#' 付き数値、head= は英数字（SHA）、body-sha256= は16進64桁、result= は ok/failed、
// run= は `<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`。
const PROOF_LINE_RE = new RegExp(
  `^${PROOF_LINE_ESCAPED_PREFIX} pr=#(\\S+) head=(\\S+) body-sha256=(\\S+) result=(ok|failed) run=(\\S+)$`,
);

// 本文の取得経路（API 直接取得 vs ファイル保存）で改行コード・末尾改行・BOM の有無が変わり、
// 生バイトの sha256 では意味的に同一の本文が不一致になるため、LF に正規化し、BOM を落とし、
// 末尾の空行を畳んでからハッシュ化する（内容の実質的な変更は区別しつつ、転記経路が生む差異は
// 無視する）。
function normalizeBodyForHash(body) {
  return String(body ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/, '');
}

// GitHub Actions のジョブログ実物は、各行の先頭に `2026-08-04T04:58:39.1234567Z ` 形式の
// ISO8601 タイムスタンプが付く（`get_job_logs` の生テキストにそのまま含まれる）。証明行の
// 行全体一致はこのタイムスタンプ込みでは成立しないため、既知の書式（数字のみで構成される
// タイムスタンプ）だけを剥がしてから判定する。攻撃者が制御できるテキスト（PR 本文・警告
// メッセージ）はこの固定書式を名乗れないため、行全体一致による偽装対策は保たれる。
const LOG_TIMESTAMP_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;
function stripLogTimestamp(line) {
  return line.replace(LOG_TIMESTAMP_PREFIX_RE, '');
}

export function computeBodyHash(body) {
  return createHash('sha256').update(normalizeBodyForHash(body), 'utf-8').digest('hex');
}

export function formatProofLine({ prNumber, headSha, bodyHash, result, runId }) {
  return `${PROOF_LINE_PREFIX} pr=#${prNumber} head=${headSha} body-sha256=${bodyHash} result=${result} run=${runId}`;
}

// 複数の証明行が含まれる出力（同一 run の再実行ログ連結等）では最後の1件を正とする
// （本ファイル内の Tier 宣言・ループ表選択と同じ「最後の候補で上書き」規約に合わせる）。
// 各行は PROOF_LINE_RE で行全体一致のみ受理する（埋め込みは受理しない。上記コメント参照）。
export function parseProofLine(text) {
  let last = null;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const m = stripLogTimestamp(rawLine).match(PROOF_LINE_RE);
    if (m) last = { prNumber: m[1], headSha: m[2], bodyHash: m[3], result: m[4], runId: m[5] };
  }
  return last;
}

// pr番号・head SHA・本文ハッシュ・run ID の4値すべてが一致する場合のみ true。
// いずれか1つでも異なれば「push」「本文編集」等で検証時点から状態が変わった、または
// 検証対象の run 自体が違うと判定する。result（ok/failed）はここでは比較しない —
// 呼び出し側が「同一状態の検証か」と「その検証が成功したか」を別々に扱えるようにする
// （真偽値1つに畳むと、失敗 run の証明行が「一致」を理由にそのまま合格と誤読される）。
// run ID は攻撃者が事前に予測できない値（GitHub がその run を実際にスケジュールした時点で
// 確定）であるため、他の3値をログ注入で偽装できても run ID までは事前に用意できない
// （敵対的レビュー3周目 ADV-r3-1: runner 自身が `with:` 入力を逐語ログ出力する経路の対策）。
export function proofLineMatches(parsed, expected) {
  if (!parsed) return false;
  return (
    String(parsed.prNumber) === String(expected.prNumber) &&
    // SHA は大文字小文字を区別しない（git の仕様）。--head-sha に大文字を渡しても、
    // 常に小文字で出力される証明行と不一致にならないよう正規化して比較する。
    parsed.headSha.toLowerCase() === String(expected.headSha).toLowerCase() &&
    parsed.bodyHash === expected.bodyHash &&
    parsed.runId === String(expected.runId)
  );
}

// --- CLI ---
function readArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requireArg(name) {
  const value = readArg(name);
  if (!value) {
    console.error(`check-artifacts --verify-proof: ${name} <値> が必須です`);
    process.exit(1);
  }
  return value;
}

function resolveBody() {
  const bodyFile = readArg('--body-file');
  if (bodyFile) return readFileSync(bodyFile, 'utf-8');
  if (process.env.PR_BODY != null) return process.env.PR_BODY;
  const inline = readArg('--body');
  if (inline != null) return inline;
  return '';
}

// --base CLI 引数 / BASE_REF 環境変数 / デフォルト 'origin/main' の解決を1箇所に集約する
// （#446 round3 品質: resolveChangedFiles・エラーメッセージ2箇所で式が重複していた）。
function resolveBaseRef() {
  return readArg('--base') || process.env.BASE_REF || 'origin/main';
}

// base との差分ファイル一覧。git 実行不能時、または base が "-" 始まり（git オプション注入
// 拒否）の場合は null（呼び出し側が fail-open / 空扱いを選ぶ）。CLI・PreToolUse hook
// （scripts/agent/hooks/check-pr-body.js）で共用し、分類基準の drift を防ぐ
export function gitChangedFiles(base = 'origin/main') {
  if (base.startsWith('-')) {
    // git は "-" 始まりの引数をオプションとして解釈しうる。--base / BASE_REF が外部制御になり
    // 得る経路（呼び出し元 workflow・hook の base 引数）でオプション注入により diff の出力が
    // 意図せず変化する（空になれば fail-open で必須検査が丸ごと skip される）のを防ぐ
    // （#446 round2 観点別レビュー 敵対的）。
    console.error(
      `check-artifacts: base の値が "-" で始まっています（値: ${base}）。git オプション注入を避けるため拒否します。`,
    );
    return null;
  }
  try {
    // --no-renames / -c core.quotepath=off: rename の旧パス消失・非 ASCII パスの C-quote による
    // 分類パターン不一致を防ぐ（ci.yml の changes ジョブと同じ理由。#446 観点別レビュー 敵対的F1/F9）。
    const out = execFileSync(
      'git',
      ['-c', 'core.quotepath=off', 'diff', '--no-renames', '--name-only', `${base}...HEAD`],
      {
        encoding: 'utf-8',
      },
    );
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

// CHANGED_FILES 環境変数がない場合は git 呼び出しに落ちる。git が失敗したら null を返す
// （空配列にフォールバックしない — 「変更なし」と「取得失敗」を区別しないと、ローカル事前
// チェック（create-pr.md 手順3.5）が git エラー時にサイレントで「artifact 不要」を返し、
// 本来必須のはずの本文チェックを素通りさせてしまう）
function resolveChangedFiles() {
  const env = process.env.CHANGED_FILES;
  // 改行のみで分割する（空白区切りは廃止。classify-changes.js の CLI と同じ理由 #446 round3:
  // ファイル名に空白を含みうるため誤分割を避ける）。
  if (env)
    return env
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  const base = resolveBaseRef();
  return gitChangedFiles(base);
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const RUN_ID_RE = /^\d+-\d+$/;

// 値を pr=.../head=.../body-sha256=... の形で示す。formatProofLine と意図的に別書式にし、
// parseProofLine で再び「証明行」として受理されないようにする（この出力を別の検証呼び出しの
// ログとして再投入しても合格しない — 自己鍛造オラクル対策。全ての人間向け出力箇所がこの
// 1関数を経由することで、書式を作り直すたびに対策が抜けるのを防ぐ）。
function describeProofState({ prNumber, headSha, bodyHash, result, runId }) {
  let s = `pr=${prNumber}, head=${headSha}, body-sha256=${bodyHash}`;
  if (result) s += `, result=${result}`;
  if (runId) s += `, run=${runId}`;
  return s;
}

// ファイルを読み、失敗時は「不一致」ではなく「確認不能」として fail-loud する（ci-run.md §4
// 「workflow の起動・完了状態を確認できない場合」の分岐。原因〔ファイル取得の失敗〕と無関係な
// 「本文編集して再走」への誤誘導を避ける）。
function readFileOrExitUnverifiable(path, label) {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    console.error(
      `check-artifacts --verify-proof: 確認不能（${label}を読めません: ${path}）: ${err.message}`,
    );
    console.error(
      '  この状態は「不一致」ではありません。取得手順を見直すか、確認不能である事実を人間へ報告してください（ci-run.md §4）。',
    );
    process.exit(1);
  }
}

// --verify-proof: artifacts-gate run のログから証明行を取り出し、現在の PR 状態（PR番号・
// head SHA・本文）と完全一致し、かつその run の判定結果（result）が ok であることを確認する。
// ci-run.md §3b が実際に呼ぶ経路。
function runVerifyProofCli() {
  const logFile = requireArg('--log-file');
  let prNumber = requireArg('--pr-number');
  const headSha = requireArg('--head-sha');
  const bodyFile = requireArg('--body-file');
  // run ID は Actions API から独立に取得した値を渡す（ログ本文からは絶対に取らない —
  // ログに書かれた run= を信用すると、その値ごと偽造される経路をふさぐ意味が無くなる）。
  const runId = requireArg('--run-id');

  // 証明行の表示（pr=#553）をそのまま貼ると `#` 付きで渡しがちなので剥がす。head SHA は
  // 表記揺れを許容せず、フル40桁でなければ「不一致」ではなく引数エラーとして扱う（短縮 SHA
  // の自然な誤用は ci.yml の head_sha 完全一致要求と同じ基準で弾く）。
  prNumber = prNumber.replace(/^#/, '');
  if (!FULL_SHA_RE.test(headSha)) {
    console.error(
      `check-artifacts --verify-proof: --head-sha はフル40桁の SHA を指定してください（受け取った値: ${headSha}）。短縮 SHA は不可です。`,
    );
    process.exit(1);
  }
  // run_attempt を落として `--run-id <id>` とだけ渡す誤用は自然に起こりうる（API が id と
  // run_attempt を別フィールドで返すため）。これも「不一致」ではなく引数エラーとして扱う
  // （落とすと --head-sha と同じ非収束ループになる）。
  if (!RUN_ID_RE.test(runId)) {
    console.error(
      `check-artifacts --verify-proof: --run-id は "<run id>-<run attempt>" 形式で指定してください（受け取った値: ${runId}）。`,
    );
    process.exit(1);
  }

  const log = readFileOrExitUnverifiable(logFile, 'ログファイル');
  const body = readFileOrExitUnverifiable(bodyFile, '本文ファイル');

  const parsed = parseProofLine(log);
  const expected = { prNumber, headSha, bodyHash: computeBodyHash(body), runId };
  if (proofLineMatches(parsed, expected) && parsed.result === 'ok') {
    process.stdout.write(
      `check-artifacts --verify-proof: OK（${describeProofState({ ...expected, result: 'ok' })} が run の証明行と一致）\n`,
    );
    return;
  }

  console.error('check-artifacts --verify-proof: 証明行が現在の PR 状態と一致しません');
  if (!parsed) {
    console.error('  run の証明行: (証明行が見つからない)');
    console.error(
      '  この状態は「不一致」ではなく「証明行が見つからない」です。ci-run.md §3c により「確認不能」と同じ扱い —' +
        ' 本文編集や再走で解消を試みず、未検証項目として人間へ報告してください。',
    );
  } else if (!proofLineMatches(parsed, expected)) {
    console.error(`  run の証明行: ${describeProofState(parsed)}`);
    console.error(`  現在の PR 状態: ${describeProofState(expected)}`);
    const onlyRunIdDiffers =
      String(parsed.prNumber) === String(expected.prNumber) &&
      parsed.headSha.toLowerCase() === String(expected.headSha).toLowerCase() &&
      parsed.bodyHash === expected.bodyHash &&
      parsed.runId !== String(expected.runId);
    if (onlyRunIdDiffers) {
      // run ID だけが食い違うのは「push・本文編集」では起きない（それらは head SHA・
      // body-sha256 も変える）。§3a をやり直さず古い --run-id を使い回した誤用が最も多い
      // 原因だが、ADV-r3-1（runner の with: 逐語出力を悪用した偽装）が現在の run ID とだけ
      // たまたま一致しなかったケースもここに現れうるため、単純な再走誘導では済ませない。
      console.error(
        '  pr/head/body-sha256 は一致していますが run ID だけが食い違っています。ci-run.md §3a を最初からやり直し、最新の run の id/run_attempt を控え直してから再度実行してください。やり直しても解消しない場合は、偽装された証明行が混入している可能性があるため、確認不能として人間へ報告してください（本文編集・再走で解消を試みない）。',
      );
    } else {
      console.error(
        '  push・本文編集のいずれかで状態が変わった古い run の可能性があります。最新の run を再確認するか、artifacts-gate を再走してください。',
      );
    }
  } else {
    console.error(
      `  pr/head/body-sha256/run は一致していますが、run の判定結果は result=${parsed.result}（artifacts-gate 自体が失敗しています。run 自体の失敗原因を修正してください）`,
    );
  }
  process.exit(1);
}

// bundled local action（.github/actions/artifacts-gate）と CLI で同一の実行本体を共有する。
// ncc バンドル内では全モジュールの import.meta.url が dist/index.js を指すが、末尾の自己起動
// ガードは basename 判定のため dist/index.js からは誤発火しない（entry が runCli を明示的に一度だけ呼ぶ）。
export function runCli() {
  if (process.argv.includes('--verify-proof')) {
    runVerifyProofCli();
    return;
  }

  const changedFiles = resolveChangedFiles();
  if (changedFiles === null) {
    console.error(
      `check-artifacts: git 差分の取得に失敗しました（base: ${resolveBaseRef()}）。ベースブランチが fetch 済みか、shallow clone で merge-base が辿れているか確認してください。`,
    );
    process.exit(1);
  }
  if (changedFiles.length === 0) {
    // 検査対象なしとして続行する（現状維持）。ただし CI の changes ジョブ
    // （classify-changes.js）は同じ「空入力」を fail-closed（全 true）で扱うため非対称で
    // あることを明示する（呼び出し元がローカル事前確認か CI 経由かに関わらず経路中立な文言。
    // #446 round3 観点別レビュー 運用性。GitHub Actions 上では annotation として出す —
    // 既存の warnings ループと同じ理由）。base は git 経路（CHANGED_FILES 未設定で
    // gitChangedFiles にフォールバックした場合）のみ意味を持つため、CHANGED_FILES env が
    // 使われた場合は表示しない（#446 round4 観点別レビュー 運用性N3・仕様参考: env 経由でも
    // base を表示すると読み手が「base の値がこの 0 件差分に関与した」と誤解する）。
    const usedGitFallback = !process.env.CHANGED_FILES;
    const baseNote = usedGitFallback ? `（base=${resolveBaseRef()}）` : '';
    const message = `check-artifacts: 変更ファイルが 0 件でした${baseNote}。検査対象なしとして続行しますが、CI の changes ジョブは空入力を全 true（fail-closed）で扱う点が非対称です。`;
    if (process.env.GITHUB_ACTIONS) console.warn(`::warning::${escapeWorkflowData(message)}`);
    else console.error(message);
  }

  const body = resolveBody();
  const { errors, warnings, mandated, mandate } = checkArtifacts({ changedFiles, body });

  // PR_NUMBER / HEAD_SHA / GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT がすべて渡された場合
  // （bundled action 経由）のみ証明行を出す。ローカル CLI 単体実行（create-pr.md 手順3.5 等）
  // では未設定のため出力されない（既存の「証明行がない = CLI 単体実行」という区別を壊さない）。
  // 4つ全部を要求するのは、一部だけ揃った状態で run=undefined-undefined のような壊れた証明行
  // を黙って出さないため（コード品質レビュー: action 側の fail-loud ガードは `GITHUB_ACTIONS`
  // が立っている場合のみ働き、ここを2値のままにすると手動デバッグ経路等でガードを経由せず
  // 壊れた証明行が漏れる非対称が残っていた）。result はこの run の判定結果（ok/failed）を
  // 束縛する — 証明行の一致だけでは「どの状態を検証したか」しかわからず「その検証が通ったか」
  // を保証しないため。checkArtifacts() の結果が確定した直後・errors 分岐で exit する前に出す
  // （成功・失敗のどちらの経路でも必ず出力される位置に置く）。
  if (
    process.env.PR_NUMBER &&
    process.env.HEAD_SHA &&
    process.env.GITHUB_RUN_ID &&
    process.env.GITHUB_RUN_ATTEMPT
  ) {
    process.stdout.write(
      `${formatProofLine({
        prNumber: process.env.PR_NUMBER,
        headSha: process.env.HEAD_SHA,
        bodyHash: computeBodyHash(body),
        result: errors.length > 0 ? 'failed' : 'ok',
        runId: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
      })}\n`,
    );
  }

  // GitHub Actions 上では警告を annotation として出す（緑ジョブの stdout に埋もれて
  // 語彙の拡張需要・免除の観測が不能になるのを防ぐ — 2周目 O-2。checks UI に表示される）
  for (const w of warnings) {
    if (process.env.GITHUB_ACTIONS)
      console.warn(`::warning::${escapeWorkflowData(`check-artifacts: ${w}`)}`);
    else console.warn(`check-artifacts: ⚠ ${w}`);
  }

  if (errors.length > 0) {
    console.error('check-artifacts: 完了主張 artifact の検証に失敗しました:\n');
    for (const e of errors) console.error(`  ✗ ${e}`);
    // フッタの誘導は mandate に合わせる（docs 系 mandate に5セクション全記載を指示すると
    // エラー本文と矛盾する）
    console.error(
      mandate in DOCS_ONLY_MANDATE_INFO
        ? `\n${DOCS_ONLY_MANDATE_INFO[mandate].label}の PR は「レビューループ記録」（Tier 宣言行＋必須系統の実施記録）のみ必須です（docs/agent-workflows/review-angles/README.md「Tier（対象系統の判定・コスト制御）」）。`
        : '\n完了条件・想定ケース・既存実装調査・証拠表・レビューループ記録を PR 本文に記載してください（docs/agent-workflows/evidence-check.md, docs/agent-workflows/codebase-recon.md）。',
    );
    console.error(
      '例外時は <!-- artifacts-check: skip (理由) --> を PR 本文に明記してください（理由は diff に残ります）。',
    );
    process.exit(1);
  }

  process.stdout.write(
    mandated
      ? 'check-artifacts: OK（必須 artifact を確認）\n'
      : 'check-artifacts: OK（artifact 必須対象外）\n',
  );
}

// 自己起動ガード。basename も併せて判定するのは ncc バンドル（.github/actions/artifacts-gate/
// dist/index.js）対策: バンドル内では全モジュールの import.meta.url が entry と一致してしまうため、
// basename 判定を足すことで dist/index.js から本ファイルが誤って CLI 起動するのを防ぐ（#428）。
// パス区切りは / と \ の両方を許容し、`some-check-artifacts.js` 等の部分一致を弾く（末尾完全一致）。
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])check-artifacts\.js$/.test(process.argv[1])
) {
  runCli();
}

// 分類は classify-changes.js を単一ソースとする（check-artifacts.js と同じ分類基準を共有）。
// 構造判定（セクション抽出・HTML コメント除去）は check-artifacts.js と共有の mdast-body.js に
// 委譲する（#409。行ベース判定の穴〔複数行コメント・外側パイプなし表・リスト形式〕の個別対応が
// イタチごっこ化したため）。ただしコードフェンス除去だけは行ベース pre-pass を維持する —
// micromark は CommonMark 準拠でフェンス開始を 0〜3 スペースに制限するため、素朴に mdast へ
// 委譲すると 4スペース/タブインデントのフェンス開始を見落とし、#408 で実証されたバイパス
// （フェンス内の偽装コンテンツが可視化されて受理される）が再発する。stripFencedLines 参照。
import { classify } from './classify-changes.js';
import { parseBody, resourceGuardErrors, findSection, sectionSourceLines } from './mdast-body.js';

// 「plan モードの機械的下限ゲート」。
// 目的: plan → 実装の遷移（ExitPlanMode）時に、実装前ワークフローの成果物
// （想定ケース表・既存実装調査表）または工程明記（/risk-modeling・/codebase-recon）が
// plan に無いまま実装へ進むのを塞ぐ。検証できるのは存在・形式まで。記述の真偽・実施の
// 実態は PR 段階の artifacts-gate と cross-model の evidence-check に残す。
// 呼び出し元: scripts/agent/hooks/check-plan-gates.js（ExitPlanMode PreToolUse hook）
// 詳細: docs/ai/rules/verification-gates.md / docs/agent-workflows/risk-modeling.md

const PLAN_SKIP_MARKER = /<!--\s*plan-gate:\s*skip\b([^>]*)-->/i;

// 貼り付け事故等の巨大 plan で正規表現・行走査が暴走しないための上限（先頭のみ検査）
const MAX_PLAN_LENGTH = 1_000_000;

// パス風トークン。セグメントは非空白・非区切り文字（全角ファイル名も許容）、拡張子には
// 英字を要求する（日付 2026/07/11・バージョン 1.2.3 を誤認しない。`Node.js`・`3.x` の
// ようなライブラリ名・バージョン表記は誤認して code 側＝厳格側に倒れる。脱出は skip マーカー）。
// 区切り文字には角括弧・波括弧・カンマ・セミコロン・`*`・`+`・`=`・全角中黒「・」・全角カンマ
// 「，」も含める（無いと空白なしで隣接する複数パス「foo.js,docs/README.md」
// 「foo.js・docs/README.md」が1トークンに結合し、末尾拡張子で prose 誤判定されてゲートを
// すり抜ける #408 Gemini 指摘）。日本語の助詞（「foo.jsとdocs/README.mdを更新」の「と」等）
// による区切りなし結合は、区切り文字の追加では閉じきれない別クラスの穴として残る
// （既知の制限。CODE_ROOT_MENTION 併用と skip マーカーで部分的に緩和する）
// 量指定子はすべて上限付き（check-artifacts.js の EVIDENCE_POINTER と同じ ReDoS 対策）
const PATH_TOKEN = /[^\s|:：、。「」()（）<>"'`[\]{}*,;+=・，]{1,300}\.(?=\w*[a-z])\w{1,6}\b/gi;
// 拡張子を持たない既知のコードファイル。これが無いと「Dockerfile と docs/README.md を
// 更新」のような plan が prose パスだけを抽出されて docs-only 判定をすり抜ける
const EXTENSIONLESS_CODE_FILE = /\b(?:Dockerfile|Makefile|Justfile)\b/g;
// 先頭ドット + 拡張子区切りのないファイル言及（.env / .npmrc / .prettierignore 等）。
// PATH_TOKEN は「セグメント.拡張子」を要求するため先頭ドットのみのファイルを拾えず、
// 「CLAUDE.md と .env を更新」のような plan が prose パスだけを抽出されて docs-only 判定を
// すり抜ける（#408 Codex 指摘）。前が単語文字・ドット・区切りでないことを要求し、
// `foo.env`（PATH_TOKEN が拾う）や URL 内・`Node.js` の誤マッチを避ける。
// #408 では既知 dotfile の許可リストだったが、リスト漏れ（.prettierignore 等）が
// 「緩み側バイパス」として恒常的に発生するため汎用トークンへ一般化（#409）:
// 抽出後に (a) 拡張子の単独言及（「.js を追加」等）をデノリストで除外し、
// (b) classify()（isCode: prose ディレクトリ配下でも不活性データ拡張子以外はすべて code。#446）へ委ねる。
// この構成では失敗モードが「デノリスト漏れ = 厳格側誤検知（skip マーカーで脱出可）」に
// 反転し、緩み側には倒れない（追加トークンは mandated を false→true にしか動かせない）。
// 数字始まりの dotfile（.1password 等）は先頭英字要求のため不抽出（受容する既知の制限）
// 後続にパスセグメントが続く場合はパス全体を 1 トークンとして拾う — 先頭セグメントだけを
// 切り出すと classify が誤判定する（`.claude/agents/foo.md` から `.claude` を切り出すと
// PROSE_PATTERNS は末尾スラッシュ必須〔/^\.claude\//〕のため code 誤判定。#446 round3:
// settings.json は現在 code 扱いのため例示から外した）。逆にパス部を
// 捨てる（後続 / を lookahead で除外する）と、拡張子なしの dot ディレクトリ配下パス
// （`.github/workflows` 等。PATH_TOKEN は拡張子必須のため拾えない）がどのチャネルからも
// 抽出されず docs-only 誤判定になる（#409 レビューで実測）。パス部の文字クラスは PATH_TOKEN と同一。
// 先頭ドットの直前は `/`・`\` も許容する（セグメント途中の dotfile も拾う）— 直前が単語文字
// なら通常拡張子（`README.md` の `.md` 等）として PATH_TOKEN 側に委ねるため引き続き除外する。
// `/`・`\` を許容しないと `config/.eslintrc`・`packages/x/.prettierrc` のような「先頭セグメント
// ではないネスト dotfile」（拡張子名が PATH_TOKEN の \w{1,6} 上限を超える名前）がどのチャネルにも
// 拾われず docs-only 誤判定になる（#411 code-review で実測）
const GENERIC_DOTFILE =
  /(?<![\w.-])\.(?!\.)[A-Za-z][\w-]{1,64}(?:\.\w{1,10})*\b(?:[/\\][^\s|:：、。「」()（）<>"'`[\]{}*,;+=・，]{1,300})?/g;
// 「拡張子そのものへの言及」をファイル名と誤認しないためのデノリスト（完全一致のみ）。
// `.md` 等の prose 拡張子は classify が落とすため本来不要だが、意図の明確化のため含める。
// 拡張子と同名のファイル（`.lock` という名の実ファイル等）は不抽出になる — 一般化設計の
// 「デノリスト漏れ = 厳格側」の唯一の例外だが、実在性が低いため受容する既知の制限
const EXTENSION_ONLY =
  /^\.(?:jsx?|tsx?|d\.ts|mts|cts|mjs|cjs|css|scss|less|sass|vue|svelte|html?|json|ya?ml|toml|md|mdx|txt|svg|png|jpe?g|gif|webp|ico|sh|py|rb|go|rs|java|sql|xml|wasm|lock|log|csv|tsv|pdf|zip)$/i;
// 拡張子を伴わない既知のコードルートディレクトリ言及（「src/lib のなんとかを直す」等）。
// PATH_TOKEN は拡張子付きトークンしか拾わないため、抽出パスが全て prose（.md 等）に
// なる場合に mandated=false へ落ちてしまう穴を塞ぐ（#408 Codex 指摘）。末尾スラッシュを
// 要求しない（「worker のコードを直す」「src 配下」のような自然な言い方も拾う）。
// 誤マッチしても厳格側（mandated=true）に倒れるだけで緩み側の実害はないため、
// リストは本リポジトリの既知ソースルートに限定してよい。
// 大文字表記（「Cloudflare Worker」等、本リポジトリ CLAUDE.md 自身が使う固有名詞的表記）も
// 拾えるよう大文字小文字を区別しない（#408 Codex 再指摘）。誤マッチしても厳格側に倒れるだけ
const CODE_ROOT_MENTION = /\b(?:src|scripts|worker|tests|e2e|bench)\b/i;
// URL 内のパス風トークン（https://…/foo.js）を変更対象と誤認しないよう先に除去する
const URL_TOKEN = /https?:\/\/[^\s)>"'`]{1,300}/gi;

// CRLF 正規化して行配列にする（check-artifacts.js の旧 splitLines 相当。mdast 移行で
// 同関数は check-artifacts から消えたため plan ゲート側に持つ）
function splitLines(body) {
  return body.replace(/\r\n?/g, '\n').split('\n');
}

// コードフェンス内の行を空行化する（開始・終了の境界行ごと）。フェンス内の見出し例・
// マーカー例・工程名の例示を実物と誤認しないため、受理側の判定はフェンス外に限定する。
// 「行の削除」ではなく「空行への置換」にする: 出力は mdast パースの入力になるため、削除だと
// フェンス前後の行が隣接して本来分離していたブロックが結合しうる（例: フェンスが表を分断して
// いた場合に区切り行とデータ行が隣接し偽の表が合成される）。空行はブロック境界なので安全。
// CommonMark と同様、閉じフェンスは開始と同種の文字・同長以上のみ（``` 内の ~~~ 行で
// 状態が反転し、フェンス内の例示が受理側へ漏れるのを防ぐ）。閉じ忘れは末尾まで不可視。
//
// 開始・終了で意図的に非対称にする:
// - 開始（FENCE_LINE）はインデント無制限（タブ含む）のまま緩く保つ。タブインデント・
//   ネストリスト内（4スペース以上）のフェンス開始を見落とすと、隠すべき内容が「可視」側に
//   漏れて受理されてしまう（緩み側の実害）ため、開始側の見落としは常に危険。
// - 終了（FENCE_CLOSE_LINE）は CommonMark 仕様どおり 0〜3 スペースのみを終了とみなす。
//   フェンス内部に4スペースインデントの偽装 ``` 行を仕込んで早期クローズさせ、フェンス内の
//   偽装コンテンツ（見出し例・工程トークン）を受理側に漏らすバイパスが成立していた
//   （#408 Gemini 指摘・実バイパスを確認）。終了側の見落とし（タブや深いインデントの閉じ
//   マーカーを認識しない）は「フェンスが閉じずに以降を隠す」厳格側（誤ブロック）にしか
//   ならないため安全（脱出は skip マーカー）。
// 開始・終了を同一インデント上限に揃えると、開始側の見落としが上記の緩み側バイパスを
// 再導入する（レビュー再検証で確認済み）ため、あえて別の正規表現にしている
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE_LINE = /^[ ]{0,3}(`{3,}|~{3,})\s*$/;
function stripFencedLines(lines) {
  const out = [];
  let fence = null; // { char, len }
  for (const line of lines) {
    const m = FENCE_LINE.exec(line);
    if (m) {
      const [char, len] = [m[1][0], m[1].length];
      if (fence === null) {
        fence = { char, len };
        out.push('');
        continue;
      }
      if (char === fence.char && len >= fence.len && FENCE_CLOSE_LINE.test(line)) {
        fence = null;
        out.push('');
        continue;
      }
    }
    out.push(fence === null ? line : '');
  }
  return out;
}

// plan 本文からパス風トークンを抽出する。コードフェンス内も含めて拾う
// （フェンス内のコードパス言及も「コード変更計画」の根拠になる。除外すると
// フェンス内にだけコードパスを書いた plan が docs-only 判定をすり抜ける）
export function extractPlanPaths(plan) {
  const text = plan.replace(URL_TOKEN, ' ');
  // Windows 風バックスラッシュ区切りを forward-slash に正規化する。classify の
  // PROSE_PATTERNS は `/` 固定のため、`.claude\agents\foo.md` のような backslash パスは
  // prose 判定を外れて厳格側（mandated=true）に誤判定される（#411 Gemini 指摘。#446 round3:
  // settings.json は現在 code 扱いのため例示から外した）。
  // 正規化は forward-slash と同一挙動にするだけで新たな緩みは生まない（backslash==forward。
  // real code path は正規化後も非 prose のまま mandated=true）
  const norm = (token) => token.replace(/\\/g, '/');
  // Set で raw match の完全一致重複を除いてから処理する。ログ貼り付け等で同一 dotfile が
  // 大量重複した場合の classify() 呼び出し（PROSE_PATTERNS 7 個ループ）を無駄に繰り返さない。
  // 生存トークンの集合は不変（重複排除のみ）— チャネル間重複（PATH_TOKEN 等との重複）は
  // 従来どおり許容する既存設計（無害）に影響しない
  const dotfiles = [...new Set(text.match(GENERIC_DOTFILE) ?? [])]
    .map(norm)
    .filter((token) => !EXTENSION_ONLY.test(token))
    .filter((token) => classify([token]).codeChanged);
  // 「.d.ts と .scss について記載」のような拡張子単独の言及はファイルではない。
  // PATH_TOKEN も `.d.ts` を丸ごと拾うため、抽出チャネルによらず一括で除外する
  return [
    ...(text.match(PATH_TOKEN) ?? []).map(norm),
    ...(text.match(EXTENSIONLESS_CODE_FILE) ?? []),
    ...dotfiles,
  ].filter((token) => !EXTENSION_ONLY.test(token));
}

// 既知のコードルートディレクトリへの言及があるか（拡張子なし。URL 内の誤マッチも
// 厳格側に倒れるだけなので URL 除去はしない）
function mentionsCodeRoot(text) {
  return CODE_ROOT_MENTION.test(text);
}

// セクション本文（sectionSourceLines の原文行）に実質的な内容があるか。
// mdast 移行後も行ベースのまま維持する（check-artifacts.js の hasSubstance が #403 後も
// 行ベースである構成と同型。sectionSourceLines が原文行を復元するため、インデントコード
// ブロック等がノード化されても判定対象の行は現行と同一になる）。
// プレースホルダ・空行・見出し・空テーブルに加え、
// テーブル/リストのセル・内容が「TODO」「なし」「数字ID」等のプレースホルダのみのデータ行も
// 実質なしとする（「テンプレ行を埋めただけ」の未作成 artifact のすり抜けを防ぐ #408 Codex/Gemini）。
// 数字単独（ID列）・`#`/`*`・`tbd` もプレースホルダに含める。テーブルはヘッダ/区切り行を実質と
// 数えず、区切り行より後の非空データ行のみを対象とする（外側パイプ有無は問わない = GFM の
// `ケース | 対応` 形式も表として扱う）
const PLACEHOLDER_CELL =
  /^(todo|tbd|n\/?a|なし|無し|未定|未実施|未対応|記入|（記入）|\d+|[#*\-―—?？…]+)$/i;
const HEADING_LINE = /^#{1,6}\s/;
function splitCells(line) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}
// GFM テーブルの区切り行（`--- | ---` / `|:--|--:|` 等。全セルが `-`/`:` のみ）
function isSeparatorLine(raw) {
  const line = raw.trim();
  if (!line.includes('|')) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((c) => c === '' || /^[-:]+$/.test(c));
}
function hasRealSubstance(bodyLines) {
  let seenSeparator = false;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i].trim();
    if (!line) {
      seenSeparator = false; // 空行でテーブルブロック終端
      continue;
    }
    if (/^<!--.*-->$/.test(line)) continue; // 単一行 HTMLコメント（保険。コメントノードは sectionSourceLines が除去済み）
    if (/^`{3}/.test(line)) continue; // コードフェンス境界（stripFencedLines 後は基本来ないが保険）
    if (line === '...' || line === '…') continue;
    if (HEADING_LINE.test(line)) continue; // 見出しだけのサブセクションは実質と数えない
    if (/^-\s*\[ \]\s*(\.\.\.|…|（記入）)?$/.test(line)) continue; // 空チェック行プレースホルダ
    // テーブルとみなすのは「区切り行を伴う `|` 行」のみ（外側パイプなしの GFM 表も対象）。
    // 区切り行と無関係な `|` 行（grep のパイプ `rg foo src/ | head` 等の散文・コマンド）は
    // テーブル扱いせず下の content 判定へフォールスルーする（区切り行なしの `|` 行を一律
    // 実質なしと数えると、既存実装調査のパイプ付きコマンドが誤ブロックされる）
    if (line.includes('|')) {
      const cells = splitCells(line);
      if (cells.every((c) => c === '' || /^[-:]+$/.test(c))) {
        seenSeparator = true; // 区切り行
        continue;
      }
      const nextIsSeparator = i + 1 < bodyLines.length && isSeparatorLine(bodyLines[i + 1]);
      if (seenSeparator) {
        // 区切り行より後のデータ行: 非プレースホルダセルがあれば実質あり
        if (cells.some((c) => c !== '' && !PLACEHOLDER_CELL.test(c))) return true;
        continue;
      }
      if (nextIsSeparator) continue; // 次行が区切り行＝テーブルヘッダ行は実質と数えない
      // 区切り行と無関係な `|` 行は散文として content 判定へ
    }
    // 引用（>）・箇条書き（-/*/+）・番号付き（1. / 1)）・タスクリスト（[ ]/[x]）の
    // マーカーを除去してから判定（`> TODO` のような引用装飾でプレースホルダ判定を
    // すり抜けさせない。剥がした結果が実質ならこれまでどおり実質あり＝厳格化のみ）
    // 交互ネスト（`- > TODO` 等）も剥がしきるため不動点までループする。剥がすほど
    // プレースホルダ判定に到達しやすくなる＝厳格側にしか動かない
    let content = line;
    for (let prev = null; content !== prev;) {
      prev = content;
      content = content
        .replace(/^(?:>\s*)+/, '')
        .replace(/^(?:[-*+]|\d+[.)])\s*/, '')
        .replace(/^\[[ xX]\]\s*/, '');
    }
    if (content && !PLACEHOLDER_CELL.test(content)) return true;
  }
  return false;
}

// 各要件は「(a) 成果物セクションが plan に埋まっている または (b) ワークフロー実行が
// 工程として明記されている」で充足。トークンは `.md` 直前を除外する（`docs/agent-workflows/
// risk-modeling.md` のような参照パスの列挙だけで「実行の明記」扱いになるのを防ぐ）
const GATES = [
  {
    name: '想定ケース表',
    keywords: ['想定ケース', 'リスクモデリング', 'リスク'],
    token: /\brisk-modeling\b(?!\.md)/i,
    hint: 'plan に「## 想定ケース」表を埋めるか、実装前工程として /risk-modeling の実行を明記してください（docs/agent-workflows/risk-modeling.md）',
  },
  {
    name: '既存実装調査表',
    keywords: ['既存実装調査'],
    token: /\bcodebase-recon\b(?!\.md)/i,
    hint: 'plan に「## 既存実装調査」表を埋めるか、実装前工程として /codebase-recon の実行を明記してください（docs/agent-workflows/codebase-recon.md）',
  },
];

// skip 理由のプレースホルダ判定は完全一致に限定する（前方一致だと「未使用ブランチの調査のみ」
// のような実質理由まで弾いてしまう）
const PLACEHOLDER_REASON =
  /^(n\/?a|なし|無し|todo|tbd|skip|未(実施|対応|検証|定)?|記入|（記入）|[―—\-?？…]+)$/i;

export function checkPlan({ plan = '' }) {
  const errors = [];
  const warnings = [];

  const text = plan.length > MAX_PLAN_LENGTH ? plan.slice(0, MAX_PLAN_LENGTH) : plan;
  const lines = splitLines(text);
  // 受理側（skip・セクション・工程トークン）はフェンス外のみ。例示による偽装を防ぐ
  const visible = stripFencedLines(lines);
  const visibleText = visible.join('\n');

  const skip = PLAN_SKIP_MARKER.exec(visibleText);
  if (skip) {
    const reason = (skip[1] || '')
      .trim()
      .replace(/^\(|\)$/g, '')
      .trim();
    if (!reason || PLACEHOLDER_REASON.test(reason)) {
      errors.push(
        'plan-gate: skip マーカーに実質的な理由がありません（<!-- plan-gate: skip (理由) -->）',
      );
    } else {
      warnings.push(`plan-gate をスキップしました（理由: ${reason}）`);
    }
    return { errors, warnings, mandated: false };
  }

  const paths = extractPlanPaths(text);
  const { codeChanged } = classify(paths);
  // パス言及ゼロは「docs のみ」ではなく「情報不足」なので厳格側に倒す（脱出は skip マーカー）。
  // 抽出パスが全て prose でも、拡張子なしのコードルート言及があれば厳格側に倒す
  // （「CLAUDE.md に合わせて src/lib を直す」のような plan の docs-only 誤判定を防ぐ）
  const mandated = paths.length === 0 ? true : codeChanged || mentionsCodeRoot(text);

  if (!mandated) {
    warnings.push('docs/prose のみに言及する計画のため plan ゲート対象外');
    return { errors, warnings, mandated };
  }

  // mdast パース前の資源ガード（micromark の二次時間対策。詳細は mdast-body.js）。
  // ここに到達するのは常に mandated（非 mandated は上で return 済み）なので fail-loud 一択。
  // 脱出経路は先に判定される skip マーカー。MAX_PLAN_LENGTH の 1MB 切詰は正規表現フェーズの
  // 防御としてこれと併存する。行数カウントは空行を除く — フェンス空白化で生じた空行は
  // ブロック境界でありパース上安全なため、長いログ貼り付けフェンスを含む正当な plan を
  // 誤ブロックしない（引用ネスト判定にも空行は無関係）
  const guardLines = visible.filter((line) => line.trim() !== '');
  const guard = resourceGuardErrors(guardLines, { subject: 'plan 本文' });
  if (guard.length > 0) {
    errors.push(...guard);
    return { errors, warnings, mandated };
  }

  // 閉じた HTML コメントの扱いは用途で分ける（#409 レビューで実測した 2 クラスの偽装対策）:
  // - 構造解析（parseBody / セクション位置）には「改行・行内位置を保存した空白化」を使う。
  //   コメント「ノード」単位の除去（mdast-body の commentSpans）だけでは、リンク title・
  //   インラインコード内のコメント風テキストが判定対象に残り、GitHub 上不可視のテキストで
  //   判定を充足できてしまう。
  // - 正規表現の充足判定（工程トークン・プレースホルダ）には「全域除去（結合）」を使う。
  //   GitHub はコメントを除去して前後を結合して描画するため、空白化のままだと
  //   `risk-modeling<!-- x -->.md` が `(?!\.md)` を、`TO<!-- -->DO` がプレースホルダ判定を
  //   すり抜ける（トークンが空白で分断され、描画と判定の字句が乖離する）。
  // 閉じ忘れ `<!--` は GitHub 上で文書末尾まで不可視になるため、全ビューで末尾まで
  // 無効化する（閉じたコメントの処理後に残る `<!--` は定義上すべて閉じ忘れ）。
  // mdast の html ブロック化に任せるだけでは不十分 — token 判定は生テキストへの
  // 正規表現のため、閉じ忘れコメント内に隠した工程トークンが充足になる
  // （#409 収束レビューで実測した緩み側バイパス）。GitHub 上で字句として可視な `<!--`
  // （インラインコード内・cmark がエスケープする `<!` 直後等）も末尾まで隠す側に
  // 倒れるが、これは厳格側の誤差（脱出は skip マーカー）。
  //
  // 既知の限界（#410。文書化のみ・未修正。いずれも厳格側 FP で脱出は skip マーカー）:
  // どちらも「cmark 描画ではコメントが開かないのに、この正規表現がコメント開始とみなす」クラス。
  // (FP1) 行内 `<!--`（行頭でないため cmark はエスケープし GitHub 上は全文可視）が、空行や
  //   実質内容をまたいで後方の `-->` とペアリングし、section 実質判定で可視の実質を誤除去する
  //   （さらに `-->` 側が section スライスから落ちて欠けると UNCLOSED_COMMENT_TAIL が末尾まで食う）。
  //   例: 「## 想定ケース」直下の `TODO <!-- メモ` … 空行 … `続き -->`。cleanSrc は parse 前に
  //   コメントを空白化するため tree にコメントノードが無く（check-artifacts.js と異なる）、section
  //   実質判定は commentSpans/stripSpans ではなくこの dropComments に依存する構造上の帰結。
  // (FP2) `<!<!-- x -->--` のように CLOSED 除去（結合）後に新たな `<!--` が合成され
  //   UNCLOSED_COMMENT_TAIL が以降を切り捨てる。GitHub は先頭 `<!` をエスケープして全文可視。
  //   極めて人工的で実 plan での発生可能性はほぼゼロ。
  // 非修正の理由: cmark 準拠の block/inline・空行認識へ寄せる（＝コメント認識を mdast ノードに
  //   委ねる）と、リンク title・インラインコード内の `<!-- /risk-modeling -->` を mdast が
  //   コメントと認識しないため、#409 が塞いだトークンバイパス（不可視相当の位置に隠した工程
  //   トークンでゲート充足）が再発する。判定コストと緩み側リスクに見合わないため現状維持
  //   （#410 方向性メモ）。
  const CLOSED_COMMENT = /<!--[\s\S]*?-->/g;
  const UNCLOSED_COMMENT_TAIL = /<!--[\s\S]*$/;
  const blankNonNewline = (m) => m.replace(/[^\n]/g, ' ');
  const cleanSrc = visibleText
    .replace(CLOSED_COMMENT, blankNonNewline)
    .replace(UNCLOSED_COMMENT_TAIL, blankNonNewline);
  const dropComments = (s) => s.replace(CLOSED_COMMENT, '').replace(UNCLOSED_COMMENT_TAIL, '');
  const tokenText = dropComments(visibleText);
  const tree = parseBody(cleanSrc);
  // 空白化は長さ・改行位置を保存するため、cleanSrc の tree の position offset は
  // visibleText にもそのまま適用できる（offset 互換）。セクション原文行は visibleText から
  // 復元し、行内のコメントを除去（結合）してから実質判定に渡す — GitHub 描画と同じ字句で判定する
  const sectionContentLines = (nodes) =>
    dropComments(sectionSourceLines(visibleText, nodes).join('\n')).split('\n');

  for (const gate of GATES) {
    const { found, nodes } = findSection(tree, gate.keywords, { depths: [2, 3] });
    const satisfied =
      (found && hasRealSubstance(sectionContentLines(nodes))) || gate.token.test(tokenText);
    if (!satisfied) errors.push(`${gate.name}: ${gate.hint}`);
  }

  // requirement-probe（完了条件）は推奨扱い（警告のみ）
  const req = findSection(tree, ['完了条件'], { depths: [2, 3] });
  if (!(
    (req.found && hasRealSubstance(sectionContentLines(req.nodes))) ||
    /\brequirement-probe\b/i.test(tokenText)
  )) {
    warnings.push(
      '完了条件の明記を推奨します（requirement-probe。docs/agent-workflows/requirement-probe.md）',
    );
  }

  if (errors.length > 0 && paths.length === 0) {
    errors.push(
      '変更対象ファイルのパス言及が plan にないため厳格側で判定しています（コード変更を含まない計画なら <!-- plan-gate: skip (理由) --> を明記）',
    );
  }

  return { errors, warnings, mandated };
}

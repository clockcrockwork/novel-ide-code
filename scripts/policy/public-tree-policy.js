// public code repo / private control repo 分離（#345）のファイル振り分けポリシー単一正本。
// 依存フリー（node ビルトイン `node:path` のみ・npm 依存なし）。CI 前段や sanitized-tree
// 生成スクリプトが npm ci なしで import できること、および mdast/micromark 依存を持つ
// check-doc-links.js のトップレベル import 群を巻き込まないことが要件（#345 レビュー指摘2）。
//
// 正本の階層:
//   - 除外ディレクトリ（denylist）の意味論の正本: docs/security/public-release-checklist.md §2
//   - コード上の単一正本: 本ファイル（check-doc-links.js / build-public-tree.js / テストが import）
// 素の startsWith によるパス前方一致は禁止（`docs/planning-public/` 等の別ディレクトリ誤判定を招く）。
// セグメント境界で判定する（CLAUDE.md / INVARIANTS.md #12 と同趣旨）。
import { relative, isAbsolute, sep } from 'node:path';

// public 側に出さない（＝private control repo にのみ残す）ディレクトリ。末尾スラッシュ付きで保持し、
// 判定側で末尾スラッシュを正規化してから比較する。allowlist ではなく denylist 方式:
// 新規追加された未列挙ファイルは既定で public 候補になる（取りこぼしを防ぐ。機密面は
// strict secret scan / prose 検査 / included-file manifest 目視で補完する残余リスク #346 §2）。
// docs/agent-memory/records/ は個々の記憶レコードの正本置き場（agent-memory-design.md）で、
// 判断過程・内部議論・非公開の意図を含む生データ。public 側は要約された digest
// （`agent-memory.js digest --visibility public`）でのみ提供する方針（accepted 記憶
// mem-20260719-5b65ee「記憶の配置は control 側正本＋public 側 digest」）。digest の public 側
// 同期の実装自体は本リストへの追加とは別作業（docs/agent-memory/README.md 参照）。
export const CONTROL_ONLY_DIRS = ['docs/pr/', 'docs/pr-analysis/', 'docs/planning/', 'docs/agent-memory/records/'];

// public tree に **tracked されていてはいけない** secret 風パス。gitignore 済みのはずだが、
// 過去の `git add -f` 等で誤って追跡された場合に silent 除外すると (a) 元リポジトリの問題を
// 隠蔽し (b) `.env.example` まで巻き添えで消える。よって build-public-tree.js は「除外」ではなく
// 「検出したら fail」に使う（#345 レビュー指摘3）。`.env.example` のみ追跡許可の例外
// （.gitignore の `.env*` + `!.env.example` と同一セマンティクス）。
export const ENV_EXAMPLE_ALLOW = '.env.example';

// パスがいずれかの control-only ディレクトリ配下（またはそのディレクトリ自身）か。
// 大文字小文字非依存で判定する（`docs/Planning/` のような大小揺れの private ディレクトリが
// denylist をすり抜けて public に漏れるのを防ぐ。denylist 方式の fail-open 方向を保守的に締める。#345 adversarial 🟡）。
export function isControlOnlyPath(relPosix) {
  const p = relPosix.toLowerCase();
  return CONTROL_ONLY_DIRS.some((d) => {
    const dir = d.replace(/\/+$/, '').toLowerCase();
    return p === dir || p.startsWith(dir + '/');
  });
}

// public tree に含めてはならない secret 風 tracked パスか（`.env.example` のみ許可）。
// **.gitignore のプレフィックスグロブ意味論に合わせる**（public-release-checklist.md §5 と同一契約。
// アンカー付き正規表現だと `.env` の直後がドット/終端の名前しか拾えず、`.envrc`(direnv)・`.env-prod`・
// `worker/.dev.vars-backup` 等の実在する秘密ファイル名が `include` に落ちて fail-closed が破れる #345 adversarial 🔴/spec 所見3）:
//   - いずれかのパスセグメント（ディレクトリ名を含む）が `.env` で始まる（`.env.example` 単体ファイルを除く）:
//     `.env.production/secret.json` のように `.env*` ディレクトリ配下も fail-closed（#458 Codex round3 指摘3）
//   - いずれかのパスセグメントが `.dev.vars` で始まる: ディレクトリ配下も同様
//   - いずれかのパスセグメントが `.local` で終わる（`*.local` ファイル本体・`*.local/` ディレクトリ配下の両方）
//   - `.claude/settings.local.json`（`.local` が中間のため上記に該当しない個別指定）
export function isForbiddenSecretPath(relPosix) {
  // 大文字小文字非依存で判定する（`isControlOnlyPath` と対称。case-insensitive FS（macOS 既定）で
  // `.ENV`・`FOO.LOCAL/` 等の大文字変種が gitignore をすり抜けて tracked された場合の漏れを塞ぐ。
  // PR #458 敵対的再レビュー）。ただし許可例外は known-safe な小文字 `.env.example` の完全一致のみ
  // （大文字変種は前方一致で forbidden 側に倒す = fail-closed）。
  const segments = relPosix.split('/');
  const lowerSegments = segments.map((s) => s.toLowerCase());
  const baseRaw = segments[segments.length - 1];
  // パス系ルール（*.local ファイル/ディレクトリ配下・個別指定）は basename の .env.example 例外より
  // **先に**判定する。さもないと `foo.local/.env.example` のように local 設定ディレクトリ配下の
  // ファイルが example 例外で include に漏れる（PR #458 Codex 指摘1）。
  if (lowerSegments.some((s) => s.endsWith('.local'))) return true;
  if (lowerSegments.join('/') === '.claude/settings.local.json') return true;
  // 祖先セグメント（basename を除く）が .env*/.dev.vars* で始まれば、basename が何であれ forbidden
  // （ディレクトリごと弾く。.env.example 例外は basename 自身にのみ適用され祖先には適用しない）。
  const ancestors = lowerSegments.slice(0, -1);
  if (ancestors.some((s) => s.startsWith('.env') || s.startsWith('.dev.vars'))) return true;
  if (baseRaw === ENV_EXAMPLE_ALLOW) return false;
  const baseLower = lowerSegments[lowerSegments.length - 1];
  if (baseLower.startsWith('.env')) return true;
  if (baseLower.startsWith('.dev.vars')) return true;
  return false;
}

// 記憶レコードの疑いがあるパスか。旧実装は「docs/agent-memory 配下 かつ 拡張子が
// .json/.jsonl/.ndjson」という allowlist 相当の拡張子判定だったため、
// `docs/agent-memory/tmp/backup.json.bak`（拡張子末尾不一致）や `docs/agent-memory.json`
// （`docs/agent-memory` が1セグメントに融合しディレクトリ配下でない）が判定をすり抜けて
// include に落ちていた（PR-preflight round6 F-2）。fail-closed 側へ規則を反転する:
//   (a) 任意深さで `docs/agent-memory` セグメント（`docs` 直下の `agent-memory`）を持つ
//       パスは、拡張子が `.md` の場合を除き全て記憶レコード扱い（misplaced）とする。
//       records/ 配下（CONTROL_ONLY_DIRS。root 直下のみ判定）は isControlOnlyPath が
//       先に拾って正常な除外になるため、classifyPublicTreePath 側の優先順位
//       （control-only を先に判定）により本関数の戻り値が使われるのは「records/ 配下
//       以外の想定外の場所」＝ docs/agent-memory/x.json（root 直下・records/ 外）や
//       worker/docs/agent-memory/records/x.json（ネスト。isControlOnlyPath は root
//       anchored のため素通りする）。
// round6 で追加した規則(b)（basename が `agent-memory` で始まる非 `.md` は配下外でも記憶
// レコード扱い）は round7 N-1（High）で撤回した——実在する `scripts/agent-memory.js`
// （記憶 CLI 本体。ディレクトリではなく単体ファイル）が basename 一致で誤検出され、
// `build-public-tree.js` が現行 HEAD で必ず生成中止する fail-open な副作用を持っていたため。
// 撤回後の既知残余リスク（意図的に検知しない）: `docs` 直下以外に置かれた `agent-memory`
// という名前のディレクトリ（例: `docs/ai/agent-memory/`・root 直下の `agent-memory/`）や
// `docs/agent-memory-old/` のような類似名ディレクトリは本規則で検知しない。運用としてそれらの
// ディレクトリを作らないことで担保する（public-release-checklist.md §2 に明記）。
// denylist 方式（#345 accepted 記憶 mem-20260726-87958f）と整合させ allowlist は使わない——
// `.md` は記憶レコードの正本形式ではなく説明文書（README.md・digest.md 等）の形式のため、
// `.md` のみを除外対象とする（それ以外の拡張子は将来 digest が新形式で出力される場合も
// 含め fail-closed 側に倒す。ラウンド3減算 S-2／ラウンド4敵対的1／round6 F-2）。
// 大文字小文字非依存。
const AGENT_MEMORY_MARKDOWN_RE = /\.md$/;
export function isAgentMemoryRecordPath(relPosix) {
  const lower = relPosix.toLowerCase();
  const segments = lower.split('/');
  const hasAgentMemorySegment = segments.some((seg, i) => seg === 'docs' && segments[i + 1] === 'agent-memory');
  if (!hasAgentMemorySegment) return false;
  const basename = segments[segments.length - 1];
  return !AGENT_MEMORY_MARKDOWN_RE.test(basename);
}

// `\`・制御文字（U+0000〜U+001F・U+007F）・非 ASCII 文字（コードポイント全域、astral 面を含む）
// のいずれかを含む tracked パスか。当初は `/` の同形グリフ（U+2215 division slash・U+FF0F
// fullwidth solidus・U+2044 fraction slash）を個別に列挙していたが、列挙方式は新種のグリフが
// 見つかるたびに追記が要る fail-open な設計だったため、**非 ASCII を一括で拒否**する方式へ一般化
// した（現在の tracked パス corpus に非 ASCII は 0 件で実害なし。将来 tracked パスを非 ASCII に
// する場合は本関数の見直しが要る。public-release-checklist.md §2 に方針を明記。ラウンド4敵対的2）。
// 制御文字も同様に一律拒否する（改行等でログ・grep 系ツールの行区切りを乱す入力を許さない）。
// Linux では `\` はファイル名の通常文字なので git 自体は許すが、`docs/agent-memory\x.json` のように
// `/` 区切りのセグメント判定（isControlOnlyPath / isForbiddenSecretPath / isAgentMemoryRecordPath）
// を、素の `\` や見た目だけ `/` に似た Unicode スラッシュですり抜けられる余地を持たせないため、
// 判定より前に fail-closed で拒否する（ラウンド2敵対的レビュー A-4／ラウンド3敵対的 A-11）。
// ラウンド3減算 S-1/S-8 で build-public-tree.js から本 policy モジュールへ判定位置を統合。
// 制御文字は \x00-\x1F/\x7F の文字クラス直書きだと no-control-regex の eslint-disable が要る
// ため、`\p{Cc}`（Unicode 制御文字プロパティ。C0/C1/DEL を包含）で代替する（scripts/agent-memory.js
// の requireTrailerSafe と同じ手法。/u フラグが必須）。非 ASCII 判定も同じ理由でコードポイント
// レンジを直書きせず `[^\p{ASCII}]`（Unicode 二値プロパティ `ASCII`＝U+0000-U+007F の否定）を使う
// ——旧実装の `\u0080-\uFFFF` レンジ指定は `/u` フラグ下でも BMP（基本多言語面）止まりで astral 面
// （U+10000 以上。絵文字・タグ文字・CJK拡張漢字等）を通過させてしまっていた（PR-preflight round6
// F-1）。`\p{ASCII}` は /u フラグ下でコードポイント単位に評価されるため、上限を書かずに astral 面
// まで一括で拒否できる。
const PATH_SEPARATOR_LOOKALIKE_RE = /\\|[^\p{ASCII}]|\p{Cc}/u;
export function hasPathSeparatorLookalike(relPosix) {
  return PATH_SEPARATOR_LOOKALIKE_RE.test(relPosix);
}

// parent（絶対パス）配下に child（絶対パス）が含まれるか（parent 自身も含む）。
// 素の `rel.startsWith('..')` は `..foo` という名前を誤判定するため、セグメント境界で判定する
// （INVARIANTS #12。scripts 配下は custom lint 対象外のため本ヘルパーに集約して再実装を防ぐ #345 quality 所見1/2）。
export function isPathInside(parentAbs, childAbs) {
  const rel = relative(parentAbs, childAbs);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

// build-public-tree.js の中心的な振り分け。返り値:
//   'invalid-path'            : パスに `\`・制御文字・非 ASCII 文字を含む（fail 対象。最優先で判定）
//   'forbidden-secret'        : public tree に tracked されていてはならない（fail 対象）
//   'control-only'            : private control repo にのみ残す（正常な除外）
//   'agent-memory-misplaced'  : docs/agent-memory/ 配下の想定外の場所にある記憶レコード（fail 対象）
//   'include'                 : public tree に含める
// symlink / submodule / 非 regular file の拒否は git のモード判定側で行う（本関数はパスのみ見る）。
export function classifyPublicTreePath(relPosix) {
  if (hasPathSeparatorLookalike(relPosix)) return 'invalid-path';
  if (isForbiddenSecretPath(relPosix)) return 'forbidden-secret';
  if (isControlOnlyPath(relPosix)) return 'control-only';
  if (isAgentMemoryRecordPath(relPosix)) return 'agent-memory-misplaced';
  return 'include';
}

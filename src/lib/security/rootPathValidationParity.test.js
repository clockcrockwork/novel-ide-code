import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import {
  validateWorkspaceRootPath as clientValidate,
  ROOTPATH_FORBIDDEN_CHAR_RE as clientForbiddenChar,
} from '../metadata/validateWorkspaceSettings.js';
import { FORBIDDEN_PKG as clientForbiddenPkg, BIDI_RE as clientBidi } from './validateGitHubWritePath.js';
import { INVISIBLE_WARN } from './unicodeSafety.js';
// worker 側は TypeScript の純関数（外部ランタイム依存なし）。vitest(esbuild) が .ts を
// トランスパイルするため直接 import できる。node --test では不可のため本テストは vitest 専用。
// parity ペアは両側同名（#475 で対称化）。alias は client/worker の区別のためだけに付ける。
import {
  validateWorkspaceRootPath as workerValidate,
  FORBIDDEN_PKG as workerForbiddenPkg,
  BIDI_RE as workerBidi,
  ROOTPATH_FORBIDDEN_CHAR_RE as workerForbiddenChar,
} from '../../../worker/src/validation.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// 不変条件は「その名前がそのファイルのトップレベル**実行時ローカル束縛**として存在する」こと。
// 正規表現の出現一致では偽装経路（alias・type-only・コメント・行継続文字列・ambient 宣言…）を
// 塞ぎきれないため TypeScript の parser で判定する（#475）。認める/認めない形の全量は BINDING_CASES
// が機械検査する。import 指定子は `name`（= ローカル束縛名）で判定するため、`X as NAME` は満たし
// `NAME as X` は満たさない。型のみの構文（`import type`・`declare`・`interface`・`type`）は
// 実行時コードを生成しないため満たさない。
function hasLocalBinding(source, name, fileName) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  if (sf.isDeclarationFile) return false; // .d.ts は全体が ambient（実行時コードを生成しない）
  const isAmbient = (st) => st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
  return sf.statements.some((st) => {
    // body なし = `declare function` / オーバーロード署名。いずれも実行時の束縛を作らない
    if (ts.isFunctionDeclaration(st)) return st.name?.text === name && !!st.body && !isAmbient(st);
    if (ts.isVariableStatement(st)) {
      if (isAmbient(st)) return false;
      return st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name);
    }
    if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.isTypeOnly) return false;
    const { name: defaultName, namedBindings } = st.importClause;
    if (defaultName?.text === name) return true;
    if (!namedBindings) return false;
    if (ts.isNamespaceImport(namedBindings)) return namedBindings.name.text === name;
    return namedBindings.elements.some((el) => !el.isTypeOnly && el.name.text === name);
  });
}

// 「名前が実行時ローカル束縛として存在するか」の判定を偽装する経路の網羅表。判定器を直接テストする
// （実ファイルのミュータント実行に依存しない）。新しい回避経路が見つかったらここに1行足す（#475）。
// tsOnly: TypeScript 固有構文のため .ts でのみ検査する。
const BINDING_CASES = [
  { label: 'function 宣言', src: 'function NAME(p) { return p; }', want: true },
  { label: 'export function 宣言', src: 'export function NAME(p) { return p; }', want: true },
  { label: 'const アロー関数', src: 'const NAME = (p) => p;', want: true },
  { label: 'named import', src: "import { NAME } from './s.js';", want: true },
  { label: 'named import（複数行）', src: "import {\n  other,\n  NAME,\n} from './s.js';", want: true },
  { label: 'alias の束縛側が実名', src: "import { shared as NAME } from './s.js';", want: true },
  { label: 'default import', src: "import NAME from './s.js';", want: true },
  { label: 'namespace import', src: "import * as NAME from './s.js';", want: true },
  { label: 'alias で束縛名が別名', src: "import { NAME as renamed } from './s.js';", want: false },
  { label: 'type-only import', src: "import type { NAME } from './s.js';", want: false },
  { label: 'インライン type 指定子', src: "import { type NAME } from './s.js';", want: false },
  { label: 'インライン type ＋ alias', src: "import { type shared as NAME } from './s.js';", want: false },
  { label: 're-export（ローカル束縛を作らない）', src: "export { NAME } from './s.js';", want: false },
  { label: '行コメント内の綴り', src: "import {\n  renamed, // NAME was renamed\n} from './s.js';", want: false },
  { label: 'ブロックコメント内の宣言', src: '/*\nfunction NAME(p) { return p; }\n*/', want: false },
  { label: 'テンプレートリテラル内の宣言', src: 'const doc = `\nfunction NAME(p) { return p; }\n`;', want: false },
  // 行継続（`\` ＋改行）で文字列を複数行に伸ばすと、行頭が宣言・import に見える（Codex 4周目）
  { label: '行継続文字列内の import', src: "const doc = 'x\\\nimport { NAME } from \\'./s.js\\';';", want: false },
  { label: '行継続文字列内の宣言', src: "const doc = 'x\\\nfunction NAME(p) { return p; }';", want: false },
  { label: 'ネストスコープの宣言（トップレベル束縛ではない）', src: 'function outer() {\n  function NAME(p) { return p; }\n}', want: false },
  // ambient 宣言・型のみの宣言は実行時コードを生成しない（Codex 5周目）
  { label: 'declare function（ambient）', src: 'declare function NAME(p: string): string;', want: false, tsOnly: true },
  { label: 'declare const（ambient）', src: 'declare const NAME: (p: string) => string;', want: false, tsOnly: true },
  { label: 'body なしのオーバーロード署名', src: 'function NAME(p: string): string;', want: false, tsOnly: true },
  { label: 'interface 宣言', src: 'interface NAME { p: string }', want: false, tsOnly: true },
  { label: 'type エイリアス', src: 'type NAME = (p: string) => string;', want: false, tsOnly: true },
];

// 戻り値形式の差を吸収するアダプタ: client は { ok, reason }、worker は string(理由) | null。
const clientAccepts = (path) => clientValidate(path).ok === true;
const workerAccepts = (path) => workerValidate(path) === null;

// 共有入力ベクター表。client / worker の githubRepoPath 受理集合が一致することを検証する（#469 / #471 柱3）。
// これは代表ベクター＋グリフ/エンコーディング変種（全角・末尾ドット/空白・Bidi・大文字・percent 等）による
// 担保であり、全入力空間の等価証明ではない。将来どちらかの実装を改修する際は、その変更が触れる入力クラスの
// ベクターを本表へ追加すること。
const VECTORS = [
  // --- accept ---
  { path: 'novels', want: 'accept' },
  { path: 'works/series-a', want: 'accept' },
  { path: 'a/b/c/d', want: 'accept' },
  { path: '原稿/第一章', want: 'accept' },
  { path: '.gitignore', want: 'accept' }, // .git セグメントとは別
  { path: '.environment', want: 'accept' }, // .env. プレフィックスではない
  { path: 'my-package.json', want: 'accept' }, // package.json に似るが別名（単一セグメント）
  { path: 'ｐａｃｋａｇｅ．ｊｓｏｎ', want: 'accept' }, // 全角は別ファイル名（禁止集合は半角）
  // --- reject: パッケージ管理ファイル（全セグメント。#469 で client を worker に一致させた中心ケース） ---
  { path: 'package.json', want: 'reject' },
  { path: 'a/package.json', want: 'reject' },
  { path: 'packages/mylib/package.json', want: 'reject' }, // 書き込みパス用途では許可されるが rootPath では禁止
  { path: 'x/pnpm-lock.yaml', want: 'reject' },
  { path: 'x/PACKAGE.JSON', want: 'reject' }, // 大文字（小文字化で一致）
  { path: 'sub/package.json ', want: 'reject' }, // 末尾空白は正規化後に一致
  { path: 'sub/package.json.', want: 'reject' }, // 末尾ドット
  { path: 'sub/package.json...  ', want: 'reject' }, // 末尾ドット/空白の多重
  // --- reject: 機微セグメント（全セグメント） ---
  { path: 'a/.git', want: 'reject' },
  { path: 'a/.github', want: 'reject' },
  { path: 'works/.env', want: 'reject' },
  { path: 'x/.envrc', want: 'reject' },
  { path: 'x/.env.local', want: 'reject' },
  // --- reject: 形式・トラバーサル・メタ文字・不可視/制御文字 ---
  { path: '/etc', want: 'reject' }, // 先頭スラッシュ
  { path: 'novels/', want: 'reject' }, // 末尾スラッシュ
  { path: '../etc', want: 'reject' },
  { path: 'a/..', want: 'reject' },
  { path: 'a?b', want: 'reject' },
  { path: 'a#b', want: 'reject' },
  { path: 'a%2Fb', want: 'reject' },
  { path: 'a\\b', want: 'reject' },
  { path: 'a‮b', want: 'reject' }, // RLO（Bidi 制御文字）
  { path: '', want: 'reject' },
  { path: 'x'.repeat(257), want: 'reject' }, // 256 超
  // --- 制御・不可視文字: #473 で両側とも reject（JS エスケープ＝ASCII ソースで実文字を生成） ---
  { path: 'a\tb', want: 'reject' }, // タブ (U+0009)
  { path: 'a\nb', want: 'reject' }, // 改行 (U+000A)
  { path: 'a\rb', want: 'reject' }, // CR (U+000D)
  { path: 'a\u200bb', want: 'reject' }, // ZWSP (U+200B)
  { path: 'a\u200cb', want: 'reject' }, // ZWNJ (U+200C)
  { path: 'a\u200db', want: 'reject' }, // ZWJ (U+200D)
  { path: 'a\u2060b', want: 'reject' }, // Word Joiner (U+2060)
  { path: 'a\u2028b', want: 'reject' }, // Line Separator (U+2028)
  { path: 'a\u2029b', want: 'reject' }, // Paragraph Separator (U+2029)
  { path: 'a\u00a0b', want: 'reject' }, // NBSP (U+00A0)
  { path: 'a\u00adb', want: 'reject' }, // Soft Hyphen (U+00AD)
  { path: 'a\ufeffb', want: 'reject' }, // BOM (U+FEFF)
  { path: 'a\x1fb', want: 'reject' }, // C0 制御 (U+001F)
  { path: 'a\x85b', want: 'reject' }, // C1 制御 NEL (U+0085)
  // --- #478 で Unicode カテゴリ deny-list 化して塞いだギャップ ---
  { path: 'a\u3164' + 'b', want: 'reject' }, // Hangul Filler（Default_Ignorable。レンダリング空白 homograph）
  { path: 'a\u115f' + 'b', want: 'reject' }, // Choseong Filler（Default_Ignorable）
  { path: 'a\u3000' + 'b', want: 'reject' }, // 全角スペース IdeoSpace（Zs, U+0020 以外）
  { path: 'a\u2000' + 'b', want: 'reject' }, // EN QUAD（Zs）
  { path: 'a\u205f' + 'b', want: 'reject' }, // MMSP（Zs）
  { path: 'a\u1680' + 'b', want: 'reject' }, // Ogham Space Mark（Zs）
  { path: 'a\u202f' + 'b', want: 'reject' }, // Narrow NBSP（Zs）
  { path: 'a\ufe0f' + 'b', want: 'reject' }, // Variation Selector-16（Default_Ignorable）
  { path: 'a\u{e0100}b', want: 'reject' }, // Variation Selector Supplement（Default_Ignorable）
  { path: 'a\ud800b', want: 'reject' }, // 孤立サロゲート（\p{Cs}。astral ペアは許容）
  { path: 'a\ue000b', want: 'reject' }, // 私用領域 PUA（\p{Co}）
  { path: '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}', want: 'reject' }, // family 絵文字（ZWJ 合成列。連結子 \p{Cf}）
  { path: '1\ufe0f\u20e3', want: 'reject' }, // キーキャップ 1\ufe0f\u20e3（VS-16 合成。\p{Default_Ignorable}）
  // --- accept: 設計判断で許容（#478） ---
  { path: 'my novel', want: 'accept' }, // ASCII スペース U+0020 は許容（他の空白 homograph は拒否）
  { path: '한글/작품', want: 'accept' }, // ハングル音節（Filler ではなく \p{L}）は許容
  { path: '\u{1f4c1}/x', want: 'accept' }, // emoji（単一 astral コードポイント）は許容
  { path: '\u{20000}', want: 'accept' }, // CJK 拡張B（astral）は許容
  { path: 'cafe\u0301', want: 'accept' }, // NFD 分解形 café（結合マーク \p{M} は拒否対象外）
  { path: 'ก\u0e34', want: 'accept' }, // タイ文字 ก\u0e34（子音＋結合母音 \p{M}）
  // --- 両側が等しく寛容な既知ギャップ（parity は成立。スコープ外） ---
  { path: '%2e%2e/etc', want: 'accept' }, // percent-encoded `..`: `%2e` は非デコード判定で両側受理（github-proxy 再検証で緩和）
];

describe('rootPath validation parity (client ↔ worker) #469', () => {
  it.each(VECTORS)('$path → $want（両実装一致）', ({ path, want }) => {
    const c = clientAccepts(path);
    const w = workerAccepts(path);
    // 受理集合が一致すること（parity）— これが本テストの主眼
    expect(c).toBe(w);
    // かつ現状の期待判定であること（"accept" 側には両側寛容な既知ギャップを含む）
    expect(c).toBe(want === 'accept');
  });

  // 上のベクター表は点検証のため、片側だけに禁止語彙を足すと該当ベクター未追加なら
  // divergence を見逃す（運用性レビュー F1）。禁止集合・Bidi 正規表現の source を直接
  // 突き合わせ、点検証に依存せず「片側だけのドリフト」を機械検出する。
  it('パッケージ管理ファイル禁止集合が client/worker で一致する', () => {
    expect([...clientForbiddenPkg].sort()).toEqual([...workerForbiddenPkg].sort());
  });

  // flags も比較する: source だけ一致していても片側に `g` が付くと、モジュールスコープの regex に
  // lastIndex が持ち越され、同一入力に対し test() が呼び出しごとに true/false を交互に返す。
  // worker は isolate がリクエストをまたいで生き続けるため、Bidi 入りパスが断続的に受理されうる
  // （#475 敵対的レビューが実測）。
  it('Bidi 制御文字の正規表現が client/worker で一致する（source・flags）', () => {
    expect(clientBidi.source).toBe(workerBidi.source);
    expect(clientBidi.flags).toBe(workerBidi.flags);
  });

  // 上と同じ理由で、両側とも状態を持つ `g`/`y` フラグを持たないことを固定する（parity が成立していても
  // 両側同時に `g` が付けば lastIndex 由来の断続受理は起きる）。
  // worker 固有の BRANCH_FORBIDDEN_RE / OWNER_RE / REPO_RE は parity 対象外のため射程外
  it('parity 対象の正規表現（BIDI_RE / ROOTPATH_FORBIDDEN_CHAR_RE）が状態を持つフラグ（g/y）を使わない', () => {
    for (const re of [clientBidi, workerBidi, clientForbiddenChar, workerForbiddenChar]) {
      expect(re.global).toBe(false);
      expect(re.sticky).toBe(false);
    }
  });

  it('制御・不可視文字の正規表現が client/worker で一致する（source・flags）', () => {
    expect(clientForbiddenChar.source).toBe(workerForbiddenChar.source);
    expect(clientForbiddenChar.flags).toBe(workerForbiddenChar.flags);
  });

  // export 定数の命名対称は上記の named import が実質的に機械保証する（片側を rename すると
  // import 解決に失敗してテストが落ちる）。private ヘルパーは import で固定できないためソース走査で
  // 検査する（#475。TRUST-BOUNDARY.md「内部シンボルの命名対応表」が実装から乖離して静かに嘘になるのを防ぐ）。
  // 検査対象リストは同表の private 行と手動同期（表に行を足したらここにも足す）。
  // .js / .ts の双方で同じ判定になることも同時に固定する（client は JS・worker は TS）
  it.each(BINDING_CASES)('ローカル束縛判定: $label → $want', ({ src, want, tsOnly }) => {
    const code = src.replaceAll('NAME', 'cleanPathSegments');
    expect(hasLocalBinding(code, 'cleanPathSegments', 'x.ts')).toBe(want);
    if (!tsOnly) expect(hasLocalBinding(code, 'cleanPathSegments', 'x.js')).toBe(want);
  });

  it('両側に同名で存在すべき private ヘルパーが揃っている', () => {
    const clientPath = join(HERE, 'validateGitHubWritePath.js');
    const workerPath = join(HERE, '../../../worker/src/validation.ts');
    const clientSource = readFileSync(clientPath, 'utf8');
    const workerSource = readFileSync(workerPath, 'utf8');
    for (const name of ['hasForbiddenWriteSegment', 'cleanPathSegments']) {
      expect(hasLocalBinding(clientSource, name, clientPath), `client に ${name} がない`).toBe(true);
      expect(hasLocalBinding(workerSource, name, workerPath), `worker に ${name} がない`).toBe(true);
    }
  });

  // 被覆参照集合→regex 方向の被覆保証（運用性/品質レビュー）: unicodeSafety.js の INVISIBLE_WARN
  // （zero-width/不可視の被覆参照集合。#478 で regex はこれを実行時 import せずカテゴリで判定するため
  // 「実行時の正本」ではない）の全要素が rootPath regex で拒否されることを機械検査する。#478 で
  // カテゴリベース（\p{Cf} 等）へ移行後もこれらは拒否され続けるが、INVISIBLE_WARN に将来要素が追加され、
  // かつそれが regex のカテゴリ（\p{Cf}/\p{Default_Ignorable_Code_Point} 等）に該当しない場合を検出する安全網。
  it('unicodeSafety.js の INVISIBLE_WARN 全要素を rootPath regex が拒否する', () => {
    for (const cp of INVISIBLE_WARN) {
      expect(clientForbiddenChar.test(String.fromCodePoint(cp))).toBe(true);
    }
  });

  // \p{Zs}（空白セパレータ）の被覆保証（#478）: regex は \p{Zs} をカテゴリでなく明示列挙する（U+0020 の
  // み許容するため v フラグ set 減算を避けた結果）。将来 Unicode が \p{Zs} を追加した際、明示列挙の
  // 更新漏れをこのテストが検出する。ASCII スペース(U+0020)は許容＝拒否されないことも同時に固定する。
  it('\\p{Zs} は ASCII スペース(U+0020)以外を rootPath regex が拒否し、U+0020 は許容する', () => {
    const zs = /\p{Zs}/u;
    for (let cp = 0; cp <= 0xffff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!zs.test(ch)) continue;
      expect(clientForbiddenChar.test(ch)).toBe(cp !== 0x20);
    }
  });
});

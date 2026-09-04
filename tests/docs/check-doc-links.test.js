import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractSlugs,
  extractLinks,
  checkFile,
  checkRepo,
  safeDecode,
  CONTROL_ONLY_DIRS,
  isVendoredSkillGuide,
  isOverlayFragment,
} from '../../scripts/check-doc-links.js';

// t.after で登録するため、アサーション失敗時も一時ディレクトリを確実に削除する
function makeRepo(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'doclinks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

test('extractSlugs: 日本語+記号見出しを GitHub と同じ slug にする', () => {
  const slugs = extractSlugs('## 1. 対象（Entry gate）: 高リスク変更のみ（Q4 決定）\n');
  assert.ok(slugs.has('1-対象entry-gate-高リスク変更のみq4-決定'));
});

test('extractSlugs: 1〜3スペースのインデント付き見出しも slug 化する（GFM/CommonMark で有効）', () => {
  const slugs = extractSlugs('  ## セットアップ\n');
  assert.ok(slugs.has('セットアップ'));
});

test('extractSlugs: ATX の閉じシーケンス（末尾の ##）は id に含めない', () => {
  const slugs = extractSlugs('## セットアップ ##\n');
  assert.ok(slugs.has('セットアップ'));
  assert.ok(!slugs.has('セットアップ-'));
});

test('extractSlugs: 本文末尾の # は閉じシーケンスと誤認しない（前に空白がない）', () => {
  const slugs = extractSlugs('## C#\n');
  assert.ok(slugs.has('c'));
});

test('extractLinks: HTML コメント内のリンクは抽出しない', () => {
  const { links } = extractLinks('[a](./a.md)\n<!-- [b](./b.md) -->\n[c](./c.md)\n');
  assert.deepEqual(
    links.map((l) => l.target),
    ['./a.md', './c.md'],
  );
});

test('extractLinks: GFM テーブルのセル内 code span はリンク抽出しない（#426 偽陽性回帰）', () => {
  // 非 GFM だと連続テーブル行が単一段落に融合し、他セルのバッククォートで
  // code span 対応が崩れて `[x](file.md?plain=1#anchor)` が偽リンク化する
  const md = [
    '| # | 例 | 対応 |',
    '|---|-----|------|',
    '| 1 | 正規表現 `/(`+)\\1/g` の説明 | done |',
    '| 2 | クエリ付きリンク `[x](file.md?plain=1#anchor)` の話 | done |',
    '',
  ].join('\n');
  const { links } = extractLinks(md);
  assert.deepEqual(links, []);
});

test('extractSlugs: 打ち消し線見出しは GitHub と同じく記号を除いて slug 化する（#426）', () => {
  const slugs = extractSlugs('## ~~旧仕様~~ 新仕様\n');
  assert.ok(slugs.has('旧仕様-新仕様'));
});

test('extractSlugs: 重複見出しは -1 サフィックス、フェンス内見出しは無視', () => {
  const slugs = extractSlugs('## Same\n\n```md\n## InsideFence\n```\n\n## Same\n');
  assert.ok(slugs.has('same'));
  assert.ok(slugs.has('same-1'));
  assert.ok(!slugs.has('insidefence'));
});

test('extractLinks: フェンス内リンクは抽出せず警告、インラインコード内は無視', () => {
  const { links, fenceWarnings } = extractLinks(
    '[ok](./a.md)\n\n```text\n[dead](#anchor)\n```\n\n`[not-a-link](./b.md)`\n',
  );
  assert.deepEqual(
    links.map((l) => l.target),
    ['./a.md'],
  );
  assert.equal(fenceWarnings.length, 1);
});

test('extractLinks: 複数バッククォートの code span 内リンクも無視する', () => {
  const { links } = extractLinks('`[a](./a.md)` ``[b](./b.md)`` [c](./c.md)\n');
  assert.deepEqual(
    links.map((l) => l.target),
    ['./c.md'],
  );
});

test('extractLinks: シングルクォートタイトル / 閉じ括弧前スペースのリンクも抽出する', () => {
  const { links } = extractLinks(
    "[a](./a.md 'title')\n[b](./b.md \"title\")\n[c](./c.md )\n",
  );
  assert.deepEqual(
    links.map((l) => l.target),
    ['./a.md', './b.md', './c.md'],
  );
});

test('extractLinks: フェンス内の info string 付き行（例 ```js）は閉じフェンスにしない', () => {
  const { links, fenceWarnings } = extractLinks(
    '```\n[a](./skip.md)\n```js\n[b](./skip.md)\n```\n\n[c](./out.md)\n',
  );
  // ```js は info string 付きなので閉じない → [a][b] はフェンス内、[c] のみ抽出
  assert.deepEqual(
    links.map((l) => l.target),
    ['./out.md'],
  );
  assert.equal(fenceWarnings.length, 2); // [a] と [b] をフェンス内リンクとして警告
});

test('extractLinks: 4スペース以上インデントされたバッククォート列はフェンスにならない（インデントコードブロック）', () => {
  const { links } = extractLinks('    ```\n[a](./a.md)\n    ```\n');
  // インデント4以上は CommonMark のフェンスにならないため、[a] はフェンス外の通常リンクとして抽出される
  assert.deepEqual(
    links.map((l) => l.target),
    ['./a.md'],
  );
});

test('extractLinks: フェンス内で閉じ条件を満たさない記号行自体もフェンス内リンクとして検出する', () => {
  const { fenceWarnings } = extractLinks('```\n```js\n[a](./a.md)\n```\n');
  // 2行目 ```js 自体は閉じフェンスにならず、フェンス内の通常行として扱われる（このテストではリンクを含まないので警告対象外）
  // 3行目の [a] がフェンス内リンクとして警告されることを確認
  assert.equal(fenceWarnings.length, 1);
  assert.match(fenceWarnings[0].raw, /\[a\]/);
});

test('extractLinks: 4個以上のバッククォートによるネストフェンスは内側の3個で閉じない', () => {
  const { links, fenceWarnings } = extractLinks(
    '````md\n```javascript\n[nested](./a.md)\n```\n````\n\n[outside](./b.md)\n',
  );
  // ネスト内の [nested] は抽出されず（フェンス内）、フェンス外の [outside] のみ抽出される
  assert.deepEqual(
    links.map((l) => l.target),
    ['./b.md'],
  );
  assert.equal(fenceWarnings.length, 1); // [nested](./a.md) をフェンス内リンクとして警告
});

test('checkFile: リンク切れは error、実在リンクは通る', (t) => {
  const root = makeRepo(t, {
    'docs/a.md': '[ok](b.md) [broken](missing.md)\n',
    'docs/b.md': '# B\n',
  });
  const { errors } = checkFile(root, 'docs/a.md', new Map());
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /missing\.md/);
});

test('checkFile: アンカーを実見出しと照合（同一ファイル/別ファイル・不一致は error）', (t) => {
  const root = makeRepo(t, {
    'docs/a.md': '## 見出し A\n[self](#見出し-a) [other](b.md#実-在) [bad](b.md#no-such)\n',
    'docs/b.md': '## 実 在\n',
  });
  const { errors } = checkFile(root, 'docs/a.md', new Map());
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /no-such/);
});

test('checkFile: アンカーの大小文字違いは error（slug は小文字・GitHub 実 id と不一致）', (t) => {
  const root = makeRepo(t, {
    'docs/a.md': '## API 設定\n[ok](#api-設定) [bad](#API-設定)\n',
  });
  const { errors } = checkFile(root, 'docs/a.md');
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /#API-設定/);
});

test('checkFile: control ディレクトリ自身へのリンク（末尾スラッシュ無し）も public→control 警告', (t) => {
  const denied = CONTROL_ONLY_DIRS[0]; // docs/pr/
  const dirNoSlash = denied.slice(0, -1); // docs/pr
  const root = makeRepo(t, {
    'README2.md': `[dir](${dirNoSlash})\n`,
    [`${denied}keep.md`]: '# keep\n',
  });
  const { warnings } = checkFile(root, 'README2.md');
  assert.equal(warnings.filter((w) => /public→control/.test(w.msg)).length, 1);
});

test('checkFile: 外部/メールリンクは対象外、絶対パスは warning', (t) => {
  const root = makeRepo(t, {
    'a.md': '[x](https://example.com) [m](mailto:a@b.c) [abs](/docs/a.md)\n',
  });
  const { errors, warnings } = checkFile(root, 'a.md', new Map());
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /絶対パス/);
});

test('checkFile: クエリ文字列付きリンク（?plain=1）はファイル解決前に落とす', (t) => {
  const root = makeRepo(t, {
    'a.md': '[q](b.md?plain=1) [qa](b.md?plain=1#実-在) [bad](missing.md?x=1)\n',
    'b.md': '## 実 在\n',
  });
  const { errors } = checkFile(root, 'a.md');
  // b.md?plain=1 は実在で通り、アンカーも照合。missing.md?x=1 のみリンク切れ
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /missing\.md/);
});

test('checkFile: 山括弧付き destination（<...>）は外側を外して判定する', (t) => {
  const root = makeRepo(t, {
    'a.md': '[ext](<https://example.com>)\n[rel](<b.md>)\n[bad](<missing.md>)\n',
    'b.md': '# B\n',
  });
  const { errors } = checkFile(root, 'a.md');
  // 外部リンクは対象外、<b.md> は実在で通る、<missing.md> のみリンク切れ
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /missing\.md/);
});

test('checkFile: public→control 境界リンクは warning、control 内相互は対象外', (t) => {
  const denied = CONTROL_ONLY_DIRS[0]; // docs/pr/
  const root = makeRepo(t, {
    'README2.md': `[log](${denied}PR-1.md)\n`,
    [`${denied}PR-1.md`]: `[peer](PR-2.md)\n`,
    [`${denied}PR-2.md`]: '# ok\n',
  });
  const pub = checkFile(root, 'README2.md', new Map());
  assert.equal(pub.warnings.filter((w) => /public→control/.test(w.msg)).length, 1);
  const ctl = checkFile(root, join(denied, 'PR-1.md'), new Map());
  assert.equal(ctl.warnings.length, 0);
});

test('checkFile: ディレクトリへのリンクは実在すれば通る・リポジトリ外は error', (t) => {
  const root = makeRepo(t, {
    'docs/a.md': '[dir](../docs/) [out](../../etc/passwd)\n',
    'docs/keep.md': '# keep\n',
  });
  const { errors } = checkFile(root, 'docs/a.md', new Map());
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /リポジトリ外/);
});

test('checkFile: root 直下の ".." で始まる名前のファイルはリポジトリ外扱いしない', (t) => {
  const root = makeRepo(t, {
    'a.md': '[dots](..dotfile.md)\n',
    '..dotfile.md': '# ok\n',
  });
  const { errors } = checkFile(root, 'a.md');
  assert.equal(errors.length, 0); // relative は '..dotfile.md' を返すが、セグメント境界判定で外扱いしない
});

test('checkFile: 未クローズのコードフェンスを error として検出する', (t) => {
  const root = makeRepo(t, {
    'a.md': '# T\n\n```\nclosed\n```\n\n```text\nnever closed\n',
  });
  const { errors } = checkFile(root, 'a.md', new Map());
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /未クローズ/);
  assert.equal(errors[0].line, 7);
});

test('safeDecode: 正常デコード / 不正エンコーディングは元文字列を返す', () => {
  assert.equal(safeDecode('%E3%81%82'), 'あ');
  assert.equal(safeDecode('100%-done'), '100%-done'); // 単独 % でも throw しない
  assert.equal(safeDecode('a#b'), 'a#b');
});

test('checkFile: 不正パーセントエンコーディングのリンク/アンカーでクラッシュしない', (t) => {
  const root = makeRepo(t, {
    'docs/a.md': '[bad](100%.md) [anchor](b.md#x%y) [ok](b.md#見出し)\n',
    'docs/b.md': '## 見出し\n',
  });
  // throw せず走査を完遂し、壊れたパス/アンカーは通常の error として報告される
  const { errors } = checkFile(root, 'docs/a.md', new Map());
  assert.ok(errors.some((e) => /100%\.md/.test(e.msg))); // リンク切れとして検出
  assert.ok(errors.some((e) => /x%y/.test(e.msg))); // アンカー不在として検出
});

test('checkFile: slugCache 省略でも自己参照アンカーを検証できる', (t) => {
  const root = makeRepo(t, {
    'a.md': '## 章 一\n[self](#章-一) [bad](#no-such)\n',
  });
  const { errors } = checkFile(root, 'a.md'); // 第3引数を省略（デフォルト new Map()）
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /no-such/);
});

test('checkRepo: 問題のあるファイルだけ返す', (t) => {
  const root = makeRepo(t, {
    'ok.md': '# fine\n',
    'ng.md': '[x](nope.md)\n',
  });
  const results = checkRepo(root, ['ok.md', 'ng.md']);
  assert.deepEqual(
    results.map((r) => r.file),
    ['ng.md'],
  );
});

// --- #400 パーサ移行（mdast + micromark）の回帰テスト ---

test('extractLinks: インデントコードブロック内リンクは抽出も警告もされない', () => {
  const { links, fenceWarnings } = extractLinks('前段落\n\n    [in-code](./a.md)\n\n[out](./b.md)\n');
  assert.deepEqual(
    links.map((l) => l.target),
    ['./b.md'],
  );
  assert.equal(fenceWarnings.length, 0); // 警告はフェンス限定（インデントコードには出さない）
});

test('extractLinks: 複数行 HTML コメント内のリンクは抽出しない', () => {
  const { links } = extractLinks('<!--\n[b](./b.md)\n-->\n\n[c](./c.md)\n');
  assert.deepEqual(
    links.map((l) => l.target),
    ['./c.md'],
  );
});

test('extractLinks: 複数行にまたがる code span 内のリンクは抽出しない', () => {
  const { links } = extractLinks('`[a](./a.md)\nつづき` [c](./c.md)\n');
  assert.deepEqual(
    links.map((l) => l.target),
    ['./c.md'],
  );
});

test('extractSlugs: setext 見出し（=== 下線）も slug 化する', () => {
  const slugs = extractSlugs('セットアップ\n===\n');
  assert.ok(slugs.has('セットアップ'));
});

test('extractSlugs: blockquote 内の見出しも slug 化する', () => {
  const slugs = extractSlugs('> ## 引用内見出し\n');
  assert.ok(slugs.has('引用内見出し'));
});

test('extractLinks: blockquote 内フェンスのリンクは警告になり行番号が正確', () => {
  const { links, fenceWarnings } = extractLinks('> ```\n> [q](#anchor)\n> ```\n');
  assert.equal(links.length, 0);
  assert.equal(fenceWarnings.length, 1);
  assert.equal(fenceWarnings[0].line, 2); // "> " プレフィックス込みの原文行
});

test('extractLinks: blockquote 終端で暗黙クローズされたフェンスは未クローズ扱いしない', () => {
  const { unclosedFence } = extractLinks('> ```\n> code\n\n後続の本文\n');
  assert.equal(unclosedFence, null); // 描画は崩れないため error にしない
});

test('extractLinks: 複数行にまたがるリンクも抽出し開始行を返す', () => {
  const { links } = extractLinks('[複数行の\nテキスト](./a.md)\n');
  assert.deepEqual(links, [{ target: './a.md', line: 1 }]);
});

test('checkFile: definition（[ref]: url）のリンク切れを検出する', (t) => {
  const root = makeRepo(t, {
    'a.md': '[本文][ref]\n\n[ref]: ./missing.md\n[ok]: ./b.md\n',
    'b.md': '# B\n',
  });
  const { errors } = checkFile(root, 'a.md');
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /missing\.md/);
  assert.equal(errors[0].line, 3);
});

test('checkFile: 末尾スラッシュ無しの control ディレクトリ定義でも境界警告が機能する', (t) => {
  // 既存エントリ（docs/pr/ 等）にマッチしないパスを「スラッシュ無し」で定義し、正規化経路だけを通す
  CONTROL_ONLY_DIRS.push('docs/noslash-probe');
  t.after(() => CONTROL_ONLY_DIRS.pop());
  const root = makeRepo(t, {
    'README2.md':
      '[in](docs/noslash-probe/x.md) [dir](docs/noslash-probe) [sib](docs/noslash-probe-other/y.md)\n',
    'docs/noslash-probe/x.md': '# ok\n',
    'docs/noslash-probe-other/y.md': '# ok\n',
  });
  const { warnings } = checkFile(root, 'README2.md');
  const boundary = warnings.filter((w) => /public→control/.test(w.msg));
  // 配下ファイル（startsWith 分岐）とディレクトリ自身（=== 分岐）の両経路で警告され、
  // エントリを前方一致だけで含むきょうだいパス（-other）はセグメント境界で除外される
  assert.equal(boundary.length, 2);
  assert.ok(!boundary.some((w) => w.msg.includes('-other')));
});

test('extractLinks: character reference 入り destination はデコードされる（mdast 仕様の固定）', () => {
  const { links } = extractLinks('[x](a&amp;b.md)\n');
  assert.deepEqual(
    links.map((l) => l.target),
    ['a&b.md'],
  );
});

test('checkFile: 空ファイルでもクラッシュせず検出ゼロ', (t) => {
  const root = makeRepo(t, { 'empty.md': '' });
  const { errors, warnings } = checkFile(root, 'empty.md');
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
});

test('checkFile: CRLF 改行のファイルでも行番号が正確', (t) => {
  const root = makeRepo(t, {
    'a.md': '# T\r\n\r\n[bad](./missing.md)\r\n',
  });
  const { errors } = checkFile(root, 'a.md');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
});

test('isVendoredSkillGuide: 外部スキルの guides 配下だけを除外し SKILL.md と docs は残す', () => {
  assert.equal(isVendoredSkillGuide('.agents/skills/modern-web-guidance/guides/passkeys/x.md'), true);
  assert.equal(isVendoredSkillGuide('.claude/skills/modern-web-guidance/guides/css/x.md'), true);
  assert.equal(isVendoredSkillGuide('.agents/skills/modern-web-guidance/SKILL.md'), false);
  // guides が スキル直下でない（＝別構造）ものは除外しない
  assert.equal(isVendoredSkillGuide('.agents/skills/guides/x.md'), false);
  assert.equal(isVendoredSkillGuide('docs/skills/foo/guides/x.md'), false);
});

test('isOverlayFragment: overlay 断片を除外し README・通常の projection 出力は残す', () => {
  assert.equal(
    isOverlayFragment('docs/agent-workflows/overlays/pre-commit-review.project-checks.md'),
    true,
  );
  assert.equal(isOverlayFragment('docs/agent-workflows/overlays/README.md'), false);
  assert.equal(isOverlayFragment('docs/agent-workflows/review-pr.md'), false);
});

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { checkArtifacts } from '../scripts/agent/check-artifacts.js';
import { parseBody } from '../scripts/agent/mdast-body.js';
import { buildBody } from './helpers/checkArtifactsBody.js';

// docs / テンプレに載っている「PR 本文にこう書く」Markdown 例を実際に checkArtifacts へ
// 通し、受理される（＝そのままコピーしてゲートを通る）ことを機械検証するドッグフードテスト（#404）。
//
// 背景: PR #396 レビュー #37 で pre-commit-review.md の「レビューループ記録」例が H3
// （`### `）で書かれており、check-artifacts が必須セクションを H2 のみ検出するため
// 「例をワークフロー通りにそのまま PR 本文へ貼ると落ちる」自己矛盾が判明した。#401
// （スイープハーネス）でも #403（mdast 移行）でも捕まらない第3のクラス＝「ゲートの説明
// ドキュメント／テンプレの記入例が、ゲートが実際に受理する形式とズレる」を機械検出する。
// ドキュメントは人間がコピーする正本のため、例がゲートを通らないと誤ブロックを生み信頼を損なう。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readDoc = (rel) => readFileSync(join(ROOT, rel), 'utf-8');

// mdast の code ノードから ```markdown / ```md フェンスの中身を文書順に集める（#403 の AST 抽出）。
// フェンス内 Markdown は code ノードとして構造から隔離されるため、本文見出しの誤検出がない。
function markdownFences(src) {
  const out = [];
  (function walk(node) {
    if (node.type === 'code' && /^(markdown|md)$/i.test(node.lang ?? '')) {
      out.push(node.value);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  })(parseBody(src.replace(/\r\n?/g, '\n')));
  return out;
}

// フェンス内容を H2（`## `）区切りのセクションに分ける。見出し行は本文に含めない。
// `### ` は `##` の直後が `\s` でないためマッチせず、H3 サブ見出し（例: 完了報告フォーマット内の
// `### レビューループ記録`）を PR 本文用セクションとして誤って拾わない — これが #404 の核心。
function h2Sections(md) {
  const sections = [];
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      cur = { title: m[1], lines: [] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return sections.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }));
}

// 必須セクション名 → buildBody の差し替えスロット。記入例フェンスに現れうる必須セクションを対応付ける。
const SLOT_BY_KEYWORD = [
  { keyword: '証拠表', slot: 'evidence' },
  { keyword: 'レビューループ', slot: 'loop' },
];
// buildBody に差し替え口がない必須セクション。記入例フェンスとして現れたらハーネス拡張が必要なため
// 気付けるよう assert.fail する（新しい記入例を追加したのに検証されないまま素通りするのを防ぐ）。
const SLOTLESS_REQUIRED = ['完了条件', '想定ケース', '既存実装調査'];

function slotFor(title) {
  return SLOT_BY_KEYWORD.find((s) => title.includes(s.keyword))?.slot ?? null;
}

// doc から「PR 本文用の記入例」（＝必須セクションを H2 で書いた具体例）を抽出する。
function prBodyExamples(rel) {
  const found = [];
  for (const fence of markdownFences(readDoc(rel))) {
    for (const sec of h2Sections(fence)) {
      const slot = slotFor(sec.title);
      if (slot) {
        found.push({ title: sec.title, slot, body: sec.body });
      } else if (SLOTLESS_REQUIRED.some((name) => sec.title.includes(name))) {
        assert.fail(
          `${rel} の記入例に未対応の必須セクション「${sec.title}」があります。` +
            'buildBody にスロットを足し SLOT_BY_KEYWORD に対応付けてから検証してください',
        );
      }
    }
  }
  return found;
}

// 抽出対象と、そのファイルに最低限含まれているべき記入例（抽出漏れ＝テストの空振り防止）。
// 見出しレベルやフェンス言語が変わって抽出結果が空になると受理検証が0件になり、テストが
// 「壊れていないのに通る」状態に陥るため、期待する例の存在自体を別テストで固定する。
const TARGETS = [
  {
    doc: 'docs/agent-workflows/pre-commit-review.md',
    mustInclude: [{ keyword: 'レビューループ', slot: 'loop' }],
  },
  {
    doc: 'docs/agent-workflows/evidence-check.md',
    mustInclude: [{ keyword: '証拠表', slot: 'evidence' }],
  },
];

describe('docs 記入例のドッグフード（#404）', () => {
  // prBodyExamples の readFileSync/parseBody を describe 収集フェーズ（登録時）で呼ぶと、
  // ファイル欠落や構文エラーでテストスイート全体がクラッシュし他テストの結果がレポートされない。
  // t.test でサブテストを動的登録し、I/O をテスト実行フェーズまで遅延させる（Gemini 指摘）。
  for (const { doc, mustInclude } of TARGETS) {
    test(`${doc}: 記入例の検証`, async (t) => {
      const examples = prBodyExamples(doc);

      await t.test('期待する記入例が抽出できている', () => {
        for (const need of mustInclude) {
          assert.ok(
            examples.some((e) => e.slot === need.slot && e.title.includes(need.keyword)),
            `${doc} から「${need.keyword}」の記入例を抽出できませんでした（H2 見出しか、` +
              'フェンス言語（```markdown / ```md）が変わっていないか確認）。抽出結果: ' +
              JSON.stringify(examples.map((e) => e.title)),
          );
        }
      });

      for (const ex of examples) {
        await t.test(`記入例「${ex.title}」を PR 本文に貼ると受理される`, () => {
          const { errors, mandated, warnings } = checkArtifacts({
            changedFiles: ['src/a.js'],
            body: buildBody({ [ex.slot]: ex.body }),
          });
          assert.deepEqual(
            errors,
            [],
            `記入例がゲートに受理されません（ドキュメントの例かゲートのどちらかがズレている）:\n${errors.join('\n')}`,
          );
          // 記入例のフェンス内に有効な `<!-- artifacts-check: skip (理由) -->` が紛れ込むと
          // checkArtifacts は必須セクション検査前に早期 return し、errors=[] のまま壊れた例が
          // 素通りする（テンプレ側と同じ穴。Codex 指摘）。ここでも mandated と skip 警告不在を固定する。
          assert.equal(
            mandated,
            true,
            `記入例に有効な skip マーカーが混入しています（early return で errors=[] のまま素通り）:\n${warnings.join('\n')}`,
          );
          assert.ok(
            !warnings.some((w) => w.includes('artifacts-check をスキップ')),
            `記入例に有効な skip マーカーが混入しています:\n${warnings.join('\n')}`,
          );
        });
      }
    });
  }
});

describe('pull_request_template.md のドッグフード（#404）', () => {
  // テンプレはコード変更 PR（artifact 必須）として検査する。収集フェーズで I/O・検証を
  // 走らせると、ファイル欠落や checkArtifacts 例外でロード時にスイート全体がクラッシュし
  // 他テストの結果がレポートされない。テスト実行時に一度だけ評価する遅延メモ化にする（Gemini 指摘）。
  let cached;
  const run = () =>
    (cached ??= checkArtifacts({
      changedFiles: ['src/a.js'],
      body: readDoc('.github/pull_request_template.md'),
    }));

  test('テンプレが artifacts gate を skip 早期 return させない（mandated が立つ）', () => {
    // テンプレは全 PR のデフォルト本文。有効な `<!-- artifacts-check: skip (理由) -->` が
    // 紛れ込むと checkArtifacts は必須セクション検査前に return し errors=[] / mandated=false に
    // なり、下の missing 検査が空振りする。テンプレがゲート全体を無効化する回帰をここで固定する
    // （現テンプレは近い例を `<!~~ ~~>` へエスケープして載せている。Codex 指摘）。
    const { mandated, warnings } = run();
    assert.equal(
      mandated,
      true,
      'テンプレがコード変更 PR で artifact 必須と判定されていません（有効な skip マーカー混入の疑い）',
    );
    assert.ok(
      !warnings.some((w) => w.includes('artifacts-check をスキップ')),
      `テンプレに有効な skip マーカーが混入しています:\n${warnings.join('\n')}`,
    );
  });

  test('未クローズ HTML コメントで構造検査が早期に打ち切られていない', () => {
    const { errors } = run();
    // 未クローズコメントがあると checkArtifacts は早期 return し、以降の必須セクション検査が
    // 走らない（#415）。その場合セクション欠落検査が空振りして下のテストが偽陽性で通るため先に固定する。
    assert.ok(
      !errors.some((e) => e.includes('未クローズの HTML コメント')),
      `テンプレに未クローズの HTML コメントがあります:\n${errors.join('\n')}`,
    );
  });

  test('必須セクションの見出しがすべてゲートに検出される（見出しレベル／名称のドリフト検出）', () => {
    const { errors } = run();
    // 空テンプレ（プレースホルダ行のみ）は「空（またはプレースホルダのみ）」で落ちてよい。
    // ここで検出したいのは「必須セクションの見出しが H2・正しいセクション名でゲートに拾える形か」。
    // 見出しを H3 化・改名するとこの missing 検査が拾い、記入時に誤ブロックされる前に気付ける。
    const missing = errors.filter(
      (e) => e.startsWith('必須セクション「') && e.includes('が PR 本文にありません'),
    );
    assert.deepEqual(
      missing,
      [],
      `テンプレの必須セクション見出しがゲートの検出形式（H2・セクション名）とズレています:\n${errors.join('\n')}`,
    );
  });
});

describe('NG 例（意図的に落ちる形）の検証（#404）', () => {
  // #404 の発端そのもの: レビューループ記録を H3（`### `）で書くと必須セクション検出（H2 のみ）を
  // すり抜け「セクションがありません」で落ちる。docs が H2 を使う根拠を回帰テストとして固定する。
  test('レビューループ記録を H3 で書くと必須セクション欠落で落ちる', () => {
    const h3Body = buildBody().replace('## レビューループ記録', '### レビューループ記録');
    const { errors } = checkArtifacts({ changedFiles: ['src/a.js'], body: h3Body });
    assert.ok(
      errors.some(
        (e) => e.startsWith('必須セクション「レビューループ記録」') && e.includes('ありません'),
      ),
      `H3 見出しは必須セクション欠落で落ちるべき:\n${errors.join('\n')}`,
    );
  });
});

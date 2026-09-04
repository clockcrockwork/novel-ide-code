import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

// worker の validateCSRFToken（worker/src/middleware.ts）が 403 で返す error 文言。
// middleware.ts は hono を値として import するため、root の npm ci しかしない CI の
// lint-test では直接 import できない（syncErrorCodeParity.test.js と同じ制約）。
// リテラル文字列をソース走査で抽出し、client 側の判定文字列と一致することを機械検査する。
// ずれると workerFetchWithCSRF のリトライ判定（missing/invalid のみリトライ対象）や
// github.js の専用エラー文言分岐が worker の実際の応答と噛み合わなくなる。
//
// 抽出パターンは `'csrf token missing'|'csrf token invalid'` に固定せず
// `'csrf token [a-z ]+'` へ一般化する（N3/F-3）。固定 2値のままだと、worker が将来
// 3つ目のバリアント（例: 'csrf token expired'）を追加した際、抽出側が対象外の文字列として
// 静かに無視し、client 側の未対応が検出されない。一般化すれば新バリアントも自動的に
// 集合へ入り、client 側の欠落が toEqual の不一致として機械的に落ちる。
function extractCsrfErrorLiterals(source) {
  const matches = source.matchAll(/'(csrf token [a-z ]+)'/g);
  return new Set([...matches].map((m) => m[1]));
}

// worker ソースだけ `//` / `/* */` コメントを除去してから抽出する（N3/F-3）。コメント内に
// 偶然 `'csrf token ...'` の形をした文字列が書かれても実コードの literal と誤認しない
// ようにする（例: 「旧実装は 'csrf token missing' を返していた」といった説明コメント）。
// 簡易的な除去であり文字列リテラル内の `//`/`/* */` も一緒に消えうるが、本ファイルが
// 対象とする 'csrf token ...' 系の literal は通常コード中で単独に書かれるため実害は無い。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('CSRF エラー文言の client/worker parity', () => {
  const workerSource = stripComments(readFileSync(join(HERE, '../../worker/src/middleware.ts'), 'utf8'));
  const workerLiterals = extractCsrfErrorLiterals(workerSource);

  it('worker（validateCSRFToken）が missing/invalid 両方の文言を返す', () => {
    expect(workerLiterals).toEqual(new Set(['csrf token missing', 'csrf token invalid']));
  });

  it('workerClient.js のリトライ判定文字列が worker と一致する', () => {
    const clientSource = readFileSync(join(HERE, 'workerClient.js'), 'utf8');
    expect(extractCsrfErrorLiterals(clientSource)).toEqual(workerLiterals);
  });

  it('github.js の CSRF 専用エラー文言の判定文字列が worker と一致する', () => {
    const githubSource = readFileSync(join(HERE, 'github.js'), 'utf8');
    expect(extractCsrfErrorLiterals(githubSource)).toEqual(workerLiterals);
  });
});

import { Hono } from 'hono';
import { bodySize, revokeSessionIfTokenInvalid } from './middleware';
import { validateGitHubWritePath, validateBranch } from './validation';
import type { AppEnv } from './types';

const GITHUB_BODY_LIMIT = bodySize(5 * 1024 * 1024);

const GH_BASE = 'https://api.github.com';
const GH_VERSION = '2022-11-28';

const decoder = new TextDecoder();

export const githubProxy = new Hono<AppEnv>();

function isAllowedGitHubRequest(method: string, ghPath: string, segments: string[]): boolean {
  if (method === 'GET' && ghPath === '/user') return true;
  if (method === 'GET' && ghPath === '/user/repos') return true;
  if (segments[0] !== 'repos' || segments.length < 3) return false;
  if (method === 'GET' && segments.length === 3) return true;
  const resource = segments[3];
  if ((method === 'GET' || method === 'PUT') && resource === 'contents') return true;
  if (method === 'GET' && resource === 'branches' && segments.length === 4) return true;
  if ((method === 'GET' || method === 'POST') && resource === 'pulls' && segments.length === 4) return true;
  if (method === 'PUT' && resource === 'pulls' && segments.length === 6 && segments[5] === 'merge') return true;
  return false;
}

// PUT /repos/{owner}/{repo}/contents/{path} のファイルパス部分を抽出する
// 不正なURLエンコーディングは URIError をスローする（呼び出し元で 400 を返す）
// contents リソースの場合は空パスも "" として返し validateGitHubWritePath で拒否させる
function extractContentsPath(segments: string[]): string | null {
  if (segments[3] !== 'contents') return null;
  return segments.slice(4).map(decodeURIComponent).join('/');
}

githubProxy.all('/*', GITHUB_BODY_LIMIT, async (c) => {
  const token = c.get('githubToken');
  const url = new URL(c.req.url);
  const ghPath = url.pathname.replace(/^\/github/, '');
  if (ghPath.includes('//')) {
    return c.json({ error: 'Empty path segments are not allowed' }, 400);
  }
  const segments = ghPath.split('/').filter(Boolean);
  if (!isAllowedGitHubRequest(c.req.method, ghPath, segments)) {
    return c.json({ error: 'GitHub endpoint not allowed' }, 403);
  }

  // repo 境界照合（#283）: /repos/{owner}/{repo}/** は認可済みリスト or 固定同期 repo のみ許可。
  // 認可外は GitHub へ送らず 403。/user・/user/repos は repo 非スコープのため対象外。
  if (segments[0] === 'repos') {
    const slug = `${segments[1].toLowerCase()}/${segments[2].toLowerCase()}`;
    const syncRepo = `${c.get('login').toLowerCase()}/.novel-ide`;
    const authorized = c.get('authorizedRepos');
    if (slug !== syncRepo && !authorized.includes(slug)) {
      return c.json({ error: 'Repository not authorized' }, 403);
    }
  }

  let isContentsPut = false;
  if (c.req.method === 'PUT') {
    try {
      const contentsPath = extractContentsPath(segments);
      if (contentsPath !== null) {
        isContentsPut = true;
        const err = validateGitHubWritePath(contentsPath);
        if (err !== null) return c.json({ error: 'Write path not allowed' }, 403);
      }
    } catch {
      return c.json({ error: 'Invalid path encoding' }, 400);
    }
  }
  const ghUrl = `${GH_BASE}${ghPath}${url.search}`;

  const init: RequestInit = {
    method: c.req.method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GH_VERSION,
      'Content-Type': 'application/json',
    },
  };

  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const body = await c.req.arrayBuffer();
    // contents 直接 commit 経路は branch を validateBranch() で検証（#287）
    if (isContentsPut) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoder.decode(body));
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
      }
      const branch = (parsed as Record<string, unknown> | null)?.branch;
      // branch 省略（undefined）はデフォルトブランチ扱いで許可。それ以外（非文字列含む）は検証
      if (branch !== undefined && validateBranch(branch) !== null) {
        return c.json({ error: 'Invalid branch' }, 400);
      }
    }
    init.body = body;
  }

  const res = await fetch(ghUrl, init);

  // GitHub token 失効時は KV セッションを破棄し、再ログインを促す（#288）
  if (await revokeSessionIfTokenInvalid(c, res.status)) {
    return c.json({ error: 'GitHub token revoked, please re-login' }, 401);
  }

  const headers = new Headers({
    'Content-Type': res.headers.get('Content-Type') || 'application/json',
  });

  const remaining = res.headers.get('X-RateLimit-Remaining');
  if (remaining !== null) headers.set('X-RateLimit-Remaining', remaining);

  return new Response(res.body, { status: res.status, headers });
});

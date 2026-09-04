import { env as cloudflareEnv, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import app from '../index';
import { CSRF_TOKEN_TTL, SESSION_TTL } from '../auth';
import type { Bindings } from '../types';

export const env = cloudflareEnv as Bindings;

export function makeSession(
  overrides: Partial<{
    githubToken: string;
    login: string;
    expiresAt: number;
    avatarUrl: string;
    authorizedRepos: string[];
  }> = {},
) {
  return JSON.stringify({
    githubToken: 'gh_test_token',
    login: 'testuser',
    expiresAt: Date.now() + SESSION_TTL * 1000,
    avatarUrl: 'https://example.com/avatar.png',
    authorizedRepos: ['testuser/myrepo'],
    ...overrides,
  });
}

export async function seedSession(sessionToken: string, data = makeSession()) {
  await env.SESSIONS.put(`session:${sessionToken}`, data, { expirationTtl: SESSION_TTL });
}

export async function seedCSRF(sessionToken: string, csrfToken: string) {
  await env.SESSIONS.put(`csrf:${sessionToken}:${csrfToken}`, '1', { expirationTtl: CSRF_TOKEN_TTL });
}

export function appFetch(path: string, opts: RequestInit = {}, cookies: Record<string, string> = {}) {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  const headers = new Headers(opts.headers as HeadersInit);
  if (cookieHeader) headers.set('Cookie', cookieHeader);
  const req = new Request(`http://localhost${path}`, { ...opts, headers });
  const ctx = createExecutionContext();
  const res = app.fetch(req, env, ctx);
  return waitOnExecutionContext(ctx).then(() => res);
}

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function encodeGitHubContent(content: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(content, null, 2));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function decodeGitHubContent(content: string) {
  const binary = atob(content.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

export function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

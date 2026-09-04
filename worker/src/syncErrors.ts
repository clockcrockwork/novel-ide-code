// GitHub upstream の失敗を「status を潰さない typed error」として扱う（#608 A-1）。
// 以前は `throw new Error('GitHub ' + status)` で文字列化していたため、SHA 競合（409）・
// 検証エラー（422）・上流障害（5xx）が route の catch で一律 500 に潰れ、client 側は
// 「サーバーエラー」としか判別できなかった。復旧経路が競合と障害を区別できないと、
// 破壊的な復旧（初回同期扱いでの全件 push）へ倒れうる。
//
// parity: src/lib/syncErrors.js と対（code 集合を syncErrorCodeParity.test.js が機械検査）。
// **定数・分類・応答テーブルは syncErrorCodes.ts**（実行時 import を持たないこと。理由は同ファイル冒頭）。
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './types';
import {
  CATEGORY_RESPONSE,
  MISSING_RESPONSE,
  CONFLICT_RESPONSE,
  PROTOCOL_UPGRADE_RESPONSE,
  RemoteContentCorruptError,
  categorizeUpstreamStatus,
} from './syncErrorCodes';
import type { SyncErrorCategory } from './syncErrorCodes';

export { SYNC_ERROR_CODES, CATEGORY_RESPONSE, RemoteContentCorruptError, categorizeUpstreamStatus } from './syncErrorCodes';
export type { SyncErrorCode, SyncErrorCategory } from './syncErrorCodes';

export class GitHubUpstreamError extends Error {
  readonly upstreamStatus: number;
  readonly category: SyncErrorCategory;
  readonly operation: string;

  constructor(upstreamStatus: number, operation: string) {
    super(`GitHub ${operation} failed with ${upstreamStatus}`);
    this.name = 'GitHubUpstreamError';
    this.upstreamStatus = upstreamStatus;
    this.category = categorizeUpstreamStatus(upstreamStatus);
    this.operation = operation;
  }
}

// remote manifest の formatVersion が、この request の capability 宣言を超えている（#609）。
// GitHubUpstreamError / RemoteContentCorruptError と同じ「throw → syncErrorResponse が
// 一括で分類」経路に統一する。route が真偽値を見て自分で応答を組み立てる別経路を
// 持たせると、新しい拒否条件を足すたびにどちらの様式で書くかが実装者依存になる
// （品質・簡潔性レビュー指摘）。**同一 category（ここでは protocol_upgrade_required）に
// 複数 code を割り当てる必要がある場合はこの throw 経路を使わない**: `CATEGORY_RESPONSE` は
// category ごとに 1 code しか持てないため、`sync_manifest_ref_required` のような別 code は
// `syncErrorCodes.ts` の route-direct テーブル（`PROTOCOL_UPGRADE_RESPONSE` / 409 側は
// `CONFLICT_RESPONSE`）と `syncProtocolUpgradeResponse` / `syncConflictResponse`
// （`syncMissingResponse` と同型の直接 return ヘルパー）を使う。
export class ProtocolUpgradeRequiredError extends Error {
  constructor(operation: string) {
    super(`protocol upgrade required: ${operation}`);
    this.name = 'ProtocolUpgradeRequiredError';
  }
}

export function syncMissingResponse(c: Context<AppEnv>, what: keyof typeof MISSING_RESPONSE) {
  return c.json(MISSING_RESPONSE[what], 404);
}

// 細分しない「見つからない」。GitHub の 404 を route の catch で分類したときと同じ応答になる。
export function syncNotFoundResponse(c: Context<AppEnv>) {
  const { status, ...body } = CATEGORY_RESPONSE.not_found;
  return c.json(body, status);
}

// worker が能動的に検出した 409（entity write の世代拘束。#609 A-2）。GitHub upstream の
// 応答ではないため throw → syncErrorResponse の経路ではなく、route から直接返す
// （syncMissingResponse と同型）。
export function syncConflictResponse(c: Context<AppEnv>, what: keyof typeof CONFLICT_RESPONSE) {
  return c.json(CONFLICT_RESPONSE[what], 409);
}

// entity write が `_manifestSha` を送っていない旧 bundle への 426（#609 A-2）。
export function syncProtocolUpgradeResponse(
  c: Context<AppEnv>, what: keyof typeof PROTOCOL_UPGRADE_RESPONSE,
) {
  return c.json(PROTOCOL_UPGRADE_RESPONSE[what], 426);
}

// route の catch を 1 箇所へ寄せる。HTTPException（401 セッション破棄等）の再送出もここで行う:
// 各 route に `if (e instanceof HTTPException) throw e;` を複製すると、新 route で書き忘れた
// ときに 401 の再ログイン導線（#288）が静かに 500 へ潰れる。
export function syncErrorResponse(c: Context<AppEnv>, e: unknown) {
  if (e instanceof HTTPException) throw e;
  // SyntaxError はリクエスト本文の parse 失敗にだけ使う。remote 側の壊れた JSON は
  // RemoteContentCorruptError で先に分けてあるので、ここで 400 に混ざらない。
  if (e instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400);
  let category: SyncErrorCategory = 'server';
  if (e instanceof GitHubUpstreamError) {
    category = e.category;
    console.error('sync upstream error', e.operation, e.upstreamStatus);
  } else if (e instanceof RemoteContentCorruptError) {
    category = 'corrupt';
    console.error('sync remote corrupt', e.path);
  } else if (e instanceof ProtocolUpgradeRequiredError) {
    category = 'protocol_upgrade_required';
  } else {
    console.error('sync error', (e as Error)?.message);
  }
  const { status, ...body } = CATEGORY_RESPONSE[category];
  return c.json(body, status);
}

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  SYNC_ERROR_CODES as clientCodes,
  CATEGORY_MESSAGE as clientCategoryMessage,
  categorizeSyncFailure,
  KNOWN_SAFE_FORMAT_VERSION as clientFormatVersion,
  LEGACY_DEFAULT_FORMAT_VERSION as clientLegacyDefaultFormatVersion,
  FORMAT_CAPABILITY_VERSION as clientCapabilityVersion,
  FORMAT_CAPABILITY_HEADER as clientCapabilityHeader,
} from './syncErrors';
// worker 側は **実行時 import を持たない** syncErrorCodes.ts から読む。vitest(esbuild) が .ts を
// トランスパイルするため直接 import できる（rootPathValidationParity.test.js と同方式）。
// syncErrors.ts（hono を値として import する）を読むと、root の npm ci しかしない CI の
// lint-test で module 解決に失敗し、すべての code 変更で lint-test が落ちる。
import {
  SYNC_ERROR_CODES as workerCodes,
  CATEGORY_RESPONSE as workerCategoryResponse,
  categorizeUpstreamStatus,
  KNOWN_SAFE_FORMAT_VERSION as workerFormatVersion,
  LEGACY_DEFAULT_FORMAT_VERSION as workerLegacyDefaultFormatVersion,
  FORMAT_CAPABILITY_VERSION as workerCapabilityVersion,
  FORMAT_CAPABILITY_HEADER as workerCapabilityHeader,
} from '../../worker/src/syncErrorCodes.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// 同期エラーの意味は worker が決め client が分岐する。code 集合がずれると
// client は未知 code として status フォールバックへ落ち、409 / 422 の取り違えや
// init 突入判定の誤りが静かに復活する（#608）。機械検査で固定する。
describe('sync error code の client/worker parity', () => {
  it('code 集合が完全に一致する', () => {
    expect(new Set(Object.values(clientCodes))).toEqual(new Set(Object.values(workerCodes)));
  });

  it('キー名も一致する（片側だけの追加を検出する）', () => {
    expect(Object.keys(clientCodes).sort()).toEqual(Object.keys(workerCodes).sort());
  });

  // 404 の細分（MISSING_RESPONSE 側の code）も client が既知として扱えること。
  it.each([
    ['sync_repo_missing', 'not_found'],
    ['sync_manifest_missing', 'not_found'],
    ['sync_workspace_inconsistent', 'workspace_inconsistent'],
  ])('worker の 404 細分 %s を client が %s へ復元する', (code, expected) => {
    expect(Object.values(workerCodes)).toContain(code);
    expect(categorizeSyncFailure(404, code)).toBe(expected);
  });

  // entity write の世代拘束（#609 A-2）で追加した code も、CATEGORY_RESPONSE（category ごと
  // 1 code）ではなく worker 側の route-direct テーブル（CONFLICT_RESPONSE /
  // PROTOCOL_UPGRADE_RESPONSE）で定義されているため、404 の細分と同じ形の it.each で
  // status/code の往復を固定する。
  it.each([
    ['sync_manifest_stale', 409, 'conflict'],
    ['sync_entity_stale', 409, 'conflict'],
    ['sync_entity_orphan', 409, 'conflict'],
    ['sync_manifest_ref_required', 426, 'protocol_upgrade_required'],
  ])('worker の %s 応答（status %d）を client が %s へ復元する', (code, status, expected) => {
    expect(Object.values(workerCodes)).toContain(code);
    expect(categorizeSyncFailure(status, code)).toBe(expected);
  });

  // worker が返した応答（status + code）を client が同じ category へ復元できること。
  // これが「意味が worker → client で失われない」の実体。旧版は worker 側の関数だけを
  // 呼び、client のフォールバックを一度も評価しないまま「client と矛盾しない」と名乗っていた。
  it.each(Object.keys(workerCategoryResponse))(
    'worker の %s 応答を client が同じ category へ復元する',
    (workerCategory) => {
      const { status, code } = workerCategoryResponse[workerCategory];
      expect(categorizeSyncFailure(status, code)).toBe(workerCategory);
    },
  );

  // GitHub upstream status → worker category の対応（worker 内部の分類）。
  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [422, 'unprocessable'],
    [429, 'upstream'],
    [500, 'upstream'],
    [502, 'upstream'],
  ])('GitHub upstream status %d を worker が %s に分類する', (status, expected) => {
    expect(categorizeUpstreamStatus(status)).toBe(expected);
  });

  // 文言そのものは一致させない（worker = 応答本文をそのまま描画する消費者向けの事実文、
  // client = 行動指示を含む UI 文言）。ただし **category 集合**がずれると、片側だけ文言の
  // 無い category が生まれる。集合の一致だけを固定する。
  it('category 集合が client / worker で一致する（network は client 専用）', () => {
    const workerCategories = new Set(Object.keys(workerCategoryResponse));
    const clientCategories = new Set(Object.keys(clientCategoryMessage));

    // network は fetch 例外に対する client 固有の category で、worker からは返らない。
    expect(clientCategories.has('network')).toBe(true);
    clientCategories.delete('network');
    // auth は worker では HTTPException(401) 経路が扱うため CATEGORY_RESPONSE に無い。
    expect(clientCategories.has('auth')).toBe(true);
    clientCategories.delete('auth');
    // internal は client 側の整合性ガードが発火した場合の category（worker からは返らない）。
    expect(clientCategories.has('internal')).toBe(true);
    clientCategories.delete('internal');
    // workspace_inconsistent は worker では 404 の細分（MISSING_RESPONSE）として返るため
    // CATEGORY_RESPONSE には無い。code の集合一致は上の検査が担保する。
    expect(clientCategories.has('workspace_inconsistent')).toBe(true);
    clientCategories.delete('workspace_inconsistent');
    // too_large は middleware の bodySize が code なしの 413 で返すため CATEGORY_RESPONSE に無い。
    expect(clientCategories.has('too_large')).toBe(true);
    clientCategories.delete('too_large');

    expect(clientCategories).toEqual(workerCategories);
  });

  it('worker の全 category に client 文言がある', () => {
    for (const category of Object.keys(workerCategoryResponse)) {
      expect(clientCategoryMessage[category]).toBeTruthy();
    }
  });

  // CATEGORY_PRIORITY の欠落は pickPrimaryCategory の末尾フォールバックで動いてしまい
  // 表面化しない（欠けた category が代表に選ばれず、実際の原因が表示から消える）。
  it('CATEGORY_PRIORITY が CATEGORY_MESSAGE の全 category を網羅する', async () => {
    const { CATEGORY_PRIORITY } = await import('./syncErrors.js');
    expect(new Set(CATEGORY_PRIORITY)).toEqual(new Set(Object.keys(clientCategoryMessage)));
  });

  // catalog（CATEGORY_RESPONSE）だけでなく、worker が実際に返す **code を持たない応答**も
  // client が正しく分類できること。往復検査が catalog に閉じていると、最も踏みやすい
  // レートリミット 429 と入力拒否 400 が一度も評価されないまま「往復検査済み」になる。
  it.each([
    [429, 'upstream', 'worker 自身のレートリミット（rateLimit.ts）'],
    [400, 'internal', 'worker の入力拒否（Invalid JSON / invalid id / invalid name 等）'],
    [401, 'auth', 'セッション失効（HTTPException）'],
    [413, 'too_large', 'body size 超過（middleware の bodySize）'],
  ])('code を持たない worker 応答 %d を client が %s に分類する（%s）', (status, expected) => {
    expect(categorizeSyncFailure(status, null)).toBe(expected);
  });

  // parity テストが worker の実行時依存（hono 等）を引き込むと、root の npm ci しかしない
  // CI の lint-test が module 解決に失敗し、すべての code 変更で落ちる。import 先が
  // 実行時 import を持たないことを機械検査する（rootPathValidationParity と同じ前提）。
  it('parity の import 先は実行時 import を持たない', () => {
    const source = readFileSync(join(HERE, '../../worker/src/syncErrorCodes.ts'), 'utf8');
    const runtimeImports = source
      .split('\n')
      .filter((line) => /^\s*import\s/.test(line) && !/^\s*import\s+type\s/.test(line));

    expect(runtimeImports).toEqual([]);
  });

  // KNOWN_SAFE_FORMAT_VERSION は信頼境界（worker ⇄ client）をまたいで値を一致させる契約
  // （sync-contract.md）だが、SYNC_ERROR_CODES と異なりどちらも独立した数値リテラルで
  // 定義されており、片方だけ更新すると CI が検出しない（#609 敵対的レビュー由来）。
  it('KNOWN_SAFE_FORMAT_VERSION が client / worker で一致する', () => {
    // rename / export 削除で両側 undefined になると toBe(undefined) が空振りで通るため、
    // 値が実在する（数値である）ことを先に固定する（敵対的レビュー由来）。
    expect(Number.isInteger(clientFormatVersion)).toBe(true);
    expect(clientFormatVersion).toBe(workerFormatVersion);
  });

  // #394 C-0: KNOWN_SAFE_FORMAT_VERSION から分離した残り 2 定数も同じ理由（独立した
  // 数値リテラル定義）で片側だけの更新を検出できないため、同様に固定する。
  it('LEGACY_DEFAULT_FORMAT_VERSION が client / worker で一致する', () => {
    expect(Number.isInteger(clientLegacyDefaultFormatVersion)).toBe(true);
    expect(clientLegacyDefaultFormatVersion).toBe(workerLegacyDefaultFormatVersion);
  });

  // 上げると旧 client 既定値の解釈が変わり、既存の v2 manifest を誤判定する（絶対値 pin）。
  it('LEGACY_DEFAULT_FORMAT_VERSION は 2 のまま', () => {
    expect(clientLegacyDefaultFormatVersion).toBe(2);
  });

  it('FORMAT_CAPABILITY_VERSION が client / worker で一致する', () => {
    expect(Number.isInteger(clientCapabilityVersion)).toBe(true);
    expect(clientCapabilityVersion).toBe(workerCapabilityVersion);
  });

  // 上げると checkFormatCapability の早期 return が v3 への無検査書き込みを通す fail-open
  // になる（絶対値 pin）。
  it('KNOWN_SAFE_FORMAT_VERSION は 2 のまま', () => {
    expect(clientFormatVersion).toBe(2);
  });

  it('FORMAT_CAPABILITY_HEADER が client / worker で一致する', () => {
    expect(typeof clientCapabilityHeader).toBe('string');
    expect(clientCapabilityHeader.length).toBeGreaterThan(0);
    expect(clientCapabilityHeader).toBe(workerCapabilityHeader);
  });
});

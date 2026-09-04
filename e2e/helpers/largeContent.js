export const PERF_FILE_ID = 'e2e-perf-test-file';

/**
 * 300段落 × ~150字のMarkdown混在コンテンツを生成する。
 * 仮想化・WritingRules・serializeToText が全部ストレスを受ける量。
 *
 * - 毎20段落に # 見出し（indent ルール非適用）
 * - 毎5段落に「（括弧）「かぎかっこ」」（bracket_sp ルール対象）
 * - 他の段落は全角スペース先頭（indent ルール適用対象）
 */
export function generateLargeContent(paragraphs = 300, targetChars = 150) {
  const lines = [];
  for (let i = 0; i < paragraphs; i++) {
    if (i % 20 === 0) {
      lines.push(`# 第${Math.floor(i / 20) + 1}章　見出しテスト${i}`);
    } else if (i % 5 === 0) {
      const base = `　（括弧テスト）「かぎかっこ」の文章。第${i}段落。`;
      lines.push(base + 'あ'.repeat(Math.max(0, targetChars - base.length)));
    } else {
      const base = `　第${i}段落のテスト文章。小説専用IDEのパフォーマンステスト用コンテンツです。`;
      lines.push(base + 'あ'.repeat(Math.max(0, targetChars - base.length)));
    }
  }
  return lines.join('\n');
}

/**
 * 大量コンテンツファイルを IDB に直接注入し、そのファイルを選択状態にする。
 * テスト前の beforeEach で page.goto 後に呼び出すこと。
 *
 * page.addInitScript を使って次の navigation（reload）の開始時に Zustand より先に
 * ide_fid を設定する。これにより lsCache の debounced write との競合を回避する。
 */
export async function injectLargeFile(page, dbName, dbVersion, content) {
  const fileId = PERF_FILE_ID;

  // 次の navigation (reload) で JS 実行前に ide_fid を設定する
  await page.addInitScript((fid) => {
    localStorage.setItem('ide_fid', JSON.stringify(fid));
  }, fileId);

  await page.evaluate(
    async ({ fileId, content, dbName, dbVersion }) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, dbVersion);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IDB open blocked'));
      });
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['files', 'meta'], 'readwrite');
          tx.objectStore('files').put({
            id: fileId,
            name: 'perf-test.md',
            content,
            createdAt: 1000000,
            updatedAt: 1000000,
          });
          tx.objectStore('meta').put({ key: 'fid', value: fileId });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
    { fileId, content, dbName, dbVersion },
  );
}

/**
 * WritingRules（indent / rm_dbl_sp / bracket_sp）をすべて有効化する。
 * 旧 localStorage キーを削除してDBを正として使わせる。
 */
export async function enableWritingRules(page, dbName, dbVersion) {
  await page.evaluate(
    async ({ dbName, dbVersion }) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, dbVersion);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        const rules = [
          { id: 'indent', label: '行頭全角スペース', enabled: true },
          { id: 'rm_dbl_sp', label: '連続全角スペース除去', enabled: true },
          { id: 'bracket_sp', label: '括弧前後のスペース除去', enabled: true },
        ];
        await new Promise((resolve, reject) => {
          const tx = db.transaction('settings', 'readwrite');
          tx.objectStore('settings').put({ key: 'rules', value: rules });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
      try {
        localStorage.removeItem('ide_rules');
      } catch {}
    },
    { dbName, dbVersion },
  );
}

/**
 * IDB から指定ファイルの content を取得する。
 */
export async function readFileContent(page, dbName, dbVersion, fileId) {
  return page.evaluate(
    async ({ dbName, dbVersion, fileId }) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, dbVersion);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('files', 'readonly');
          const req = tx.objectStore('files').get(fileId);
          req.onsuccess = () => resolve(req.result?.content ?? null);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    { dbName, dbVersion, fileId },
  );
}

/**
 * IDB から指定ファイルの updatedAt を取得する。
 */
export async function readFileUpdatedAt(page, dbName, dbVersion, fileId) {
  return page.evaluate(
    async ({ dbName, dbVersion, fileId }) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, dbVersion);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('files', 'readonly');
          const req = tx.objectStore('files').get(fileId);
          req.onsuccess = () => resolve(req.result?.updatedAt ?? 0);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    { dbName, dbVersion, fileId },
  );
}

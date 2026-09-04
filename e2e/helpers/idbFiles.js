/**
 * IndexedDB の files ストアに、content に指定文字列を含むレコードが
 * 存在するかを調べる。write-persist.spec.js / github-disconnected.spec.js の
 * 永続化確認（expect.poll と組み合わせて使う）で共通利用する。
 */
export async function filesContainText(page, dbName, dbVersion, text) {
  return page.evaluate(
    async ({ dbName, dbVersion, text }) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, dbVersion);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB open blocked'));
      });
      try {
        const files = await new Promise((resolve, reject) => {
          const tx = db.transaction('files', 'readonly');
          const r = tx.objectStore('files').getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        return files.some((f) => (f.content || '').includes(text));
      } finally {
        db.close();
      }
    },
    { dbName, dbVersion, text },
  );
}

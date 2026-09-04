import { dbClearAll } from './db';
import { cancelWritesByPrefix } from './lsCache';

const LS_PREFIX = 'ide_';

// ide_ プレフィックスの localStorage キーを削除する（#279 / JSON バックアップ復元 #216 / #219
// の両方から使う共通処理）。IDB 側だけを置き換えて localStorage を触らないと、復元後の
// リロードで filesStore.hydrate 等の「IDB が空なら localStorage を正とする」フォールバックが
// 踏まれ、復元前のデータが IDB へ書き戻される（A3）。
//
// 削除の前に lsCache の pending（debounce 書き込みキュー）を ide_ プレフィックス分だけ破棄する:
// 破棄しないと、この直後の window.location.reload() が発火させる beforeunload で
// lsCache.flush() が走り、削除したはずの ide_* が削除前の値で書き戻ってしまう
// （#279 の clearAllLocalData も同じ穴を持っていたため、この共通関数の修正で同時に塞がれる）。
//
// キー単位で try/catch し、1件の削除失敗で以降のキーの削除を中断しない。戻り値
// { ok, failedKeys } で成否を呼び出し側（RestoreDataModal.jsx）へ伝える。
export function clearIdePrefixedStorage() {
  cancelWritesByPrefix(LS_PREFIX);

  let keys;
  try {
    keys = Object.keys(localStorage);
  } catch (e) {
    console.warn('[clearLocalData] localStorage access failed', e);
    return { ok: false, failedKeys: [] };
  }

  const failedKeys = [];
  for (const key of keys) {
    if (!key.startsWith(LS_PREFIX)) continue;
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn('[clearLocalData] localStorage.removeItem failed', key, e);
      failedKeys.push(key);
    }
  }
  return { ok: failedKeys.length === 0, failedKeys };
}

// ローカルデータを全削除して初期状態へリセットする（#279 / LOCAL-STORAGE-PROTECTION.md §4）。
// IndexedDB の全ストアを clear し、localStorage の ide_ プレフィックスキー（UI 設定・本文
// キャッシュ・旧 migration キー）を削除してからリロードする。clearIdePrefixedStorage の
// 戻り値は見ない（#279 の挙動を変えない。削除失敗時のハンドリングは JSON バックアップ復元側
// 〔RestoreDataModal.jsx〕のみが持つ）。
export async function clearAllLocalData() {
  await dbClearAll();
  clearIdePrefixedStorage();
  window.location.reload();
}

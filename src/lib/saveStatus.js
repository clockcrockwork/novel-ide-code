import { dbPut } from './db';
import { uiActions } from '../stores/uiStore';

// ローカル（IndexedDB）保存状態の観測系（#215）。保存はファイル単位で並行 debounce される
// ため、内部はファイル単位の世代（dirtySeq/savedSeq）で管理し、公開は派生グローバル状態にする。
// flat な単一状態だと「A の保存完了で B が dirty でも保存済み表示」の嘘をつくため。

// fileId -> { dirtySeq, savedSeq, oversize, error, name }
// キーはファイル ID（ユーザー由来）なので Map を使う（INVARIANTS #11 プロトタイプ汚染回避）。
const _files = new Map();
let _pending = 0; // in-flight な dbPut の本数
let _lastSavedAt = null;

// never-settle な dbPut（バックグラウンドタブ throttle / unload 中の接続クローズ等）で
// _pending が減らず「保存中」が恒久固着し全状態をマスクするのを防ぐ番犬の待ち時間。
const SAVE_TIMEOUT_MS = 15000; // not-a-threshold

let _status = { state: 'idle', lastSavedAt: null, error: null, detail: null };
const _listeners = new Set();

function setStatus(next) {
  // 派生状態が不変なら通知しない（編集ごとの dirty→dirty で全 listener・ヘッダを
  // 再レンダリングさせない）。
  if (
    _status.state === next.state &&
    _status.lastSavedAt === next.lastSavedAt &&
    _status.error === next.error &&
    _status.detail === next.detail
  ) {
    return;
  }
  _status = { ...next };
  for (const fn of _listeners) fn({ ..._status });
}

function entryFor(fileId) {
  let e = _files.get(fileId);
  if (!e) {
    // savedSeq=-1 は「未保存」の番兵。generation 0（初回保存）と区別するため 0 にしない。
    e = { dirtySeq: 0, savedSeq: -1, oversize: false, error: null, name: '' };
    _files.set(fileId, e);
  }
  return e;
}

// 派生グローバル状態を map の1パスで再計算する。優先順位:
// error > oversize > saving > dirty > saved > idle。
// 実際に書き込み失敗した error を最優先で表に出し、他ファイルの oversize/saved で隠さない。
function recompute() {
  const oversizeNames = [];
  const errorNames = [];
  let anyDirty = false;
  let lastError = null;
  for (const e of _files.values()) {
    if (e.oversize) oversizeNames.push(e.name || '');
    if (e.error) {
      errorNames.push(e.name || '');
      lastError = e.error;
    }
    if (e.dirtySeq > e.savedSeq) anyDirty = true;
  }

  let state = 'idle';
  let error = null;
  let detail = null;
  if (errorNames.length) {
    state = 'error';
    error = lastError;
    detail = errorNames.filter(Boolean).join(', ') || null;
  } else if (oversizeNames.length) {
    state = 'oversize';
    detail = oversizeNames.filter(Boolean).join(', ') || null;
  } else if (_pending > 0) {
    state = 'saving';
  } else if (anyDirty) {
    state = 'dirty';
  } else if (_lastSavedAt) {
    state = 'saved';
  }
  setStatus({ state, lastSavedAt: _lastSavedAt, error, detail });
}

export function onSaveStatusChange(fn) {
  _listeners.add(fn);
  fn({ ..._status });
  return () => _listeners.delete(fn);
}

export function getSaveStatus() {
  return { ..._status };
}

// 編集ごとに呼ぶ（上限内）。当該ファイルを未保存にし、以前の oversize を解除する
// （上限内へ戻した瞬間に「サイズ超過」表示を解いて「未保存 → 保存中」に進める）。
export function noteDirty(fileId, name) {
  if (!fileId) return;
  const e = entryFor(fileId);
  e.dirtySeq++;
  e.oversize = false;
  if (name != null) e.name = name;
  recompute();
}

function dropSaveEntry(fileId) {
  if (!fileId) return;
  if (_files.delete(fileId)) recompute();
}

// ファイル削除・隔離で active から外れたときに呼ぶ。残置エントリが recompute を汚染して
// error/oversize/dirty を永続表示し続けるのを防ぐ。
export function noteRemoved(fileId) {
  dropSaveEntry(fileId);
}

// content が非エディタ経路（pull 採用）で置換され、本文が同期的に永続済みのときに呼ぶ。
// 直前の oversize/error/dirty なローカル未保存状態は無効なので即時掃除する。
export function noteReset(fileId) {
  dropSaveEntry(fileId);
}

// content 採用（競合解決・ブランチ切替）で、書き込みが非同期（dbPut.then）のときに使う。
// 呼び出し時点の世代を捕捉し、返り値のコミッタを永続成功後に呼ぶと、その間に新編集が
// 無ければ（世代不変なら）掃除する。永続前の false-clean を避けつつ、永続待ちの窓で入った
// 新編集（特に後続フラッシュで再生成されない oversize/error）を誤って消さない。
export function deferReset(fileId) {
  // saveFileRecord と同様に entry を identity で捕捉する。値（dirtySeq）だけの比較だと、
  // 永続待ちの窓で entry が別経路でドロップ→再生成され dirtySeq が捕捉値へ戻る ABA で、
  // 掃除すべきでない新規未保存状態を誤ってドロップする（fail-open）。
  const captured = _files.get(fileId) || null;
  const seq = captured ? captured.dirtySeq : -1;
  return () => {
    const cur = _files.get(fileId) || null;
    // 別オブジェクトに再生成された（ABA）／同一 entry でも新編集で世代が進んだ場合は掃除しない。
    if (cur !== captured || (cur && cur.dirtySeq !== seq)) return;
    if (cur) dropSaveEntry(fileId);
  };
}

// リネーム時に呼ぶ。既存エントリの表示名（error/oversize バッジの detail）のみ更新する。
// エントリを新規作成しない（未編集ファイルのリネームで幽霊エントリを作らない）。
export function noteRenamed(fileId, name) {
  if (!fileId || name == null) return;
  const e = _files.get(fileId);
  if (!e) return;
  e.name = name;
  recompute();
}

// 5MB 上限超過で書き込みをスキップした編集に対して呼ぶ。書き込みは発生しないため
// savedSeq は前進せず、当該ファイルはメモリ上のみ（未永続）のまま。トーストで警告する。
export function noteOversize(fileId, name) {
  if (!fileId) return;
  const e = entryFor(fileId);
  e.oversize = true;
  e.dirtySeq++;
  if (name != null) e.name = name;
  recompute();
  uiActions.addToast(
    'ファイルサイズが上限（5MB）を超えています。この変更は保存されません',
    5000,
  );
}

// 本文（files ストア）の保存を解決する唯一のラッパ。dbPut を包み、保存中 → 保存済み/失敗の
// 状態遷移と最終保存時刻を管理する。metadata・security メタ・同期経路の書き込みには使わない
// （INVARIANTS #3: content と metadata は別トランザクション）。
export function saveFileRecord(record) {
  const fileId = record?.id;
  if (!fileId) return Promise.resolve();
  const e = entryFor(fileId);
  if (record.name != null) e.name = record.name;
  // 呼び出し時点の dirtySeq を捕捉＝いま書き込むスナップショットの世代。debounce タイマーは
  // 編集のたびリセットされ発火時の record は最新編集に一致するため、seq は record の世代と一致。
  // 書き込み中に追い越し編集が来ると dirtySeq が seq を超え、resolve 時 savedSeq=seq<dirtySeq と
  // なり当該ファイルは dirty のまま残る。
  const seq = e.dirtySeq;
  _pending++;
  recompute();

  // _pending は resolve / reject / タイムアウトのうち最初の1回だけ減算する。watchdog は
  // 「保存中」固着を防ぐ暫定エラー表示にとどめ、後から本 dbPut が resolve/reject したら
  // 結果を反映して回復させる（遅延成功で偽の「保存失敗」が恒久残留しないように）。
  let pendingCounted = true;
  const releasePending = () => {
    if (!pendingCounted) return;
    pendingCounted = false;
    _pending = Math.max(0, _pending - 1);
  };
  const watchdog = setTimeout(() => {
    releasePending();
    // この世代以降の保存が既に成功していれば（savedSeq>=seq）このタイムアウトは陳腐化。
    if (seq > e.savedSeq) {
      e.error = e.error || new Error('save timed out');
      uiActions.addToast('保存に時間がかかっています。変更は未保存の可能性があります', 5000);
    }
    recompute();
  }, SAVE_TIMEOUT_MS);

  return dbPut('files', record).then(
    () => {
      clearTimeout(watchdog);
      releasePending();
      // 同一ファイルで新旧2本が in-flight のとき、古い成功が新しい結果を巻き戻さないよう
      // 世代ガード（seq<savedSeq＝より新しい保存が反映済みなら陳腐化した成功として無視）。
      if (seq >= e.savedSeq) {
        e.savedSeq = seq;
        e.error = null;
        _lastSavedAt = Date.now();
        // oversize は最新編集が立てるフラグ。この保存より後に oversize 編集が来ている
        // （dirtySeq>seq）場合、古い（上限内）保存の成功で oversize を誤解除しない。
        // in-flight な保存が oversize 転換後に resolve するケースを塞ぐ。
        if (seq === e.dirtySeq) e.oversize = false;
      }
      recompute();
    },
    (err) => {
      clearTimeout(watchdog);
      releasePending();
      // この世代以降の保存が既に成功していれば（savedSeq>=seq）、陳腐化した失敗として無視する
      // （最新内容は永続化済みなのに偽の「保存失敗」を復活させない）。
      if (seq > e.savedSeq) {
        // savedSeq は前進させない → 当該ファイルは dirty のまま（次の編集/flush で再試行）。
        e.error = err || new Error('save failed');
        // QuotaExceededError のみ容量不足案内。AbortError は unload 時の接続クローズ等でも
        // 発生し容量とは無関係のため、削除を促す誤案内を避け汎用メッセージにする。
        const quota = err?.name === 'QuotaExceededError';
        uiActions.addToast(
          quota
            ? '保存領域が不足しています。不要なファイルを削除してください'
            : '保存に失敗しました。変更は未保存のままです',
          5000,
        );
      }
      recompute();
    },
  );
}

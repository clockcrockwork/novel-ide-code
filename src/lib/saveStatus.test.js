import { describe, it, expect, vi, beforeEach } from 'vitest';

// db と uiStore をモックする。saveStatus はモジュールレベル状態（_files Map / _pending /
// _lastSavedAt）を持つため、テストごとに vi.resetModules() で新鮮なモジュールを取り込む。
vi.mock('./db', () => ({ dbPut: vi.fn() }));
vi.mock('../stores/uiStore', () => ({ uiActions: { addToast: vi.fn() } }));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let saveStatus, db, uiStore;

beforeEach(async () => {
  vi.resetModules();
  db = await import('./db');
  uiStore = await import('../stores/uiStore');
  // モック済み ./db・uiStore は vitest がキャッシュするため（resetModules でも同一 fn）、
  // 呼び出し履歴と実装を明示的にリセットしてからデフォルトを張り直す。
  db.dbPut.mockReset();
  uiStore.uiActions.addToast.mockReset();
  db.dbPut.mockResolvedValue(undefined);
  saveStatus = await import('./saveStatus');
});

describe('saveStatus — 状態機械', () => {
  it('初期状態は idle、編集で dirty になる', () => {
    expect(saveStatus.getSaveStatus().state).toBe('idle');
    saveStatus.noteDirty('a', 'a.md');
    expect(saveStatus.getSaveStatus().state).toBe('dirty');
  });

  it('dirty → saving → saved（lastSavedAt がセットされる）', async () => {
    const d = deferred();
    db.dbPut.mockReturnValueOnce(d.promise);
    saveStatus.noteDirty('a', 'a.md');
    const p = saveStatus.saveFileRecord({ id: 'a', name: 'a.md', content: 'x' });
    expect(saveStatus.getSaveStatus().state).toBe('saving');
    d.resolve();
    await p;
    const s = saveStatus.getSaveStatus();
    expect(s.state).toBe('saved');
    expect(typeof s.lastSavedAt).toBe('number');
  });

  it('遅延クロスファイル解決: A の保存完了中に B が dirty なら グローバルは saved にならない', async () => {
    saveStatus.noteDirty('a', 'a.md');
    const pa = saveStatus.saveFileRecord({ id: 'a', name: 'a.md' });
    saveStatus.noteDirty('b', 'b.md'); // B は未保存のまま
    await pa;
    // A は clean だが B が dirty → 派生グローバルは dirty（saved の嘘をつかない）
    expect(saveStatus.getSaveStatus().state).toBe('dirty');
  });

  it('世代: 書き込み中に追い越し編集が来たら resolve 後も dirty のまま', async () => {
    const d = deferred();
    db.dbPut.mockReturnValueOnce(d.promise);
    saveStatus.noteDirty('a', 'a.md'); // dirtySeq 1
    const p = saveStatus.saveFileRecord({ id: 'a', name: 'a.md' }); // seq=1 を捕捉
    saveStatus.noteDirty('a', 'a.md'); // dirtySeq 2（追い越し編集）
    d.resolve();
    await p;
    // savedSeq=1 < dirtySeq=2 → 古い本文の永続化で新編集を消さない
    expect(saveStatus.getSaveStatus().state).toBe('dirty');
  });

  it('保存失敗: error になり savedSeq を前進させず、トーストを出す', async () => {
    db.dbPut.mockRejectedValueOnce(new Error('boom'));
    saveStatus.noteDirty('a', 'a.md');
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' });
    expect(saveStatus.getSaveStatus().state).toBe('error');
    expect(uiStore.uiActions.addToast).toHaveBeenCalled();
  });

  it('QuotaExceededError は容量不足の専用トーストを出す', async () => {
    const err = new Error('quota');
    err.name = 'QuotaExceededError';
    db.dbPut.mockRejectedValueOnce(err);
    saveStatus.noteDirty('a', 'a.md');
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' });
    expect(uiStore.uiActions.addToast).toHaveBeenCalledWith(
      expect.stringContaining('保存領域'),
      expect.anything(),
    );
  });

  it('AbortError は容量案内ではなく汎用の失敗トーストを出す（削除を促す誤案内を避ける）', async () => {
    const err = new Error('abort');
    err.name = 'AbortError';
    db.dbPut.mockRejectedValueOnce(err);
    saveStatus.noteDirty('a', 'a.md');
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' });
    expect(saveStatus.getSaveStatus().state).toBe('error');
    const msg = uiStore.uiActions.addToast.mock.calls.at(-1)[0];
    expect(msg).not.toContain('保存領域');
    expect(msg).toContain('失敗');
  });

  it('保存失敗は同時のサイズ超過より優先表示される（error > oversize）', async () => {
    db.dbPut.mockRejectedValueOnce(new Error('boom'));
    saveStatus.noteDirty('a', 'a.md');
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' }); // a = error
    saveStatus.noteOversize('b', 'b.md'); // b = oversize
    expect(saveStatus.getSaveStatus().state).toBe('error');
  });

  it('決着しない保存は watchdog で error になり「保存中」が固着しない（F4）', async () => {
    vi.useFakeTimers();
    db.dbPut.mockReturnValueOnce(new Promise(() => {})); // 永遠に決着しない
    saveStatus.noteDirty('a', 'a.md');
    saveStatus.saveFileRecord({ id: 'a', name: 'a.md' });
    expect(saveStatus.getSaveStatus().state).toBe('saving');
    await vi.advanceTimersByTimeAsync(15000);
    expect(saveStatus.getSaveStatus().state).toBe('error');
    vi.useRealTimers();
  });

  it('watchdog 発火後に dbPut が遅れて成功したら saved に回復する（偽エラー残留なし）', async () => {
    vi.useFakeTimers();
    const d = deferred();
    db.dbPut.mockReturnValueOnce(d.promise);
    saveStatus.noteDirty('a', 'a.md');
    const p = saveStatus.saveFileRecord({ id: 'a', name: 'a.md' });
    await vi.advanceTimersByTimeAsync(15000);
    expect(saveStatus.getSaveStatus().state).toBe('error');
    d.resolve();
    await p;
    expect(saveStatus.getSaveStatus().state).toBe('saved');
    vi.useRealTimers();
  });

  it('同一ファイルの新旧2本 in-flight で、古い保存の遅延失敗は新しい成功を巻き戻さない', async () => {
    const dA = deferred();
    const dB = deferred();
    db.dbPut.mockReturnValueOnce(dA.promise); // seqA
    db.dbPut.mockReturnValueOnce(dB.promise); // seqB
    saveStatus.noteDirty('a', 'a.md'); // dirtySeq 1
    const pA = saveStatus.saveFileRecord({ id: 'a', name: 'a.md' }); // seq=1
    saveStatus.noteDirty('a', 'a.md'); // dirtySeq 2
    const pB = saveStatus.saveFileRecord({ id: 'a', name: 'a.md' }); // seq=2
    dB.resolve(); // 新しい方が先に成功（seqA はまだ in-flight なので _pending>0 → saving）
    await pB;
    expect(saveStatus.getSaveStatus().state).toBe('saving');
    dA.reject(new Error('stale fail')); // 古い方が遅れて失敗
    await pA;
    expect(saveStatus.getSaveStatus().state).toBe('saved'); // 偽の保存失敗を復活させない
  });

  it('in-flight 保存が oversize 転換後に resolve しても oversize を誤解除しない', async () => {
    const d = deferred();
    db.dbPut.mockReturnValueOnce(d.promise);
    saveStatus.noteDirty('a', 'a.md'); // dirtySeq 1
    const p = saveStatus.saveFileRecord({ id: 'a', name: 'a.md' }); // seq=1 in-flight
    saveStatus.noteOversize('a', 'a.md'); // dirtySeq 2, oversize=true（後続の巨大編集）
    d.resolve(); // 古い（上限内）保存が resolve
    await p;
    // 古い保存の成功で oversize を消して「保存済み」に戻さない（巨大編集は未永続）
    expect(saveStatus.getSaveStatus().state).toBe('oversize');
  });

  it('保存済み後に noteDirty 無しの reject は stale 扱い、noteDirty 先行なら error（flush 契約）', async () => {
    saveStatus.noteDirty('a', 'a.md'); // dirtySeq 1
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' }); // savedSeq 1 → saved
    expect(saveStatus.getSaveStatus().state).toBe('saved');
    // noteDirty を経ずに直接 saveFileRecord（seq===savedSeq）が失敗 → 陳腐化として無視される。
    // ＝ flushFileContentNow が保存前に noteDirty を呼ぶ必要があることの契約（Codex P2）。
    db.dbPut.mockRejectedValueOnce(new Error('boom'));
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' });
    expect(saveStatus.getSaveStatus().state).toBe('saved');
    // noteDirty で世代を進めれば、同じ失敗が error として可視化される。
    saveStatus.noteDirty('a', 'a.md'); // dirtySeq 2
    db.dbPut.mockRejectedValueOnce(new Error('boom2'));
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' });
    expect(saveStatus.getSaveStatus().state).toBe('error');
  });

  it('noteReset は content 置換時に既存エントリ（oversize/error）を掃除して idle へ戻す', async () => {
    saveStatus.noteOversize('a', 'a.md');
    expect(saveStatus.getSaveStatus().state).toBe('oversize');
    saveStatus.noteReset('a'); // pull 採用/競合解決/ブランチ切替で content 置換
    expect(saveStatus.getSaveStatus().state).toBe('idle');
    // error エントリも掃除する
    db.dbPut.mockRejectedValueOnce(new Error('boom'));
    saveStatus.noteDirty('b', 'b.md');
    await saveStatus.saveFileRecord({ id: 'b', name: 'b.md' });
    expect(saveStatus.getSaveStatus().state).toBe('error');
    saveStatus.noteReset('b');
    expect(saveStatus.getSaveStatus().state).toBe('idle');
    // 未登録 id は no-op
    saveStatus.noteReset('zzz');
    expect(saveStatus.getSaveStatus().state).toBe('idle');
  });

  it('deferReset は捕捉後に新編集が無ければ掃除する', () => {
    saveStatus.noteOversize('a', 'a.md');
    const commit = saveStatus.deferReset('a');
    commit();
    expect(saveStatus.getSaveStatus().state).toBe('idle');
  });

  it('deferReset は永続待ちの窓に入った新編集(oversize)を掃除しない', () => {
    saveStatus.noteOversize('a', 'a.md'); // 採用前の stale oversize（dirtySeq 1）
    const commit = saveStatus.deferReset('a'); // seq=1 捕捉
    saveStatus.noteOversize('a', 'a.md'); // 永続待ちの窓で新たな巨大編集（dirtySeq 2）
    commit(); // dbPut 成功後の掃除
    expect(saveStatus.getSaveStatus().state).toBe('oversize'); // 新編集を残す
  });

  it('deferReset は捕捉時エントリ無し→窓で新編集ありなら掃除しない', () => {
    const commit = saveStatus.deferReset('a'); // エントリ無し（seq=-1）
    saveStatus.noteDirty('a', 'a.md'); // 窓で新編集
    commit();
    expect(saveStatus.getSaveStatus().state).toBe('dirty'); // 残す
  });

  it('deferReset は窓内でエントリがドロップ→再生成されたら（ABA）掃除しない', () => {
    saveStatus.noteDirty('a', 'a.md'); // entry #1（dirtySeq 1）
    const commit = saveStatus.deferReset('a'); // entry #1 を identity 捕捉
    saveStatus.noteReset('a'); // 別経路でドロップ
    saveStatus.noteDirty('a', 'a.md'); // 新編集 → entry #2（dirtySeq 1・同値だが別オブジェクト）
    commit();
    expect(saveStatus.getSaveStatus().state).toBe('dirty'); // ABA で新 entry を誤ドロップしない
  });

  it('noteRenamed は既存エントリの detail 名のみ更新し、無い場合は作らない', async () => {
    db.dbPut.mockRejectedValueOnce(new Error('boom'));
    saveStatus.noteDirty('a', 'draft.md');
    await saveStatus.saveFileRecord({ id: 'a', name: 'draft.md' });
    expect(saveStatus.getSaveStatus().detail).toBe('draft.md');
    saveStatus.noteRenamed('a', 'chapter1.md');
    expect(saveStatus.getSaveStatus().detail).toBe('chapter1.md');
    // 未登録 id は no-op（エントリを作らない）
    saveStatus.noteRenamed('zzz', 'x.md');
    expect(saveStatus.getSaveStatus().detail).toBe('chapter1.md');
  });

  it('サイズ超過は saved より優先され、トーストを出す', async () => {
    saveStatus.noteDirty('a', 'a.md');
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' }); // a は保存済み
    saveStatus.noteOversize('b', 'b.md'); // b はサイズ超過
    expect(saveStatus.getSaveStatus().state).toBe('oversize');
    expect(uiStore.uiActions.addToast).toHaveBeenCalled();
  });

  it('サイズ超過は上限内へ戻すと解除され、保存成功で saved へ復帰する', async () => {
    saveStatus.noteOversize('a', 'a.md');
    expect(saveStatus.getSaveStatus().state).toBe('oversize');
    saveStatus.noteDirty('a', 'a.md'); // 上限内に戻す編集 → oversize 解除
    expect(saveStatus.getSaveStatus().state).toBe('dirty');
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' });
    expect(saveStatus.getSaveStatus().state).toBe('saved');
  });

  it('error は同ファイルの後続保存成功で解消する', async () => {
    db.dbPut.mockRejectedValueOnce(new Error('boom'));
    saveStatus.noteDirty('a', 'a.md');
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' });
    expect(saveStatus.getSaveStatus().state).toBe('error');
    saveStatus.noteDirty('a', 'a.md');
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' }); // 成功
    expect(saveStatus.getSaveStatus().state).toBe('saved');
  });

  it('onSaveStatusChange は購読時に現在値を通知し、変化を配信する', () => {
    const seen = [];
    const unsub = saveStatus.onSaveStatusChange((s) => seen.push(s.state));
    expect(seen).toEqual(['idle']);
    saveStatus.noteDirty('a', 'a.md');
    expect(seen[seen.length - 1]).toBe('dirty');
    unsub();
    saveStatus.noteDirty('b', 'b.md');
    expect(seen[seen.length - 1]).toBe('dirty'); // 解除後は配信されない
  });

  it('id なしの record は no-op（例外を投げない）', async () => {
    await expect(saveStatus.saveFileRecord({})).resolves.toBeUndefined();
    expect(db.dbPut).not.toHaveBeenCalled();
  });
});

describe('saveStatus — 削除エントリの掃除（F1/F2）', () => {
  it('未保存ファイルを削除すると dirty が解消する', () => {
    saveStatus.noteDirty('a', 'a.md');
    expect(saveStatus.getSaveStatus().state).toBe('dirty');
    saveStatus.noteRemoved('a');
    expect(saveStatus.getSaveStatus().state).toBe('idle');
  });

  it('サイズ超過ファイルを削除すると oversize が解消する', () => {
    saveStatus.noteOversize('a', 'a.md');
    expect(saveStatus.getSaveStatus().state).toBe('oversize');
    saveStatus.noteRemoved('a');
    expect(saveStatus.getSaveStatus().state).toBe('idle');
  });

  it('保存失敗ファイルを削除すると error が解消する', async () => {
    db.dbPut.mockRejectedValueOnce(new Error('boom'));
    saveStatus.noteDirty('a', 'a.md');
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' });
    expect(saveStatus.getSaveStatus().state).toBe('error');
    saveStatus.noteRemoved('a');
    expect(saveStatus.getSaveStatus().state).toBe('idle');
  });

  it('別ファイルが健全なら、片方の未保存ファイル削除後は saved に戻る', async () => {
    saveStatus.noteDirty('a', 'a.md');
    await saveStatus.saveFileRecord({ id: 'a', name: 'a.md' }); // a 保存済み → lastSavedAt
    saveStatus.noteDirty('b', 'b.md'); // b 未保存 → global dirty
    expect(saveStatus.getSaveStatus().state).toBe('dirty');
    saveStatus.noteRemoved('b');
    expect(saveStatus.getSaveStatus().state).toBe('saved');
  });
});

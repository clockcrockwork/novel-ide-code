// Blob を生成しダウンロードを開始する共通ヘルパー。
// アンカーは document に append してから click し、click 後に取り除く。append せずに
// click する形は一部ブラウザで無視されることがあるため（歴史的な既知動作）。
// setTimeout(..., 100) は click() 後に revoke すると一部ブラウザでダウンロードが
// 開始前にキャンセルされることがあるための猶予（ExportModal.jsx / MultiReplaceMod.jsx の
// 重複実装から移設。挙動は変更しない）。
export function downloadFile(content, name, mime = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 100);
}

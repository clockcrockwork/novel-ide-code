import kill from 'kill-port';

// vite preview が複数ポートに残留している場合に一括終了する
// ポートにプロセスがない場合は無視
const PORTS = [5173, 5174, 5175, 5176];
for (const port of PORTS) {
  try {
    await kill(port, 'tcp');
  } catch {
    // ポートが使用されていない場合は正常終了
  }
}

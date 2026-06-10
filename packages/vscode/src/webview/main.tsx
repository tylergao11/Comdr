import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const rootEl = document.getElementById('root');

if (!rootEl) {
  // ★ 诊断：如果 #root 不存在，直接在 body 上渲染错误
  document.body.innerHTML = '<div style="color:red;padding:20px;font-family:monospace;">[Comdr] Fatal: #root element not found. Webview HTML may be broken.</div>';
} else {
  try {
    const root = createRoot(rootEl);
    root.render(<App />);
  } catch (err) {
    // ★ 诊断：React 渲染失败时显示错误
    rootEl.innerHTML = `<div style="color:#f14c4c;padding:20px;font-family:monospace;background:#1e1e1e;height:100vh;">
      <h2>Comdr — Render Error</h2>
      <pre style="white-space:pre-wrap;word-break:break-all;">${String(err)}</pre>
    </div>`;
    console.error('[Comdr] Render failed:', err);
  }
}

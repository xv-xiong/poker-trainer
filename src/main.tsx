import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import './ui/styles/app.css';

const el = document.getElementById('root');
if (!el) throw new Error('找不到 #root 挂载点');

// ErrorBoundary 必须包在 App 外层：任何未捕获的渲染 / effect 异常都在这里兜底，
// 避免整棵 React 树被卸载后留下空白页（dev 模式的「下一手白屏」就是这种形态）。
createRoot(el).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

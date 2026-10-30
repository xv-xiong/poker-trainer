import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
// 样式按层叠顺序引入：后加载的覆盖先加载的，顺序不能调换。
// 阶段四把原来的 app.css（1784 行）按这个顺序拆成 6 个文件，内容零改动。
import './ui/styles/base.css';
import './ui/styles/lobby.css';
import './ui/styles/table.css';
import './ui/styles/actions.css';
import './ui/styles/panels.css';
import './ui/styles/responsive.css';

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

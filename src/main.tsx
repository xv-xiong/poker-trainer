import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import './ui/styles/app.css';

const el = document.getElementById('root');
if (!el) throw new Error('找不到 #root 挂载点');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

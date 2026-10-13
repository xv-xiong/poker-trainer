import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base 必须是 '/poker-trainer/'：GitHub Pages 项目站点位于子路径，
// 若用默认 '/'，线上静态资源会全部 404。
export default defineConfig({
  base: '/poker-trainer/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    reportCompressedSize: true,
  },
  worker: {
    format: 'es',
  },
});

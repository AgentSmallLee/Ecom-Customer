// monitor/vite.config.ts 构建配置
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()], // 让 Vite 能编译 .vue 单文件组件
  server: {
    port: 5175, // 独立端口，和客服前台（5173/5174）互不影响
  },
});

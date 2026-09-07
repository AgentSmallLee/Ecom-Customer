// client/vite.config.ts 构建配置
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()], // 让 Vite 能编译 .vue 单文件组件
  server: {
    port: 5173, // 开发环境端口
  },
});

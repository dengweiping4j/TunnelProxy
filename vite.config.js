import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import electron from 'vite-plugin-electron/simple'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.js',
        vite: {
          build: {
            outDir: 'dist-electron',
            // lib 模式不会把相对 require 打进 main.js，所以日志模块要单独出一个入口，
            // 保证 dist-electron/logger.js 存在（开发和打包都依赖它）
            lib: {
              entry: {
                main: 'electron/main.js',
                logger: 'electron/logger.js',
              },
            },
          },
        },
      },
      preload: {
        input: resolve('electron/preload.js'),
      },
      renderer: {},
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    open: false,
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss,
        autoprefixer,
      ],
    },
  },
  resolve: {
    extensions: ['.js', '.jsx', '.json']
  },
  esbuild: {
    loader: "jsx",
    include: /src\/.*\.jsx?$/,
    exclude: [],
  },
}) 
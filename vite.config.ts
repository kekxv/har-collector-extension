import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.json'
import { resolve } from 'path'
import { copyFileSync, statSync, readdirSync, mkdirSync, existsSync } from 'fs'

function copyLocalesPlugin() {
  return {
    name: 'copy-locales',
    closeBundle() {
      const src = resolve(__dirname, 'src/_locales')
      const dest = resolve(__dirname, 'dist/_locales')
      if (!existsSync(src)) return

      function copyDirRecursive(from: string, to: string) {
        if (!existsSync(to)) mkdirSync(to, { recursive: true })
        for (const entry of readdirSync(from)) {
          const fromPath = resolve(from, entry)
          const toPath = resolve(to, entry)
          if (statSync(fromPath).isDirectory()) {
            copyDirRecursive(fromPath, toPath)
          } else {
            copyFileSync(fromPath, toPath)
          }
        }
      }

      copyDirRecursive(src, dest)
    },
  }
}

export default defineConfig({
  plugins: [
    crx({ manifest }),
    copyLocalesPlugin(),
  ],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
        fallback: 'src/fallback/index.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  }
})

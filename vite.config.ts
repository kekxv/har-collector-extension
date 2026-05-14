import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import { resolve } from 'path'
import { copyFileSync, statSync, readdirSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import pkg from './package.json'

// Build manifest with version from package.json and resolved locale messages
function buildManifest() {
  const raw = JSON.parse(readFileSync(resolve(__dirname, 'src/manifest.json'), 'utf-8'))
  const localeEn = JSON.parse(readFileSync(resolve(__dirname, 'src/_locales/en/messages.json'), 'utf-8'))

  // Replace __MSG_key__ with actual values from default locale
  function resolveMsgs(value: string): string {
    const match = value.match(/^__MSG_(\w+)__$/)
    if (match) {
      const key = match[1]
      if (localeEn[key]) return localeEn[key].message
    }
    return value
  }

  return {
    ...raw,
    version: pkg.version,
    name: resolveMsgs(raw.name),
    description: resolveMsgs(raw.description),
    action: {
      ...raw.action,
      default_title: resolveMsgs(raw.action.default_title),
    },
  }
}

const manifest = buildManifest()

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

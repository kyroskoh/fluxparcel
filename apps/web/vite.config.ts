import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

function offlineShell(): Plugin {
  let output: string
  return {
    name: 'fluxparcel-offline-shell',
    apply: 'build',
    configResolved(config) { output = join(config.root, config.build.outDir) },
    async closeBundle() {
      const bundles = (await readdir(join(output, 'assets')))
        .filter(name => /\.(css|js)$/.test(name))
        .sort()
        .map(name => '/assets/' + name)
      const files = ['/index.html', '/manifest.webmanifest', '/logo.svg', '/icon-192.png', '/icon-512.png', ...bundles]
      const contents = await Promise.all(files.map(file => readFile(join(output, file.slice(1)))))
      const source = await readFile(new URL('./service-worker.js', import.meta.url), 'utf8')
      const version = createHash('sha256').update(source)
      contents.forEach(content => version.update(content))
      const configuration = JSON.stringify({ files, cache: 'fluxparcel-shell-' + version.digest('hex') })
      await writeFile(join(output, 'sw.js'), 'const SHELL = ' + configuration + '\n' + source)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwind(), offlineShell()],
  server: {
    host: 'localhost',
    proxy: { '/v1': process.env.FLUXPARCEL_API ?? 'http://localhost:8080' },
  },
})

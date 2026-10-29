import { defineConfig, type Connect, type Plugin } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

const runtimeCredentials = (): string | undefined => {
  const apiId = process.env.TG_ID
  const apiHash = process.env.TG_HASH
  if (typeof apiId !== 'string' || typeof apiHash !== 'string') {
    return undefined
  }
  if (!/^[1-9]\d*$/.test(apiId) || !/^[a-f\d]{32}$/i.test(apiHash)) {
    return undefined
  }
  return JSON.stringify({ apiId, apiHash })
}

const runtimeTelegramApp = (): Connect.NextHandleFunction => (request, response, next) => {
  const path = request.url?.split('?')[0]
  if (path !== '/runtime/telegram-app') {
    next()
    return
  }
  const body = runtimeCredentials()
  response.setHeader('Cache-Control', 'no-store')
  if (body === undefined) {
    response.statusCode = 404
    response.end()
    return
  }
  response.statusCode = 200
  response.setHeader('Content-Type', 'application/json')
  response.end(body)
}

const runtimeTelegramAppPlugin = (): Plugin => {
  const handler = runtimeTelegramApp()
  return {
    name: 'runtime-telegram-app',
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}

export default defineConfig({
  plugins: [
    runtimeTelegramAppPlugin(),
    nodePolyfills(),
    tailwindcss(),
    foldkit({ devToolsMcpPort: false }),
  ],
  optimizeDeps: {
    entries: ['src/entry.ts'],
  },
  build: {
    rollupOptions: {
      input: 'index.html',
    },
  },
})

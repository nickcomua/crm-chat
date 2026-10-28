import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    nodePolyfills(),
    tailwindcss(),
    foldkit({ devToolsMcpPort: false }),
  ],
  optimizeDeps: {
    entries: ['src/entry.ts'],
  },
})

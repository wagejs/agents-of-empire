import { defineConfig } from 'vite'
import { apiMiddleware } from './server/api.mjs'

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'agents-of-empire-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
  },
})

export default defineConfig({
  plugins: [api()],
  // PORT lets a second copy run alongside the first without a flag on the command line.
  server: {
    port: Number(process.env.PORT) || 5274,
    strictPort: false,
    // Vite's default CORS lets any localhost page read responses, the API's included. The page
    // is same-origin with its API, so it needs none.
    cors: false,
    // Claude Code keeps worktrees inside the repo. Another session editing one is not this page
    // changing, and reloading for it interrupts whatever you were doing here.
    watch: { ignored: ['**/.claude/worktrees/**'] },
  },
  build: { target: 'esnext' },
})

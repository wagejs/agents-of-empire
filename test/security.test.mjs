import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { withServer } from './support/with-server.mjs'

// The page can start Claude in Allow all, so whatever reaches the API is as good as a shell.
// These are the ways another page on this machine might try to get in.
test('only the page this server served may change anything', async () => {
  await withServer(async ({ call }) => {
    const port = new URL((await call('/api/state')).url).port
    // A folder that is not there: a request that gets past the gate is turned away by the handler
    // itself, before a Claude session could ever start. Pointed at a real folder, every test run
    // left a real session behind.
    const body = JSON.stringify({ folder: '/nonexistent/agents-of-empire-test', text: 'hello' })
    const post = (headers) =>
      fetch(`http://127.0.0.1:${port}/api/chat/new`, { method: 'POST', headers, body }).then((r) => r.status)

    // A dev server on another local port is another site, even though its hostname is local.
    assert.equal(await post({ Origin: 'http://127.0.0.1:3000', 'Content-Type': 'application/json' }), 403)
    assert.equal(await post({ Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }), 403)
    // A no-cors text/plain POST skips the preflight; it must not reach a handler.
    assert.equal(await post({ Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'text/plain' }), 415)
    // The browser's own word that a request is cross-site wins.
    assert.equal(await post({ Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' }), 403)
    // DNS rebinding: a foreign Host is refused before anything else.
    // (fetch drops a custom Host header, so this one goes out raw.)
    const rebound = await new Promise((resolve, reject) =>
      http.get({ host: '127.0.0.1', port, path: '/api/threads', headers: { Host: 'evil.example' } }, (r) => resolve(r.statusCode)).on('error', reject))
    assert.equal(rebound, 403)

    // The page itself still gets through: same origin, JSON. It reaches the handler, which
    // answers the missing folder with a 400 rather than the gate's 403 or 415.
    const own = await post({ Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' })
    assert.equal(own, 400)
  })
})

test('the link preview never probes this machine or the local network', async () => {
  const { isInternal } = await import('../server/link.mjs')
  for (const u of ['http://127.0.0.1:5275/x', 'http://localhost/', 'http://10.0.0.1/', 'http://192.168.1.1/admin', 'http://172.20.0.5/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[fd00::1]/', 'not a url'])
    assert.equal(await isInternal(u), true, u)
  assert.equal(await isInternal('http://93.184.216.34/'), false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { fuzzy, splitLine } from '../src/game/fuzzy.js'

test('palette: fuzzy prefers the file name and word starts', () => {
  const rank = (q, paths) => paths.map((p) => [p, fuzzy(q, p)?.score ?? -Infinity]).sort((a, b) => b[1] - a[1]).map((x) => x[0])
  assert.equal(rank('handler', ['api-server/handler/x.go', 'api-server/api/handler.go'])[0], 'api-server/api/handler.go')
  assert.equal(rank('oh', ['a/order/handler.go', 'a/zzz/oops-h.go'])[0], 'a/zzz/oops-h.go')
  assert.equal(fuzzy('xyz', 'a/b.go'), null)
  assert.deepEqual(fuzzy('ab', 'x/ab.go').at, [2, 3])
})

test('palette: a trailing :line is the line to open', () => {
  assert.deepEqual(splitLine('handler.go:120'), { query: 'handler.go', line: 120 })
  assert.deepEqual(splitLine('handler.go'), { query: 'handler.go', line: 0 })
})

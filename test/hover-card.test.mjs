import test from 'node:test'
import assert from 'node:assert/strict'
import { lastSaid, plain } from '../src/ui/hover-card.js'

test('a quiet bot previews the last thing said, as plain text', () => {
  assert.deepEqual(
    lastSaid([
      { role: 'user', text: 'fix it' },
      { role: 'assistant', text: '**Done.** See `server/api.mjs` and [the PR](https://x/1).\n\n```js\nx()\n```', tools: [] },
      { role: 'assistant', text: '', tools: [{ name: 'Bash' }] },
    ]),
    { who: 'Claude', text: 'Done. See server/api.mjs and the PR. [code]' }
  )
  assert.deepEqual(lastSaid([{ role: 'user', text: 'are you there?' }]), { who: 'You', text: 'are you there?' })
  assert.equal(lastSaid([]), null)
  assert.equal(plain('# Title\n> quoted _text_'), 'Title quoted text')
})

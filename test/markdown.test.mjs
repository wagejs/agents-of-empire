/**
 * The chat's markdown: what Claude's replies actually contain parses to the right tree, and
 * nothing in a reply can become a script or a link that runs one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown } from '../src/ui/markdown.js'

const n = (tag, children, attrs) => ({ tag, children, ...attrs })

test('a typical reply: heading, inline marks, nested list, code, table', () => {
  const src = [
    '## Plan',
    'Run **`npm test`** first, then *maybe* ~~not~~ deploy.',
    'A second line stays a line.',
    '',
    '1. one',
    '   - nested',
    '2. two',
    '',
    '```js',
    'const a = 1 // **not bold**',
    '```',
    '| file | lines |',
    '| --- | ---: |',
    '| a.js | 3 |',
  ].join('\n')

  assert.deepEqual(parseMarkdown(src), [
    n('h2', ['Plan']),
    n('p', [
      'Run ', n('strong', [n('code', ['npm test'])]), ' first, then ', n('em', ['maybe']), ' ', n('del', ['not']),
      ' deploy.\nA second line stays a line.',
    ]),
    n('ol', [n('li', [n('p', ['one']), n('ul', [n('li', ['nested'])])]), n('li', ['two'])]),
    n('pre', [n('code', ['const a = 1 // **not bold**'])]),
    n('table', [
      n('thead', [n('tr', [n('th', ['file']), n('th', ['lines'])])]),
      n('tbody', [n('tr', [n('td', ['a.js']), n('td', ['3'])])]),
    ]),
  ])
})

test('a fence still open mid-stream is code to the end, not a paragraph', () => {
  assert.deepEqual(parseMarkdown('Here:\n```\nline **one**'), [n('p', ['Here:']), n('pre', [n('code', ['line **one**'])])])
})

const textOf = (nodes) => nodes.map((x) => (typeof x === 'string' ? x : textOf(x.children))).join('')
const tagsOf = (nodes) => nodes.flatMap((x) => (typeof x === 'string' ? [] : [x.tag, ...tagsOf(x.children)]))
const hrefsOf = (nodes) => nodes.flatMap((x) => (typeof x === 'string' ? [] : [...(x.href ? [x.href] : []), ...hrefsOf(x.children)]))

test('links keep an href only when it is http(s) or mailto, and HTML stays text', () => {
  const src = '[docs](https://example.com/a) [x](javascript:alert(1)) see https://example.com/b. <img src=x onerror=alert(1)>'
  const tree = parseMarkdown(src)
  assert.deepEqual(hrefsOf(tree), ['https://example.com/a', 'https://example.com/b'])
  assert.deepEqual(tagsOf(tree), ['p', 'a', 'a'])
  assert.equal(textOf(tree), src.replace('[docs](https://example.com/a)', 'docs'))
})

test('globs, snake_case and arithmetic are not emphasis', () => {
  const [p] = parseMarkdown('use src/*.js and *.ts in my_var_name, 2*3*4')
  assert.deepEqual(p.children, ['use src/*.js and *.ts in my_var_name, 2*3*4'])
})

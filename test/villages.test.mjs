/**
 * Where each thread lands: a hex in Sprint or Side-project, or its repo's plot in Misc.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { placeThreads, hexPlotId } from '../src/game/villages.js'

const t = (id, project, extra = {}) => ({ id, project, ...extra })
const hex = (village, name, extra = {}) => ({ village, name, archived: false, createdAt: 1, ...extra })
const ids = (group) => group.threads.map((x) => x.id)

test('an unplaced thread lands on its repo plot in Misc', () => {
  const { groups } = placeThreads({ threads: [t('a', 'lapakgaming-api')] })
  const g = groups.get('lapakgaming-api')
  assert.equal(g.village, 'misc')
  assert.equal(g.name, 'lapakgaming-api')
  assert.deepEqual(ids(g), ['a'])
})

test('two threads in one repo, one placed, land in the hex and in Misc', () => {
  const { groups } = placeThreads({
    threads: [t('a', 'api'), t('b', 'api')],
    hexes: { h1: hex('sprint', 'LPG-1') },
    placements: { a: 'h1' },
  })
  assert.deepEqual(ids(groups.get(hexPlotId('h1'))), ['a'])
  assert.equal(groups.get(hexPlotId('h1')).village, 'sprint')
  assert.equal(groups.get(hexPlotId('h1')).name, 'LPG-1')
  assert.deepEqual(ids(groups.get('api')), ['b'])
})

test('a thread in an archived hex is off the map, not in Misc', () => {
  const { groups, onMap } = placeThreads({
    threads: [t('a', 'api')],
    hexes: { h1: hex('sprint', 'LPG-1', { archived: true }) },
    placements: { a: 'h1' },
  })
  assert.equal(groups.has('api'), false)
  assert.equal(groups.has(hexPlotId('h1')), false)
  assert.equal(onMap.has('a'), false)
})

test('an empty hex is still a plot', () => {
  const { groups } = placeThreads({ threads: [], hexes: { h1: hex('side', 'AoE') } })
  assert.deepEqual(ids(groups.get(hexPlotId('h1'))), [])
  assert.equal(groups.get(hexPlotId('h1')).village, 'side')
})

test('a placement to a hex that no longer exists falls back to Misc', () => {
  const { groups } = placeThreads({ threads: [t('a', 'api')], placements: { a: 'gone' } })
  assert.deepEqual(ids(groups.get('api')), ['a'])
})

test('hiding a repo hides its Misc plot, not its threads placed in hexes', () => {
  const { groups, onMap } = placeThreads({
    threads: [t('a', 'api'), t('b', 'api')],
    hexes: { h1: hex('sprint', 'LPG-1') },
    placements: { a: 'h1' },
    hiddenProjects: ['api'],
  })
  assert.equal(groups.has('api'), false)
  assert.deepEqual(ids(groups.get(hexPlotId('h1'))), ['a'])
  assert.deepEqual([...onMap], ['a'])
})

test('an archived thread is off the map even when placed', () => {
  const { groups } = placeThreads({
    threads: [t('a', 'api'), t('b', 'api', { archived: true })],
    hexes: { h1: hex('sprint', 'LPG-1') },
    placements: { a: 'h1', b: 'h1' },
    archivedIds: ['a'],
  })
  assert.deepEqual(ids(groups.get(hexPlotId('h1'))), [])
})

test('a thread with no repo goes to the unknown plot, as today', () => {
  const { groups } = placeThreads({ threads: [t('a', '')] })
  assert.deepEqual(ids(groups.get('unknown')), ['a'])
})

test('an orchestrator moved to a hex takes its repo sessions with it', () => {
  const { groups } = placeThreads({
    threads: [
      t('o', '.claude', { share: { plan: 'p1', role: 'orchestrator' } }),
      t('c1', 'api', { share: { plan: 'p1', role: 'child' } }),
      t('c2', 'web', { share: { plan: 'p1', role: 'child' } }),
      t('x', 'api', { share: { plan: 'p2', role: 'child' } }),
    ],
    hexes: { h1: hex('sprint', 'LPG-1') },
    placements: { o: 'h1' },
  })
  assert.deepEqual(ids(groups.get(hexPlotId('h1'))), ['o', 'c1', 'c2'])
  assert.deepEqual(ids(groups.get('api')), ['x'], 'another plan’s session stays put')
})

test('a subagent follows its parent into a hex', () => {
  const { groups } = placeThreads({
    threads: [t('p', 'api'), t('s', 'api', { parentId: 'p' })],
    hexes: { h1: hex('side', 'AoE') },
    placements: { p: 'h1' },
  })
  assert.deepEqual(ids(groups.get(hexPlotId('h1'))), ['p', 's'])
})

test('a session placed on its own keeps its own place', () => {
  const { groups } = placeThreads({
    threads: [t('o', '.claude', { share: { plan: 'p1', role: 'orchestrator' } }), t('c1', 'api', { share: { plan: 'p1', role: 'child' } })],
    hexes: { h1: hex('sprint', 'A'), h2: hex('side', 'B') },
    placements: { o: 'h1', c1: 'h2' },
  })
  assert.deepEqual(ids(groups.get(hexPlotId('h2'))), ['c1'])
})

test('a follower kept in Misc stays there while its orchestrator is in a hex', () => {
  const { groups } = placeThreads({
    threads: [t('o', '.claude', { share: { plan: 'p1', role: 'orchestrator' } }), t('c1', 'api', { share: { plan: 'p1', role: 'child' } })],
    hexes: { h1: hex('sprint', 'A') },
    placements: { o: 'h1', c1: 'misc' },
  })
  assert.deepEqual(ids(groups.get('api')), ['c1'])
})

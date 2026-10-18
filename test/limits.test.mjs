import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readLimits } from '../server/limits.mjs'

const tmp = async (body) => {
  const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'aoe-limits-')), 'limits.json')
  await fsp.writeFile(file, typeof body === 'string' ? body : JSON.stringify(body))
  return file
}
const now = 1_800_000_000_000

test('both windows come back in ms, as Claude Code reported them', async () => {
  const file = await tmp({ at: 1_799_999_990, five_hour: { used_percentage: 34, resets_at: 1_800_003_600 }, seven_day: { used_percentage: 61.5, resets_at: 1_800_300_000 } })
  assert.deepEqual(await readLimits(file, now), {
    at: 1_799_999_990_000,
    five_hour: { used: 34, resetsAt: 1_800_003_600_000 },
    seven_day: { used: 61.5, resetsAt: 1_800_300_000_000 },
  })
})

test('a window that has already reset is dropped, and none at all is null', async () => {
  const file = await tmp({ at: 1, five_hour: { used_percentage: 90, resets_at: 1_799_000_000 }, seven_day: { used_percentage: 10, resets_at: 1_800_300_000 } })
  const got = await readLimits(file, now)
  assert.equal(got.five_hour, undefined)
  assert.equal(got.seven_day.used, 10)
  assert.equal(await readLimits(await tmp({ at: 1 }), now), null)
})

test('no file, or a broken one, is null rather than an error', async () => {
  assert.equal(await readLimits('/nonexistent/limits.json', now), null)
  assert.equal(await readLimits(await tmp('{not json'), now), null)
})

test('a percentage out of range is clamped', async () => {
  const file = await tmp({ at: 1, five_hour: { used_percentage: 140, resets_at: 1_800_003_600 } })
  assert.equal((await readLimits(file, now)).five_hour.used, 100)
})

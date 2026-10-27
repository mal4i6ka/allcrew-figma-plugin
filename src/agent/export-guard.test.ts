import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ExportGuard,
  MAX_REPLY_RAW_BYTES,
  clampReplyBudget,
  fitScaleToPixels,
  renderPixels,
} from './export-guard.ts'

test('exactly-at-budget is accepted and the next item resumes at its own offset', async () => {
  const guard = new ExportGuard({ budgetBytes: 100 })

  assert.deepEqual(await guard.beforeRender(4), { include: true })
  assert.deepEqual(guard.admit(100, 4), { include: true })
  assert.deepEqual(await guard.beforeRender(5), {
    include: false,
    stoppedOn: 'bytes',
    nextOffset: 5,
  })
  assert.equal(guard.spent, 100)
})

test('a first item larger than the reply is reported without consuming the budget', () => {
  const guard = new ExportGuard({ budgetBytes: 100 })

  assert.deepEqual(guard.admit(101, 7), {
    include: false,
    stoppedOn: 'bytes',
    nextOffset: 7,
    firstItemTooLarge: true,
  })
  assert.equal(guard.spent, 0)
  assert.equal(guard.count, 0)
})

test('a boundary item after accepted files returns its resumable offset', () => {
  const guard = new ExportGuard({ budgetBytes: 100 })

  assert.deepEqual(guard.admit(60, 2), { include: true })
  assert.deepEqual(guard.admit(41, 3), {
    include: false,
    stoppedOn: 'bytes',
    nextOffset: 3,
  })
  assert.equal(guard.spent, 60)
})

test('raster preflight refuses only a render that could not fit even at the best compression', () => {
  const guard = new ExportGuard({ budgetBytes: 100 })
  assert.deepEqual(guard.admit(60, 2), { include: true })

  // 40 bytes left: 800 px needs at least 40 and may fit; 820 px needs at least 41 and cannot.
  assert.deepEqual(guard.preflightRaster({ width: 800, height: 1, pixels: 800, scale: 1 }, 3), { include: true })
  assert.deepEqual(
    guard.preflightRaster({ width: 820, height: 1, pixels: 820, scale: 1 }, 3),
    { include: false, stoppedOn: 'bytes', nextOffset: 3 },
  )
  assert.equal(guard.spent, 60)
})

test('a budget that never travels in a reply is not clamped to the transport cap', () => {
  assert.equal(new ExportGuard({ budgetBytes: 20_000_000, transport: false }).budgetBytes, 20_000_000)
  assert.equal(new ExportGuard({ budgetBytes: 20_000_000 }).budgetBytes, MAX_REPLY_RAW_BYTES)
})

test('reply budgets are clamped below the 3 MiB transport ceiling', () => {
  assert.equal(clampReplyBudget(99_000_000), MAX_REPLY_RAW_BYTES)
  assert.ok(Math.ceil(MAX_REPLY_RAW_BYTES / 3) * 4 + 128 * 1024 <= 3 * 1024 * 1024)
})

test('pixel math covers SCALE, WIDTH and HEIGHT constraints', () => {
  const node = { width: 400, height: 200 }

  assert.deepEqual(renderPixels(node, { type: 'SCALE', value: 2 }), {
    width: 800,
    height: 400,
    pixels: 320_000,
    scale: 2,
  })
  assert.deepEqual(renderPixels(node, { type: 'WIDTH', value: 1000 }), {
    width: 1000,
    height: 500,
    pixels: 500_000,
    scale: 2.5,
  })
  assert.deepEqual(renderPixels(node, { type: 'HEIGHT', value: 50 }), {
    width: 100,
    height: 50,
    pixels: 5_000,
    scale: 0.25,
  })
})

test('oversized screenshots are downscaled before rendering', () => {
  const fitted = fitScaleToPixels({ width: 1000, height: 1000 }, 2, 1_000_000)

  assert.equal(fitted.downscaled, true)
  assert.equal(fitted.scale, 1)
  assert.equal(fitted.render.pixels, 1_000_000)
})

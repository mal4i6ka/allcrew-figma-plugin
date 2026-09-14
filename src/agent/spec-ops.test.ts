import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureSubtree } from './spec-ops.ts'

/** A layer the way `measureSubtree` reads one — structural, so no Figma runtime is needed. */
function layer(
  id: string,
  name: string,
  box: { x: number; y: number; width: number; height: number },
  extra: Partial<{
    type: string
    children: unknown[]
    css: Record<string, string> | Error
    visible: boolean
  }> = {}
) {
  return {
    id,
    name,
    type: extra.type ?? 'FRAME',
    absoluteBoundingBox: box,
    children: (extra.children ?? []) as never,
    ...(extra.visible === undefined ? {} : { visible: extra.visible }),
    ...(extra.css === undefined
      ? {}
      : {
          getCSSAsync: async () => {
            if (extra.css instanceof Error) throw extra.css
            return extra.css as Record<string, string>
          },
        }),
  }
}

test('a section measures the same wherever it sits on the canvas', async () => {
  const card = layer('2', 'Card', { x: 1272, y: 348, width: 416, height: 240 }, { css: { padding: '20px' } })
  const section = layer('1', 'Container', { x: 1200, y: 300, width: 1296, height: 600 }, {
    children: [card],
    css: { display: 'flex', gap: '24px' },
  })

  const result = await measureSubtree(section as never, { depth: 3, limit: 100 })

  // The root sits at x 1200 on the page; a consumer comparing a block in a browser has no way
  // to know that, so every box is reported relative to the measured root.
  assert.deepEqual(result.layers[0].box, { x: 0, y: 0, width: 1296, height: 600 })
  assert.deepEqual(result.layers[1].box, { x: 72, y: 48, width: 416, height: 240 })
  assert.equal(result.layers[1].path, '0')
  assert.equal(result.layers[1].label, 'Container / Card')
  assert.deepEqual(result.layers[1].css, { padding: '20px' })
})

test('depth stops the walk, and the answer still carries the layers it did reach', async () => {
  const grandchild = layer('3', 'Label', { x: 0, y: 0, width: 40, height: 20 })
  const child = layer('2', 'Card', { x: 0, y: 0, width: 416, height: 240 }, { children: [grandchild] })
  const root = layer('1', 'Container', { x: 0, y: 0, width: 1296, height: 600 }, { children: [child] })

  const shallow = await measureSubtree(root as never, { depth: 1, limit: 100 })
  assert.deepEqual(
    shallow.layers.map((l) => l.name),
    ['Container', 'Card']
  )
  assert.equal(shallow.truncated, false)

  const deep = await measureSubtree(root as never, { depth: 2, limit: 100 })
  assert.deepEqual(
    deep.layers.map((l) => l.name),
    ['Container', 'Card', 'Label']
  )
})

test('hitting the limit is reported, not hidden', async () => {
  const children = Array.from({ length: 5 }, (_, index) =>
    layer(`c${index}`, `Card ${index}`, { x: index * 100, y: 0, width: 100, height: 100 })
  )
  const root = layer('1', 'Cards', { x: 0, y: 0, width: 500, height: 100 }, { children })

  const result = await measureSubtree(root as never, { depth: 3, limit: 3 })

  assert.equal(result.layers.length, 3)
  assert.equal(result.truncated, true)
})

test('a layer switched off in the file is not measured unless asked for', async () => {
  const hidden = layer('2', 'Old banner', { x: 0, y: 0, width: 100, height: 100 }, { visible: false })
  const root = layer('1', 'Container', { x: 0, y: 0, width: 500, height: 100 }, { children: [hidden] })

  const visible = await measureSubtree(root as never, { depth: 2, limit: 100 })
  assert.deepEqual(
    visible.layers.map((l) => l.name),
    ['Container']
  )

  const all = await measureSubtree(root as never, { depth: 2, limit: 100, includeHidden: true })
  assert.deepEqual(
    all.layers.map((l) => l.name),
    ['Container', 'Old banner']
  )
})

test('a layer Figma cannot express as CSS still reports its box', async () => {
  const mask = layer('2', 'Union', { x: 10, y: 10, width: 80, height: 80 }, {
    type: 'BOOLEAN_OPERATION',
    css: new Error('cannot produce CSS for this node'),
  })
  const root = layer('1', 'Container', { x: 0, y: 0, width: 100, height: 100 }, { children: [mask] })

  const result = await measureSubtree(root as never, { depth: 2, limit: 100 })

  const measured = result.layers[1]
  assert.equal(measured.name, 'Union')
  assert.deepEqual(measured.box, { x: 10, y: 10, width: 80, height: 80 })
  assert.equal(measured.css, undefined)
})

/**
 * Master-component Export panel settings must reach placed instances: Figma does not mirror the
 * master ROOT's export settings onto instances, so both the IR "marked graphic" rule and the
 * asset pass consult `getMainComponentAsync` for instances with no settings of their own.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveExportSettings } from '../../../utils/graphics.ts'
import { primaryDesignerAssetFilename, type DesignerExportSetting } from '../assets.ts'
import { collectExportAssets, type AssetSourceNode } from './assets.ts'
import type { IrNode } from '../ir.ts'

const SVG_SETTING: DesignerExportSetting = { format: 'SVG' }

test('resolveExportSettings: own settings win; instance falls back to the master; others do not', async () => {
  const own = { exportSettings: [SVG_SETTING], type: 'INSTANCE' }
  assert.deepEqual(await resolveExportSettings(own), [SVG_SETTING])

  const viaAsync = { type: 'INSTANCE', exportSettings: [], getMainComponentAsync: async () => ({ exportSettings: [SVG_SETTING] }) }
  assert.deepEqual(await resolveExportSettings(viaAsync), [SVG_SETTING])

  const viaSync = { type: 'INSTANCE', mainComponent: { exportSettings: [SVG_SETTING] } }
  assert.deepEqual(await resolveExportSettings(viaSync), [SVG_SETTING])

  const frame = { type: 'FRAME', exportSettings: [], mainComponent: { exportSettings: [SVG_SETTING] } }
  assert.deepEqual(await resolveExportSettings(frame), [])

  const throwing = { type: 'INSTANCE', getMainComponentAsync: async () => { throw new Error('library gone') } }
  assert.deepEqual(await resolveExportSettings(throwing), [])
})

test('asset pass exports an instance of a marked master per the MASTER settings, at the promised filename', async () => {
  // The IR leaf the serializer produces for such an instance (vector — master exports SVG).
  const leafId = 'I5:1;2:2'
  const assetSrc = `img/${primaryDesignerAssetFilename(leafId, 'Icon Star', [SVG_SETTING])}`
  const leaf: IrNode = {
    id: leafId,
    name: 'Icon Star',
    type: 'vector',
    position: { x: 0, y: 0 },
    sizing: { width: { mode: 'fixed', px: 24 }, height: { mode: 'fixed', px: 24 } },
    gridPlacement: null,
    componentPropertyReferences: {},
    warnings: [],
    assetSrc,
  } as unknown as IrNode

  const calls: unknown[] = []
  const instanceNode: AssetSourceNode = {
    id: leafId,
    name: 'Icon Star',
    type: 'INSTANCE',
    exportSettings: [],
    getMainComponentAsync: async () => ({ exportSettings: [SVG_SETTING] }),
    exportAsync: (async (settings: DesignerExportSetting) => {
      calls.push(settings)
      return '<svg>star</svg>'
    }) as AssetSourceNode['exportAsync'],
  }

  const assets = await collectExportAssets([leaf], new Map([[leafId, instanceNode]]))
  assert.equal(assets.length, 1)
  assert.equal(`img/${assets[0].filename}`, assetSrc)
  assert.equal(assets[0].content, '<svg>star</svg>')
  assert.deepEqual(calls, [SVG_SETTING])
})

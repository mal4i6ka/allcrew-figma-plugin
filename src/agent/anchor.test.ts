/**
 * Aiming a comment pin.
 *
 * The failure this prevents is a comment attached to the right layer and pointing at the wrong
 * pixel. Figma's `FrameOffset` is measured from the top-left of a FRAME, and every node id an
 * agent has out of `design.ir` is a deep layer whose own position is relative to its parent.
 * Getting the composition wrong is not a visible error — it is a pin a few hundred pixels off,
 * which reads as a designer's mistake rather than a tool's.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { anchorOf, ANCHOR_POINTS, enclosingFrame, pinFor, type AnchorSource } from './anchor.ts'
import { ANCHOR_POINT_NAMES } from '../../agent/bridge.mjs'

test('the bridge and the plugin name the same anchor points', () => {
  /* `comments.post` declares the `anchor` enum in the bridge's own manifest, because the bridge
   * owns that op — so the list exists twice and a copy nobody checks is a copy that is wrong
   * within a month. An agent handed `top-right` by the manifest must not be refused by the op. */
  assert.deepEqual([...ANCHOR_POINT_NAMES], [...ANCHOR_POINTS])
})


test('a frame INSIDE an instance is not a pin target — Figma refuses its id', () => {
  /* Measured against the live API, because nothing in the docs says it: posting with a composite
   * instance-sublayer id (`I4658:161436;823:99713`) as `node_id` answers
   * `400 "Comment couldn't be saved"` — twice in the same second, while the enclosing real frame
   * was accepted in between. So the walk has to skip past frames that live inside an instance,
   * however frame-like they are, and measure the offset from the first frame with a real id.
   *
   * This is not exotic: a `Header` instance whose main component is built out of frames puts one
   * directly above every layer in it. */
  const insideInstance = tree({
    id: 'PAGE',
    type: 'PAGE',
    child: {
      id: 'screen',
      name: 'Screen',
      type: 'FRAME',
      box: { x: 1000, y: 500, width: 1440, height: 960 },
      child: {
        id: 'header',
        name: 'Header',
        type: 'INSTANCE',
        box: { x: 1000, y: 500, width: 1440, height: 60 },
        child: {
          // Frame-typed, boxed, and unusable as a pin target because of its id alone.
          id: 'I header;823:99712',
          name: 'Main',
          type: 'FRAME',
          box: { x: 1072, y: 512, width: 1296, height: 46 },
          child: { id: 'I header;823:99713', name: 'Left', type: 'TEXT', box: { x: 1072, y: 512, width: 359, height: 46 } },
        },
      },
    },
  })
  const anchor = anchorOf(insideInstance)
  // Not `I header;823:99712`, and not the INSTANCE either — both carry ids Figma would throw away
  // or, in the instance's case, is itself a real id and therefore fine. The instance IS real:
  assert.equal(anchor.frame?.id, 'header')
  assert.ok(!anchor.frame.id.includes(';'), 'a pin target must never carry a composite id')
  // Offset measured from that frame: 1072-1000 = 72, 512-500 = 12.
  assert.deepEqual(anchor.inFrame, { x: 72, y: 12, width: 359, height: 46 })
})

test('every frame above a layer being instance-internal falls back to an absolute pin', () => {
  // Rather than emitting a pin Figma discards. An absolute point does not follow the frame, and
  // saying so is the honest answer; silently posting an unsaveable pin is not.
  const orphan = tree({
    id: 'PAGE',
    type: 'PAGE',
    child: {
      id: 'I outer;1:2',
      name: 'Inner',
      type: 'FRAME',
      box: { x: 100, y: 200, width: 50, height: 50 },
      child: { id: 'I outer;1:3', name: 'Leaf', type: 'TEXT', box: { x: 110, y: 210, width: 10, height: 10 } },
    },
  })
  assert.equal(enclosingFrame(orphan), null)
  assert.deepEqual(pinFor(anchorOf(orphan)), { x: 115, y: 215 })
})

/** Builds the chain top-down, linking each node to the one above it, and returns the DEEPEST —
 * the layer an agent would actually have an id for. Built downward on purpose: linking upward
 * from the leaf re-points the same leaf at every level and quietly flattens the tree. */
function tree(spec: {
  id: string
  name?: string
  type: string
  box?: { x: number; y: number; width: number; height: number }
  rotation?: number
  child?: Parameters<typeof tree>[0]
}): AnchorSource {
  const build = (
    at: Parameters<typeof tree>[0],
    parent: AnchorSource | null
  ): AnchorSource => {
    const node: AnchorSource = {
      id: at.id,
      name: at.name ?? at.id,
      type: at.type,
      absoluteBoundingBox: at.box ?? null,
      ...(at.rotation !== undefined ? { rotation: at.rotation } : {}),
      parent,
    }
    return at.child ? build(at.child, node) : node
  }
  return build(spec, null)
}

/* A screen at (1000, 500), a card 40 in from its left and 80 down, a label inside that. The
 * absolute numbers are deliberately not round: a frame dragged anywhere on the canvas must not
 * change the offset a pin uses. */
const LABEL = tree({
  id: 'PAGE',
  type: 'PAGE',
  child: {
    id: 'frame',
    name: 'Screen',
    type: 'FRAME',
    box: { x: 1000, y: 500, width: 375, height: 812 },
    child: {
      id: 'card',
      name: 'Card',
      type: 'GROUP',
      box: { x: 1040, y: 580, width: 295, height: 120 },
      child: {
        id: 'label',
        name: 'Label',
        type: 'TEXT',
        box: { x: 1056, y: 596, width: 100, height: 20 },
      },
    },
  },
})

/* ------------------------------------------------------------- frame walk */

test('the pin is addressed to the enclosing frame, not the immediate parent', () => {
  const found = enclosingFrame(LABEL)
  assert.equal(found?.frame.id, 'frame')
  // Two levels up: the GROUP in between is skipped on purpose — a pin on a group tracks a
  // bounding box that moves whenever any child moves.
  assert.equal(found?.depth, 2)
})

test('a frame aims at itself', () => {
  const frame = tree({ id: 'PAGE', type: 'PAGE', child: { id: 'f', type: 'FRAME', box: { x: 0, y: 0, width: 10, height: 10 } } })
  const found = enclosingFrame(frame)
  assert.equal(found?.frame.id, 'f')
  assert.equal(found?.depth, 0, 'pinning a comment to a screen means pinning it to that screen')
})

test('an instance counts as a frame, a group does not', () => {
  const inInstance = tree({
    id: 'PAGE',
    type: 'PAGE',
    child: {
      id: 'inst',
      type: 'INSTANCE',
      box: { x: 0, y: 0, width: 100, height: 100 },
      child: { id: 'leaf', type: 'VECTOR', box: { x: 10, y: 10, width: 8, height: 8 } },
    },
  })
  assert.equal(enclosingFrame(inInstance)?.frame.id, 'inst')

  const onlyGroups = tree({
    id: 'PAGE',
    type: 'PAGE',
    child: {
      id: 'g',
      type: 'GROUP',
      box: { x: 0, y: 0, width: 100, height: 100 },
      child: { id: 'leaf', type: 'VECTOR', box: { x: 10, y: 10, width: 8, height: 8 } },
    },
  })
  assert.equal(enclosingFrame(onlyGroups), null, 'no frame above it — the pin must be absolute')
})

/* ------------------------------------------------------------- the offset */

test('the offset is the node measured from the frame, whatever the canvas coordinates are', () => {
  const anchor = anchorOf(LABEL)
  assert.equal(anchor.frame?.id, 'frame')
  // 1056 - 1000 = 56, 596 - 500 = 96. Two absolute boxes subtracted; no transform composition.
  assert.deepEqual(anchor.inFrame, { x: 56, y: 96, width: 100, height: 20 })
  assert.deepEqual(anchor.absolute, { x: 1056, y: 596, width: 100, height: 20 })
})

test('moving the frame across the canvas does not change the offset', () => {
  /* This is the whole reason the pin is frame-relative: the designer drags the screen and the
   * comment stays on the label. If the offset moved with the canvas, every annotation would
   * drift the first time anyone tidied the page. */
  const moved = tree({
    id: 'PAGE',
    type: 'PAGE',
    child: {
      id: 'frame',
      type: 'FRAME',
      box: { x: -8400, y: 12.5, width: 375, height: 812 },
      child: {
        id: 'card',
        type: 'GROUP',
        box: { x: -8360, y: 92.5, width: 295, height: 120 },
        child: { id: 'label', type: 'TEXT', box: { x: -8344, y: 108.5, width: 100, height: 20 } },
      },
    },
  })
  assert.deepEqual(anchorOf(moved).inFrame, { x: 56, y: 96, width: 100, height: 20 })
  assert.deepEqual(anchorOf(moved).offsets.center, anchorOf(LABEL).offsets.center)
})

test('all nine named points are in the frame’s space and land on the box', () => {
  const o = anchorOf(LABEL).offsets
  assert.deepEqual(o['top-left'], { x: 56, y: 96 })
  assert.deepEqual(o.center, { x: 106, y: 106 })
  assert.deepEqual(o['bottom-right'], { x: 156, y: 116 })
  assert.deepEqual(o.top, { x: 106, y: 96 })
  assert.deepEqual(o.left, { x: 56, y: 106 })
  assert.deepEqual(o.right, { x: 156, y: 106 })
  assert.deepEqual(o.bottom, { x: 106, y: 116 })
  assert.deepEqual(o['top-right'], { x: 156, y: 96 })
  assert.deepEqual(o['bottom-left'], { x: 56, y: 116 })
})

test('a node with no frame above it reports absolute points instead', () => {
  const loose = tree({
    id: 'PAGE',
    type: 'PAGE',
    child: { id: 'sticky', type: 'STICKY', box: { x: 250, y: 400, width: 100, height: 100 } },
  })
  const anchor = anchorOf(loose)
  assert.equal(anchor.frame, null)
  assert.equal(anchor.inFrame, undefined, 'no frame means no frame-relative box to report')
  // The canvas coordinates, which is what a `Vector` pin takes.
  assert.deepEqual(anchor.offsets.center, { x: 300, y: 450 })
})

/* ------------------------------------------------------------------- pins */

test('the pin is the exact client_meta Figma takes', () => {
  assert.deepEqual(pinFor(anchorOf(LABEL), 'center'), {
    node_id: 'frame',
    node_offset: { x: 106, y: 106 },
  })
  assert.deepEqual(pinFor(anchorOf(LABEL), 'top-left'), {
    node_id: 'frame',
    node_offset: { x: 56, y: 96 },
  })
})

test('a frameless node pins to an absolute Vector, with no node_id at all', () => {
  const loose = tree({
    id: 'PAGE',
    type: 'PAGE',
    child: { id: 'sticky', type: 'STICKY', box: { x: 250, y: 400, width: 100, height: 100 } },
  })
  // Not `{node_id: null}`: Figma's Vector shape has no node_id field, and sending one would be
  // a different request than the one documented.
  assert.deepEqual(pinFor(anchorOf(loose)), { x: 300, y: 450 })
})

test('center is the default, because that is what an annotation wants', () => {
  assert.deepEqual(pinFor(anchorOf(LABEL)), pinFor(anchorOf(LABEL), 'center'))
})

/* ---------------------------------------------------------------- honesty */

test('a rotated layer is flagged rather than silently mis-cornered', () => {
  /* `absoluteBoundingBox` of a rotated layer is the axis-aligned box AROUND it, so its
   * `top-left` is empty space outside the visible shape. There is no honest single point for
   * "the top-left of a rotated label", so it is named instead of corrected — and `center` is
   * still exact. */
  const rotated = tree({
    id: 'PAGE',
    type: 'PAGE',
    child: {
      id: 'frame',
      type: 'FRAME',
      box: { x: 0, y: 0, width: 400, height: 400 },
      child: { id: 'badge', type: 'TEXT', box: { x: 10, y: 10, width: 60, height: 60 }, rotation: -45 },
    },
  })
  assert.equal(anchorOf(rotated).rotated, true)
  // An unrotated layer says nothing — an always-present flag is a flag nobody reads.
  assert.equal(anchorOf(LABEL).rotated, undefined)
})

test('a node Figma cannot place is refused, not pinned to the corner', () => {
  const unplaceable = tree({ id: 'PAGE', type: 'PAGE', child: { id: 'ghost', type: 'FRAME' } })
  // `{0,0}` would put the comment in the frame's corner and read as a design mistake rather
  // than a gap in the answer.
  assert.throws(() => anchorOf(unplaceable), /no absoluteBoundingBox/)
})

test('fractional geometry is rounded to two places, not carried as float noise', () => {
  const noisy = tree({
    id: 'PAGE',
    type: 'PAGE',
    child: {
      id: 'frame',
      type: 'FRAME',
      box: { x: 0, y: 0, width: 100, height: 100 },
      child: { id: 'leaf', type: 'TEXT', box: { x: 9.899999618530273, y: 0, width: 3, height: 2 } },
    },
  })
  assert.deepEqual(anchorOf(noisy).offsets['top-left'], { x: 9.9, y: 0 })
})

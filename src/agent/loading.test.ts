import test from 'node:test'
import assert from 'node:assert/strict'
import { getNodeByIdTimed, resetLoading, takeLoading, warmPages } from './loading.ts'

function setFigma(getNodeByIdAsync: (id: string) => Promise<unknown>) {
  ;(globalThis as { figma?: unknown }).figma = { getNodeByIdAsync }
}

/** A clock the test moves by hand: what this module measures is elapsed time, and a test that
 * actually slept forty seconds would be a test nobody runs. */
const realNow = Date.now
let offset = 0
function advance(ms: number) {
  offset += ms
}
Date.now = () => realNow() + offset

/** A node with a parent chain up to a page, the way a live scene node has one. */
function onPage(id: string, pageId: string, pageName: string) {
  const page = { id: pageId, name: pageName, type: 'PAGE', parent: null }
  return { id, type: 'FRAME', parent: page }
}

test('a slow first touch of a page is reported; the same page again is not', async () => {
  // Forty seconds and six milliseconds are the two real numbers from a live file — and the
  // caller has to be able to tell "cold document" from "dead channel".
  resetLoading()
  let slow = true
  setFigma(async (id) => {
    advance(slow ? 40_000 : 5)
    slow = false
    return onPage(id, '0:1', 'Components')
  })

  await getNodeByIdTimed('1:1')
  const first = takeLoading()
  assert.equal(first?.length, 1)
  assert.equal(first?.[0].page, 'Components')
  assert.ok((first?.[0].ms ?? 0) >= 40_000)

  await getNodeByIdTimed('1:2')
  assert.equal(takeLoading(), null, 'a warm page is ordinary work, not news')
})

test('a fast first touch says nothing at all', async () => {
  resetLoading()
  setFigma(async (id) => onPage(id, '0:2', 'Cover'))

  await getNodeByIdTimed('2:1')

  assert.equal(takeLoading(), null)
  assert.equal(warmPages(), 1, 'it still counts as paid for')
})

test('taking the report clears it, so the next call is not told about this one', async () => {
  resetLoading()
  setFigma(async (id) => {
    advance(3000)
    return onPage(id, '0:3', 'Guides')
  })

  await getNodeByIdTimed('3:1')
  assert.equal(takeLoading()?.length, 1)
  assert.equal(takeLoading(), null)
})

test('a node that does not resolve is not blamed on a page', async () => {
  resetLoading()
  setFigma(async () => null)

  await getNodeByIdTimed('nope')

  assert.equal(takeLoading(), null)
  assert.equal(warmPages(), 0)
})

test('a page that never finishes loading answers with a sentence, not with silence', async () => {
  // The failure this replaces: 170 seconds of nothing, then the bridge ceiling. The load keeps
  // going in Figma, so the retry the message asks for is the fast one.
  resetLoading()
  setFigma(() => new Promise(() => {}))

  await assert.rejects(
    () => getNodeByIdTimed('9:9', 20),
    /has not finished loading \(waited 0s\)[\s\S]*call again/
  )
})

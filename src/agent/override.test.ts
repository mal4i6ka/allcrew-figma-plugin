import test from 'node:test'
import assert from 'node:assert/strict'
import { WRITE_OPS, isOwnOverride, mainAliasFor, resolveMainSide } from './write-ops.ts'
import type { MainSideLookups, OverrideJob } from './write-ops.ts'

/* The whole safety of `variables.rebind overrides: true` rests on this one comparison: edit a
 * binding the instance owns, never write over one it merely inherits. Writing over an inherited
 * binding would mint an override per instance — the thing the walk avoids by skipping instance
 * children in the first place. */

test('a sublayer binding that differs from its main is the instance own override', () => {
  assert.equal(isOwnOverride('VariableID:1:2', 'VariableID:9:9'), true)
})

test('a binding equal to the main is inherited — writing there would mint an override', () => {
  assert.equal(isOwnOverride('VariableID:1:2', 'VariableID:1:2'), false)
})

test('main binds nothing while the sublayer does — still the instance own', () => {
  // Happens when someone bound a colour on the instance that the component never bound at all.
  assert.equal(isOwnOverride('VariableID:1:2', undefined), true)
})

test('an empty alias is never an override — there is nothing to repoint', () => {
  assert.equal(isOwnOverride('', undefined), false)
  assert.equal(isOwnOverride('', 'VariableID:1:2'), false)
})

/* ------------------------------------------------------------ main side */

/* A skeletal scene: enough of a node for the walk (`id`, `type`, `children`), the collector
 * (`boundVariables`, `fills`, `strokes`) and the resolver (`parent`) — nothing else. */
type Fake = Record<string, unknown> & { id: string; type: string; name: string; parent: Fake | null; children?: Fake[] }

function node(id: string, type: string, extra: Record<string, unknown> = {}, children?: Fake[]): Fake {
  const made: Fake = { id, type, name: id, parent: null, ...extra }
  if (children) {
    made.children = children
    for (const child of children) child.parent = made
  }
  return made
}

const FROM = 'VariableID:1:1'
const TO = 'VariableID:1:2'
const OTHER = 'VariableID:1:3'

const solid = (aliasId?: string) => ({
  type: 'SOLID',
  color: { r: 0, g: 0, b: 0 },
  ...(aliasId ? { boundVariables: { color: { id: aliasId } } } : {}),
})

const asScene = (fake: Fake) => fake as unknown as SceneNode

test('a sublayer of a library instance finds its mirror in the local copy of the main, by position', async () => {
  /* The real shape that broke the id lookup: `I1836:22376;4518:286745` mirrors a node whose id
   * in THIS file is 12164:75019 — 4518:286745 is the source file's id and resolves to nothing. */
  const mainChild = node('12164:75019', 'RECTANGLE', { fills: [solid(FROM)] })
  const main = node('12164:75017', 'COMPONENT', { remote: true }, [node('12164:75018', 'TEXT'), mainChild])
  const sub = node('I1836:22376;4518:286745', 'RECTANGLE', { fills: [solid(FROM)] })
  node('1836:22376', 'INSTANCE', {}, [node('I1836:22376;4518:286744', 'TEXT'), sub])

  const asked: string[] = []
  const lookups: MainSideLookups = {
    byId: async (id) => {
      asked.push(id)
      return null
    },
    mainOf: async () => main as unknown as ComponentNode,
  }
  assert.equal(await resolveMainSide(asScene(sub), lookups), mainChild)
  assert.deepEqual(asked, [], 'the source-file id was never looked up in this file')
})

test('without a reachable instance the mirrored id is looked up — the local-component path', async () => {
  const mainChild = node('4518:286745', 'RECTANGLE')
  const sub = node('I1836:22376;4518:286745', 'RECTANGLE') // no parent chain at all
  const lookups: MainSideLookups = {
    byId: async (id) => (id === '4518:286745' ? (mainChild as unknown as BaseNode) : null),
    mainOf: async () => {
      throw new Error('never reached without an instance to ask')
    },
  }
  assert.equal(await resolveMainSide(asScene(sub), lookups), mainChild)
})

test('a layer inside a nested instance is compared one level up — against what the outer main shows', async () => {
  /* A's main holds an instance of B, and A's main overrides B's rectangle. An instance of A
   * INHERITS that override; comparing against B's main instead would call it A's own. */
  const rectInAMain = node('I10:5;10:9', 'RECTANGLE', { fills: [solid(OTHER)] })
  const bInAMain = node('10:5', 'INSTANCE', {}, [rectInAMain])
  const aMain = node('10:0', 'COMPONENT', {}, [bInAMain])

  const rect = node('I10:1;10:5;10:9', 'RECTANGLE', { fills: [solid(OTHER)] })
  const bInA = node('I10:1;10:5', 'INSTANCE', {}, [rect])
  const a = node('10:1', 'INSTANCE', {}, [bInA])

  const askedFor: string[] = []
  const lookups: MainSideLookups = {
    byId: async () => null,
    mainOf: async (instance) => {
      askedFor.push(instance.id)
      return instance.id === a.id ? (aMain as unknown as ComponentNode) : null
    },
  }
  assert.equal(await resolveMainSide(asScene(rect), lookups), rectInAMain)
  assert.deepEqual(askedFor, ['10:1'], 'the OUTERMOST instance is the one whose main is read')
})

test('a swapped nested instance fails the type check and falls back to the mirrored id', async () => {
  // Position lands on something else entirely, so the answer is not trusted.
  const main = node('20:0', 'COMPONENT', {}, [node('20:1', 'TEXT')])
  const sub = node('I30:1;20:1', 'RECTANGLE')
  node('30:1', 'INSTANCE', {}, [sub])
  const byIdAnswer = node('20:1', 'RECTANGLE')
  const lookups: MainSideLookups = {
    byId: async (id) => (id === '20:1' ? (byIdAnswer as unknown as BaseNode) : null),
    mainOf: async () => main as unknown as ComponentNode,
  }
  assert.equal(await resolveMainSide(asScene(sub), lookups), byIdAnswer)
})

test('mainAliasFor reads a paint-level alias by position and a node-level one by field', () => {
  const main = { fills: [solid(FROM), solid(TO)], boundVariables: { opacity: { id: OTHER } } }
  const paintJob = (index: number): OverrideJob => ({
    node: asScene(node('x', 'RECTANGLE')),
    at: 0,
    aliasId: FROM,
    field: `fills[${index}]`,
    prop: 'fills',
    index,
  })
  assert.equal(mainAliasFor(main, paintJob(0)), FROM)
  assert.equal(mainAliasFor(main, paintJob(1)), TO)
  assert.equal(mainAliasFor(main, paintJob(2)), undefined)
  assert.equal(mainAliasFor(main, { node: asScene(node('x', 'FRAME')), at: 0, aliasId: FROM, field: 'opacity' }), OTHER)
  assert.equal(mainAliasFor(null, paintJob(0)), undefined)
})

/* ------------------------------------------------------ the op, end to end */

/* One page, two instances of a LIBRARY component whose local copy binds the old token on its
 * first child and another token on its second. Instance A carries two own overrides on the
 * second child — a fill over the main's other token, a stroke where the main has none — both
 * still on the old token. Everything else on the old token is inherited. */
function libraryScene() {
  const mainFirst = node('12164:75018', 'RECTANGLE', { fills: [solid(FROM)] })
  const mainSecond = node('12164:75019', 'RECTANGLE', { fills: [solid(OTHER)] })
  const main = node('12164:75017', 'COMPONENT', { remote: true }, [mainFirst, mainSecond])

  const aFirst = node('I1836:1;4518:1', 'RECTANGLE', { fills: [solid(FROM)] })
  const aSecond = node('I1836:1;4518:2', 'RECTANGLE', { fills: [solid(FROM)], strokes: [solid(FROM)] })
  const a = node('1836:1', 'INSTANCE', {}, [aFirst, aSecond])

  const bFirst = node('I1836:2;4518:1', 'RECTANGLE', { fills: [solid(FROM)] })
  const bSecond = node('I1836:2;4518:2', 'RECTANGLE', { fills: [solid(OTHER)] })
  const b = node('1836:2', 'INSTANCE', {}, [bFirst, bSecond])

  const page = node('0:1', 'PAGE', { loadAsync: async () => {} }, [a, b])
  for (const instance of [a, b]) {
    ;(instance as unknown as { getMainComponentAsync: () => Promise<unknown> }).getMainComponentAsync = async () => main
  }
  return { page, main, a, aFirst, aSecond, b, bFirst, bSecond }
}

function installFigma(scene: ReturnType<typeof libraryScene>) {
  const variables: Record<string, { id: string; name: string; resolvedType: string }> = {
    [FROM]: { id: FROM, name: 'old/accent', resolvedType: 'COLOR' },
    [TO]: { id: TO, name: 'new/accent', resolvedType: 'COLOR' },
    [OTHER]: { id: OTHER, name: 'other/accent', resolvedType: 'COLOR' },
  }
  const byId = new Map<string, Fake>()
  const index = (fake: Fake) => {
    byId.set(fake.id, fake)
    for (const child of fake.children ?? []) index(child)
  }
  index(scene.page)
  index(scene.main)
  const writes: string[] = []
  let undo = 0
  ;(globalThis as { figma?: unknown }).figma = {
    skipInvisibleInstanceChildren: false,
    root: { children: [scene.page] },
    currentPage: scene.page,
    commitUndo: () => {
      undo += 1
    },
    getNodeByIdAsync: async (id: string) => byId.get(id) ?? null,
    getLocalPaintStylesAsync: async () => [],
    variables: {
      getVariableByIdAsync: async (id: string) => variables[id] ?? null,
      setBoundVariableForPaint: (paint: Record<string, unknown>, field: string, variable: { id: string }) => {
        writes.push(variable.id)
        return { ...paint, boundVariables: { [field]: { id: variable.id } } }
      },
    },
  }
  return { writes, undo: () => undo }
}

const rebind = WRITE_OPS.find((op) => op.name === 'variables.rebind')!
const paintAlias = (fake: Fake, prop: 'fills' | 'strokes') =>
  ((fake[prop] as Array<{ boundVariables?: { color?: { id: string } } }>)[0].boundVariables?.color?.id ?? '')

test('a dry run with overrides reports the own/inherited split and writes nothing', async () => {
  const scene = libraryScene()
  const doc = installFigma(scene)

  const report = (await rebind.run({
    map: [{ from: FROM, to: TO }],
    pageId: scene.page.id,
    overrides: true,
    dryRun: true,
  })) as Record<string, unknown>

  assert.equal(report.dryRun, true)
  assert.deepEqual(report.pairs, [
    {
      from: 'old/accent',
      to: 'new/accent',
      type: 'COLOR',
      matched: 4, // A.first fill, A.second fill + stroke, B.first fill
      rebound: 0,
      failed: 0,
      overrides: 2, // A.second: fill over the main's other token, stroke where the main has none
      inherited: 2, // the two first children, showing exactly what the main shows
    },
  ])
  assert.equal(report.totalMatched, 4)
  assert.equal(report.totalRebound, 0)
  assert.equal(report.totalOverrides, 2)
  assert.equal(report.totalInherited, 2)

  assert.deepEqual(doc.writes, [], 'a dry run touched a paint')
  assert.equal(doc.undo(), 0, 'a dry run opened an undo step')
  assert.equal(paintAlias(scene.aSecond, 'fills'), FROM)
  assert.equal(paintAlias(scene.aSecond, 'strokes'), FROM)
})

test('the live run repoints exactly what the dry run promised, and leaves the inherited alone', async () => {
  const scene = libraryScene()
  const doc = installFigma(scene)

  const report = (await rebind.run({
    map: [{ from: FROM, to: TO }],
    pageId: scene.page.id,
    overrides: true,
  })) as Record<string, unknown>

  const [pair] = report.pairs as Array<Record<string, unknown>>
  assert.equal(pair.matched, 4)
  assert.equal(pair.overrides, 2)
  assert.equal(pair.inherited, 2)
  assert.equal(pair.rebound, 2)
  assert.equal(pair.failed, 0)
  assert.equal(report.totalRebound, 2)

  assert.deepEqual(doc.writes, [TO, TO])
  assert.equal(doc.undo(), 1)
  assert.equal(paintAlias(scene.aSecond, 'fills'), TO)
  assert.equal(paintAlias(scene.aSecond, 'strokes'), TO)
  // Inherited: still reading the old token, because the main does — writing there would mint.
  assert.equal(paintAlias(scene.aFirst, 'fills'), FROM)
  assert.equal(paintAlias(scene.bFirst, 'fills'), FROM)
})

test('without overrides the split is not reported at all, dry run or not', async () => {
  const scene = libraryScene()
  installFigma(scene)
  const report = (await rebind.run({ map: [{ from: FROM, to: TO }], pageId: scene.page.id, dryRun: true })) as Record<
    string,
    unknown
  >
  assert.equal(report.totalMatched, 0, 'the walk descended into instances without being asked')
  assert.equal('totalOverrides' in report, false)
  assert.equal('totalInherited' in report, false)
})

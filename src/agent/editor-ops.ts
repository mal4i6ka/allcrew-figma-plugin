/**
 * Agent listener — what only FigJam, Slides and Buzz have.
 *
 * Everything that is a property of a node — a sticky's words, a slide's transition, a Buzz
 * asset's format — travels through `NODE_CREATE` and `NODE_SET` like any other property. What is
 * here is the rest: the arrangement of a deck or a Buzz canvas, which is a grid of rows rather
 * than x and y; the text and media fields Buzz keeps for templated content; the board-wide things
 * of FigJam, its timer and who is looking. Each op names the editor it needs and refuses, by
 * name, anywhere else — a missing constructor is not an explanation.
 */

import { BUZZ_ASSET_TYPES, editorFeatures, editorProblem, transitionWords } from '../canvas/board.ts'
import type { OpDef } from './protocol.ts'
import { resolveSceneNode } from './subtree.ts'

function need(feature: string, what: string): void {
  const problem = editorProblem(feature, figma.editorType, what)
  if (problem) throw new Error(problem)
}

const brief = (node: BaseNode) => ({ id: node.id, name: node.name, type: node.type })

/** The names on `figma` or one of its namespaces — methods and properties, nothing read or called:
 * a getter like `currentPage` or `root` is not a question about what the build supports. */
function apiSurface(path: string): { methods: string[]; properties: string[] } {
  let at: unknown = figma
  for (const key of path.split('.').slice(1)) {
    at = at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined
    if (!at || typeof at !== 'object') throw new Error(`${path} is not an object in this Figma build`)
  }
  const methods: string[] = []
  const properties: string[] = []
  const seen = new Set<string>()
  for (let level = at as object | null; level && level !== Object.prototype; level = Object.getPrototypeOf(level)) {
    for (const key of Object.getOwnPropertyNames(level)) {
      if (seen.has(key) || key === 'constructor') continue
      seen.add(key)
      const descriptor = Object.getOwnPropertyDescriptor(level, key)
      ;(descriptor && typeof descriptor.value === 'function' ? methods : properties).push(key)
    }
  }
  return { methods: methods.sort(), properties: properties.sort() }
}

function gridOf(rows: ReadonlyArray<ReadonlyArray<SceneNode>>, buzz: boolean) {
  return rows.map((row) =>
    row.map((node) => ({
      ...brief(node),
      ...(node.type === 'SLIDE' && node.isSkippedSlide ? { skipped: true } : {}),
      ...(node.type === 'SLIDE' && transitionWords(node.getSlideTransition())
        ? { transition: transitionWords(node.getSlideTransition()) }
        : {}),
      ...(buzz && figma.buzz.getBuzzAssetTypeForNode(node) ? { assetType: figma.buzz.getBuzzAssetTypeForNode(node) } : {}),
    }))
  )
}

/** Rows of ids into rows of nodes, every id checked before anything moves. */
async function nodesGrid(raw: unknown, where: string): Promise<SceneNode[][]> {
  if (!Array.isArray(raw) || !raw.every((row) => Array.isArray(row) && row.every((id) => typeof id === 'string'))) {
    throw new Error(`${where} must be rows of node ids — [["1:2", "1:3"], ["1:4"]]`)
  }
  const grid: SceneNode[][] = []
  for (const row of raw as string[][]) grid.push(await Promise.all(row.map((id) => resolveSceneNode(id))))
  return grid
}

/**
 * The deck or canvas as rows, read off the tree — SLIDE_GRID → SLIDE_ROW → slide or asset, the
 * same shape in Slides and Buzz. The API is only the fallback, because it was measured wrong in
 * both: `getSlideGrid` answered with the grid as it stood BEFORE a slide made a moment ago, and
 * Buzz's `getCanvasGrid` kept a removed frame and then threw "does not exist" on every call.
 */
function currentGrid(): ReadonlyArray<ReadonlyArray<SceneNode>> {
  const grid = figma.currentPage.children.find((node) => node.type === 'SLIDE_GRID') as SlideGridNode | undefined
  if (grid) {
    return grid.children
      .filter((row): row is SlideRowNode => row.type === 'SLIDE_ROW')
      .map((row) => row.children.filter((node) => figma.editorType !== 'slides' || node.type === 'SLIDE'))
  }
  return figma.editorType === 'slides' ? figma.getSlideGrid() : figma.getCanvasGrid()
}

function viewport(): { view?: string; focused?: unknown } {
  const port = figma.viewport as unknown as { slidesView?: string; canvasView?: string }
  const page = figma.currentPage as unknown as { focusedNode?: SceneNode | null; focusedSlide?: SceneNode | null }
  const view = figma.editorType === 'slides' ? port.slidesView : figma.editorType === 'buzz' ? port.canvasView : undefined
  const focused = figma.editorType === 'slides' ? page.focusedSlide : page.focusedNode
  return { ...(view ? { view } : {}), ...(focused ? { focused: brief(focused) } : {}) }
}

export const EDITOR_OPS: readonly OpDef[] = [
  {
    name: 'editor.capabilities',
    summary: 'Which editor this file is open in, and what can be done here that cannot elsewhere.',
    agent:
      'One plugin runs in Figma Design, Dev Mode, FigJam, Slides and Buzz, and the Plugin API is not the same in each: ' +
      'stickies and connectors exist only on a board, slides only in a deck, components and styles are only authored ' +
      'in Design. Ask once at the start of a session; an op used in the wrong editor refuses by naming the right one.',
    mutates: false,
    params: {},
    async run() {
      return {
        editorType: figma.editorType,
        mode: figma.mode,
        features: editorFeatures(figma.editorType),
        ...viewport(),
      }
    },
  },

  {
    name: 'canvas.grid',
    summary: 'Slides or Buzz: the deck or canvas as rows of slides/assets, with what is focused and the view.',
    agent:
      'Slides and Buzz place things in a grid of rows rather than at x and y — order in a row is order in the deck. ' +
      'Each cell carries its id for node.get, plus a slide\'s transition and skip flag or a Buzz asset\'s format.',
    mutates: false,
    params: {},
    async run() {
      need('canvasGrid', 'canvas.grid')
      return { editorType: figma.editorType, rows: gridOf(currentGrid(), figma.editorType === 'buzz'), ...viewport() }
    },
  },

  {
    name: 'canvas.arrange',
    summary: 'Slides or Buzz: reorder the grid, move nodes to a row/column, add a row, focus a node, switch view.',
    agent:
      '`grid` replaces the whole arrangement with rows of ids — every slide or asset must be named once, which is how ' +
      'a deck is reordered. `move` puts the given nodes at `[row, column]`. `newRow` inserts an empty row at that ' +
      'index. `focus` opens one slide or asset; `view` switches between the grid and the single-item view.',
    mutates: true,
    params: {
      grid: { type: 'json', description: 'Rows of node ids, the whole new arrangement.' },
      move: { type: 'json', description: '{ nodes: [ids], at: [row, column] } — move these there.' },
      newRow: { type: 'number', min: 0, description: 'Insert an empty row at this index.' },
      focus: { type: 'string', description: 'Node id of the slide or asset to focus.' },
      view: { type: 'string', enum: ['grid', 'single'], description: 'The grid, or one slide/asset at a time.' },
    },
    async run(params) {
      need('canvasGrid', 'canvas.arrange')
      const slides = figma.editorType === 'slides'
      const done: string[] = []
      if (params.grid !== undefined) {
        const grid = await nodesGrid(params.grid, 'grid')
        if (slides) {
          const wrong = grid.flat().find((node) => node.type !== 'SLIDE')
          if (wrong) throw new Error(`${wrong.id} is a ${wrong.type} — a deck's grid holds slides`)
          figma.setSlideGrid(grid as SlideNode[][])
        } else figma.setCanvasGrid(grid)
        done.push('grid')
      }
      if (params.newRow !== undefined) {
        figma.createCanvasRow(params.newRow as number)
        done.push('newRow')
      }
      if (params.move !== undefined) {
        const move = params.move as { nodes?: unknown; at?: unknown }
        const at = Array.isArray(move?.at) ? (move.at as number[]) : []
        if (!Array.isArray(move?.nodes) || move.nodes.length === 0 || !at.every((n) => Number.isInteger(n) && n >= 0)) {
          throw new Error('move must be { nodes: [ids], at: [row, column] }')
        }
        const ids = move.nodes.map(String)
        for (const id of ids) await resolveSceneNode(id)
        figma.moveNodesToCoord(ids, at[0], at[1])
        done.push('move')
      }
      if (params.focus !== undefined) {
        const node = await resolveSceneNode(String(params.focus))
        const page = figma.currentPage as unknown as { focusedSlide?: SceneNode | null; focusedNode?: SceneNode | null }
        if (slides) {
          if (node.type !== 'SLIDE') throw new Error(`${node.id} is a ${node.type} — focus a slide`)
          page.focusedSlide = node
        } else page.focusedNode = node
        done.push('focus')
      }
      if (params.view !== undefined) {
        const port = figma.viewport as unknown as { slidesView: string; canvasView: string }
        if (slides) port.slidesView = params.view === 'single' ? 'single-slide' : 'grid'
        else port.canvasView = params.view === 'single' ? 'single-asset' : 'grid'
        done.push('view')
      }
      if (done.length === 0) throw new Error('send grid, move, newRow, focus or view')
      return { done, rows: gridOf(currentGrid(), !slides), ...viewport() }
    },
  },

  {
    name: 'buzz.content',
    summary: 'Buzz: the text and media fields of an asset — what a templated post lets you swap.',
    agent:
      'A Buzz asset is a template: the fields are the words and images meant to change from one post to the next. ' +
      'Read them here, then buzz.content.set by field index or by the field\'s node id.',
    mutates: false,
    params: { nodeId: { type: 'string', required: true, description: 'The asset (or any node in it).' } },
    async run(params) {
      need('buzz', 'buzz.content')
      const node = await resolveSceneNode(String(params.nodeId))
      return {
        node: brief(node),
        assetType: figma.buzz.getBuzzAssetTypeForNode(node),
        texts: figma.buzz.getTextContent(node).map((field, index) => ({
          index,
          value: field.value,
          ...(field.node ? { node: brief(field.node) } : {}),
        })),
        media: figma.buzz.getMediaContent(node).map((field, index) => ({
          index,
          type: field.type,
          hash: field.hash,
          ...(field.node ? { node: brief(field.node) } : {}),
        })),
      }
    },
  },

  {
    name: 'buzz.content.set',
    summary: 'Buzz: fill an asset\'s text and media fields — the words and images of a templated post.',
    agent:
      '`texts` maps a field (its index from buzz.content, or its node id) to the new words. `media` maps a field to ' +
      '`{ image: hash }` or `{ video: hash }` — upload with ASSET_UPLOAD first to get a hash. Fonts are loaded for you.',
    mutates: true,
    params: {
      nodeId: { type: 'string', required: true, description: 'The asset.' },
      texts: { type: 'json', description: '{ "<index or node id>": "new text" }' },
      media: { type: 'json', description: '{ "<index or node id>": { image: hash } | { video: hash } }' },
    },
    async run(params) {
      need('buzz', 'buzz.content.set')
      const node = await resolveSceneNode(String(params.nodeId))
      const pick = <T extends { node: SceneNode | null }>(fields: T[], key: string): T => {
        const byIndex = /^\d+$/.test(key) ? fields[Number(key)] : undefined
        const found = byIndex ?? fields.find((field) => field.node?.id === key)
        if (!found) throw new Error(`no field "${key}" — there are ${fields.length}; ask buzz.content for them`)
        return found
      }
      const changed: Array<Record<string, unknown>> = []
      const texts = (params.texts ?? {}) as Record<string, unknown>
      const media = (params.media ?? {}) as Record<string, unknown>
      if (Object.keys(texts).length + Object.keys(media).length === 0) throw new Error('send texts or media')
      const textFields = figma.buzz.getTextContent(node)
      for (const [key, value] of Object.entries(texts)) {
        if (typeof value !== 'string') throw new Error(`texts.${key} must be a string`)
        const field = pick(textFields, key)
        const before = field.value
        if (field.node && field.node.fontName !== figma.mixed) await figma.loadFontAsync(field.node.fontName)
        else if (field.node) await Promise.all(field.node.getRangeAllFontNames(0, field.node.characters.length).map((font) => figma.loadFontAsync(font)))
        await field.setValueAsync(value)
        changed.push({ text: key, before, after: value })
      }
      const mediaFields = figma.buzz.getMediaContent(node)
      for (const [key, value] of Object.entries(media)) {
        const one = (value ?? {}) as { image?: unknown; video?: unknown }
        const hash = typeof one.image === 'string' ? one.image : typeof one.video === 'string' ? one.video : null
        if (!hash) throw new Error(`media.${key} must be { image: hash } or { video: hash }`)
        const field = pick(mediaFields, key)
        const paint =
          typeof one.image === 'string'
            ? ({ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL' } as ImagePaint)
            : ({ type: 'VIDEO', videoHash: hash, scaleMode: 'FILL' } as VideoPaint)
        const before = field.hash
        await field.setMediaAsync(paint)
        changed.push({ media: key, before, after: hash })
      }
      return { node: brief(node), changed }
    },
  },

  {
    name: 'buzz.resize',
    summary: 'Buzz: resize an asset to a new format the way Buzz does — layout kept, images reframed.',
    agent:
      'Not a plain resize: Buzz re-lays the content for the new proportions. Give `assetType` to resize to a known ' +
      'format and record it, or `width` and `height` for a custom size.',
    mutates: true,
    params: {
      nodeId: { type: 'string', required: true, description: 'The asset.' },
      width: { type: 'number', min: 1, description: 'New width in pixels.' },
      height: { type: 'number', min: 1, description: 'New height in pixels.' },
      assetType: { type: 'string', enum: BUZZ_ASSET_TYPES, description: 'Also record the asset as this format.' },
    },
    async run(params) {
      need('buzz', 'buzz.resize')
      const node = await resolveSceneNode(String(params.nodeId))
      const before = { width: node.width, height: node.height, assetType: figma.buzz.getBuzzAssetTypeForNode(node) }
      if (typeof params.width === 'number' && typeof params.height === 'number') {
        figma.buzz.smartResize(node, params.width, params.height)
      } else if (params.width !== undefined || params.height !== undefined) {
        throw new Error('send both width and height')
      }
      if (typeof params.assetType === 'string') figma.buzz.setBuzzAssetTypeForNode(node, params.assetType as BuzzAssetType)
      if (params.width === undefined && params.assetType === undefined) throw new Error('send width and height, or assetType')
      return {
        node: brief(node),
        before,
        after: { width: node.width, height: node.height, assetType: figma.buzz.getBuzzAssetTypeForNode(node) },
      }
    },
  },

  {
    name: 'figjam.board',
    summary: 'FigJam: who is on the board, the timer, and what is stuck to a node.',
    mutates: false,
    params: { nodeId: { type: 'string', description: 'Also list what is stuck to this node.' } },
    async run(params) {
      need('stickies', 'figjam.board')
      const timer = figma.timer
      // Who is here needs the `activeusers` permission; without it the getter throws, and the
      // rest of the answer is still worth having.
      let users: unknown
      try {
        users = figma.activeUsers.map((user) => ({ id: user.id, name: user.name, color: user.color }))
      } catch (error) {
        users = { unavailable: String((error as Error)?.message || error) }
      }
      const stuck: unknown[] = []
      if (typeof params.nodeId === 'string' && params.nodeId !== '') {
        const node = await resolveSceneNode(params.nodeId)
        for (const one of (node as unknown as { stuckNodes?: SceneNode[] }).stuckNodes ?? []) stuck.push(brief(one))
      }
      return {
        activeUsers: users,
        timer: timer ? { state: timer.state, remaining: timer.remaining, total: timer.total } : null,
        ...(params.nodeId ? { stuckNodes: stuck } : {}),
      }
    },
  },

  {
    name: 'figjam.timer',
    summary: 'FigJam: start, pause, resume or stop the board timer everyone sees.',
    agent: 'The timer is shared — starting it starts it for every person on the board. `seconds` is required to start.',
    mutates: true,
    params: {
      action: { type: 'string', required: true, enum: ['start', 'pause', 'resume', 'stop'], description: 'What to do.' },
      seconds: { type: 'number', min: 1, max: 86400, description: 'How long, for start.' },
    },
    async run(params) {
      need('timer', 'figjam.timer')
      const timer = figma.timer
      if (!timer) throw new Error('the timer is not available on this board')
      const action = String(params.action)
      if (action === 'start') {
        if (typeof params.seconds !== 'number') throw new Error('start needs seconds')
        timer.start(params.seconds)
      } else if (action === 'pause') timer.pause()
      else if (action === 'resume') timer.resume()
      else timer.stop()
      return { state: timer.state, remaining: timer.remaining, total: timer.total }
    },
  },
  {
    name: 'node.probe',
    summary: 'Every property and method a node actually has, with the plain values — for node types the typings do not describe.',
    agent:
      'For a node type Figma ships before its typings do (code layers read as CODE_INSTANCE with nothing documented). ' +
      'Walks the object and its prototypes, names each method, and reads each property — a value when it is plain ' +
      'or small, its kind otherwise, the error when the getter throws. Read-only: no method is called.',
    mutates: false,
    params: {
      nodeId: {
        type: 'string',
        required: true,
        description: 'The node to look inside — or `figma` / `figma.<namespace>` for the API object itself, to see what a newer Figma build has that the typings do not.',
      },
    },
    async run(params) {
      const id = String(params.nodeId)
      if (id === 'figma' || id.startsWith('figma.')) return { api: id, ...apiSurface(id) }
      const node = await resolveSceneNode(id)
      const methods: string[] = []
      const properties: Record<string, unknown> = {}
      const seen = new Set<string>()
      for (let at: object | null = node; at && at !== Object.prototype; at = Object.getPrototypeOf(at)) {
        for (const key of Object.getOwnPropertyNames(at)) {
          if (seen.has(key) || key === 'constructor') continue
          seen.add(key)
          const descriptor = Object.getOwnPropertyDescriptor(at, key)
          if (descriptor && typeof descriptor.value === 'function') {
            methods.push(key)
            continue
          }
          try {
            const value = (node as unknown as Record<string, unknown>)[key]
            if (typeof value === 'function') methods.push(key)
            else if (value === figma.mixed) properties[key] = 'mixed'
            else if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) properties[key] = value ?? null
            else {
              const text = JSON.stringify(value)
              properties[key] = text !== undefined && text.length <= 2000 ? JSON.parse(text) : `(${Array.isArray(value) ? `array of ${(value as unknown[]).length}` : typeof value})`
            }
          } catch (error) {
            properties[key] = { threw: String((error as Error)?.message || error) }
          }
        }
      }
      return { node: brief(node), methods: methods.sort(), properties }
    },
  },
]

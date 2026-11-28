/**
 * Agent listener — the rest of the Plugin API: nodes from a JSX tree, the widgets on a page, and
 * the plugin's own reach beyond the document — a toast for the designer, a link opened in their
 * browser, the plugin closing itself.
 */

import { recordEvent } from './events.ts'
import type { OpDef } from './protocol.ts'

/** The elements Figma's JSX runtime builds — the same ones a widget renders. */
export const JSX_ELEMENTS = ['AutoLayout', 'Frame', 'Text', 'Rectangle', 'Ellipse', 'Image', 'SVG', 'Line', 'Span', 'Fragment'] as const

type JsxRuntime = { h: (...args: unknown[]) => unknown } & Record<string, unknown>

/**
 * A widget-style JSX tree from plain JSON, built with the runtime's own `h` — a plugin has no
 * compiler here, and an agent has no JSX, so the elements are named instead of written. Every
 * problem names where in the tree it is.
 */
export function jsxFromJson(raw: unknown, widget: JsxRuntime, where = 'tree'): unknown {
  if (typeof raw === 'string') return raw
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${where} must be { type, props?, children? } or text`)
  const element = raw as { type?: unknown; props?: unknown; children?: unknown }
  if (typeof element.type !== 'string' || !(JSX_ELEMENTS as readonly string[]).includes(element.type)) {
    throw new Error(`${where}.type must be one of: ${JSX_ELEMENTS.join(', ')}`)
  }
  const component = widget[element.type]
  if (!component) throw new Error(`${where}: this Figma's JSX runtime has no ${element.type}`)
  if (element.props !== undefined && (typeof element.props !== 'object' || element.props === null || Array.isArray(element.props))) {
    throw new Error(`${where}.props must be an object`)
  }
  const children = element.children === undefined ? [] : Array.isArray(element.children) ? element.children : [element.children]
  return widget.h(component, element.props ?? null, ...children.map((child, index) => jsxFromJson(child, widget, `${where}.children[${index}]`)))
}

const brief = (node: BaseNode) => ({ id: node.id, name: node.name, type: node.type })

export const REACH_OPS: readonly OpDef[] = [
  {
    name: 'node.fromJsx',
    summary: 'Build nodes from a widget-style JSX tree given as JSON — Figma\'s createNodeFromJSXAsync.',
    agent:
      'An alternative to node.create when the shape is easiest said as nested auto-layout: ' +
      '{ type: "AutoLayout", props: { direction: "vertical", padding: 16, fill: "#FFF" }, children: [{ type: "Text", ' +
      'children: ["Hi"] }] }. Props are the widget API\'s, not the node vocabulary. Read the result back with node.get.',
    mutates: true,
    params: {
      tree: { type: 'json', required: true, description: `{ type, props?, children? } — type one of ${JSX_ELEMENTS.join(', ')}; a child may be plain text inside Text.` },
      parentId: { type: 'string', description: 'Where the result goes; omitted, the current page.' },
    },
    async run(params) {
      const widget = (figma as unknown as { widget?: JsxRuntime }).widget
      if (!widget?.h) throw new Error('this Figma offers no JSX runtime to plugins')
      const element = jsxFromJson(params.tree, widget)
      let parent: (BaseNode & ChildrenMixin) | null = null
      if (typeof params.parentId === 'string' && params.parentId !== '') {
        const found = await figma.getNodeByIdAsync(params.parentId)
        if (!found || !('appendChild' in found)) throw new Error(`${params.parentId} cannot hold children`)
        parent = found as BaseNode & ChildrenMixin
      }
      const node = await figma.createNodeFromJSXAsync(element)
      if (parent) parent.appendChild(node)
      figma.commitUndo()
      return { created: brief(node), parent: node.parent ? brief(node.parent) : null }
    },
  },

  {
    name: 'widgets.find',
    summary: 'The widgets on a page — every one, or the instances of one widget by its id.',
    agent:
      'Which widget a node is, and where — not what it holds: a widget\'s synced state belongs to its own code, and ' +
      'Figma lets nothing else write it. node.get on a widget reads its state.',
    mutates: false,
    params: {
      widgetId: { type: 'string', description: 'Keep only instances of this widget (findWidgetNodesByWidgetId).' },
      pageId: { type: 'string', description: 'Search this page instead of the open one.' },
    },
    async run(params) {
      const page = typeof params.pageId === 'string' && params.pageId !== '' ? await figma.getNodeByIdAsync(params.pageId) : figma.currentPage
      if (!page || page.type !== 'PAGE') throw new Error(`no page with id ${String(params.pageId)}`)
      await page.loadAsync()
      const found =
        typeof params.widgetId === 'string' && params.widgetId !== ''
          ? page.findWidgetNodesByWidgetId(params.widgetId)
          : (page.findAllWithCriteria({ types: ['WIDGET'] }) as WidgetNode[])
      return { page: { id: page.id, name: page.name }, widgets: found.map((one) => ({ id: one.id, name: one.name, widgetId: one.widgetId })) }
    },
  },

  {
    name: 'plugin.notify',
    summary: 'Show the designer a toast — a message, optionally an error, with one button.',
    agent:
      'For telling the person at the screen something now. When the toast goes away (and why) or its button is ' +
      'pressed, events.read reports NOTIFY_DEQUEUE / NOTIFY_ACTION with the id this answers — how an agent asks ' +
      '"ready?" and waits for a click.',
    mutates: true,
    params: {
      message: { type: 'string', required: true, description: 'What to say.' },
      error: { type: 'boolean', description: 'Show it as an error.' },
      timeout: { type: 'number', min: 0, description: 'Seconds on screen; omitted, Figma\'s own default.' },
      button: { type: 'string', description: 'The label of one button the designer can press.' },
    },
    async run(params) {
      const message = String(params.message ?? '')
      if (message.trim() === '') throw new Error('message must be text')
      const id = `notify-${Date.now().toString(36)}`
      const button = typeof params.button === 'string' && params.button !== '' ? params.button : null
      figma.notify(message, {
        ...(params.error === true ? { error: true } : {}),
        ...(typeof params.timeout === 'number' ? { timeout: params.timeout * 1000 } : {}),
        ...(button ? { button: { text: button, action: () => recordEvent({ kind: 'NOTIFY_ACTION', id, data: { button } }) } } : {}),
        onDequeue: (reason) => recordEvent({ kind: 'NOTIFY_DEQUEUE', id, data: { reason } }),
      })
      return { id }
    },
  },

  {
    name: 'plugin.openUrl',
    summary: 'Open a link in the designer\'s browser — Figma\'s openExternal.',
    agent: 'The designer sees a browser tab appear; use it for something they asked to see, not to navigate on their behalf.',
    mutates: true,
    params: { url: { type: 'string', required: true, description: 'An http(s) address.' } },
    async run(params) {
      const url = String(params.url ?? '')
      if (!/^https?:\/\//i.test(url)) throw new Error('url must be an http(s) address')
      figma.openExternal(url)
      return { opened: url }
    },
  },

  {
    name: 'plugin.close',
    summary: 'Close this plugin — the panel goes, and with it this channel.',
    agent:
      'Nothing answers after this until the designer runs the plugin again, so it is the last call of a session. ' +
      '`message` leaves a last toast.',
    mutates: true,
    params: { message: { type: 'string', description: 'A last toast for the designer.' } },
    async run(params) {
      const message = typeof params.message === 'string' && params.message !== '' ? params.message : undefined
      // A moment's grace, so this answer reaches the channel before the sandbox is gone.
      setTimeout(() => figma.closePlugin(message), 300)
      return { closing: true }
    },
  },
]

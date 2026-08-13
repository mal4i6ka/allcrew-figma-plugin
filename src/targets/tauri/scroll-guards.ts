/**
 * Squeeze scroll-guards for the Tauri target. A desktop window is freely resizable below the
 * design's frame size; when that happens, Figma FILL regions (`flex: 1 0 0`) shrink but their
 * hug-sized content does not — without a guard the content paints straight over the siblings
 * below/beside it (the "sidebar list over the footer" artifact). At design size a guard is
 * invisible (`auto` shows no scrollbar without overflow); on squeeze the region scrolls like
 * any native app pane.
 *
 * Only emitted for the Tauri build — the web/django export keeps the emitter's pure Figma
 * semantics (a designer previews that in a browser at design width).
 *
 * A guarded node must be a container-like node with children, sized FILL along its flex
 * parent's main axis, and not already clipping (clip → the css-emitter owns its overflow;
 * measured/explicit scroll flags land there).
 */

import type { IrContainerNode, IrNode } from '../django/ir.ts'
import { toClassName } from '../django/css-emitter.ts'

function isGuardCandidate(child: IrNode, mainAxis: 'width' | 'height'): boolean {
  if (child.type !== 'container' && child.type !== 'instance-ref') return false
  if (!('children' in child) || child.children.length === 0) return false
  const layout = 'layout' in child ? child.layout : undefined
  if (layout && 'clip' in layout && layout.clip) return false
  return child.sizing[mainAxis].mode === 'fill'
}

/** Walks the page trees and returns the `overflow` guard rules, or '' when nothing qualifies. */
export function emitScrollGuardsCss(pageRoots: readonly IrContainerNode[]): string {
  const guards = new Map<string, 'x' | 'y'>()

  const visit = (node: IrNode): void => {
    if (!('children' in node)) return
    const layout = 'layout' in node ? node.layout : undefined
    if (layout && layout.kind === 'flex') {
      const mainAxis = layout.direction === 'row' ? 'width' : 'height'
      for (const child of node.children) {
        if (isGuardCandidate(child, mainAxis)) {
          guards.set(toClassName(child.id), layout.direction === 'row' ? 'x' : 'y')
        }
      }
    }
    node.children.forEach(visit)
  }
  pageRoots.forEach(visit)

  if (guards.size === 0) return ''
  const lines = [
    '/* Tauri squeeze guards: FILL regions scroll instead of painting over siblings when the',
    '   window is smaller than the design frame. Invisible at design size. */',
  ]
  for (const [className, axis] of guards) {
    lines.push(`.${className} { overflow-${axis}: auto; }`)
  }
  return lines.join('\n') + '\n'
}

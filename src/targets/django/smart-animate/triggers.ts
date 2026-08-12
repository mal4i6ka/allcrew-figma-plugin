/**
 * Trigger → web mechanism mapper (T5.6, docs/research/05-smart-animate-css-diff.md §2.5):
 * converts a Figma `Trigger` into the CSS selector or JS mechanism that reproduces it on the
 * web. `ON_HOVER` and `ON_PRESS`/`MOUSE_DOWN`/`MOUSE_UP` map to native pseudo-classes (free
 * auto-revert on mouse-up/mouse-leave); `ON_CLICK` needs an explicit class toggle since there's
 * no persistent-click pseudo-class; `AFTER_TIMEOUT` needs a `setTimeout`. Triggers with no
 * direct CSS/simple-JS analog (drag, keyboard, media) fall back to a generic JS listener that
 * toggles the same class `ON_CLICK` does.
 */

export type TriggerMechanism =
  | { readonly kind: 'css-pseudo-class'; readonly pseudoClass: 'hover' | 'active' }
  | { readonly kind: 'toggle-class'; readonly event: 'click' }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'js-listener'; readonly event: string }

/** Figma's `timeout`/`delay` trigger fields are seconds, matching `Transition.duration`. */
function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000)
}

export function mapTriggerToMechanism(trigger: Trigger): TriggerMechanism {
  switch (trigger.type) {
    case 'ON_HOVER':
      return { kind: 'css-pseudo-class', pseudoClass: 'hover' }
    case 'ON_PRESS':
    case 'MOUSE_DOWN':
    case 'MOUSE_UP':
      return { kind: 'css-pseudo-class', pseudoClass: 'active' }
    case 'ON_CLICK':
      return { kind: 'toggle-class', event: 'click' }
    case 'AFTER_TIMEOUT':
      return { kind: 'timeout', timeoutMs: secondsToMs(trigger.timeout) }
    case 'MOUSE_ENTER':
    case 'MOUSE_LEAVE':
      return { kind: 'js-listener', event: trigger.type === 'MOUSE_ENTER' ? 'mouseenter' : 'mouseleave' }
    case 'ON_KEY_DOWN':
      return { kind: 'js-listener', event: 'keydown' }
    case 'ON_DRAG':
      return { kind: 'js-listener', event: 'pointerdown' }
    case 'ON_MEDIA_HIT':
    case 'ON_MEDIA_END':
      return { kind: 'js-listener', event: trigger.type.toLowerCase().replace(/_/g, '-') }
  }
}

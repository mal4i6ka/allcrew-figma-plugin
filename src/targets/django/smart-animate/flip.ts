/**
 * FLIP emitter (T5.6, docs/research/05-smart-animate-css-diff.md §2.3): for layout-affecting
 * diffs (auto-layout spacing, differently-sized variants that reflow siblings) a `transition` on
 * `width`/`gap`/`left` reflows every frame; FLIP instead measures before/after with
 * `getBoundingClientRect()` and plays the delta back as a single composited `transform`
 * (Paul Lewis, https://aerotwist.com/blog/flip-your-animations/). This is the closest web
 * equivalent to Smart Animate's "two static states, the browser/Figma computes the motion".
 */

export interface EmitFlipToggleInput {
  readonly rootSelector: string
  readonly toggleClass: string
  readonly durationMs: number
  readonly timingFunction: string
  /** Attribute marking descendants that must FLIP together with the root. Defaults to `data-flip`. */
  readonly flipAttribute?: string
}

/** Emits a self-invoking FLIP toggle: measure, apply `toggleClass`, measure again, animate the delta. */
export function emitFlipToggle(input: EmitFlipToggleInput): string {
  const flipAttribute = input.flipAttribute ?? 'data-flip'

  return `(function flipToggle(root, cls, dur, easing) {
  if (!root) return
  var kids = [root].concat(Array.prototype.slice.call(root.querySelectorAll('[${flipAttribute}]')))
  var first = kids.map(function (k) { return k.getBoundingClientRect() })
  root.classList.toggle(cls)
  var last = kids.map(function (k) { return k.getBoundingClientRect() })
  kids.forEach(function (k, i) {
    var dx = first[i].left - last[i].left
    var dy = first[i].top - last[i].top
    var sx = last[i].width === 0 ? 1 : first[i].width / last[i].width
    var sy = last[i].height === 0 ? 1 : first[i].height / last[i].height
    k.animate(
      [{ transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')' }, { transform: 'none' }],
      { duration: dur, easing: easing, composite: 'replace' }
    )
  })
})(document.querySelector(${JSON.stringify(input.rootSelector)}), ${JSON.stringify(input.toggleClass)}, ${
    input.durationMs
  }, ${JSON.stringify(input.timingFunction)})`
}

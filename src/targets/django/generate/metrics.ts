/**
 * REFORM phase 11 / B4+: pixel-accurate Bootstrap 5.3 defaults for the generated design kit.
 * The kit builder (kit.ts) draws every master component 1:1 with these numbers so a designer
 * opens a near-final blank instead of a stack of gray boxes, and binds each role-colored fill
 * to the file's matching token. All `rem` values are converted at the 16px root.
 *
 * These are GENERATION-side visuals only — the exporter (components.ts) reads the DESIGN back
 * out of Figma and never consults this table. Colors are Bootstrap's own `$theme-colors`;
 * tints/shades follow Bootstrap's `tint-color`/`shade-color` (mix toward white/black), so alert
 * and subtle backgrounds land close to the framework without hard-coding every derived hex.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** `#rrggbb` / `#rgb` → normalized {r,g,b} in 0..1 (Figma's RGB space). */
export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '').trim()
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

/** Linear mix of two colors; `t`=0 → a, `t`=1 → b. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t))
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k }
}

const WHITE: Rgb = { r: 1, g: 1, b: 1 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

/** Bootstrap `tint-color($color, $weight)` — shift toward white. */
export function tint(color: Rgb, weight: number): Rgb {
  return mix(color, WHITE, weight)
}
/** Bootstrap `shade-color($color, $weight)` — shift toward black. */
export function shade(color: Rgb, weight: number): Rgb {
  return mix(color, BLACK, weight)
}

/** Bootstrap 5.3 `$theme-colors` (role → base hex). Lowercased keys; `link` reuses primary. */
export const ROLE_HEX: Record<string, string> = {
  primary: '#0d6efd',
  secondary: '#6c757d',
  success: '#198754',
  danger: '#dc3545',
  warning: '#ffc107',
  info: '#0dcaf0',
  light: '#f8f9fa',
  dark: '#212529',
  link: '#0d6efd',
}

/** The eight role names in Bootstrap's canonical order (the Variant prop's options). */
export const ROLES = ['Primary', 'Secondary', 'Success', 'Danger', 'Warning', 'Info', 'Light', 'Dark'] as const

/** Roles whose solid fill wants DARK foreground text for contrast (`text-bg-*` / `btn-*`). */
const DARK_TEXT_ROLES = new Set(['warning', 'info', 'light'])

/** Base role color as {r,g,b}; unknown roles fall back to primary. */
export function roleColor(role: string): Rgb {
  return hexToRgb(ROLE_HEX[role.trim().toLowerCase()] ?? ROLE_HEX.primary)
}

/** Foreground text color to place ON a solid role fill (contrast-correct, like `text-bg-*`). */
export function roleTextColor(role: string): Rgb {
  return DARK_TEXT_ROLES.has(role.trim().toLowerCase()) ? hexToRgb('#000000') : WHITE
}

/** Contextual alert palette for a role — Bootstrap `$alert-*-scale` (bg −80%, border −70%, text
 * +40% toward black). Returns fills for the tinted background, border, and text. */
export function alertColors(role: string): { bg: Rgb; border: Rgb; text: Rgb } {
  const base = roleColor(role)
  return { bg: tint(base, 0.8), border: tint(base, 0.7), text: shade(base, 0.4) }
}

/** Named greys used across components (Bootstrap CSS variables). */
export const COLOR = {
  bodyText: hexToRgb('#212529'), // --bs-body-color
  secondaryText: hexToRgb('#6c757d'), // --bs-secondary-color
  border: hexToRgb('#dee2e6'), // --bs-border-color
  inputBorder: hexToRgb('#ced4da'),
  surface: hexToRgb('#ffffff'), // --bs-body-bg
  subtleBg: hexToRgb('#f8f9fa'), // --bs-tertiary-bg / table-striped
  headerBg: hexToRgb('#f8f8f9'), // card-header ≈ body over rgba(0,0,0,.03)
  trackBg: hexToRgb('#e9ecef'), // progress / range track
  placeholder: hexToRgb('#e9ecef'),
  focusRing: hexToRgb('#0d6efd'),
} as const

/** Border radii (`--bs-border-radius*`). */
export const RADIUS = { sm: 4, base: 6, lg: 8, pill: 999 } as const

/** Body/control font sizes by size token (px). Base 16, sm .875rem, lg 1.25rem. */
export const FONT = { sm: 14, base: 16, lg: 20, small: 14, label: 16, heading: 20 } as const

export const LINE_HEIGHT = 1.5
export const BORDER_WIDTH = 1

/** A control's total height by size — `calc(line-height·font + padY·2 + border·2)`. Buttons and
 * form controls share this: base 38, sm 31, lg 48. */
export const CONTROL_HEIGHT: Record<string, number> = { sm: 31, md: 38, base: 38, lg: 48 }

/** Button / input padding `[vertical, horizontal]` px by size. */
export const CONTROL_PAD: Record<string, [number, number]> = {
  sm: [4, 8],
  md: [6, 12],
  base: [6, 12],
  lg: [8, 16],
}

/** Component-local spacing/padding constants (px), grouped by kind. Documented against the
 * Bootstrap source variable so the numbers are auditable. */
export const SPACE = {
  card: { radius: RADIUS.base, bodyPad: 16, headerPadV: 8, headerPadH: 16 }, // $card-*-padding
  alert: { padV: 16, padH: 16, radius: RADIUS.base }, // $alert-padding-y/x 1rem
  badge: { padV: 3, padH: 6, radius: RADIUS.base, font: 12 }, // .badge .375em .65em @ .75em
  listGroupItem: { padV: 8, padH: 16 }, // $list-group-item-padding
  accordion: { btnPadV: 16, btnPadH: 20, bodyPadV: 16, bodyPadH: 20 }, // $accordion-*-padding
  navbar: { padV: 8, padH: 16 }, // $navbar-padding
  navLink: { padV: 8, padH: 16 }, // $nav-link-padding
  pageLink: { padV: 6, padH: 12 }, // $pagination-padding
  dropdown: { minWidth: 160, padV: 8, itemPadV: 4, itemPadH: 16, radius: RADIUS.base }, // $dropdown-*
  toast: { width: 350, headerPadV: 8, headerPadH: 12, bodyPad: 12, radius: RADIUS.base },
  breadcrumb: { gap: 8 }, // $breadcrumb-item-padding + divider
  tableCell: { padV: 8, padH: 8 }, // $table-cell-padding .5rem
  offcanvas: { width: 400, height: 400, pad: 16 }, // $offcanvas-horizontal-width 400px
  modal: { width: 500, pad: 16, radius: RADIUS.lg }, // $modal-md 500, content radius .5rem
  progress: { height: 16, radius: RADIUS.base }, // $progress-height 1rem
  spinner: { size: 32, smSize: 16, border: 3 }, // 2rem, .25em border
  formCheck: { size: 16, gap: 8, switchWidth: 32 }, // 1em check, switch 2em wide
  range: { trackH: 8, thumb: 16 }, // $form-range
  inputGroup: { addonPadV: 6, addonPadH: 12 },
} as const

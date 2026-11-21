/**
 * 3D transforms (Plugin API Update 142, typings 1.143.0, beta): `transform3d`, `transformOrigin`
 * and `scene3d`, in the shape a write takes and a read gives back.
 *
 * The vocabulary is CSS's, because that is what Figma's own fields mean: `translateZ`, `rotateX`,
 * `rotateY`, `rotateZ`, `transform-origin`, `perspective`, `preserve-3d`. A write of
 * `{ transform3d: { rotateY: 30 } }` changes one rotation and keeps the rest — the docs' own
 * example spreads the old value for the same reason — and `"none"` or `null` takes it off.
 *
 * Kept apart from `props.ts` so the parsing, the merge and the read are pure and tested without a
 * Figma node; the planner and the applier only route to them.
 */

export type Space3dProperty = 'transform3d' | 'transformOrigin' | 'scene3d'

export const SPACE_3D_PROPERTIES: readonly Space3dProperty[] = ['transform3d', 'transformOrigin', 'scene3d']

/** What the planner hands the applier: a partial transform, a whole origin, a partial scene, or off. */
export type Space3dValue =
  | { kind: 'off' }
  | { kind: 'transform'; fields: Partial<Record<TransformNumber, number>> & { backfaceVisible?: boolean; visible?: boolean } }
  | { kind: 'origin'; origin: TransformOrigin }
  | { kind: 'scene'; fields: { perspective?: number; preserve3d?: boolean; visible?: boolean } }

type TransformNumber = 'translateZ' | 'rotateX' | 'rotateY' | 'rotateZ'
const TRANSFORM_NUMBERS: readonly TransformNumber[] = ['translateZ', 'rotateX', 'rotateY', 'rotateZ']
const TRANSFORM_FLAGS = ['backfaceVisible', 'visible'] as const
const SCENE_FLAGS = ['preserve3d', 'visible'] as const

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isOff = (raw: unknown) => raw === null || raw === 'none' || raw === 'NONE'

/** `50%`, `"12px"`, `12` (pixels) or Figma's own `{ unit, value }`. */
function originAxis(raw: unknown): TransformOriginAxis | null {
  if (isFiniteNumber(raw)) return { unit: 'PIXELS', value: raw }
  if (typeof raw === 'string') {
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*(%|px)?\s*$/i.exec(raw)
    if (!match) return null
    return { unit: match[2] === '%' ? 'PERCENT' : 'PIXELS', value: Number(match[1]) }
  }
  const held = raw as { unit?: unknown; value?: unknown } | null
  if (held && (held.unit === 'PERCENT' || held.unit === 'PIXELS') && isFiniteNumber(held.value)) {
    return { unit: held.unit, value: held.value }
  }
  return null
}

/** Checks one 3D prop as the caller wrote it. Problems are pushed; null means nothing to apply. */
export function plan3d(property: Space3dProperty, raw: unknown, where: string, problems: string[]): Space3dValue | null {
  const at = `${where}.${property}`
  const object = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null

  if (property === 'transform3d') {
    if (isOff(raw)) return { kind: 'off' }
    if (!object) {
      problems.push(`${at} must be { translateZ, rotateX, rotateY, rotateZ, backfaceVisible, visible } or "none"`)
      return null
    }
    const known = [...TRANSFORM_NUMBERS, ...TRANSFORM_FLAGS, 'type']
    const unknown = Object.keys(object).filter((key) => !known.includes(key))
    if (unknown.length > 0) {
      problems.push(`${at}: unknown field ${unknown.map((key) => `"${key}"`).join(', ')} — accepted: ${known.join(', ')}`)
      return null
    }
    if (object.type !== undefined && object.type !== 'FIXED_ORDER') {
      problems.push(`${at}.type can only be FIXED_ORDER — a FREEFORM transform is imported, not written, and "none" takes it off`)
      return null
    }
    const fields: Extract<Space3dValue, { kind: 'transform' }>['fields'] = {}
    let ok = true
    for (const key of TRANSFORM_NUMBERS) {
      if (object[key] === undefined) continue
      if (!isFiniteNumber(object[key])) {
        problems.push(`${at}.${key} must be a number (${key === 'translateZ' ? 'pixels' : 'degrees'})`)
        ok = false
      } else fields[key] = object[key] as number
    }
    for (const key of TRANSFORM_FLAGS) {
      if (object[key] === undefined) continue
      if (typeof object[key] !== 'boolean') {
        problems.push(`${at}.${key} must be a boolean`)
        ok = false
      } else fields[key] = object[key] as boolean
    }
    if (!ok) return null
    if (Object.keys(fields).length === 0) {
      problems.push(`${at} names nothing to change — give a rotation or translateZ, or "none" to take it off`)
      return null
    }
    return { kind: 'transform', fields }
  }

  if (property === 'transformOrigin') {
    if (!object) {
      problems.push(`${at} must be { x, y } — each "50%", "12px" or a number of pixels`)
      return null
    }
    const x = object.x === undefined ? { unit: 'PERCENT' as const, value: 50 } : originAxis(object.x)
    const y = object.y === undefined ? { unit: 'PERCENT' as const, value: 50 } : originAxis(object.y)
    if (!x || !y) {
      problems.push(`${at}.${!x ? 'x' : 'y'} must be "50%", "12px" or a number of pixels`)
      return null
    }
    return { kind: 'origin', origin: { x, y } }
  }

  // scene3d
  if (isOff(raw)) return { kind: 'off' }
  if (!object) {
    problems.push(`${at} must be { perspective, preserve3d, visible } or "none"`)
    return null
  }
  const known = ['perspective', ...SCENE_FLAGS]
  const unknown = Object.keys(object).filter((key) => !known.includes(key))
  if (unknown.length > 0) {
    problems.push(`${at}: unknown field ${unknown.map((key) => `"${key}"`).join(', ')} — accepted: ${known.join(', ')}`)
    return null
  }
  const fields: Extract<Space3dValue, { kind: 'scene' }>['fields'] = {}
  if (object.perspective !== undefined) {
    if (!isFiniteNumber(object.perspective)) {
      problems.push(`${at}.perspective must be a number of pixels — or -1 for none`)
      return null
    }
    fields.perspective = object.perspective
  }
  for (const key of SCENE_FLAGS) {
    if (object[key] === undefined) continue
    if (typeof object[key] !== 'boolean') {
      problems.push(`${at}.${key} must be a boolean`)
      return null
    }
    fields[key] = object[key] as boolean
  }
  if (Object.keys(fields).length === 0) {
    problems.push(`${at} names nothing to change — give perspective or preserve3d, or "none" to clear it`)
    return null
  }
  return { kind: 'scene', fields }
}

/**
 * The value to assign, given what the node holds now. A partial write keeps the fields it does
 * not name: the whole object has to be assigned, and assigning only what was named would zero the
 * other rotations.
 */
export function merge3d(property: Space3dProperty, before: unknown, value: Space3dValue): Transform3d | TransformOrigin | Scene3d | null {
  if (property === 'transform3d') {
    if (value.kind === 'off') return { type: 'NONE' }
    if (value.kind !== 'transform') throw new Error('transform3d takes a transform')
    const held = before as Partial<Record<string, unknown>> | null
    const base = held?.type === 'FIXED_ORDER' ? held : {}
    const number = (key: TransformNumber) =>
      value.fields[key] ?? (isFiniteNumber(base[key]) ? (base[key] as number) : 0)
    const next: Record<string, unknown> = {
      type: 'FIXED_ORDER',
      translateZ: number('translateZ'),
      rotateX: number('rotateX'),
      rotateY: number('rotateY'),
      rotateZ: number('rotateZ'),
    }
    // A FREEFORM transform keeps its backface choice when it is replaced by a fixed one.
    const flagsFrom = held && held.type !== 'NONE' ? held : {}
    for (const key of TRANSFORM_FLAGS) {
      const flag = value.fields[key] ?? flagsFrom[key]
      if (typeof flag === 'boolean') next[key] = flag
    }
    return next as Transform3d
  }
  if (property === 'transformOrigin') {
    if (value.kind !== 'origin') throw new Error('transformOrigin takes { x, y }')
    return value.origin
  }
  if (value.kind === 'off') return null
  if (value.kind !== 'scene') throw new Error('scene3d takes a scene')
  const held = (before as Partial<Scene3d> | null) ?? {}
  const next: Record<string, unknown> = {
    perspective: value.fields.perspective ?? (isFiniteNumber(held.perspective) ? held.perspective : -1),
    preserve3d: value.fields.preserve3d ?? held.preserve3d === true,
  }
  const visible = value.fields.visible ?? held.visible
  if (typeof visible === 'boolean') next.visible = visible
  return next as unknown as Scene3d
}

const round = (value: number) => Math.round(value * 100) / 100

function axisWord(axis: TransformOriginAxis): string | number {
  return axis.unit === 'PERCENT' ? `${round(axis.value)}%` : round(axis.value)
}

/**
 * The 3D state of a node in the write's own shape, or undefined when it has none worth saying.
 * Defaults say nothing: no transform, a centred origin, no scene.
 */
export function describe3d(source: { transform3d?: unknown; transformOrigin?: unknown; scene3d?: unknown }):
  | { transform3d?: Record<string, unknown>; transformOrigin?: { x: string | number; y: string | number }; scene3d?: Record<string, unknown> }
  | undefined {
  const out: ReturnType<typeof describe3d> & object = {}
  const transform = source.transform3d as Record<string, unknown> | undefined
  if (transform && (transform.type === 'FIXED_ORDER' || transform.type === 'FREEFORM')) {
    const read: Record<string, unknown> = {}
    if (transform.type === 'FREEFORM') read.type = 'FREEFORM'
    for (const key of TRANSFORM_NUMBERS) {
      if (isFiniteNumber(transform[key]) && round(transform[key] as number) !== 0) read[key] = round(transform[key] as number)
    }
    if (transform.backfaceVisible === false) read.backfaceVisible = false
    if (transform.visible === false) read.visible = false
    if (Object.keys(read).length > 0) out.transform3d = read
  }
  const origin = source.transformOrigin as TransformOrigin | undefined
  const centred = (axis: TransformOriginAxis | undefined) => axis?.unit === 'PERCENT' && axis.value === 50
  // The origin only means something once there is a transform to turn about.
  if (out.transform3d && origin?.x && origin?.y && !(centred(origin.x) && centred(origin.y))) {
    out.transformOrigin = { x: axisWord(origin.x), y: axisWord(origin.y) }
  }
  const scene = source.scene3d as Partial<Scene3d> | null | undefined
  if (scene && typeof scene === 'object') {
    const read: Record<string, unknown> = {}
    if (isFiniteNumber(scene.perspective) && scene.perspective >= 0) read.perspective = round(scene.perspective)
    if (scene.preserve3d === true) read.preserve3d = true
    if (scene.visible === false) read.visible = false
    if (Object.keys(read).length > 0) out.scene3d = read
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Keyframe words for the five 3D tracks, ours → Figma's. */
export const SPACE_3D_KEYFRAME_FIELDS: Readonly<Record<string, string>> = {
  translateZ: 'TRANSFORM_3D_TRANSLATION_Z',
  rotateX: 'TRANSFORM_3D_ROTATION_X',
  rotateY: 'TRANSFORM_3D_ROTATION_Y',
  rotateZ: 'TRANSFORM_3D_ROTATION_Z',
  perspective: 'SCENE_3D_PERSPECTIVE',
}

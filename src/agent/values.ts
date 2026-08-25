/**
 * Agent listener — value and reference plumbing shared by the mutating ops.
 *
 * An agent types JSON by hand: it names a variable `"Colors/orange/500"` rather than
 * `VariableID:95:9010`, and writes a colour as `"#FB5B0A"` rather than four floats. Everything
 * that turns designer-readable text into Figma's own shapes (and back, so a write can report
 * what it replaced) lives here — the ops themselves then read as intent.
 */

import { formatHex, parseHex, type Rgb } from '../tokens/color.ts'

/* ------------------------------------------------------------------ colour */

export interface Rgba extends Rgb {
  a: number
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

/**
 * Accepts `#RGB`, `#RRGGBB`, `#RRGGBBAA`, `"#RRGGBB 40%"` and the `{r,g,b,a}` floats Figma
 * itself returns. The `hex + percent` form exists because that is how an alpha token reads in
 * the variables panel — `alpha/black/40` is `#000000` at 40%, not `#00000066`.
 */
export function parseColor(input: unknown): Rgba | null {
  if (typeof input === 'object' && input !== null) {
    const raw = input as Record<string, unknown>
    if (['r', 'g', 'b'].every((key) => typeof raw[key] === 'number')) {
      return {
        r: clamp01(raw.r as number),
        g: clamp01(raw.g as number),
        b: clamp01(raw.b as number),
        a: typeof raw.a === 'number' ? clamp01(raw.a) : 1,
      }
    }
    return null
  }
  if (typeof input !== 'string') return null

  const text = input.trim()
  const withPercent = /^(#?[0-9a-fA-F]{3,8})\s*[@/]?\s*([0-9.]+)\s*%$/.exec(text)
  if (withPercent) {
    const rgb = parseHex(withPercent[1])
    if (!rgb) return null
    return { ...rgb, a: clamp01(Number(withPercent[2]) / 100) }
  }

  const hex = text.replace(/^#/, '')
  if (/^[0-9a-fA-F]{8}$/.test(hex)) {
    const rgb = parseHex(hex.slice(0, 6))
    if (!rgb) return null
    return { ...rgb, a: parseInt(hex.slice(6, 8), 16) / 255 }
  }
  const rgb = parseHex(text)
  return rgb ? { ...rgb, a: 1 } : null
}

/** `#RRGGBB`, plus the alpha as a percentage when it is not opaque — the variables-panel form. */
export function describeColor(color: Rgba): string {
  const hex = formatHex(color)
  return color.a >= 0.999 ? hex : `${hex} ${Math.round(color.a * 100)}%`
}

/* -------------------------------------------------------------- references */

const VARIABLE_ID = /^VariableID:/
const COLLECTION_ID = /^VariableCollectionId:/

/** `"Colors"` or the raw `VariableCollectionId:…`. Name match is case-insensitive. */
export async function resolveCollection(ref: unknown): Promise<VariableCollection> {
  if (typeof ref !== 'string' || ref === '') throw new Error('collection reference must be a non-empty string')
  if (COLLECTION_ID.test(ref)) {
    const collection = await figma.variables.getVariableCollectionByIdAsync(ref)
    if (!collection) throw new Error(`no variable collection with id ${ref}`)
    return collection
  }
  const collections = await figma.variables.getLocalVariableCollectionsAsync()
  const matches = collections.filter((collection) => collection.name.toLowerCase() === ref.toLowerCase())
  if (matches.length === 0) {
    throw new Error(`no local collection named "${ref}" — have: ${collections.map((c) => c.name).join(', ')}`)
  }
  if (matches.length > 1) throw new Error(`"${ref}" names ${matches.length} collections — use the id`)
  return matches[0]
}

/** A published variable is addressed by its `key` — 40 hex characters, no prefix — which is
 * what distinguishes it from every local reference form. Nothing local ever looks like this:
 * ids carry a `VariableID:` prefix and names carry slashes. */
const LIBRARY_KEY = /^[0-9a-f]{20,}$/i

export const isLibraryKey = (ref: unknown): ref is string => typeof ref === 'string' && LIBRARY_KEY.test(ref)

/**
 * A local variable *or* a library one. Importing a key is what turns "the design system
 * publishes this colour" into something this file can actually alias — it is the whole
 * mechanism behind one library inheriting another's tokens.
 */
export async function resolveVariableRef(ref: unknown): Promise<Variable> {
  if (isLibraryKey(ref)) {
    try {
      return await figma.variables.importVariableByKeyAsync(ref as string)
    } catch (err) {
      throw new Error(
        `no library variable with key ${ref} — is that library enabled in this file? ` +
          `(${String((err as Error)?.message || err)})`
      )
    }
  }
  return resolveVariable(ref)
}

/**
 * `VariableID:…`, `"Colors/orange/500"` (collection-qualified) or `"orange/500"` when the name
 * is unique across local collections. Ambiguity is an error rather than a coin flip: a recolor
 * that silently wrote to the wrong collection is worse than one that stops.
 */
export async function resolveVariable(ref: unknown): Promise<Variable> {
  if (typeof ref !== 'string' || ref === '') throw new Error('variable reference must be a non-empty string')
  if (VARIABLE_ID.test(ref)) {
    const variable = await figma.variables.getVariableByIdAsync(ref)
    if (!variable) throw new Error(`no variable with id ${ref}`)
    return variable
  }

  const variables = await figma.variables.getLocalVariablesAsync()
  const exact = variables.filter((variable) => variable.name === ref)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) {
    const owners = await collectionNames(exact)
    throw new Error(`"${ref}" exists in ${owners.join(', ')} — qualify it as "Collection/${ref}"`)
  }

  // Collection-qualified: "One/accent/primary" → collection "One", variable "accent/primary".
  const slash = ref.indexOf('/')
  if (slash > 0) {
    const collectionName = ref.slice(0, slash).toLowerCase()
    const variableName = ref.slice(slash + 1)
    const collections = await figma.variables.getLocalVariableCollectionsAsync()
    const collection = collections.find((entry) => entry.name.toLowerCase() === collectionName)
    if (collection) {
      const match = variables.find(
        (variable) => variable.variableCollectionId === collection.id && variable.name === variableName
      )
      if (match) return match
    }
  }
  throw new Error(`no variable named "${ref}"`)
}

async function collectionNames(variables: readonly Variable[]): Promise<string[]> {
  const names: string[] = []
  for (const variable of variables) {
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId)
    names.push(collection?.name ?? variable.variableCollectionId)
  }
  return names
}

/**
 * A mode id, a mode name (`"Dark"`), or `"*"` for every mode in the collection. Omitted means
 * the collection default — right for a single-mode primitive collection, and explicit enough
 * to be safe for a themed one, where omitting it would otherwise silently write one theme.
 */
export function resolveModes(collection: VariableCollection, ref: unknown): Array<{ modeId: string; name: string }> {
  if (ref === undefined || ref === null || ref === '') {
    const fallback = collection.modes.find((mode) => mode.modeId === collection.defaultModeId) ?? collection.modes[0]
    return [{ modeId: fallback.modeId, name: fallback.name }]
  }
  if (ref === '*') return collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name }))
  if (typeof ref !== 'string') throw new Error('mode must be a string')

  const byId = collection.modes.find((mode) => mode.modeId === ref)
  if (byId) return [{ modeId: byId.modeId, name: byId.name }]
  const byName = collection.modes.filter((mode) => mode.name.toLowerCase() === ref.toLowerCase())
  if (byName.length === 1) return [{ modeId: byName[0].modeId, name: byName[0].name }]
  throw new Error(
    `collection "${collection.name}" has no mode "${ref}" — have: ${collection.modes.map((m) => m.name).join(', ')}`
  )
}

/* ------------------------------------------------------------------ values */

export function isAlias(value: unknown): value is VariableAlias {
  return typeof value === 'object' && value !== null && (value as VariableAlias).type === 'VARIABLE_ALIAS'
}

/** What a value looks like in a report: `#FB5B0A`, `→ Colors/orange/500`, `12`, `true`. */
export async function describeValue(value: VariableValue | undefined): Promise<string> {
  if (value === undefined) return '(unset)'
  if (isAlias(value)) {
    const target = await figma.variables.getVariableByIdAsync(value.id)
    if (!target) return `→ ${value.id}`
    // A remote target is the point of an inheritance pass — the report has to say so, or a
    // designer cannot tell a repointed token from one that merely moved a rung.
    return target.remote ? `→ ${target.name} (library)` : `→ ${target.name}`
  }
  if (typeof value === 'object' && value !== null && 'r' in value) {
    const color = value as RGBA | RGB
    return describeColor({ r: color.r, g: color.g, b: color.b, a: 'a' in color ? color.a : 1 })
  }
  return String(value)
}

/**
 * Turns one agent-supplied value into a `VariableValue` of the target's own type. `{ alias }`
 * points at another variable; anything else is read as the literal the variable's type expects,
 * so a `FLOAT` token can never be handed a colour by accident.
 */
export async function coerceVariableValue(variable: Variable, raw: unknown): Promise<VariableValue> {
  if (typeof raw === 'object' && raw !== null && 'alias' in (raw as Record<string, unknown>)) {
    const target = await resolveVariableRef((raw as Record<string, unknown>).alias)
    if (target.id === variable.id) throw new Error(`"${variable.name}" cannot alias itself`)
    if (target.resolvedType !== variable.resolvedType) {
      throw new Error(
        `"${variable.name}" is ${variable.resolvedType} but "${target.name}" is ${target.resolvedType}`
      )
    }
    return figma.variables.createVariableAlias(target)
  }

  switch (variable.resolvedType) {
    case 'COLOR': {
      const color = parseColor(raw)
      if (!color) throw new Error(`"${variable.name}" needs a colour — got ${JSON.stringify(raw)}`)
      return { r: color.r, g: color.g, b: color.b, a: color.a }
    }
    case 'FLOAT': {
      const num = typeof raw === 'string' ? Number(raw) : raw
      if (typeof num !== 'number' || !Number.isFinite(num)) {
        throw new Error(`"${variable.name}" needs a number — got ${JSON.stringify(raw)}`)
      }
      return num
    }
    case 'BOOLEAN': {
      if (typeof raw === 'boolean') return raw
      if (raw === 'true') return true
      if (raw === 'false') return false
      throw new Error(`"${variable.name}" needs a boolean — got ${JSON.stringify(raw)}`)
    }
    case 'STRING': {
      if (typeof raw !== 'string') throw new Error(`"${variable.name}" needs a string — got ${JSON.stringify(raw)}`)
      return raw
    }
  }
}

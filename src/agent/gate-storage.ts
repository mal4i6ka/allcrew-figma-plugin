export interface StoredGates {
  read: boolean
  write: boolean
}

const CLOSED_GATES: StoredGates = { read: false, write: false }

function parseStoredGates(entry: unknown): StoredGates | null {
  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>
    return { read: record.read === true, write: record.write === true }
  }
  // The first stored shape was a bare read grant.
  if (entry === true) return { read: true, write: false }
  return null
}

/**
 * Grants are keyed by a stable file identity: `figma.fileKey` where Figma gives one, otherwise the
 * id the plugin stamps into the document on the first grant (see `fileIdentity` in `code.ts`). A
 * file name is never the key: two unrelated files named "Untitled" must never share an agent
 * grant. Without any key the listener starts closed and consent lasts only for this session.
 */
export function storedGatesFor(storage: unknown, fileKey: string | null | undefined): StoredGates {
  if (!fileKey || !storage || typeof storage !== 'object') return { ...CLOSED_GATES }
  return parseStoredGates((storage as Record<string, unknown>)[fileKey]) ?? { ...CLOSED_GATES }
}

/** Returns the next persisted map. With no stable file key, nothing is persisted. */
export function withStoredGates(
  storage: unknown,
  fileKey: string | null | undefined,
  legacyFileName: string,
  gates: StoredGates
): Record<string, unknown> {
  const current = storage && typeof storage === 'object' ? { ...(storage as Record<string, unknown>) } : {}
  if (!fileKey) return current
  if (gates.read || gates.write) current[fileKey] = { read: gates.read, write: gates.write }
  else delete current[fileKey]
  // Remove the unsafe name-keyed shape once a stable identity is available.
  delete current[legacyFileName]
  return current
}

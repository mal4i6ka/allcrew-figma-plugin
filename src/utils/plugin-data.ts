/**
 * Typed wrapper over Figma's shared plugin data, namespaced so entries from this plugin
 * never collide with other plugins' data on the same node.
 */

/** Exported because the Django emitters read the same blob off a plain `getSharedPluginData`
 * shape rather than a `BaseNode` — the template emitter only ever sees the narrow node source
 * interface, and a second hardcoded `'altery'` there is how the two sides drift apart. */
export const PLUGIN_DATA_NAMESPACE = 'altery'
const MAX_PLUGIN_DATA_BYTES = 100_000

export enum PluginDataKey {
  I18N_KEY = 'i18nKey',
  /** Pre-translation `characters`, backed up on first import so a locale swap can be undone. */
  I18N_ORIGINAL = 'i18nOriginal',
}

/** Parses one raw shared-plugin-data string. Split out of `getPluginData` so a caller holding
 * the raw value (not the node) decodes it exactly the same way, malformed JSON included. */
export function parsePluginData<T>(raw: string | undefined | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function getPluginData<T>(node: BaseNode, key: PluginDataKey): T | null {
  return parsePluginData<T>(node.getSharedPluginData(PLUGIN_DATA_NAMESPACE, key))
}

export function setPluginData<T>(node: BaseNode, key: PluginDataKey, value: T): void {
  const serialized = JSON.stringify(value)
  if (serialized.length > MAX_PLUGIN_DATA_BYTES) {
    throw new Error('pluginData limit 100KB exceeded')
  }
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, key, serialized)
}

export function clearPluginData(node: BaseNode, key: PluginDataKey): void {
  node.setSharedPluginData(PLUGIN_DATA_NAMESPACE, key, '')
}

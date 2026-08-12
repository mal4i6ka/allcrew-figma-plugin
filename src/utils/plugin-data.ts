/**
 * Typed wrapper over Figma's shared plugin data, namespaced so entries from this plugin
 * never collide with other plugins' data on the same node.
 */

const NAMESPACE = 'altery'
const MAX_PLUGIN_DATA_BYTES = 100_000

export enum PluginDataKey {
  I18N_KEY = 'i18nKey',
  /** Pre-translation `characters`, backed up on first import so a locale swap can be undone. */
  I18N_ORIGINAL = 'i18nOriginal',
}

export function getPluginData<T>(node: BaseNode, key: PluginDataKey): T | null {
  const raw = node.getSharedPluginData(NAMESPACE, key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function setPluginData<T>(node: BaseNode, key: PluginDataKey, value: T): void {
  const serialized = JSON.stringify(value)
  if (serialized.length > MAX_PLUGIN_DATA_BYTES) {
    throw new Error('pluginData limit 100KB exceeded')
  }
  node.setSharedPluginData(NAMESPACE, key, serialized)
}

export function clearPluginData(node: BaseNode, key: PluginDataKey): void {
  node.setSharedPluginData(NAMESPACE, key, '')
}

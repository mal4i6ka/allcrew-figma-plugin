/** Runtime boundary guard shared by config, IPC and imported JSON parsers. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

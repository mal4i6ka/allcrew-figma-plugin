/**
 * Target types — shared interfaces for the target system.
 */

export type TargetId = 'design-tokens' | 'django'

export interface TargetArtifacts {
  /** path → content. Binary entries (component preview PNGs) travel as `Uint8Array`; the UI's
   * zip writer takes either. */
  files: Record<string, string | Uint8Array>
  summary: TargetSummary
}

export interface TargetSummary {
  target: TargetId
  // target-specific fields added by each target
  [key: string]: unknown
}

/**
 * The modules this plugin has installed, and what they look like to the channel.
 *
 * Storage lives in the sandbox (`figma.clientStorage`); this holds what was read out of it,
 * decides what is usable, and projects every module command into the same `UiCommandDef` shape
 * `plugin.commands` serves for native ones. That projection is the whole trick: an agent asking
 * what this plugin can do gets one list, and cannot tell which half was compiled in.
 *
 * A module that no longer validates — written against a newer plugin, or edited by hand into
 * nonsense — is kept and listed with its problems rather than dropped. A capability that
 * vanishes silently is worse than one that says why it is unavailable.
 */

import type { UiCommandDef } from '../agent/ui-commands.ts'
import { moduleCapabilities, parseUserModule, type ModuleCapability, type ModuleProblem, type UserModule } from './contract.ts'

/** One module as it sits in storage: the file exactly as imported, plus what it has kept. */
export interface StoredModule {
  file: unknown
  state?: Record<string, unknown>
  installedAt?: string
  disabled?: boolean
}

export interface RegisteredModule {
  id: string
  module: UserModule | null
  stored: StoredModule
  problems: ModuleProblem[]
  capabilities: ModuleCapability[]
  /** Usable: it parsed, and the designer has not switched it off. */
  active: boolean
}

/** The most a single module file may be. Storage is shared with everything else the plugin
 * remembers, and a module is a form and a few steps — a megabyte of one is a mistake, not a
 * feature. */
export const MODULE_SIZE_LIMIT = 200_000

export function registerModules(
  stored: Readonly<Record<string, StoredModule>>,
  known: readonly UiCommandDef[]
): RegisteredModule[] {
  const modules: RegisteredModule[] = []
  for (const [id, entry] of Object.entries(stored ?? {})) {
    const { module, problems } = parseUserModule(entry?.file, known)
    // The id under which it is stored is the id it must answer to; a file whose own id has been
    // edited to something else is not the module that was installed.
    const mismatched =
      module && module.id !== id ? [{ path: 'id', message: `stored as "${id}" but the file says "${module.id}"` }] : []
    const usable = module !== null && mismatched.length === 0
    modules.push({
      id,
      module: usable ? module : null,
      stored: entry,
      problems: [...problems, ...mismatched],
      capabilities: usable ? moduleCapabilities(module, known) : [],
      active: usable && entry?.disabled !== true,
    })
  }
  return modules.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Module commands as the channel sees them.
 *
 * `access` is the derived one, so the gate treats a module command exactly as it treats the
 * write it wraps. The `module` field is the only thing marking the difference, and it is there
 * to be *shown*, never to be trusted with a decision.
 */
export function moduleCommandDefs(modules: readonly RegisteredModule[]): UiCommandDef[] {
  const defs: UiCommandDef[] = []
  for (const entry of modules) {
    if (!entry.active || !entry.module) continue
    for (const command of entry.module.commands) {
      defs.push({
        name: command.name,
        access: command.access,
        classified: true,
        summary: command.summary,
        module: entry.id,
        params: command.confirms
          ? [
              ...command.params,
              {
                name: 'confirm',
                required: false,
                type: 'boolean',
                note: 'this module stops to ask before it writes — pass true to go past that',
              },
            ]
          : command.params,
        replies: [],
        ...(costOf(command.steps.flatMap((step) => ('call' in step ? [step.call] : [])), entry.capabilities)
          ? { cost: costOf(command.steps.flatMap((step) => ('call' in step ? [step.call] : [])), entry.capabilities)! }
          : {}),
      })
    }
  }
  return defs
}

/** What the run will cost, said in the words of the commands it runs — a module cannot know
 * this about itself, and the caller should not have to look it up per step. */
function costOf(calls: readonly string[], capabilities: readonly ModuleCapability[]): string | undefined {
  const costs = capabilities.filter((entry) => calls.includes(entry.command) && entry.cost).map((entry) => `${entry.command}: ${entry.cost}`)
  return costs.length > 0 ? costs.join(' · ') : undefined
}

/** Finds the module a command name belongs to. Names are namespaced by module id, so this is a
 * lookup rather than a search — but it stays honest about a disabled module rather than
 * pretending the command never existed. */
export function findModuleCommand(
  modules: readonly RegisteredModule[],
  name: string
): { module: UserModule; command: UserModule['commands'][number]; entry: RegisteredModule } | { error: string } | null {
  for (const entry of modules) {
    const command = entry.module?.commands.find((candidate) => candidate.name === name)
    if (!command || !entry.module) continue
    if (!entry.active) return { error: `"${name}" belongs to module "${entry.id}", which is switched off` }
    return { module: entry.module, command, entry }
  }
  return null
}

/** What `MODULES_LIST` answers: enough to install, remove and trust — never the whole file. */
export function describeModules(modules: readonly RegisteredModule[]): Array<Record<string, unknown>> {
  return modules.map((entry) => ({
    id: entry.id,
    active: entry.active,
    ...(entry.module
      ? {
          name: entry.module.name,
          summary: entry.module.summary,
          version: entry.module.version,
          ...(entry.module.author ? { author: entry.module.author } : {}),
          screens: Object.keys(entry.module.screens),
          commands: entry.module.commands.map((command) => ({
            name: command.name,
            access: command.access,
            summary: command.summary,
            confirms: command.confirms,
          })),
          capabilities: entry.capabilities,
        }
      : {}),
    ...(entry.stored?.installedAt ? { installedAt: entry.stored.installedAt } : {}),
    ...(entry.problems.length > 0 ? { problems: entry.problems } : {}),
  }))
}

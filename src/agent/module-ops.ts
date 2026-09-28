import { MODULE_AUTHORING_GUIDE, MODULE_JSON_SCHEMA, MODULE_SCHEMA_ID, MODULE_TEMPLATE, moduleAgentPrompt } from '../modules/schema.ts'
import type { OpDef } from './protocol.ts'

export interface ModuleAdminProvider {
  list: () => Promise<unknown> | unknown
  inspect: (id: string) => Promise<unknown> | unknown
  install: (file: unknown, allowDowngrade: boolean) => Promise<unknown>
  configure: (id: string, enabled: boolean | undefined, state: unknown) => Promise<unknown>
  remove: (id: string) => Promise<unknown>
  export: (id: string, includeState: boolean) => Promise<unknown> | unknown
}

let provider: ModuleAdminProvider | null = null

export function setModuleAdminProvider(next: ModuleAdminProvider | null): void {
  provider = next
}

function installedModules(): ModuleAdminProvider {
  if (!provider) throw new Error('module registry is not ready')
  return provider
}

export const MODULE_OPS: readonly OpDef[] = [
  {
    name: 'modules.schema',
    summary: 'Get the canonical JSON Schema, a valid starter module, authoring rules and runtime limits.',
    mutates: false,
    params: {},
    async run() {
      return { schemaId: MODULE_SCHEMA_ID, schema: MODULE_JSON_SCHEMA, template: MODULE_TEMPLATE, guide: MODULE_AUTHORING_GUIDE, agentPrompt: moduleAgentPrompt() }
    },
  },
  {
    name: 'modules.list',
    summary: 'List installed modules, versions, status, commands, problems and derived capabilities.',
    mutates: false,
    params: {},
    async run() {
      return installedModules().list()
    },
  },
  {
    name: 'modules.inspect',
    summary: 'Inspect one installed module, including its declarative file and redacted current state.',
    mutates: false,
    params: { id: { type: 'string', required: true, description: 'Module id from modules.list.' } },
    async run(params) {
      return installedModules().inspect(String(params.id))
    },
  },
  {
    name: 'modules.export',
    summary: 'Export an installed module file, optionally with non-secret state for transfer or review.',
    mutates: false,
    params: {
      id: { type: 'string', required: true, description: 'Module id from modules.list.' },
      includeState: { type: 'boolean', default: false, description: 'Include current non-secret state beside the file.' },
    },
    async run(params) {
      return installedModules().export(String(params.id), params.includeState === true)
    },
  },
  {
    name: 'modules.install',
    summary: 'Validate and install or upgrade a declarative module file; compatible state is migrated.',
    mutates: true,
    agent: 'Call modules.schema first, then send the complete module object. Review the returned derived capabilities; downgrades are refused unless allowDowngrade is explicit.',
    params: {
      file: { type: 'json', required: true, description: 'Complete module object matching modules.schema.' },
      allowDowngrade: { type: 'boolean', default: false, description: 'Explicitly permit replacing a newer installed version.' },
    },
    async run(params) {
      return installedModules().install(params.file, params.allowDowngrade === true)
    },
  },
  {
    name: 'modules.configure',
    summary: 'Enable or disable a module and atomically update its declared state fields.',
    mutates: true,
    agent: 'Pass only declared state fields with correctly typed values. Secret fields may be written but are never returned by inspect or export.',
    params: {
      id: { type: 'string', required: true, description: 'Module id from modules.list.' },
      enabled: { type: 'boolean', description: 'Enable or disable the module; omit to leave unchanged.' },
      state: { type: 'json', description: 'Partial object of declared state fields to update atomically.' },
    },
    async run(params) {
      return installedModules().configure(String(params.id), params.enabled as boolean | undefined, params.state)
    },
  },
  {
    name: 'modules.remove',
    summary: 'Remove an installed module and all of its persisted state.',
    mutates: true,
    agent: 'Removal is irreversible and deletes the module state. Export first when the file or non-secret state may be needed again.',
    params: { id: { type: 'string', required: true, description: 'Exact module id to remove.' } },
    async run(params) {
      return installedModules().remove(String(params.id))
    },
  },
]

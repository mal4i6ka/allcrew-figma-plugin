import {
  MODULE_COMMAND_NAME_PATTERN,
  MODULE_FORMAT,
  MODULE_ICON_TYPES,
  MODULE_ID_PATTERN,
  MODULE_LIMITS,
  MODULE_REFERENCE_PATTERN,
  MODULE_SAFE_NAME_PATTERN,
  MODULE_VERSION_PATTERN,
} from './contract.ts'

export const MODULE_SCHEMA_ID = 'https://allcrew.dev/schemas/channel-module-v1.json'

const condition = {
  type: 'object',
  required: ['from'],
  properties: {
    from: { type: 'string', pattern: MODULE_REFERENCE_PATTERN.source },
    equals: { type: ['string', 'number', 'boolean'] },
    notEquals: { type: ['string', 'number', 'boolean'] },
    oneOf: { type: 'array', minItems: 1, maxItems: 100, items: { type: ['string', 'number', 'boolean'] } },
    truthy: { type: 'boolean' },
    exists: { type: 'boolean' },
  },
  oneOf: [
    { required: ['equals'] },
    { required: ['notEquals'] },
    { required: ['oneOf'] },
    { required: ['truthy'] },
    { required: ['exists'] },
  ],
  additionalProperties: false,
} as const

const conditionProperties = {
  when: { $ref: '#/$defs/condition' },
} as const

const interactiveProperties = {
  ...conditionProperties,
  disabledWhen: { $ref: '#/$defs/condition' },
} as const

const step = {
  oneOf: [
    {
      type: 'object',
      required: ['call'],
      properties: {
        call: { type: 'string', minLength: 1 },
        params: { type: 'object' },
        as: { type: 'string', pattern: MODULE_SAFE_NAME_PATTERN.source },
        ...conditionProperties,
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['set', 'from'],
      properties: {
        set: { type: 'string' },
        from: { type: 'string' },
        ...conditionProperties,
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['confirm'],
      properties: {
        confirm: { type: 'string', minLength: 1, maxLength: MODULE_LIMITS.textLength },
        ...conditionProperties,
      },
      additionalProperties: false,
    },
  ],
} as const

const blocks = [
  {
    type: 'object', required: ['block', 'text'],
    properties: {
      block: { const: 'heading' }, text: { type: 'string', minLength: 1, maxLength: MODULE_LIMITS.textLength },
      icon: { enum: MODULE_ICON_TYPES },
      hint: { type: 'string' }, ...conditionProperties,
    }, additionalProperties: false,
  },
  {
    type: 'object', required: ['block', 'text'],
    properties: { block: { const: 'text' }, text: { type: 'string', minLength: 1, maxLength: MODULE_LIMITS.textLength }, ...conditionProperties },
    additionalProperties: false,
  },
  {
    type: 'object', required: ['block', 'text'],
    properties: {
      block: { const: 'callout' }, text: { type: 'string', minLength: 1, maxLength: MODULE_LIMITS.textLength },
      tone: { enum: ['info', 'warn', 'error', 'success'] }, ...conditionProperties,
    }, additionalProperties: false,
  },
  {
    type: 'object', required: ['block', 'bind'],
    properties: {
      block: { const: 'field' }, bind: { type: 'string' }, label: { type: 'string' }, placeholder: { type: 'string' },
      multiline: { type: 'boolean' }, rows: { type: 'integer', minimum: 2, maximum: 20 }, ...interactiveProperties,
    }, additionalProperties: false,
  },
  {
    type: 'object', required: ['block', 'bind'],
    properties: { block: { const: 'value' }, bind: { type: 'string' }, label: { type: 'string' }, hint: { type: 'string' }, ...conditionProperties },
    additionalProperties: false,
  },
  {
    type: 'object', required: ['block', 'bind', 'options'],
    properties: {
      block: { const: 'select' }, bind: { type: 'string' }, label: { type: 'string' },
      options: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', required: ['value'], properties: { value: { type: 'string' }, label: { type: 'string' } }, additionalProperties: false } },
      ...interactiveProperties,
    }, additionalProperties: false,
  },
  {
    type: 'object', required: ['block', 'bind'],
    properties: { block: { const: 'toggle' }, bind: { type: 'string' }, label: { type: 'string' }, ...interactiveProperties },
    additionalProperties: false,
  },
  {
    type: 'object', required: ['block', 'label', 'steps'],
    properties: {
      block: { const: 'button' }, label: { type: 'string', minLength: 1, maxLength: MODULE_LIMITS.nameLength },
      look: { enum: ['primary', 'secondary', 'danger'] },
      steps: { type: 'array', minItems: 1, maxItems: MODULE_LIMITS.stepsPerPipeline, items: { $ref: '#/$defs/step' } },
      ...interactiveProperties,
    }, additionalProperties: false,
  },
  {
    type: 'object', required: ['block', 'from'],
    properties: {
      block: { const: 'table' }, from: { type: 'string' }, label: { type: 'string' },
      columns: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string', minLength: 1 } },
      limit: { type: 'integer', minimum: 1, maximum: MODULE_LIMITS.tableRows }, ...conditionProperties,
    }, additionalProperties: false,
  },
  {
    type: 'object', required: ['block'],
    oneOf: [{ required: ['from'] }, { required: ['text'] }],
    properties: {
      block: { const: 'code' }, from: { type: 'string' }, text: { type: 'string' }, label: { type: 'string' }, language: { type: 'string' }, ...conditionProperties,
    }, additionalProperties: false,
  },
  {
    type: 'object', required: ['block', 'from'],
    properties: {
      block: { const: 'list' }, from: { type: 'string' }, label: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: MODULE_LIMITS.tableRows }, ...conditionProperties,
    }, additionalProperties: false,
  },
] as const

export const MODULE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: MODULE_SCHEMA_ID,
  title: 'AllCrew Channel user module',
  description: 'A declarative, sandboxed plugin screen and command composition.',
  type: 'object',
  required: ['module', 'id', 'name', 'summary', 'version', 'screens'],
  properties: {
    $schema: { type: 'string' },
    module: { const: MODULE_FORMAT },
    id: { type: 'string', pattern: MODULE_ID_PATTERN.source, maxLength: MODULE_LIMITS.nameLength },
    name: { type: 'string', minLength: 1, maxLength: MODULE_LIMITS.nameLength },
    summary: { type: 'string', minLength: 1, maxLength: MODULE_LIMITS.textLength },
    version: { type: 'string', pattern: MODULE_VERSION_PATTERN.source },
    author: { type: 'string', maxLength: MODULE_LIMITS.nameLength },
    state: {
      type: 'object', maxProperties: MODULE_LIMITS.stateFields,
      propertyNames: { pattern: MODULE_SAFE_NAME_PATTERN.source },
      additionalProperties: { $ref: '#/$defs/stateField' },
    },
    screens: {
      type: 'object', required: ['main'],
      properties: { main: { $ref: '#/$defs/screen' }, settings: { $ref: '#/$defs/screen' } },
      additionalProperties: false,
    },
    commands: { type: 'array', maxItems: MODULE_LIMITS.commands, items: { $ref: '#/$defs/command' } },
  },
  additionalProperties: false,
  $defs: {
    condition,
    step,
    stateField: {
      oneOf: [
        {
          type: 'object', required: ['type', 'default'],
          properties: {
            type: { const: 'string' }, default: { type: 'string' }, label: { type: 'string' }, secret: { type: 'boolean' },
          },
          allOf: [{
            if: { properties: { secret: { const: true } }, required: ['secret'] },
            then: { properties: { default: { const: '' } } },
          }],
          additionalProperties: false,
        },
        {
          type: 'object', required: ['type', 'default'],
          properties: {
            type: { const: 'number' }, default: { type: 'number' }, label: { type: 'string' },
            min: { type: 'number' }, max: { type: 'number' },
          },
          additionalProperties: false,
        },
        {
          type: 'object', required: ['type', 'default'],
          properties: {
            type: { const: 'boolean' }, default: { type: 'boolean' }, label: { type: 'string' },
          },
          additionalProperties: false,
        },
      ],
    },
    screen: {
      type: 'object', required: ['blocks'],
      properties: { blocks: { type: 'array', maxItems: MODULE_LIMITS.blocksPerScreen, items: { oneOf: blocks } } },
      additionalProperties: false,
    },
    command: {
      type: 'object', required: ['name', 'summary', 'steps'],
      properties: {
        name: { type: 'string', pattern: MODULE_COMMAND_NAME_PATTERN.source, maxLength: MODULE_LIMITS.nameLength },
        summary: { type: 'string', minLength: 1, maxLength: MODULE_LIMITS.textLength },
        params: {
          type: 'array', maxItems: MODULE_LIMITS.stateFields,
          items: {
            type: 'object', required: ['name'],
            properties: {
              name: { type: 'string', pattern: MODULE_SAFE_NAME_PATTERN.source }, required: { type: 'boolean' },
              type: { type: 'string' }, shape: { type: 'string' }, note: { type: 'string' }, nested: { type: 'boolean' },
            }, additionalProperties: false,
          },
        },
        steps: { type: 'array', minItems: 1, maxItems: MODULE_LIMITS.stepsPerPipeline, items: { $ref: '#/$defs/step' } },
      }, additionalProperties: false,
    },
  },
} as const

export const MODULE_TEMPLATE = {
  $schema: MODULE_SCHEMA_ID,
  module: MODULE_FORMAT,
  id: 'my-team.notes',
  name: 'Team notes',
  summary: 'A small private panel for notes kept with this plugin installation.',
  version: '1.0.0',
  state: {
    note: { type: 'string', default: '', label: 'Note' },
    pinned: { type: 'boolean', default: false, label: 'Pinned' },
  },
  screens: {
    main: {
      blocks: [
        { block: 'heading', text: 'Team notes', icon: 'document', hint: 'A safe, declarative module' },
        { block: 'text', text: 'Module screens can collect state and compose commands already exposed by the plugin.' },
        { block: 'field', bind: 'note', label: 'Note', placeholder: 'Write a handoff…', multiline: true, rows: 5 },
        { block: 'toggle', bind: 'pinned', label: 'Pin this note' },
        { block: 'callout', text: 'Pinned for the next handoff.', tone: 'success', when: { from: 'pinned', equals: true } },
      ],
    },
  },
  commands: [],
} as const

export const MODULE_AUTHORING_GUIDE = {
  format: MODULE_FORMAT,
  schema: MODULE_SCHEMA_ID,
  execution: 'Modules are declarative. They can only call commands exposed by this plugin build.',
  permissions: 'Read/write access is derived from called commands and cannot be declared by a module.',
  state: 'Only declared scalar state persists. Step results stay in the current run view.',
  upgrades: 'Use SemVer. Compatible state migrates by name and type; removed or invalid fields are dropped.',
  limits: MODULE_LIMITS,
} as const

/** Prompt copied by the SDK builder screen. It carries the starter and authoring rules from this
 * build, while the agent fetches the full schema through the live bridge. */
export function moduleAgentPrompt(): string {
  return [
    'Create a custom screen for the AllCrew Channel Figma plugin using the AllCrew SDK module format.',
    '',
    'First ask me one concise question: what workflow should this screen automate? Then design the fields, controls and actions around my answer.',
    '',
    'Requirements:',
    '- Call `modules.schema` first to fetch the canonical JSON Schema for this build.',
    '- Return one valid module JSON document. Do not use arbitrary HTML, JavaScript, network calls or undeclared storage.',
    '- Use only commands exposed by this AllCrew Channel build.',
    '- Keep every capability explicit so the plugin can show its read/write review before installation.',
    '- Validate the draft with `plugin.call` using `{ \"command\": \"MODULE_INSPECT\", \"params\": { \"file\": <module JSON> } }`.',
    '- Do not call `modules.install` until I approve the capabilities returned by MODULE_INSPECT.',
    '- When validation passes, give me the final JSON file and a short explanation of the screen flow.',
    '',
    `Schema: ${MODULE_SCHEMA_ID}`,
    '',
    'Starter module:',
    JSON.stringify(MODULE_TEMPLATE, null, 2),
    '',
    'Authoring rules:',
    JSON.stringify(MODULE_AUTHORING_GUIDE, null, 2),
  ].join('\n')
}

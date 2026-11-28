/**
 * Agent listener — the two halves of a copy between files.
 *
 * A plugin sees one file. Copying a layer from one file into another therefore takes two of
 * them: `node.spec` reads the layer in the file it lives in as a portable spec — tokens by name,
 * components by library key, pictures as bytes — and `node.build` makes it in another file,
 * reads it back and says what did not survive. The bridge's `node.transfer` calls one and then
 * the other; these two are what it calls, and are callable on their own.
 *
 * Both are the panel commands NODE_SPEC / NODE_BUILD underneath, returned whole: the picture
 * bytes have to reach the other file, which a digest that spills them to disk would prevent.
 */

import type { OpDef } from './protocol.ts'
import { runCommandRaw } from './plugin-ops.ts'

const replyOf = (replies: unknown[], type: string): Record<string, unknown> => {
  const found = replies.find((reply) => (reply as { type?: unknown })?.type === type)
  if (!found) throw new Error(`the plugin answered without a ${type}`)
  const { type: _drop, ...rest } = found as Record<string, unknown>
  return rest
}

export const TRANSFER_OPS: readonly OpDef[] = [
  {
    name: 'node.spec',
    summary: 'A layer as a portable spec another file can build — tokens by name, components by library key, pictures as bytes.',
    agent:
      'The reading half of a copy between files; `node.transfer` (the bridge) calls this and then node.build. An instance of a LIBRARY ' +
      'component travels as its key; one whose main lives in this file (or is gone) comes across as the frame it shows, named ' +
      'in `detached` — `localComponents: "key"` sends the key instead, for a target that has this file as a library. Publish ' +
      'status is deliberately never asked: that call goes to the team library and, when it hangs, wedges the session. Pictures travel once each as base64 up to `budgetBytes` (2 MB); past it ' +
      'they are listed in `imagesSkipped`. `dropped` and `notValues` are what the spec could not carry at all — a gradient read ' +
      'as a summary, a mixed value. Read-only.',
    mutates: false,
    params: {
      nodes: { type: 'string[]', required: true, description: 'Ids of the layers to read.' },
      depth: { type: 'number', default: 6, min: 0, max: 12, description: 'Levels of children to carry — 0 is the layer alone.' },
      budgetBytes: { type: 'number', default: 2_000_000, min: 0, max: 2_500_000, description: 'Bytes of pictures one answer may carry.' },
      localComponents: {
        type: 'string',
        enum: ['frame', 'key'],
        default: 'frame',
        description: 'An instance of a component that lives in THIS file: "frame" brings it as the frame it shows; "key" sends the key, for a target that uses this file as a library.',
      },
    },
    async run(params) {
      return replyOf(
        await runCommandRaw('NODE_SPEC', { nodes: params.nodes, depth: params.depth, budgetBytes: params.budgetBytes, localComponents: params.localComponents }),
        'NODE_SPECS'
      )
    },
  },
  {
    name: 'node.build',
    summary: 'Build layers from node.spec\'s answer in this file, read them back, and report what did not survive.',
    agent:
      'The writing half of a copy between files. Pass node.spec\'s `nodes` and `images` as they came. Tokens resolve BY NAME, ' +
      'locally first and then in the libraries enabled here — a file without the same design system gets the copy, with the ' +
      'bindings it could not make in `failed`. Each node reports `diverged` (a property that came out different), `failed` (one ' +
      'the file refused) and `imagesMissing`. `parent` places the copies; the current page by default. One call is one undo step.',
    mutates: true,
    params: {
      nodes: { type: 'json', required: true, description: 'node.spec\'s `nodes`: [{ source, spec, before }].' },
      images: { type: 'json', description: 'node.spec\'s `images`: base64 by original hash.' },
      parent: { type: 'string', description: 'Frame, section or page to build into. The current page when omitted.' },
      ignore: { type: 'string[]', description: 'Properties to leave out of the comparison.' },
      dryRun: { type: 'boolean', default: false, description: 'Check every spec plans, building nothing.' },
    },
    async run(params) {
      return replyOf(
        await runCommandRaw('NODE_BUILD', { nodes: params.nodes, images: params.images, parent: params.parent, ignore: params.ignore, dryRun: params.dryRun }),
        'NODE_BUILT'
      )
    },
  },
]

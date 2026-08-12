/**
 * DESIGN.md — the agent-facing design contract shipped with every export.
 *
 * One writer per target: the artifact describes the package the user actually asked for
 * (token package vs. Django project), so an agent reading it never has to guess which files
 * exist or which rules apply.
 */

export { buildTokensDesignMd, type TokensDesignMdInput } from './tokens-target.ts'
export {
  buildDjangoDesignMd,
  type DjangoDesignMdInput,
  type DjangoDesignMdBootstrap,
  type DjangoDesignMdPackage,
  type DjangoDesignMdTokens,
} from './django-target.ts'
export { buildTokenAudit, auditGuardrails, type TokenAudit } from './audit.ts'
export {
  buildTokenModel,
  classifyRole,
  detectComponentBlocks,
  ROLE_INFO,
  type DesignTokenModel,
  type TokenEntry,
  type TokenRole,
} from './model.ts'

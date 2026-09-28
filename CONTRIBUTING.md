# Contributing

## Development setup

Requirements: Node.js 18 or newer, npm, Figma Desktop, and the `zip` command for release packaging.

```bash
npm ci
npm run build
npm test
```

In Figma Desktop, open **Plugins → Development → Import plugin from manifest…** and select this repository's `manifest.json`. Use `npm run dev` while changing plugin code.

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run package
```

Keep generated `dist/code.js` and `dist/ui.html` in sync with their sources. Do not commit pairing secrets, Figma tokens, exported customer files, `node_modules`, or Python `*.egg-info` metadata.

## Design and security constraints

- Agent access remains opt-in; read and write gates are separate.
- A development plugin has no stable `figma.fileKey`, so its grants must remain session-only.
- The local bridge listens on loopback by default.
- New external transfers must be explicit in the UI and documented in `SECURITY.md`.
- User modules remain declarative. Do not add arbitrary JavaScript execution to the module format.

Report vulnerabilities through GitHub Security Advisories rather than a public issue.

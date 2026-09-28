# Security policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability or include a Figma file, access token, pairing secret, exported package, or customer data in an issue.

Report security problems privately through GitHub Security Advisories:

https://github.com/mal4i6ka/allcrew-figma-plugin/security/advisories/new

Include the affected version, reproduction steps, impact, and whether the issue requires the Agent Listener, Delivery receiver, or REST fallback. You should receive an initial response within 7 days.

## Local trust model

AllCrew Figma Workspace is installed as a Figma development plugin and can read the open file through the Figma Plugin API. Optional features can move derived data outside Figma:

- **Agent Listener** connects to a user-run bridge on `127.0.0.1` by default. Read and write access are separate switches. For development-plugin installs, grants last only for the current plugin session because Figma does not expose a stable file key.
- **Delivery** sends the generated package only to the endpoint configured by the user.
- **REST fallback** uses a Figma token supplied by the user to the local bridge.

Never expose the bridge on a public interface. Treat `~/.allcrew-channel/agent-secret`, receiver secrets, and Figma tokens as credentials. Stop the listener before opening an untrusted file, and enable writes only while an intended automation is running.

## Supported versions

Security fixes are applied to the latest GitHub Release. Upgrade to the latest release before reporting an issue already fixed there.

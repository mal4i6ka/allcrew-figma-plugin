# Privacy and data handling

AllCrew Figma Workspace is a locally installed Figma development plugin. The project does not operate a hosted AllCrew service and does not collect telemetry.

## Data processed inside Figma

The plugin can read the file currently open in Figma through the Figma Plugin API, including variables, styles, layers, component metadata, prototype interactions, and assets needed for an explicit export or agent operation. Core processing happens inside the plugin runtime.

## Optional transfers

Data leaves Figma only through features the user configures and activates:

- **Downloads** save generated packages and assets to the user's machine.
- **Delivery** sends a generated package to the receiver endpoint entered by the user.
- **Agent Listener** sends operation results to the user-run local bridge. The bridge listens on loopback by default.
- **REST fallback** contacts Figma using a token configured on the user's machine when no plugin is connected.
- **Update discovery** contacts the public GitHub Releases API only when the user presses **Check now** or explicitly enables automatic discovery. Automatic discovery is off by default and runs at most once every 24 hours.

The repository owner does not receive these transfers. Retention and deletion at a configured receiver are controlled by the user who operates that receiver.

## Local credentials and settings

Plugin settings, including the update-discovery preference and last successful check, are stored with `figma.clientStorage`. Pairing secrets and Figma tokens are stored on the user's machine under `~/.allcrew-channel/` unless the user overrides those paths. Secrets are not included in release archives or generated design packages.

Development-plugin installs do not have a stable Figma file key. Agent read/write grants therefore last only for the current plugin session and are not restored by file name.

## Contact

Privacy questions and non-sensitive reports: https://github.com/mal4i6ka/allcrew-figma-plugin/issues

Security reports: https://github.com/mal4i6ka/allcrew-figma-plugin/security/advisories/new

# Design-to-site fidelity

The fidelity tool compares Figma frames with the web pages built from them and turns differences into actionable output: an HTML report, Figma comments, ticket drafts, and a list of CSS fixes.

## Run a comparison

Copy `fidelity/example.json`, rename it for your project, and replace every placeholder with your Figma file key, page URLs, frame node IDs, and any project-specific options.

```bash
cp fidelity/example.json fidelity/my-project.json
npm run fidelity -- --config fidelity/my-project.json
npm run fidelity -- --config fidelity/my-project.json --page "Home" --width 1440
npm run fidelity -- --config fidelity/my-project.json --base local
```

The tool needs a Figma personal access token and system Chrome. Set `FIGMA_TOKEN`, or put the token in `~/.allcrew-channel/figma-token` (the same convention used by the bridge and CLI). `FIGMA_TOKEN_FILE` can select a different file.

Figma does not need to be open for a comparison: the design is read through the REST API and cached by file version, so a rerun after a CSS change only captures the pages again. By default, output is written to `~/.allcrew-channel/fidelity/<project>/<time>/`:

- `report.html`: the interactive report;
- `findings.json`: machine-readable run metadata and differences used for delivery;
- design and page screenshots.

## What is checked

Text is the matching key because it exists in both the design and the page regardless of the implementation's HTML structure. Each design text layer can produce these findings:

| Type | Meaning |
| --- | --- |
| Style | Font size, weight, line height, tracking, colour, or family differs |
| Position | The alignment edge is displaced by more than 4px |
| Line wrapping | The line count differs, usually because the text box width differs |
| Vertical shift | The page starts drifting from the design at this point, often because an earlier section has the wrong height |
| Text in image | Design text is drawn into an image on the page, so it cannot be translated or edited |
| Missing from page | Content changed or the section has not been built |

Vertical shifts use text that is unique in both the design and the page as anchors. An extra 40px in one section therefore produces one finding rather than findings for every text below it. Short repeated labels are matched only near their expected position.

Style comparison skips mixed-style layers, where the node-level values describe only the first run; text inside scaled illustrations, which often has fractional font sizes; and multiline design layers implemented as lists.

## Deliver results

```bash
npm run fidelity:deliver -- tickets  --run <run-directory>
npm run fidelity:deliver -- fixes    --run <run-directory> --width 1440
npm run fidelity:deliver -- comments --run <run-directory> --page "Home" --width 1440
npm run fidelity:deliver -- comments --run <run-directory> --page "Home" --width 1440 --post
```

- **Tickets:** one for each component with a repeated style difference (up to the 15 most widespread) and one per page with structural differences. A repeated component location counts once even if it appears on several pages. Style tickets include the design specification: text style by width, size and line height, tracking in `em`, case, colour, width rules, and layers outside the design system. Token names and colour modes are available only through the AllCrew plugin. If the file is open in Figma with the plugin and the local bridge is running, delivery reads them through the bridge; otherwise the ticket says they were not read. Use `--tokens off` to skip the bridge. Results are cached in `design-specs.json` in the run directory.
- **Comments:** one comment per section, pinned to the frame at its first finding and marked `[fidelity]`. Nothing is posted unless `--post` is supplied.
- **Fixes:** `fixes.json` is a brief for CSS work, not a patch. Its selector identifies where the text appeared; the rule that sets the value may be on an ancestor.

Delivery resolves bridge credentials exactly like the CLI: `ALLCREW_CHANNEL_AGENT_URL` (default `http://127.0.0.1:8788`), `ALLCREW_CHANNEL_AGENT_SECRET`, or `ALLCREW_CHANNEL_AGENT_SECRET_FILE` (default `~/.allcrew-channel/agent-secret`).

## Project configuration

A configuration file contains the Figma file, named base URLs, ignored design layers, selectors to hide before measurement, and pages with one frame node ID per viewport width:

```json
{
  "project": "example.com",
  "fileKey": "YOUR_FIGMA_FILE_KEY",
  "bases": {
    "production": "https://example.com",
    "local": "http://127.0.0.1:8000"
  },
  "defaultBase": "production",
  "skipLayers": ["Status Bar"],
  "hide": ["#cookie-banner"],
  "pages": [
    {
      "name": "Home",
      "url": "/",
      "frames": { "1440": "0:1", "375": "0:2" }
    }
  ]
}
```

If a frame represents an interactive state, such as a selected tab or expanded panel, add a `setup` JavaScript string to that page. The helper `click('Label')` clicks the visible button, link, tab, or label with exactly that text before measurement.
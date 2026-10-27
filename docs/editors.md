# One plugin, five editors

The manifest names every editor Figma has: `figma`, `dev`, `figjam`, `slides` and `buzz`. It also asks for the `activeusers` permission (who is on a FigJam board) and the `fileusers` permission (who placed a stamp).

The Plugin API is not the same in each editor. This page compares them, using the "only available in …" notes in `@figma/plugin-typings` 1.142. Each row says where AllCrew reaches that part of the API. An op or a node kind used in the wrong editor fails with a message that names the editor it needs, for example `sticky needs FigJam — this file is open in Figma Design`. It does not fail with a missing constructor. `editor.capabilities` lists what the current file's editor allows.

## What is the same everywhere

The rest of the plugin is not tied to one editor:
- reading nodes (`node.get`, `node.tree`, `node.find`)
- the property vocabulary (`NODE_CREATE` / `NODE_SET`)
- paints, effects, text and runs
- variables and library reads
- export, plates and screenshots
- plugin data
- the agent channel itself

Frames, text, shapes, sections, instances of library components and SVG can be made in every editor that has a canvas.

## Editor-only API

| Area | Plugin API | Design | Dev | FigJam | Slides | Buzz | AllCrew |
|---|---|:-:|:-:|:-:|:-:|:-:|---|
| Components | `createComponent`, `createComponentFromNode`, `combineAsVariants` | ✓ | | | | | `NODE_CREATE kind: component`, `COMPONENT_MAKE`, `component.restore`, `GENERATE_KIT` |
| Local styles | `create{Paint,Text,Effect,Grid,CustomAnimation}Style`, `moveLocal*StyleAfter`, `moveLocal*FolderAfter` | ✓ | | | | | `STYLE_MAKE`, `STYLE_MOVE`, `MOTION_STYLE_SET`, `MOTION_STYLE_MOVE` |
| Measurements | `addMeasurement`, `editMeasurement`, `deleteMeasurement` | | ✓ | | | | `MEASURE_LIST`, `MEASURE_SET` |
| Codegen | `figma.codegen` | | ✓ | | | | the React codegen panel |
| Stickies | `createSticky`, `StickyNode.{text, isWideWidth, authorVisible, authorName}` | | | ✓ | | | `kind: sticky`; props `text`, `fontSize`, `fontName`, `wide`, `authorVisible`; reads `author` |
| Shapes with text | `createShapeWithText`, `shapeType` | | | ✓ | | | `kind: shapeWithText`; prop `shapeType` |
| Connectors | `createConnector`, `connectorStart/End`, `connectorLineType`, caps, `textBackground` | | | ✓ | | | `kind: connector`; prop `connector: { start, end, line, startCap, endCap, label }` |
| Code blocks | `createCodeBlock`, `code`, `codeLanguage` | | | ✓ | | | `kind: codeBlock`; props `code`, `codeLanguage` |
| Tables | `createTable`, `insert/remove/move/resize{Row,Column}`, `cellAt` | | | ✓ | | | `kind: table`; prop `table: { rows, columns, cells, columnWidths, rowHeights, moveRows, moveColumns }` |
| Link previews, GIFs | `createLinkPreviewAsync`, `createGif` | | | ✓ | | | `kind: linkPreview` / `gif`; reads `preview` (embed / unfurl data) |
| Sticking | `stuckTo`, `stuckNodes` | | | ✓ | | | prop `stuckTo`; `figjam.board nodeId` lists `stuckNodes` |
| Stamps | `StampNode.getAuthorAsync` (`fileusers`) | | | ✓ | | | reads `author` |
| Board session | `activeUsers` (`activeusers`), `timer` | | | ✓ | | | `figjam.board`, `figjam.timer` |
| Slides | `createSlide`, `createSlideRow`, `isSkippedSlide`, `get/setSlideTransition` | | | | ✓ | | `kind: slide` / `slideRow` (`at: [row, column]`); props `skipped`, `transition` |
| Slide grid | `getSlideGrid`, `setSlideGrid`, `focusedSlide`, `viewport.slidesView` | | | | ✓ | | `canvas.grid`, `canvas.arrange` |
| Canvas grid | `getCanvasGrid`, `setCanvasGrid`, `createCanvasRow`, `moveNodesToCoord`, `viewport.canvasView` | | | | ✓ | ✓ | `canvas.grid`, `canvas.arrange` |
| Focused node | `PageNode.focusedNode` | | ✓ | | ✓ | ✓ | `canvas.arrange focus`, `editor.capabilities` |
| Interactive slide elements | `interactiveSlideElementType` | | | | ✓ | | read as `interactive` |
| Buzz assets | `buzz.createFrame`, `buzz.createInstance`, `get/setBuzzAssetTypeForNode` | | | | | ✓ | `kind: asset` (`at`, optional `of` component); prop `assetType` |
| Buzz content | `buzz.getTextContent`, `getMediaContent`, `setValueAsync`, `setMediaAsync` | | | | | ✓ | `buzz.content`, `buzz.content.set` |
| Smart resize | `buzz.smartResize` | | | | | ✓ | `buzz.resize` |

All 45 editor-only members in the typings are reached. You can check this by looking for each name in `src/`.

## Deliberately not reached

- **Widgets:** `setWidgetSyncedState` and `cloneWidget`. Figma lets a widget's state be written only by the widget's own code (a node whose `widgetId` matches the caller's). AllCrew is not a widget, so the API would refuse every call. Reads report `widget: { id, state }`.
- **`ShapeWithTextNode.rescale`:** `width` / `height` already resize a shape, and scale is not a property that can be read back.
- **`StickyNode.authorName` as a write:** reads report who wrote a sticky. Setting it would forge authorship.

## What carries over between editors

The vocabulary is the same in every editor. A sticky reads as `{ text, wide, fill }` and is made from exactly that. A slide reads its transition in the words `transition` takes. A connector reads as what it joins. So `NODE_ROUNDTRIP` (read → create from the reading → compare) works on a board or a deck just as it does on a screen.

Stickies, connectors, code blocks and tables size themselves to their content and to what they join, so their size is compared and never sent back.

## Code layers (open beta, October 2026)

A code layer is a Figma Make project placed on a Design canvas. As of `@figma/plugin-typings` 1.142 the Plugin API does not document it. Measured live:

- **What the plugin sees.** The node has type `CODE_INSTANCE` and carries only geometry, visibility, lock, plugin data, dev resources and `exportAsync`. There is no source and no settings. Its export renders blank, and `node.probe` lists everything it has.
- **Undocumented methods.** It also has `createCanvasControl` and `get/add/edit/deleteRelatedLinkAsync`, which appear nowhere in the typings. They are not called.
- **Figma's MCP reads the source.** `get_design_context` on the node returns the project's files as resources (`src/App.tsx`, `package.json`, `vite.config.ts` and so on). The template is Vite 8, React 19, Tailwind 4 and TypeScript.
- **Figma's MCP creates layers.** `send_code_to_figma` imports a local project archive as a new code layer in a Design file.

So AllCrew can find and report code layers, but it cannot make or edit one through the plugin. `NODE_ROUNDTRIP` says so when it meets one.

### A frame as a code layer, from AllCrew's own export

A code layer built this way runs the code the design system exports: tokens as CSS variables, components as components. It is not code generated by Figma's agent from a picture of the frame. It takes three steps:

1. `EMIT_REACT` with `codeLayer: true` packs the export for Figma's importer:
   - the four `.figma/make` scripts (`install`, `dev`, `deploy-preview`, `deploy`), named in `executables`;
   - a Vite dev server on Figma's `$PORT`;
   - `src/App.tsx`, which renders the screen with its mock data;
   - no Code Connect files.
2. `node agent/code-layer.mjs <files.json> <new-dir> <archive>` writes the project, makes the scripts executable and archives it the way the importer requires. That means contents at the root, dotfiles kept, no links and no macOS `._*` files. An export made without the flag is packed here too.
3. Figma's MCP `send_code_to_figma` is called first without `upload` to get the archive path and the upload command. Then the upload command runs, and the import is called with the returned arguments. The import writes a new layer into the file.

Measured on 2026-10-27, with the "Altery Onboarding" frame of a real file (42 exported files): the import created layer `700:5686`, and `get_design_context` on it lists exactly the exported sources. Locally the project installs and `vite build` succeeds. Figma's own preview is only checked by opening the layer.

## Measured live

These were measured in real FigJam, Slides and Buzz files through the channel. Each one is handled in the code. They are listed here because the typings say nothing about them.

- **Stale grids.** `getSlideGrid` returns the grid as it was before a slide created moments earlier. Buzz's `getCanvasGrid` keeps a removed frame and then throws "does not exist" on every call. Both editors keep the same tree, `SLIDE_GRID` → `SLIDE_ROW` → slide or asset, so `canvas.grid` reads that tree. The API is only a fallback.
- **Connector labels.** Writing a connector's text resets its label background, so `connector.label` is applied after `text`. A new connector also has no font at all (`family: ""`); it gets Inter Medium, the board's default.
- **Code blocks.** A code block does not expose its font. A write that Figma refuses for an unloaded font loads the font named in the refusal and tries once more.
- **Read-only fields.** The corner radius of a FigJam shape or connector is read-only, so it is not part of the reading. A slide cannot be resized ("Cannot resize slide nodes"), so its size is compared and never sent.
- **Shape size.** FigJam shapes have `resize` but no `resizeWithoutConstraints`.
- **Dev resources.** `getDevResourcesAsync` exists in FigJam and Slides but takes tens of seconds to return nothing, so it is only called in Design and Dev Mode.
- **Theme variables in Slides.** Binding a slide's theme variable by name used to search every enabled library and took minutes. Library variables met while reading are now remembered, so writing the same name back is immediate.
- **Hot reload.** On a rebuild of `dist/`, Figma reloads the development plugin in Slides and Buzz but not in FigJam or Design files.

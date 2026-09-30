import * as esbuild from "esbuild";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractUiCommands } from "./src/agent/ui-commands.ts";
import { extractProps } from "./src/agent/props-vocabulary.ts";

const watch = process.argv.includes("--watch");
const PLUGIN_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;
const PLUGIN_VERSION_MARKER = "'__ALLCREW_PLUGIN_VERSION__'";

const commonOptions = {
  bundle: true,
  platform: "browser",
  target: "es2017",
  logLevel: "info",
};

/**
 * A designer installs this plugin from Figma — they have no checkout of this repo, so any
 * instruction of the form "run server/receiver.mjs" names a path that does not exist for them.
 * Inline the real scripts instead and let the plugin hand them over as downloads: one source
 * of truth, and a script can never be a different version than the plugin asking for it.
 *
 * The markers are quoted so the source tree keeps a valid (if useless) JS string and ui.html
 * stays readable and diffable on its own.
 */
const EMBEDS = [
  { marker: "'__ALLCREW_CHANNEL_BRIDGE_SOURCE__'", file: "agent/bridge.mjs" },
  { marker: "'__ALLCREW_CHANNEL_MCP_SOURCE__'", file: "agent/mcp.mjs" },
  { marker: "'__ALLCREW_CHANNEL_RECEIVER_SOURCE__'", file: "server/receiver.mjs" },
];

function copyUi() {
  let ui = readFileSync("ui.html", "utf8");
  for (const { marker, file } of EMBEDS) {
    if (!ui.includes(marker)) {
      // Loud, because the alternative is shipping a download button that writes an empty file.
      throw new Error(`ui.html no longer contains ${marker} — the ${file} download would ship empty`);
    }
    const embedded = JSON.stringify(readFileSync(file, "utf8")).replace(/<\/script/gi, "<\\/script");
    ui = ui.replace(marker, embedded);
  }
  const versionMarkers = ui.split(PLUGIN_VERSION_MARKER).length - 1;
  if (versionMarkers !== 1) {
    throw new Error(`ui.html contains ${PLUGIN_VERSION_MARKER} ${versionMarkers} time(s), expected exactly 1`);
  }
  ui = ui.replace(PLUGIN_VERSION_MARKER, JSON.stringify(PLUGIN_VERSION));
  writeFileSync("dist/ui.html", ui);
}

/**
 * The agent channel's view of the plugin's own commands, read off the switch that implements
 * them (see src/agent/ui-commands.ts). Done here, on every rebuild, so a `case` added to
 * code.ts is callable by an agent as soon as it is built — there is no registry to update and
 * no generated file that can fall behind.
 */
const UI_COMMANDS_MARKER = "'__ALLCREW_CHANNEL_UI_COMMANDS__'";
const PROPS_MARKER = "'__ALLCREW_CHANNEL_PROPS__'";

/**
 * Every non-test source, concatenated, as the dictionary the extractor resolves param types
 * against: a command that takes an `AnnotationFormState` can then say what one is, and the type
 * lives wherever it always lived rather than being restated for the agent's benefit.
 */
function typeSources(dir = "src") {
  let text = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) text += typeSources(path);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) text += `\n${readFileSync(path, "utf8")}`;
  }
  return text;
}

function injectUiCommands(source) {
  const commands = extractUiCommands(readFileSync("src/code.ts", "utf8"), typeSources());
  if (commands.length === 0) {
    // Loud: a silent empty table would ship a channel that reports the plugin has no features.
    throw new Error("no UI commands extracted from src/code.ts — the message handler moved or its shape changed");
  }
  const occurrences = source.split(UI_COMMANDS_MARKER).length - 1;
  if (occurrences !== 1) {
    // Exactly one, so there is no question which literal the injection lands on.
    throw new Error(
      `ui-commands.ts contains ${UI_COMMANDS_MARKER} ${occurrences} time(s), expected exactly 1 — the agent channel would ship an empty or wrong command table`
    );
  }
  const unclassified = commands.filter((command) => !command.classified).map((command) => command.name);
  if (unclassified.length > 0) {
    // Not fatal — an unmarked command still works, it just costs the write gate. Worth a line
    // in the build log so the marker gets added while the case is fresh.
    console.log(`[agent] ${unclassified.length} command(s) with no @agent marker, treated as writes: ${unclassified.join(", ")}`);
  }
  console.log(`[agent] ${commands.length} plugin commands exposed to the listener`);
  return source.replace(UI_COMMANDS_MARKER, JSON.stringify(JSON.stringify(commands)));
}

/**
 * The same trick as the command table, one level down: the property vocabulary is read out of
 * `props.ts` so the channel cannot describe a stale half of it.
 */
function injectProps(source) {
  const props = extractProps(readFileSync("src/canvas/props.ts", "utf8"));
  if (props.length === 0) {
    throw new Error("no properties extracted from src/canvas/props.ts — the NodeProps interface moved or its shape changed");
  }
  const occurrences = source.split(PROPS_MARKER).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `props-vocabulary.ts contains ${PROPS_MARKER} ${occurrences} time(s), expected exactly 1 — the channel would describe an empty vocabulary`
    );
  }
  const undocumented = props.filter((entry) => !entry.note).map((entry) => entry.name);
  if (undocumented.length > 0) {
    console.log(`[agent] ${undocumented.length} propert(ies) with no sentence above them: ${undocumented.join(", ")}`);
  }
  console.log(`[agent] ${props.length} node properties exposed to the listener`);
  return source.replace(PROPS_MARKER, JSON.stringify(JSON.stringify(props)));
}

/**
 * Отказ сборки, если в бандл попало выражение `import(`.
 *
 * Песочница Figma сканирует код плагина и отклоняет его целиком с
 * «SyntaxError: possible import expression rejected around line 1» — плагин
 * просто не запускается, канал молчит, и по симптому это неотличимо от
 * закрытого окна. Стоило одной строки в ОПИСАНИИ параметра («ids to import (a
 * bare string…»): проверка смотрит на текст, а не на код, поэтому попасться
 * может любая строка справки. Дешевле поймать здесь, чем в Figma.
 *
 * `import {` не проверяется: статические импорты в шаблонах генераторов кода
 * песочница пропускает, их в бандле много и они безобидны.
 */
function refuseImportExpressions(file) {
  const source = readFileSync(file, "utf8");
  const pattern = /(^|[^.\w$])import\s*\(/g;
  const hits = [...source.matchAll(pattern)];
  if (hits.length === 0) return;
  console.error(`\n${file}: выражений import( — ${hits.length}. Песочница Figma отклонит бандл целиком.`);
  for (const hit of hits.slice(0, 5)) {
    const around = source.slice(Math.max(0, hit.index - 120), hit.index + 80).replace(/\n/g, " ");
    console.error(`  …${around}`);
  }
  process.exit(1);
}

const mainCtx = await esbuild.context({
  ...commonOptions,
  entryPoints: ["src/code.ts"],
  outfile: "dist/code.js",
  plugins: [
    {
      name: "inject-ui-commands",
      setup(build) {
        build.onLoad({ filter: /src[\\/]agent[\\/]ui-commands\.ts$/ }, (args) => ({
          contents: injectUiCommands(readFileSync(args.path, "utf8")),
          loader: "ts",
        }));
      },
    },
    {
      name: "inject-props",
      setup(build) {
        build.onLoad({ filter: /src[\\/]agent[\\/]props-vocabulary\.ts$/ }, (args) => ({
          contents: injectProps(readFileSync(args.path, "utf8")),
          loader: "ts",
        }));
      },
    },
    {
      name: "copy-ui-html",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) copyUi();
        });
      },
    },
  ],
});

if (watch) {
  await mainCtx.watch();
  console.log("Watching for changes...");
} else {
  await mainCtx.rebuild();
  await mainCtx.dispose();
  refuseImportExpressions("dist/code.js");
}

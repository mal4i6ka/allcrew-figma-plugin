import * as esbuild from "esbuild";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractUiCommands } from "./src/agent/ui-commands.ts";

const watch = process.argv.includes("--watch");

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
  { marker: "'__ALTERY_BRIDGE_SOURCE__'", file: "agent/bridge.mjs" },
  { marker: "'__ALTERY_RECEIVER_SOURCE__'", file: "server/receiver.mjs" },
];

function copyUi() {
  let ui = readFileSync("ui.html", "utf8");
  for (const { marker, file } of EMBEDS) {
    if (!ui.includes(marker)) {
      // Loud, because the alternative is shipping a download button that writes an empty file.
      throw new Error(`ui.html no longer contains ${marker} — the ${file} download would ship empty`);
    }
    ui = ui.replace(marker, JSON.stringify(readFileSync(file, "utf8")));
  }
  writeFileSync("dist/ui.html", ui);
}

/**
 * The agent channel's view of the plugin's own commands, read off the switch that implements
 * them (see src/agent/ui-commands.ts). Done here, on every rebuild, so a `case` added to
 * code.ts is callable by an agent as soon as it is built — there is no registry to update and
 * no generated file that can fall behind.
 */
const UI_COMMANDS_MARKER = "'__ALTERY_UI_COMMANDS__'";

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
}

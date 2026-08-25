import * as esbuild from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

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

const mainCtx = await esbuild.context({
  ...commonOptions,
  entryPoints: ["src/code.ts"],
  outfile: "dist/code.js",
  plugins: [
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

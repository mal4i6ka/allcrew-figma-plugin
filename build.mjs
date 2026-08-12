import * as esbuild from "esbuild";
import { copyFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

const commonOptions = {
  bundle: true,
  platform: "browser",
  target: "es2017",
  logLevel: "info",
};

function copyUi() {
  copyFileSync("ui.html", "dist/ui.html");
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

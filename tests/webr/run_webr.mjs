// Run R scripts against the project's R/ code in webR (R compiled to
// WebAssembly) -- for machines without an R installation. Base R only: the
// compiled packages the code imports (openssl, xml2, jsonlite) are replaced
// by tests/webr/shims.R; Shiny/htmltools code is syntax-checked, not run.
//
//   cd tests/webr && npm install webr@0.6.0      (once, ~40 MB)
//   node tests/webr/run_webr.mjs tests/webr/test-karaoke.R [more.R ...]
//   RS_WEBR_MOUNTS=/tmp/biglib=/biglib node tests/webr/run_webr.mjs tests/perf/library_bench.R
//
// The project root is mounted at /work (also the working directory). Exit
// status 1 if any script signals an error.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const dist = process.env.WEBR_DIST || path.join(here, "node_modules", "webr", "dist");
if (!fs.existsSync(path.join(dist, "R.wasm"))) {
  console.error(`webR not found at ${dist}: run 'npm install webr@0.6.0' in tests/webr (or set WEBR_DIST).`);
  process.exit(2);
}
const { WebR } = await import(path.join(dist, "webr.mjs"));
const webR = new WebR({ baseUrl: dist + "/", interactive: false });
await webR.init();
await webR.FS.mkdir("/work");
await webR.FS.mount("NODEFS", { root }, "/work");
// extra folders, e.g. a big song library: RS_WEBR_MOUNTS="/tmp/biglib=/biglib,/data=/data"
for (const spec of (process.env.RS_WEBR_MOUNTS || "").split(",").filter(Boolean)) {
  const [from, to] = spec.split("=");
  await webR.FS.mkdir(to);
  await webR.FS.mount("NODEFS", { root: path.resolve(from) }, to);
}

const prelude = `
  setwd("/work")
  options(warn = 1, rockshiny.root = "/work", rockshiny.cache_dir = file.path(tempdir(), "rs-cache"))
  source("tests/webr/shims.R")
  for (f in list.files("R", pattern = "[.]R$", full.names = TRUE)) sys.source(f, envir = globalenv())
`;
let failed = false;
const shelter = await new webR.Shelter();
for (const file of process.argv.slice(2)) {
  // the script text is passed in (it may live outside the mounted project); R reports
  // its own conditions, so nothing but text crosses into JS
  const body = fs.readFileSync(file, "utf8");
  const code = `.rs_failed <- FALSE\n` + prelude + `\n.rs_script <- ${JSON.stringify(body)}\n` +
    `withCallingHandlers(
       tryCatch(eval(parse(text = .rs_script, keep.source = FALSE), envir = globalenv()),
                error = function(e) { cat("Error: ", conditionMessage(e), "\\n", sep = "", file = stderr()); .rs_failed <<- TRUE }),
       warning = function(w) { cat("Warning: ", conditionMessage(w), "\\n", sep = "", file = stderr()); invokeRestart("muffleWarning") },
       message = function(m) { cat(conditionMessage(m), file = stderr()); invokeRestart("muffleMessage") })
     invisible(.rs_failed)`;
  const res = await shelter.captureR(code, { withAutoprint: false, captureStreams: true, captureConditions: false });
  for (const o of res.output) {
    if (o.type === "stdout") console.log(o.data);
    else if (o.type === "stderr") console.error(o.data);
  }
  if (await res.result.toBoolean()) failed = true;
}
await shelter.purge();
process.exit(failed ? 1 : 0);

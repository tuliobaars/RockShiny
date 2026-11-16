// Load the Creator engine into this Node process (globalThis.RSCreator), with
// Node's zlib as the (synchronous) inflate/deflate implementation.
const fs = require("fs"), path = require("path"), vm = require("vm"), zlib = require("zlib");
const ENGINE = path.resolve(__dirname, "..", "..", "inst", "engine");
const ORDER = ["rsc-core.js", "rsc-aes.js", "rsc-psarc.js", "rsc-xml.js", "rsc-sng.js", "rsc-arrangement.js", "rsc-compile.js", "rsc-vocals.js",
  "rsc-manifest.js", "rsc-codebooks.js", "rsc-wem.js", "rsc-dds.js", "rsc-project.js", "rsc-difficulty.js", "rsc-demo.js", "rsc-dsp.js", "rsc-beats.js", "rsc-sync.js", "rsc-voice.js", "rsc-transcribe.js", "rsc-stems.js"];
function load(files = ORDER) {
  for (const f of files) {
    const p = path.join(ENGINE, f);
    if (!fs.existsSync(p)) continue;
    vm.runInThisContext(fs.readFileSync(p, "utf8"), { filename: p });
  }
  const E = globalThis.RSCreator.engine;
  E.zlibImpl = { inflate: (u8) => new Uint8Array(zlib.inflateSync(u8)), deflate: (u8) => new Uint8Array(zlib.deflateSync(u8)) };
  return globalThis.RSCreator;
}
module.exports = { load, ROOT: path.resolve(__dirname, "..", "..", ".."), SONGS: path.resolve(__dirname, "..", "..", "..", "songs") };

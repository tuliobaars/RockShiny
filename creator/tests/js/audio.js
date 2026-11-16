// Decode a song's audio for the DSP tests: .wem -> Ogg (the engine) -> PCM (ffmpeg).
const { execFileSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
function haveFfmpeg() { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch (e) { return false; } }
async function songAudio(E, psarcBytes, opts) {
  opts = opts || {};
  const sr = opts.sr || 22050, ch = opts.channels || 1;
  const a = await E.psarcOpen(psarcBytes);
  const banks = a.find(/\.bnk$/).filter((b) => !/_preview/.test(b));
  const ids = E.bankWemIds(await a.read(banks[0]));
  const wem = await a.read(a.find(new RegExp(ids[0] + "\\.wem$"))[0]);
  const play = E.wemToPlayable(wem);
  const tmp = path.join(os.tmpdir(), "rsc-" + process.pid + "-" + Math.random().toString(36).slice(2) + (play.mime === "audio/ogg" ? ".ogg" : ".wav"));
  fs.writeFileSync(tmp, play.bytes);
  const args = ["-v", "error", "-i", tmp, "-f", "f32le", "-ac", String(ch), "-ar", String(sr)];
  if (opts.start) args.splice(2, 0, "-ss", String(opts.start));
  if (opts.duration) args.push("-t", String(opts.duration));
  const raw = execFileSync("ffmpeg", args.concat(["-"]), { maxBuffer: 2 ** 31 });
  fs.unlinkSync(tmp);
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const out = [];
  for (let c = 0; c < ch; c++) { const x = new Float32Array(all.length / ch); for (let i = 0; i < x.length; i++) x[i] = all[i * ch + c]; out.push(x); }
  return { channels: out, sr };
}
module.exports = { songAudio, haveFfmpeg };

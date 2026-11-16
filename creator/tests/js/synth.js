// A synthetic song with known stems, played from a real chart (for measuring the separation).
// Guitar / bass: Karplus-Strong plucked strings at the charted notes; drums on the beat grid;
// a formant "voice" on the lyric syllables (centre), guitar left, hats right.
"use strict";
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function pluck(out, sr, t0, hz, dur, amp, bright, pan, rand) {
  const n0 = Math.floor(t0 * sr), len = Math.floor(Math.min(dur + 0.3, 6) * sr), p = Math.max(2, Math.round(sr / hz));
  const buf = new Float32Array(p); for (let i = 0; i < p; i++) buf[i] = rand() * 2 - 1;
  let idx = 0; const decay = 0.996 + 0.0035 * Math.min(1, dur / 2);
  const gl = amp * Math.cos((pan + 1) * Math.PI / 4), gr = amp * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < len; i++) {
    const j = n0 + i; if (j >= out[0].length) break;
    const cur = buf[idx], nxt = buf[(idx + 1) % p];
    const v = cur; buf[idx] = decay * (bright * cur + (1 - bright) * nxt);
    idx = (idx + 1) % p;
    const env = i < len - 0.05 * sr ? 1 : (len - i) / (0.05 * sr);
    if (j >= 0) { out[0][j] += v * gl * env; out[1][j] += v * gr * env; }
  }
}
function drums(out, sr, beats, rand, end) {
  for (let b = 0; b < beats.length; b++) {
    const t = beats[b].time; if (t > end) break;
    const beatInBar = b % 4, n0 = Math.floor(t * sr);
    if (beatInBar === 0 || beatInBar === 2) for (let i = 0; i < 0.18 * sr; i++) { const j = n0 + i; if (j >= out[0].length) break; const tt = i / sr; const f = 50 + 70 * Math.exp(-tt * 25); const v = 0.7 * Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 18); out[0][j] += v; out[1][j] += v; }
    if (beatInBar === 1 || beatInBar === 3) { let lp = 0; for (let i = 0; i < 0.15 * sr; i++) { const j = n0 + i; if (j >= out[0].length) break; const nz = rand() * 2 - 1; lp = 0.6 * lp + 0.4 * nz; const v = 0.35 * (nz - lp) * Math.exp(-i / sr * 25); out[0][j] += v; out[1][j] += v; } }
    const nb = b + 1 < beats.length ? beats[b + 1].time : t + 0.5;
    for (const ht of [t, (t + nb) / 2]) { const h0 = Math.floor(ht * sr); let prev = 0; for (let i = 0; i < 0.04 * sr; i++) { const j = h0 + i; if (j >= out[0].length) break; const nz = rand() * 2 - 1; const v = 0.12 * (nz - prev) * Math.exp(-i / sr * 90); prev = nz; out[0][j] += v * 0.3; out[1][j] += v; } }
  }
}
function voice(out, sr, syl, rand) {
  const formants = [[730, 1090, 2440], [270, 2290, 3010], [530, 1840, 2480], [570, 840, 2410], [300, 870, 2240]];
  let k = 0;
  for (const s of syl) {
    const n0 = Math.floor(s.time * sr), len = Math.floor(Math.max(0.12, s.length) * sr);
    const f0 = 196 * Math.pow(2, ((k * 5) % 12) / 12), F = formants[k % formants.length]; k++;
    let ph = 0, y = [0, 0, 0], y2 = [0, 0, 0];
    for (let i = 0; i < len; i++) {
      const j = n0 + i; if (j >= out[0].length) break;
      const vib = 1 + 0.01 * Math.sin(2 * Math.PI * 5.5 * i / sr);
      ph += f0 * vib / sr; const src = (ph % 1) < 0.5 ? 1 : -1;   // pulse
      let v = 0;
      for (let q = 0; q < 3; q++) {                                 // resonators
        const r = Math.exp(-Math.PI * 90 / sr), th = 2 * Math.PI * F[q] / sr;
        const o = src + 2 * r * Math.cos(th) * y[q] - r * r * y2[q]; y2[q] = y[q]; y[q] = o; v += o * (q === 0 ? 1 : 0.5);
      }
      const env = Math.min(1, i / (0.02 * sr), (len - i) / (0.03 * sr));
      const o = 0.02 * v * env; out[0][j] += o; out[1][j] += o;
    }
  }
}
function makeSong(project, seconds, sr) {
  const n = Math.floor(seconds * sr), rand = rng(42);
  const mk = () => [new Float32Array(n), new Float32Array(n)];
  const st = { guitar: mk(), bass: mk(), drums: mk(), vocals: mk() };
  const STANDARD = [40, 45, 50, 55, 59, 64];
  for (const a of project.arrangements) {
    if (a.kind === "rhythm") continue;
    const d = a.doc, lv = d.levels[0], bass = a.kind === "bass";
    const midi = (s, f) => STANDARD[s] + (d.tuning[s] || 0) + f - (bass ? 12 : 0) + (d.centOffset || 0) / 100;
    const play = (s, f, t, sus) => { if (t > seconds) return; const hz = 440 * Math.pow(2, (midi(s, f) - 69) / 12); pluck(bass ? st.bass : st.guitar, sr, t, hz, Math.max(sus, 0.3), bass ? 0.45 : 0.3, bass ? 0.15 : 0.5, bass ? 0 : -0.45, rand); };
    for (const nn of lv.notes) if (!nn.mute) play(nn.string, nn.fret, nn.time, nn.sustain);
    for (const c of lv.chords) { const tp = d.chordTemplates[c.chordId]; if (tp) tp.frets.forEach((f, s) => { if (f >= 0) play(s, f, c.time, 0.5); }); }
  }
  drums(st.drums, sr, project.beats, rand, seconds);
  // an uncharted part (keys): an organ pad, a new chord every bar, slightly right
  st.other = mk();
  const chords = [[57, 61, 64], [55, 59, 62], [53, 57, 60], [52, 55, 59]];
  const downs = project.beats.filter((b) => b.measure >= 0).map((b) => b.time).filter((t) => t < seconds);
  downs.forEach((t, i) => {
    const end = i + 1 < downs.length ? downs[i + 1] : seconds, ch = chords[i % chords.length];
    for (let j = Math.floor(t * sr); j < Math.min(n, Math.floor(end * sr)); j++) {
      const tt = j / sr - t; let v = 0;
      for (const m of ch) { const hz = 440 * Math.pow(2, (m - 69) / 12); v += Math.sin(2 * Math.PI * hz * tt) + 0.3 * Math.sin(4 * Math.PI * hz * tt); }
      const env = Math.min(1, tt / 0.08, (end - j / sr) / 0.08);
      st.other[0][j] += 0.6 * v * env; st.other[1][j] += 0.9 * v * env;
    }
  });
  voice(st.vocals, sr, (project.vocals && project.vocals.syllables || []).filter((s) => s.time < seconds), rand);
  // balance: each stem to a target RMS (a plausible mix: voice and guitar up front)
  const target = { vocals: 0.07, guitar: 0.06, bass: 0.06, drums: 0.05, other: 0.035 };
  for (const k of Object.keys(st)) {
    let e = 0, c = 0;
    for (const ch of st[k]) for (let i = 0; i < n; i++) if (ch[i] !== 0) { e += ch[i] * ch[i]; c++; }
    const g = c ? target[k] / Math.sqrt(e / c) : 1;
    for (const ch of st[k]) for (let i = 0; i < n; i++) ch[i] *= g;
  }
  const mix = mk();
  for (const k of Object.keys(st)) for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) mix[c][i] += st[k][c][i];
  return { mix, stems: st, sr };
}
module.exports = { makeSong };

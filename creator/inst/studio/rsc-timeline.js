/* ---------------------------------------------------------------------------
 * rsc-timeline.js -- the studio's timeline: drawing every lane on the canvas,
 * hit testing, and the edits the pointer and the keyboard make (move, resize,
 * draw, erase, marquee, nudge, quantize, techniques, copy / paste).
 *
 * Charts are drawn like tablature: one row per string (the high string on top),
 * notes in their string's colour (RockShiny's highway colours) with the fret
 * number, sustains as tails, chords framed with their name, techniques as marks.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const RSC = root.RSCreator, E = RSC.engine;
  const COLORS = RSC.STRING_COLORS;
  const TOP = 20, ROW = 15;
  const lowerBound = (arr, t, key) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][key] < t) lo = m + 1; else hi = m; } return lo; };
  const r3 = (v) => Math.round(v * 1000) / 1000;

  // ---- geometry ----------------------------------------------------------------------------------
  const rowY = (lane, s) => lane.y + TOP + (lane.strings - 1 - s) * ROW;
  const rowOf = (lane, y) => { const r = Math.floor((y - lane.y - TOP) / ROW); return r < 0 || r >= lane.strings ? -1 : lane.strings - 1 - r; };
  const headW = (fret) => (fret >= 10 ? 20 : 16);
  const arrOf = (st, lane) => st.project.arrangements[lane.arr];
  const levelOf = (st, lane) => arrOf(st, lane).doc.levels[0];
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  const techLabel = (n) => {
    const t = [];
    if (n.hammerOn) t.push("H"); if (n.pullOff) t.push("P"); if (n.tap) t.push("T"); if (n.palmMute) t.push("PM"); if (n.mute) t.push("X");
    if (n.harmonic) t.push("\u25c7"); if (n.harmonicPinch) t.push("PH"); if (n.vibrato) t.push("~"); if (n.tremolo) t.push("\u2248");
    if (n.accent) t.push(">"); if (n.bend > 0) t.push("\u2197" + (n.bend % 1 ? n.bend.toFixed(1) : n.bend));
    if (n.linkNext) t.push("\u2040");
    return t.join(" ");
  };
  RSC.techLabel = techLabel;

  // ---- drawing -----------------------------------------------------------------------------------
  RSC.drawTimeline = function (st) {
    const g = st.canvas.getContext("2d"), W = st.W, H = st.H, p = st.project;
    g.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const ta = st.t(-40), tb = st.t(W + 40);
    // lane backgrounds
    st.lanes.forEach((l, i) => {
      g.fillStyle = l.kind === "ruler" ? "rgba(255,255,255,0.025)" : i % 2 ? "rgba(255,255,255,0.012)" : "rgba(0,0,0,0.0)";
      g.fillRect(0, l.y, W, l.h);
      if (st.sel.lane === l.id) { g.fillStyle = "rgba(245,165,36,0.035)"; g.fillRect(0, l.y, W, l.h); }
      g.fillStyle = "rgba(255,255,255,0.05)"; g.fillRect(0, l.y + l.h - 1, W, 1);
    });
    // beat grid across the lanes
    const beats = p.beats, gridTop = st.lanes[1] ? st.lanes[1].y : 0;
    const bi0 = Math.max(0, lowerBound(beats, ta, "time") - 1), bi1 = Math.min(beats.length, lowerBound(beats, tb, "time") + 1);
    const beatPx = beats.length > 1 ? (beats[Math.min(beats.length - 1, bi0 + 1)].time - beats[bi0].time) * st.view.pps : 40;
    for (let i = bi0; i < bi1; i++) {
      const b = beats[i], x = Math.round(st.x(b.time)) + 0.5;
      const down = b.measure >= 0;
      if (!down && beatPx < 6) continue;
      g.fillStyle = down ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.045)";
      g.fillRect(x - 0.5, gridTop, 1, H - gridTop);
      if (st.snap > 1 && i + 1 < beats.length && beatPx / st.snap > 14) {
        const step = (beats[i + 1].time - b.time) / st.snap;
        g.fillStyle = "rgba(255,255,255,0.022)";
        for (let k = 1; k < st.snap; k++) g.fillRect(Math.round(st.x(b.time + k * step)), gridTop, 1, H - gridTop);
      }
    }
    for (const l of st.lanes) {
      g.save(); g.beginPath(); g.rect(0, l.y, W, l.h); g.clip();
      if (l.kind === "ruler") drawRuler(st, g, l, ta, tb);
      else if (l.kind === "sections") drawSections(st, g, l, ta, tb);
      else if (l.kind === "beats") drawBeats(st, g, l, bi0, bi1);
      else if (l.kind === "wave") drawWave(st, g, l);
      else if (l.kind === "arr") drawArr(st, g, l, ta, tb);
      else if (l.kind === "vocals") drawVocals(st, g, l, ta, tb);
      g.restore();
    }
  };

  function drawRuler(st, g, l, ta, tb) {
    const pps = st.view.pps, steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const step = steps.find((s) => s * pps >= 70) || 300;
    g.font = "600 10.5px Inter, system-ui, sans-serif"; g.textBaseline = "middle";
    for (let t = Math.floor(ta / step) * step; t <= tb; t += step) {
      const x = Math.round(st.x(t)) + 0.5;
      g.fillStyle = "rgba(255,255,255,0.25)"; g.fillRect(x - 0.5, l.y + l.h - 8, 1, 8);
      if (t >= 0) {
        const m = Math.floor(t / 60), sec = t - 60 * m;
        const label = m + ":" + (step < 1 ? sec.toFixed(step < 0.25 ? 2 : 1).padStart(step < 0.25 ? 5 : 4, "0") : String(Math.round(sec)).padStart(2, "0"));
        g.fillStyle = "rgba(232,234,241,0.55)"; g.fillText(label, x + 4, l.y + 9);
      }
    }
    const b = st.project.beats;
    g.fillStyle = "rgba(245,165,36,0.85)"; g.font = "700 10px Inter, system-ui, sans-serif";
    let lastX = -1e9;
    for (let i = Math.max(0, lowerBound(b, ta, "time") - 1); i < b.length && b[i].time <= tb; i++) {
      if (b[i].measure < 0) continue;
      const x = st.x(b[i].time);
      if (x - lastX < 26) continue;
      lastX = x;
      g.fillText(String(b[i].measure), x + 3, l.y + l.h - 8);
    }
  }

  function drawSections(st, g, l, ta, tb) {
    const S = st.project.sections, d = st.duration();
    g.font = "700 11px Inter, system-ui, sans-serif"; g.textBaseline = "middle";
    S.forEach((s, i) => {
      const end = i + 1 < S.length ? S[i + 1].startTime : d;
      if (end < ta || s.startTime > tb) return;
      const x0 = st.x(s.startTime), x1 = st.x(end), col = RSC.sectionColor(s.name);
      const sel = st.sel.kind === "section" && st.isSelected(s);
      g.fillStyle = col; g.globalAlpha = sel ? 0.55 : 0.3;
      rr(g, x0 + 1, l.y + 3, Math.max(2, x1 - x0 - 2), l.h - 6, 5); g.fill();
      g.globalAlpha = 1;
      g.fillStyle = col; g.fillRect(x0, l.y + 3, 3, l.h - 6);
      if (sel) { g.strokeStyle = "#fff"; g.lineWidth = 1.5; rr(g, x0 + 1, l.y + 3, Math.max(2, x1 - x0 - 2), l.h - 6, 5); g.stroke(); }
      if (x1 - x0 > 30) {
        g.fillStyle = "#fff";
        const label = s.name.charAt(0).toUpperCase() + s.name.slice(1) + " " + s.number;
        g.save(); g.beginPath(); g.rect(x0, l.y, x1 - x0 - 4, l.h); g.clip();
        g.fillText(label, Math.max(x0 + 8, 6), l.y + l.h / 2);
        g.restore();
      }
    });
  }

  function drawBeats(st, g, l, bi0, bi1) {
    const b = st.project.beats;
    g.textBaseline = "middle"; g.font = "600 9.5px Inter, system-ui, sans-serif";
    let lastBpm = null, lastLabelX = -1e9;
    for (let i = bi0; i < bi1; i++) {
      const x = st.x(b[i].time), down = b[i].measure >= 0, sel = st.sel.kind === "beat" && st.isSelected(b[i]);
      g.fillStyle = sel ? "#fff" : down ? "rgba(245,165,36,0.95)" : "rgba(210,216,230,0.5)";
      g.fillRect(Math.round(x) - (down ? 1 : 0.5), l.y + (down ? 3 : 10), down ? 2 : 1, l.h - (down ? 6 : 16));
      if (sel || down) { g.beginPath(); g.arc(x, l.y + l.h - 6, sel ? 3.5 : 2.5, 0, Math.PI * 2); g.fill(); }
      if (i + 1 < b.length && st.view.pps > 40) {
        const bpm = 60 / (b[i + 1].time - b[i].time);
        if (lastBpm == null || Math.abs(bpm - lastBpm) > 2) {
          if (x - lastLabelX > 110) {
            g.fillStyle = "rgba(143,211,255,0.85)";
            g.fillText(bpm.toFixed(bpm < 100 ? 1 : 0) + " bpm", x + 4, l.y + 9);
            lastLabelX = x;
          }
          lastBpm = bpm;
        }
      }
    }
  }

  function drawWave(st, g, l) {
    const pk = st.audio.peaks && st.audio.peaks[l.audio];
    const mid = l.y + l.h / 2, amp = l.h * 0.46;
    g.fillStyle = "rgba(255,255,255,0.05)"; g.fillRect(0, Math.round(mid), st.W, 1);
    if (!pk) {
      g.fillStyle = "rgba(232,234,241,0.35)"; g.font = "600 11px Inter, system-ui, sans-serif"; g.textBaseline = "middle";
      g.fillText(l.stem ? "" : "No audio", 10, mid);
      return;
    }
    const lane = st.audio.lanes[l.audio] || {}, anySolo = Object.values(st.audio.lanes).some((x) => x.solo);
    const silent = lane.mute || (anySolo && !lane.solo);
    const sr = st.audio.stems && l.stem ? st.audio.stems.sr : st.audio.sr, block = 256;
    const off = l.stem && st.audio.stems ? st.audio.stems.start || 0 : 0;
    const n = pk.length / 2;
    g.fillStyle = l.color; g.globalAlpha = silent ? 0.25 : 0.85;
    for (let x = 0; x < st.W; x++) {
      const t0 = st.t(x) - off, t1 = st.t(x + 1) - off;
      let a = Math.floor(t0 * sr / block), b = Math.ceil(t1 * sr / block);
      if (b <= 0 || a >= n) continue;
      a = Math.max(0, a); b = Math.min(n, Math.max(b, a + 1));
      let lo = 0, hi = 0;
      for (let i = a; i < b; i++) { if (pk[2 * i] < lo) lo = pk[2 * i]; if (pk[2 * i + 1] > hi) hi = pk[2 * i + 1]; }
      const y0 = mid - Math.min(1, hi * 1.6) * amp, y1 = mid - Math.max(-1, lo * 1.6) * amp;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    g.globalAlpha = 1;
  }

  function drawArr(st, g, l, ta, tb) {
    const a = arrOf(st, l), d = a.doc, lv = d.levels[0], n = l.strings;
    if (l.collapsed) {
      g.fillStyle = "rgba(31,156,240,0.55)";
      for (const x of lv.notes) if (x.time >= ta && x.time <= tb) g.fillRect(st.x(x.time), l.y + 8, 2, l.h - 16);
      g.fillStyle = "rgba(245,165,36,0.6)";
      for (const c of lv.chords) if (c.time >= ta && c.time <= tb) g.fillRect(st.x(c.time), l.y + 6, 3, l.h - 12);
      return;
    }
    // strings
    for (let s = 0; s < n; s++) {
      const y = rowY(l, s) + ROW / 2;
      g.fillStyle = COLORS[s]; g.globalAlpha = 0.22; g.fillRect(0, Math.round(y), st.W, 1); g.globalAlpha = 1;
    }
    g.textBaseline = "middle"; g.textAlign = "center";
    // anchors (top band): the fret the hand sits at, with its width
    const an = lv.anchors;
    for (let i = Math.max(0, lowerBound(an, ta, "time") - 1); i < an.length && an[i].time <= tb; i++) {
      const x0 = st.x(an[i].time), x1 = i + 1 < an.length ? st.x(an[i + 1].time) : st.x(d.songLength || st.duration());
      const sel = st.sel.kind === "anchor" && st.isSelected(an[i]);
      g.fillStyle = sel ? "rgba(255,255,255,0.18)" : "rgba(143,211,255,0.07)"; g.fillRect(x0, l.y + 3, Math.max(1, x1 - x0), 5);
      g.fillStyle = sel ? "#fff" : "rgba(143,211,255,0.75)"; g.fillRect(x0, l.y + 2, 1.5, 8);
      if (x1 - x0 > 16) { g.font = "700 9px Inter, system-ui, sans-serif"; g.textAlign = "left"; g.fillText(an[i].fret + (an[i].width !== 4 ? "\u00b7" + an[i].width : ""), x0 + 4, l.y + 13); g.textAlign = "center"; }
    }
    // hand shapes
    for (const h of lv.handShapes) {
      if (h.endTime < ta || h.startTime > tb) continue;
      const x0 = st.x(h.startTime), x1 = st.x(h.endTime), y = l.y + l.h - 4;
      g.fillStyle = "rgba(245,165,36,0.35)"; g.fillRect(x0, y, Math.max(1, x1 - x0), 2);
    }
    // ghosts: at an easier level, what the hardest chart plays there (dashed)
    const gh = st.ghosts && st.ghosts[l.arr];
    if (gh) {
      g.save(); g.setLineDash([3, 2]); g.lineWidth = 1;
      const ghost = (s, fret, t, sus) => {
        if (s < 0 || s >= n || t + (sus || 0) < ta || t > tb) return;
        const px = st.x(t), y = rowY(l, s) + 1, w = headW(fret);
        g.strokeStyle = COLORS[s]; g.globalAlpha = 0.5; rr(g, px, y, w, ROW - 2, 3); g.stroke();
        if (sus > 0) { g.globalAlpha = 0.18; g.fillStyle = COLORS[s]; g.fillRect(px + w, y + (ROW - 2) / 2 - 1.5, sus * st.view.pps - w, 3); }
        g.globalAlpha = 0.45; g.fillStyle = "#fff"; g.font = "600 9px Inter, system-ui, sans-serif"; g.textAlign = "center"; g.fillText(String(fret), px + w / 2, y + (ROW - 2) / 2 + 0.5);
      };
      for (const x of gh.notes) ghost(x.string, x.fret, x.time, x.sustain);
      for (const c of gh.chords) { const tp = d.chordTemplates[c.chordId]; if (tp) tp.frets.forEach((f, s) => { if (f >= 0) ghost(s, f, c.time, Math.max(0, ...(c.chordNotes || []).map((q) => q.sustain || 0))); }); }
      g.restore(); g.textAlign = "center"; g.textBaseline = "middle";
    }
    // notes
    const N = lv.notes, i0 = Math.max(0, lowerBound(N, ta - 30, "time"));
    for (let i = i0; i < N.length && N[i].time <= tb; i++) {
      const x = N[i];
      if (x.time + (x.sustain || 0) < ta) continue;
      drawNote(st, g, l, x, st.x(x.time), st.sel.kind === "note" && st.isSelected(x), null);
    }
    // chords
    for (const c of lv.chords) {
      if (c.time > tb) break;
      const tp = d.chordTemplates[c.chordId];
      const sus = Math.max(0, ...(c.chordNotes || []).map((q) => q.sustain || 0));
      if (c.time + sus < ta || !tp) continue;
      drawChord(st, g, l, c, tp, st.x(c.time), st.sel.kind === "chord" && st.isSelected(c));
    }
    g.textAlign = "left";
    if (a.dd && a.dd.view != null) drawLevelShade(st, g, l, a, ta, tb);
  }

  /** Viewing level k: phrases whose max difficulty is below k play their top level there (shaded, labelled). */
  function drawLevelShade(st, g, l, a, ta, tb) {
    const k = a.dd.view, top = a.dd.levels.length - 1;
    g.font = "700 9.5px Inter, system-ui, sans-serif"; g.textBaseline = "middle";
    for (const r of E.ddRanges(a.doc)) {
      if (r.phraseId < 0 || r.t1 < ta || r.t0 > tb) continue;
      const m = Math.max(0, Math.min(top, (a.doc.phrases[r.phraseId] || {}).maxDifficulty | 0));
      const x0 = Math.max(0, st.x(Math.max(r.t0, ta - 1))), x1 = Math.min(st.W, st.x(Math.min(r.t1, tb + 1)));
      if (m < k) {
        g.fillStyle = "rgba(8, 10, 16, 0.42)"; g.fillRect(x0, l.y, Math.max(0, x1 - x0), l.h);
        if (x1 - x0 > 70) { g.fillStyle = "rgba(232, 234, 241, 0.55)"; g.textAlign = "left"; g.fillText("plays level " + m + " (its top)", x0 + 6, l.y + l.h - 10); }
      }
      // phrase boundary
      g.fillStyle = "rgba(245, 165, 36, 0.25)"; g.fillRect(Math.round(st.x(r.start)), l.y, 1, l.h);
    }
    g.fillStyle = "rgba(245, 165, 36, 0.92)"; g.textAlign = "left";
    const label = "LEVEL " + k, w = g.measureText(label).width + 10;
    g.beginPath(); if (g.roundRect) g.roundRect(4, l.y + 3, w, 14, 4); else g.rect(4, l.y + 3, w, 14); g.fill();
    g.fillStyle = "#1a1206"; g.fillText(label, 9, l.y + 10.5);
  }

  function drawNote(st, g, l, x, px, sel, over) {
    const s = over && over.string != null ? over.string : x.string, fret = over && over.fret != null ? over.fret : x.fret;
    const sus = over && over.sustain != null ? over.sustain : x.sustain || 0;
    if (s < 0 || s >= l.strings) return;
    const y = rowY(l, s) + 1, h = ROW - 2, w = headW(fret), col = COLORS[s];
    if (sus > 0) {
      const tw = sus * st.view.pps;
      g.fillStyle = col; g.globalAlpha = 0.45;
      if (x.slideTo >= 0 || x.slideUnpitchTo >= 0) {
        const to = x.slideTo >= 0 ? x.slideTo : x.slideUnpitchTo, dir = to > fret ? -1 : 1;
        g.beginPath(); g.moveTo(px + w / 2, y + h / 2 - 2); g.lineTo(px + w / 2 + tw, y + h / 2 - 2 + dir * 4); g.lineTo(px + w / 2 + tw, y + h / 2 + 2 + dir * 4); g.lineTo(px + w / 2, y + h / 2 + 2); g.fill();
        g.globalAlpha = 1; g.font = "700 8.5px Inter, system-ui, sans-serif"; g.fillStyle = "rgba(255,255,255,0.8)"; g.fillText(String(to), px + w / 2 + tw + 7, y + h / 2);
      } else if (x.vibrato || x.tremolo) {
        g.beginPath();
        for (let k = 0; k <= tw; k += 2) { const yy = y + h / 2 + Math.sin(k / 3) * 2.5; if (k === 0) g.moveTo(px + w / 2 + k, yy); else g.lineTo(px + w / 2 + k, yy); }
        g.lineWidth = 2.5; g.strokeStyle = col; g.stroke();
      } else rr(g, px + w / 2, y + h / 2 - 2.5, tw, 5, 2.5), g.fill();
      g.globalAlpha = 1;
    }
    g.fillStyle = x.mute ? "#3a4256" : col;
    rr(g, px, y, w, h, 3.5); g.fill();
    if (x.harmonic || x.harmonicPinch) { g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 1; rr(g, px + 1.5, y + 1.5, w - 3, h - 3, 2.5); g.stroke(); }
    if (sel) { g.strokeStyle = "#fff"; g.lineWidth = 2; rr(g, px - 1.5, y - 1.5, w + 3, h + 3, 4.5); g.stroke(); }
    g.font = "800 10px Inter, system-ui, sans-serif";
    g.fillStyle = s === 1 ? "#1a1206" : "#fff";
    g.fillText(x.mute ? "X" : String(fret), px + w / 2, y + h / 2 + 0.5);
    const tl = techLabel(x).replace(/^X ?/, "");
    if (tl && st.view.pps > 25) {
      g.font = "700 8.5px Inter, system-ui, sans-serif"; g.fillStyle = "rgba(255,255,255,0.85)"; g.textAlign = "left";
      g.fillText(tl, px + w + 2, y + 3); g.textAlign = "center";
    }
  }

  function drawChord(st, g, l, c, tp, px, sel, over) {
    const frets = tp.frets, used = [];
    frets.forEach((f, s) => { if (f >= 0 && s < l.strings) used.push(s); });
    if (!used.length) return;
    const top = rowY(l, Math.max(...used)) - 1, bot = rowY(l, Math.min(...used)) + ROW + 1;
    const w = Math.max(...used.map((s) => headW(frets[s])));
    g.strokeStyle = sel ? "#fff" : "rgba(245,196,107,0.8)"; g.lineWidth = sel ? 2 : 1.2;
    rr(g, px - 3, top, w + 6, bot - top, 4); g.stroke();
    for (const s of used) {
      const cn = (c.chordNotes || []).find((q) => q.string === s) || {};
      drawNote(st, g, l, Object.assign({}, cn, { string: s, fret: frets[s], sustain: cn.sustain || 0, mute: cn.mute || c.fretHandMute }), px, false, over);
    }
    const name = tp.chordName || tp.displayName;
    if (name && st.view.pps > 12) {
      g.font = "800 10px Inter, system-ui, sans-serif"; g.fillStyle = sel ? "#fff" : "#ffc46b"; g.textAlign = "left";
      g.fillText(name + (c.highDensity ? "\u2026" : ""), px - 2, l.y + 14); g.textAlign = "center";
    }
    if (c.palmMute || c.accent) {
      g.font = "700 8.5px Inter, system-ui, sans-serif"; g.fillStyle = "rgba(255,255,255,0.85)"; g.textAlign = "left";
      g.fillText([c.palmMute ? "PM" : "", c.accent ? ">" : ""].filter(Boolean).join(" "), px + w + 5, top + 5); g.textAlign = "center";
    }
  }

  /** Where the voice sings (rsc-voice.js), under the lyrics: p(voice) as a band, sung phrases underlined. */
  function drawVoice(st, g, l, ta, tb) {
    const V = st.voice;
    if (!V || !st.showVoice || V.mix !== st.audio.mix) return;
    const p = V.p, f0 = Math.max(0, Math.floor(ta * 100)), f1 = Math.min(p.length - 1, Math.ceil(tb * 100));
    const base = l.y + l.h - 4, hmax = l.voice ? l.h - 44 : l.h - 8, step = Math.max(1, Math.floor((f1 - f0) / Math.max(1, st.W)));
    g.save();
    if (l.voice) { g.fillStyle = "rgba(255,255,255,0.03)"; g.fillRect(st.x(ta), base - hmax - 2, (tb - ta) * st.view.pps, hmax + 4); }
    g.beginPath(); g.moveTo(st.x(f0 / 100), base);
    for (let f = f0; f <= f1; f += step) g.lineTo(st.x(f / 100), base - Math.max(0, p[f] - 0.2) / 0.8 * hmax);
    g.lineTo(st.x(f1 / 100), base); g.closePath();
    g.fillStyle = l.voice ? "rgba(245,165,36,0.32)" : "rgba(245,165,36,0.16)"; g.fill();
    if (l.voice) { g.strokeStyle = "rgba(255,196,107,0.55)"; g.lineWidth = 1; g.stroke(); }
    g.fillStyle = "rgba(255,196,107,0.85)";
    for (const s of V.segments) { if (s.t1 < ta || s.t0 > tb) continue; g.fillRect(st.x(s.t0), base, Math.max(1, (s.t1 - s.t0) * st.view.pps), 2); }
    g.restore();
  }

  function drawVocals(st, g, l, ta, tb) {
    drawVoice(st, g, l, ta, tb);
    const v = st.project.vocals;
    if (!v || !v.syllables.length) {
      g.fillStyle = "rgba(232,234,241,0.35)"; g.font = "600 11px Inter, system-ui, sans-serif"; g.textBaseline = "middle";
      g.fillText("No lyrics \u2014 Lyrics tab: find them online, import a .lrc or paste them", 10, l.y + l.h / 2);
      return;
    }
    const S = v.syllables, y = l.y + (l.voice ? 6 : 8), h = l.voice ? 26 : l.h - 16;
    g.font = "700 11px Inter, system-ui, sans-serif"; g.textBaseline = "middle"; g.textAlign = "left";
    let lineStart = true;
    for (let i = Math.max(0, lowerBound(S, ta - 10, "time") - 1); i < S.length && S[i].time <= tb; i++) {
      const s = S[i], x0 = st.x(s.time), w = Math.max(3, s.length * st.view.pps - 1), sel = st.sel.kind === "syl" && st.isSelected(s);
      const prev = S[i - 1];
      lineStart = !prev || /\+$/.test(prev.lyric || "");
      g.fillStyle = sel ? "rgba(255,196,107,0.95)" : "rgba(245,165,36,0.55)";
      rr(g, x0, y, w, h, 4); g.fill();
      if (lineStart) { g.fillStyle = "#ffc46b"; g.fillRect(x0, y - 5, 2, h + 10); }
      if (/\+$/.test(s.lyric || "")) { g.fillStyle = "rgba(255,255,255,0.5)"; g.fillRect(x0 + w - 1, y + 3, 1.5, h - 6); }
      const txt = (s.lyric || "").replace(/\+$/, "");
      if (w > 14) {
        g.save(); g.beginPath(); g.rect(x0 + 2, y, w - 4, h); g.clip();
        g.fillStyle = sel ? "#1a1206" : "#fff"; g.fillText(txt, x0 + 4, y + h / 2 + 0.5);
        g.restore();
      }
    }
    g.textAlign = "left";
  }

  /** The dragged items, drawn translucent at their new place. */
  RSC.drawGhost = function (st, g, gh) {
    const l = gh.lane;
    if (!l) return;
    for (const it of gh.items) {
      const px = st.x(it.t);
      if (l.kind === "arr") {
        if (it.chord) drawChord(st, g, l, it.chord, arrOf(st, l).doc.chordTemplates[it.chord.chordId], px, true);
        else drawNote(st, g, l, it.note, px, true, { string: it.s, sustain: it.sus });
      } else if (l.kind === "vocals") {
        g.fillStyle = "rgba(255,255,255,0.9)"; rr(g, px, l.y + (l.voice ? 6 : 8), Math.max(3, it.len * st.view.pps), l.voice ? 26 : l.h - 16, 4); g.fill();
      } else if (l.kind === "sections" || l.kind === "beats") {
        g.fillStyle = "#fff"; g.fillRect(px - 1, l.y, 2, l.h);
      }
    }
  };

  // ---- hit testing -------------------------------------------------------------------------------
  RSC.hitTest = function (st, lane, x, y) {
    const p = st.project, t = st.t(x), px = st.view.pps;
    if (lane.kind === "sections") {
      const S = p.sections;
      for (let i = 0; i < S.length; i++) {
        const x0 = st.x(S[i].startTime), end = i + 1 < S.length ? S[i + 1].startTime : st.duration();
        if (Math.abs(x - x0) <= 5) return { kind: "section", item: S[i], edge: "start", time: S[i].startTime, tip: S[i].name + " " + S[i].number + " \u00b7 " + RSC.fmtTime(S[i].startTime, true) };
        if (t >= S[i].startTime && t < end) return { kind: "section", item: S[i], time: S[i].startTime, tip: S[i].name + " " + S[i].number };
      }
      return null;
    }
    if (lane.kind === "beats") {
      const B = p.beats;
      let best = null, bd = 6;
      for (let i = Math.max(0, lowerBound(B, t - 8 / px, "time")); i < B.length && B[i].time <= t + 8 / px; i++) {
        const d = Math.abs(st.x(B[i].time) - x);
        if (d < bd) { bd = d; best = B[i]; }
      }
      return best ? { kind: "beat", item: best, time: best.time, tip: (best.measure >= 0 ? "Bar " + best.measure : "Beat") + " \u00b7 " + RSC.fmtTime(best.time, true) } : null;
    }
    if (lane.kind === "vocals") {
      const v = p.vocals;
      if (!v) return null;
      const S = v.syllables;
      for (let i = Math.max(0, lowerBound(S, t - 5, "time") - 1); i < S.length && S[i].time <= t + 1; i++) {
        const x0 = st.x(S[i].time), x1 = x0 + Math.max(3, S[i].length * px);
        if (x >= x0 - 2 && x <= x1 + 2 && y >= lane.y + 6 && y <= lane.y + lane.h - 6) {
          return { kind: "syl", item: S[i], time: S[i].time, edge: x > x1 - 5 && x1 - x0 > 10 ? "length" : null, tip: '"' + S[i].lyric + '" \u00b7 ' + RSC.fmtTime(S[i].time, true) };
        }
      }
      return null;
    }
    if (lane.kind === "arr" && !lane.collapsed) {
      const a = arrOf(st, lane), lv = a.doc.levels[0];
      if (y < lane.y + TOP - 2) {                              // anchors band
        const an = lv.anchors;
        for (let i = 0; i < an.length; i++) if (Math.abs(st.x(an[i].time) - x) < 6) return { kind: "anchor", item: an[i], time: an[i].time, tip: "Anchor: fret " + an[i].fret + ", width " + an[i].width };
        for (const c of lv.chords) { const tp = a.doc.chordTemplates[c.chordId]; if (tp && x >= st.x(c.time) - 3 && x <= st.x(c.time) + 40) return { kind: "chord", item: c, time: c.time, tip: (tp.chordName || "chord") }; }
        return null;
      }
      const s = rowOf(lane, y);
      // chords first (they span strings)
      for (const c of lv.chords) {
        const cx = st.x(c.time);
        if (cx > x + 4) break;
        const tp = a.doc.chordTemplates[c.chordId];
        if (!tp) continue;
        const used = tp.frets.map((f, k) => (f >= 0 ? k : -1)).filter((k) => k >= 0);
        if (!used.length) continue;
        const top = rowY(lane, Math.max(...used)) - 2, bot = rowY(lane, Math.min(...used)) + ROW + 2;
        const sus = Math.max(0, ...(c.chordNotes || []).map((q) => q.sustain || 0)), w = 22, tail = cx + w / 2 + sus * px;
        if (y >= top && y <= bot && x >= cx - 3 && x <= Math.max(cx + w, tail)) {
          return { kind: "chord", item: c, time: c.time, edge: sus > 0 && Math.abs(x - tail) < 5 ? "sustain" : null,
            tip: (tp.chordName || "chord") + " [" + tp.frets.map((f) => (f < 0 ? "x" : f)).join(" ") + "] \u00b7 " + RSC.fmtTime(c.time, true) };
        }
      }
      if (s < 0) return null;
      const N = lv.notes;
      let best = null;
      for (let i = Math.max(0, lowerBound(N, t - 20, "time")); i < N.length && N[i].time <= t + 1; i++) {
        const n = N[i];
        if (n.string !== s) continue;
        const nx = st.x(n.time), w = headW(n.fret), tail = nx + w / 2 + (n.sustain || 0) * px;
        if (x >= nx - 2 && x <= nx + w + 2) best = { kind: "note", item: n, time: n.time };
        else if (n.sustain > 0 && x > nx + w && x <= tail + 4) best = { kind: "note", item: n, time: n.time, edge: Math.abs(x - tail) < 6 ? "sustain" : null };
      }
      if (best) {
        const n = best.item, midi = E.midiNote(a.doc.tuning, n.string, n.fret, a.kind === "bass", a.doc.capo);
        best.tip = "String " + (lane.strings - n.string) + ", fret " + n.fret + " \u00b7 " + noteName(midi) + (techLabel(n) ? " \u00b7 " + techLabel(n) : "") + " \u00b7 " + RSC.fmtTime(n.time, true);
      }
      return best;
    }
    return null;
  };
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const noteName = (m) => (m == null || m < 0 ? "" : NAMES[m % 12] + (Math.floor(m / 12) - 1));
  RSC.noteName = noteName;

  // ---- edits -------------------------------------------------------------------------------------
  const keyOf = (lane) => (lane.kind === "arr" ? "arr:" + lane.arr : lane.kind === "vocals" ? "vocals" : lane.kind);
  const sortLevel = (lv) => { lv.notes.sort((a, b) => a.time - b.time || a.string - b.string); lv.chords.sort((a, b) => a.time - b.time); lv.anchors.sort((a, b) => a.time - b.time); lv.handShapes.sort((a, b) => a.startTime - b.startTime); };
  RSC.sortLevel = sortLevel;
  function renumberSections(S) {
    S.sort((a, b) => a.startTime - b.startTime);
    const n = {};
    for (const s of S) { const k = s.name.toLowerCase(); n[k] = (n[k] || 0) + 1; s.number = n[k]; }
  }
  RSC.renumberSections = renumberSections;
  function renumberMeasures(B) {
    B.sort((a, b) => a.time - b.time);
    let m = 0;
    for (const b of B) if (b.measure >= 0) b.measure = ++m;
  }
  RSC.renumberMeasures = renumberMeasures;

  RSC.eraseHit = function (st, lane, hit) {
    st.edit("Erase", [keyOf(lane)], () => removeItems(st, lane, hit.kind, [hit.item]));
    st.clearSelection(lane.id);
  };
  function removeItems(st, lane, kind, items) {
    const p = st.project, set = new Set(items);
    if (kind === "note") { const lv = levelOf(st, lane); lv.notes = lv.notes.filter((x) => !set.has(x)); }
    else if (kind === "chord") { const lv = levelOf(st, lane); lv.chords = lv.chords.filter((x) => !set.has(x)); }
    else if (kind === "anchor") { const lv = levelOf(st, lane); lv.anchors = lv.anchors.filter((x) => !set.has(x)); }
    else if (kind === "syl") {
      const S = p.vocals.syllables;
      // keep line breaks: a removed line-end passes its "+" to the syllable before
      for (const s of items) if (/\+$/.test(s.lyric)) { const i = S.indexOf(s); if (i > 0 && !set.has(S[i - 1]) && !/\+$/.test(S[i - 1].lyric)) S[i - 1].lyric = S[i - 1].lyric.replace(/-$/, "") + "+"; }
      p.vocals.syllables = S.filter((x) => !set.has(x));
    } else if (kind === "section") { p.sections = p.sections.filter((x) => !set.has(x)); renumberSections(p.sections); }
    else if (kind === "beat") { p.beats = p.beats.filter((x) => !set.has(x)); renumberMeasures(p.beats); }
  }
  RSC.deleteSelection = function (st) {
    const sel = st.sel, lane = st.lanes.find((l) => l.id === sel.lane);
    if (!lane || !sel.items.length) return;
    st.edit("Delete " + sel.items.length + " " + sel.kind + (sel.items.length > 1 ? "s" : ""), [keyOf(lane)], () => removeItems(st, lane, sel.kind, sel.items));
    st.clearSelection(lane.id);
  };

  /** Draw tool: add an item where the lane was clicked. */
  RSC.drawAt = function (st, lane, x, y) {
    const p = st.project, t = st.snapTime(st.t(x));
    if (t < 0) return;
    if (lane.kind === "arr" && !lane.collapsed) {
      const lv = levelOf(st, lane);
      if (y < lane.y + TOP - 2) {
        const an = { time: t, fret: Math.max(1, st.fret || 1), width: 4 };
        st.edit("Add anchor", [keyOf(lane)], () => { lv.anchors.push(an); sortLevel(lv); });
        st.select(lane, "anchor", [an]);
        return;
      }
      const s = rowOf(lane, y);
      if (s < 0) return;
      const n = Object.assign({}, E.NOTE_DEFAULTS, { time: t, string: s, fret: st.fret, sustain: 0, bendValues: [] });
      st.edit("Add note", [keyOf(lane)], () => { lv.notes.push(n); sortLevel(lv); });
      st.select(lane, "note", [n]);
    } else if (lane.kind === "vocals") {
      if (!p.vocals) p.vocals = { id: null, syllables: [], origin: null, edited: true };
      const syl = { time: t, length: Math.max(0.1, r3(st.gridStep(t) * 0.9)), lyric: "la", note: 254 };
      st.edit("Add syllable", ["vocals"], () => { p.vocals.syllables.push(syl); p.vocals.syllables.sort((a, b) => a.time - b.time); });
      st.select(lane, "syl", [syl]);
      RSC.inlineEdit(st, lane, syl);
    } else if (lane.kind === "sections") {
      const order = ["intro", "verse", "chorus", "verse", "chorus", "bridge", "solo", "chorus", "outro"];
      const prev = p.sections.filter((s) => s.startTime < t).length;
      const sec = { name: order[Math.min(order.length - 1, prev)], number: 1, startTime: t };
      st.edit("Add section", ["sections"], () => { p.sections.push(sec); renumberSections(p.sections); });
      st.select(lane, "section", [sec]);
    } else if (lane.kind === "beats") {
      const b = { time: r3(st.t(x)), measure: -1 };
      st.edit("Insert beat", ["beats"], () => { p.beats.push(b); renumberMeasures(p.beats); });
      st.select(lane, "beat", [b]);
    }
  };

  RSC.doubleClick = function (st, lane, x, y) {
    const hit = RSC.hitTest(st, lane, x, y);
    if (lane.kind === "vocals" && hit) { RSC.inlineEdit(st, lane, hit.item); return; }
    if (lane.kind === "sections" && hit) { RSC.inlineEdit(st, lane, hit.item); return; }
    if (lane.kind === "beats" && hit) {
      st.edit("Toggle bar start", ["beats"], () => { hit.item.measure = hit.item.measure >= 0 ? -1 : 0; renumberMeasures(st.project.beats); });
      return;
    }
    if (!hit && (lane.kind === "arr" || lane.kind === "vocals" || lane.kind === "sections")) RSC.drawAt(st, lane, x, y);
  };

  /** In-place text editing of a syllable or a section name. */
  RSC.inlineEdit = function (st, lane, item) {
    const inp = document.createElement("input");
    inp.className = "rsc-edit";
    const isSyl = lane.kind === "vocals";
    inp.value = isSyl ? item.lyric : item.name;
    const wr = st.wrap.getBoundingClientRect(), R = st.root.getBoundingClientRect();
    inp.style.left = (wr.left - R.left + Math.max(0, st.x(isSyl ? item.time : item.startTime))) + "px";
    inp.style.top = (wr.top - R.top + lane.y + lane.h / 2 - 12) + "px";
    st.root.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      const v = inp.value.trim();
      inp.remove();
      st.root.focus({ preventScroll: true });
      if (!ok || !v) return;
      if (isSyl) st.edit("Edit syllable", ["vocals"], () => { item.lyric = v; });
      else st.edit("Rename section", ["sections"], () => { item.name = v.toLowerCase().replace(/\s+/g, ""); renumberSections(st.project.sections); });
      st.renderInspector();
    };
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
    inp.addEventListener("blur", () => finish(true));
  };

  // ---- dragging ----------------------------------------------------------------------------------
  function dragDelta(st, d, x, y, e) {
    const ref = d.hit.time != null ? d.hit.time : d.t0;
    const raw = ref + (x - d.x0) / st.view.pps;
    const snapped = e.altKey ? raw : st.snapTime(raw);
    return { dt: r3(snapped - ref), ds: d.lane.kind === "arr" ? Math.round((d.y0 - y) / ROW) : 0 };
  }
  RSC.dragPreview = function (st, d, x, y, e) {
    const lane = d.lane, items = [], sel = st.sel.items, { dt, ds } = dragDelta(st, d, x, y, e);
    if (d.kind === "resize") {
      const it = d.hit.item, end = e.altKey ? st.t(x) : st.snapTime(st.t(x));
      if (lane.kind === "vocals") { const len = Math.max(0.03, r3(end - it.time)); items.push({ t: it.time, len }); return { lane, items, tip: "Length " + len.toFixed(3) + " s" }; }
      const sus = Math.max(0, r3(end - it.time));
      if (d.hit.kind === "note") items.push({ t: it.time, note: it, s: it.string, sus });
      return { lane, items, tip: "Sustain " + sus.toFixed(3) + " s" };
    }
    for (const it of sel) {
      if (lane.kind === "arr") {
        if (st.sel.kind === "chord") items.push({ t: it.time + dt, chord: it });
        else if (st.sel.kind === "note") items.push({ t: it.time + dt, note: it, s: Math.max(0, Math.min(lane.strings - 1, it.string + ds)), sus: it.sustain });
        else if (st.sel.kind === "anchor") items.push({ t: it.time + dt });
      } else if (lane.kind === "vocals") items.push({ t: it.time + dt, len: it.length });
      else if (lane.kind === "sections") items.push({ t: it.startTime + dt });
      else if (lane.kind === "beats") items.push({ t: it.time + dt });
    }
    return { lane, items, tip: (dt >= 0 ? "+" : "") + dt.toFixed(3) + " s" + (ds ? ", " + (ds > 0 ? "+" : "") + ds + " string" : "") };
  };
  RSC.dragCommit = function (st, d, x, y, e) {
    const lane = d.lane, p = st.project, sel = st.sel.items.slice(), { dt, ds } = dragDelta(st, d, x, y, e);
    if (d.kind === "resize") {
      const it = d.hit.item, end = e.altKey ? st.t(x) : st.snapTime(st.t(x));
      if (lane.kind === "vocals") st.edit("Resize syllable", ["vocals"], () => { it.length = Math.max(0.03, r3(end - it.time)); });
      else if (d.hit.kind === "note") st.edit("Sustain", [keyOf(lane)], () => { it.sustain = Math.max(0, r3(end - it.time)); });
      else if (d.hit.kind === "chord") st.edit("Sustain", [keyOf(lane)], () => { const s = Math.max(0, r3(end - it.time)); for (const q of it.chordNotes || []) q.sustain = s; });
      return;
    }
    if (!dt && !ds) return;
    if (lane.kind === "arr") {
      const lv = levelOf(st, lane);
      st.edit("Move " + sel.length + " " + st.sel.kind + (sel.length > 1 ? "s" : ""), [keyOf(lane)], () => {
        for (const it of sel) {
          it.time = Math.max(0, r3(it.time + dt));
          if (st.sel.kind === "note" && ds) {
            const s2 = Math.max(0, Math.min(lane.strings - 1, it.string + ds));
            if (e.shiftKey) {                                     // keep the pitch: move the fret with the string
              const doc = arrOf(st, lane).doc, m = E.midiNote(doc.tuning, it.string, it.fret, false, 0);
              const f2 = m - E.midiNote(doc.tuning, s2, 0, false, 0);
              if (f2 >= 0 && f2 <= 24) { it.fret = f2; it.string = s2; }
            } else it.string = s2;
          }
        }
        sortLevel(lv);
      });
    } else if (lane.kind === "vocals") {
      st.edit("Move lyrics", ["vocals"], () => { for (const it of sel) it.time = Math.max(0, r3(it.time + dt)); p.vocals.syllables.sort((a, b) => a.time - b.time); });
    } else if (lane.kind === "sections") {
      st.edit("Move section", ["sections"], () => { for (const it of sel) it.startTime = Math.max(0, r3(it.startTime + dt)); renumberSections(p.sections); });
    } else if (lane.kind === "beats") {
      st.edit(e.altKey ? "Shift beats" : "Move beat", ["beats"], () => {
        const B = p.beats;
        if (sel.length === 1 && !e.shiftKey) {
          const i = B.indexOf(sel[0]);
          const lo = i > 0 ? B[i - 1].time + 0.02 : 0, hi = i + 1 < B.length ? B[i + 1].time - 0.02 : Infinity;
          sel[0].time = r3(Math.max(lo, Math.min(hi, sel[0].time + dt)));
        } else {
          // Shift: the selected beat and every later one move together
          const from = Math.min(...sel.map((b) => B.indexOf(b)));
          for (let i = from; i < B.length; i++) B[i].time = Math.max(0, r3(B[i].time + dt));
        }
        renumberMeasures(B);
      });
    }
  };

  RSC.marqueeSelect = function (st, lane, m, add) {
    const ta = st.t(m.x0), tb = st.t(m.x1), p = st.project;
    let kind = null, items = [];
    if (lane.kind === "arr") {
      const lv = levelOf(st, lane), sTop = rowOf(lane, m.y0), sBot = rowOf(lane, m.y1);
      const hiS = sTop < 0 ? lane.strings - 1 : sTop, loS = sBot < 0 ? 0 : sBot;
      items = lv.notes.filter((n) => n.time >= ta && n.time <= tb && n.string >= loS && n.string <= hiS);
      kind = "note";
      if (!items.length) { items = lv.chords.filter((c) => c.time >= ta && c.time <= tb); kind = "chord"; }
    } else if (lane.kind === "vocals" && p.vocals) { items = p.vocals.syllables.filter((s) => s.time >= ta && s.time <= tb); kind = "syl"; }
    else if (lane.kind === "beats") { items = p.beats.filter((b) => b.time >= ta && b.time <= tb); kind = "beat"; }
    else if (lane.kind === "sections") { items = p.sections.filter((s) => s.startTime >= ta && s.startTime <= tb); kind = "section"; }
    if (kind) st.select(lane, kind, items, add);
  };

  RSC.selectAll = function (st) {
    const lane = st.lanes.find((l) => l.id === st.sel.lane) || st.lanes.find((l) => l.kind === "arr");
    if (!lane) return;
    const p = st.project;
    if (lane.kind === "arr") { const lv = levelOf(st, lane); st.select(lane, st.sel.kind === "chord" ? "chord" : "note", st.sel.kind === "chord" ? lv.chords.slice() : lv.notes.slice()); }
    else if (lane.kind === "vocals" && p.vocals) st.select(lane, "syl", p.vocals.syllables.slice());
    else if (lane.kind === "beats") st.select(lane, "beat", p.beats.slice());
    else if (lane.kind === "sections") st.select(lane, "section", p.sections.slice());
  };

  RSC.nudge = function (st, dir, fine) {
    const lane = st.lanes.find((l) => l.id === st.sel.lane);
    if (!lane) return;
    const items = st.sel.items, ref = items[0].time != null ? items[0].time : items[0].startTime;
    const dt = fine || !st.snap ? dir * 0.01 : r3(st.gridStep(ref) * dir);
    RSC.shiftItems(st, lane, dt);
  };
  RSC.nudgeMs = function (st, ms) { const lane = st.lanes.find((l) => l.id === st.sel.lane); if (lane) RSC.shiftItems(st, lane, ms / 1000); };
  RSC.shiftItems = function (st, lane, dt) {
    const p = st.project, items = st.sel.items;
    st.edit("Nudge", [keyOf(lane)], () => {
      for (const it of items) { if (it.startTime != null) it.startTime = Math.max(0, r3(it.startTime + dt)); else it.time = Math.max(0, r3(it.time + dt)); }
      if (lane.kind === "arr") sortLevel(levelOf(st, lane));
      if (lane.kind === "vocals") p.vocals.syllables.sort((a, b) => a.time - b.time);
      if (lane.kind === "sections") renumberSections(p.sections);
      if (lane.kind === "beats") renumberMeasures(p.beats);
    });
  };
  /** Up / down: string (notes), Alt: fret +-1. */
  RSC.moveVertical = function (st, dir, alt) {
    const lane = st.lanes.find((l) => l.id === st.sel.lane);
    if (!lane || lane.kind !== "arr") return;
    const items = st.sel.items;
    if (st.sel.kind === "note") {
      st.edit(alt ? "Fret" : "String", [keyOf(lane)], () => {
        for (const n of items) {
          if (alt) n.fret = Math.max(0, Math.min(24, n.fret + dir));
          else n.string = Math.max(0, Math.min(lane.strings - 1, n.string + dir));
        }
        sortLevel(levelOf(st, lane));
      });
    } else if (st.sel.kind === "anchor") {
      st.edit("Anchor fret", [keyOf(lane)], () => { for (const a of items) a.fret = Math.max(1, Math.min(22, a.fret + dir)); });
    } else if (st.sel.kind === "chord" && alt) {
      RSC.transposeChords(st, lane, items, dir);
    }
  };
  RSC.transposeChords = function (st, lane, chords, dir) {
    const doc = arrOf(st, lane).doc;
    st.edit("Transpose chord", [keyOf(lane)], () => {
      for (const c of chords) {
        const tp = doc.chordTemplates[c.chordId];
        const frets = tp.frets.map((f) => (f >= 0 ? Math.max(0, Math.min(24, f + dir)) : f));
        c.chordId = RSC.templateFor(doc, frets, tp.fingers, "");
        for (const q of c.chordNotes || []) if (q.fret >= 0) q.fret = frets[q.string];
      }
    });
  };
  /** Index of a chord template with these frets (a new one if needed). */
  RSC.templateFor = function (doc, frets, fingers, name) {
    const key = frets.join(",");
    const i = doc.chordTemplates.findIndex((t) => t.frets.join(",") === key && (!name || t.chordName === name));
    if (i >= 0) return i;
    doc.chordTemplates.push({ chordName: name || RSC.chordName(doc, frets), displayName: name || RSC.chordName(doc, frets), frets: frets.slice(), fingers: (fingers || frets.map(() => -1)).slice() });
    return doc.chordTemplates.length - 1;
  };
  /** A chord's name from its notes (root + quality, or the two notes of a power chord). */
  RSC.chordName = function (doc, frets) {
    const pcs = [], ms = [];
    frets.forEach((f, s) => { if (f >= 0) { const m = E.midiNote(doc.tuning, s, f, false, doc.capo); ms.push(m); pcs.push(m % 12); } });
    if (!ms.length) return "";
    const bass = ms[ms.indexOf(Math.min(...ms))] % 12, set = new Set(pcs);
    const has = (i) => set.has((bass + i) % 12);
    let q = "";
    if (set.size === 1) q = "";
    else if (has(7) && set.size === 2) q = "5";
    else if (has(4) && has(7)) q = has(10) ? "7" : has(11) ? "maj7" : "";
    else if (has(3) && has(7)) q = has(10) ? "m7" : "m";
    else if (has(3) && has(6)) q = "dim";
    else if (has(5) && has(7)) q = "sus4";
    else if (has(2) && has(7)) q = "sus2";
    else q = "";
    return NAMES[bass] + q;
  };

  RSC.quantize = function (st) {
    const lane = st.lanes.find((l) => l.id === st.sel.lane);
    if (!lane) return;
    st.edit("Quantize", [keyOf(lane)], () => {
      for (const it of st.sel.items) { if (it.startTime != null) it.startTime = st.snapTime(it.startTime, true); else it.time = st.snapTime(it.time, true); }
      if (lane.kind === "arr") sortLevel(levelOf(st, lane));
      if (lane.kind === "vocals") st.project.vocals.syllables.sort((a, b) => a.time - b.time);
    });
    st.toast("Snapped " + st.sel.items.length + " to the grid");
  };

  // ---- techniques and frets from the keyboard ----
  const TECH_KEYS = { h: "hammerOn", p: "pullOff", v: "vibrato", m: "palmMute", x: "mute", a: "accent", t: "tap", n: "harmonic", k: "linkNext", r: "tremolo", i: "ignore" };
  RSC.TECH_KEYS = TECH_KEYS;
  RSC.techKey = function (st, e) {
    const lane = st.lanes.find((l) => l.id === st.sel.lane);
    if (!lane || lane.kind !== "arr" || !st.sel.items.length) return false;
    const k = e.key.toLowerCase();
    if (/^[0-9]$/.test(e.key) && st.sel.kind === "note") {
      const now = performance.now();
      let v = +e.key;
      if (st._fretKey && now - st._fretKey.t < 700 && st._fretKey.v * 10 + v <= 24) v = st._fretKey.v * 10 + v;
      st._fretKey = { t: now, v };
      st.fret = v;
      st.edit("Fret " + v, [keyOf(lane)], () => { for (const n of st.sel.items) n.fret = v; });
      return true;
    }
    if (k === "c" && st.sel.kind === "note") { RSC.makeChord(st, lane); return true; }
    if (k === "b") { RSC.toggleTech(st, lane, "bend"); return true; }
    if (k === "s") { RSC.toggleTech(st, lane, "slide"); return true; }
    if (TECH_KEYS[k]) { RSC.toggleTech(st, lane, TECH_KEYS[k]); return true; }
    return false;
  };
  RSC.toggleTech = function (st, lane, tech, value) {
    const items = st.sel.items, kind = st.sel.kind;
    st.edit(tech, [keyOf(lane)], () => {
      for (const it of items) {
        const targets = kind === "chord" ? (["palmMute", "accent", "linkNext", "ignore", "highDensity", "fretHandMute"].includes(tech) ? [it] : it.chordNotes || []) : [it];
        for (const n of targets) {
          if (tech === "bend") {
            const next = value != null ? value : (n.bend || 0) >= 2 ? 0 : (n.bend || 0) + 1;
            n.bend = next;
            n.bendValues = next ? [{ time: r3(n.time + Math.min(0.1, (n.sustain || 0.3) * 0.3)), step: next, unk5: 0 }] : [];
            if (next && !(n.sustain > 0)) n.sustain = 0.3;
          } else if (tech === "slide") {
            n.slideTo = n.slideTo >= 0 ? -1 : Math.max(0, Math.min(24, n.fret + (value || 2)));
            if (n.slideTo >= 0 && !(n.sustain > 0)) n.sustain = 0.3;
          } else if (tech === "fretHandMute" && kind === "chord") n.fretHandMute = n.fretHandMute ? 0 : 1;
          else if (tech === "highDensity") n.highDensity = n.highDensity ? 0 : 1;
          else if (tech === "vibrato") n.vibrato = n.vibrato ? 0 : 80;
          else n[tech] = n[tech] ? 0 : 1;
          if (tech === "hammerOn" || tech === "pullOff") n.hopo = n.hammerOn || n.pullOff ? 1 : 0;
        }
      }
    });
    st.renderInspector();
  };
  /** Selected single notes at one time -> a chord (with a template). */
  RSC.makeChord = function (st, lane) {
    const notes = st.sel.items;
    const byTime = new Map();
    for (const n of notes) { const k = n.time.toFixed(3); if (!byTime.has(k)) byTime.set(k, []); byTime.get(k).push(n); }
    const doc = arrOf(st, lane).doc, lv = doc.levels[0], made = [];
    st.edit("Make chord", [keyOf(lane)], () => {
      for (const group of byTime.values()) {
        if (group.length < 2) continue;
        const frets = [-1, -1, -1, -1, -1, -1];
        for (const n of group) frets[n.string] = n.fret;
        const id = RSC.templateFor(doc, frets, null, "");
        const c = { time: group[0].time, linkNext: 0, accent: 0, chordId: id, fretHandMute: 0, highDensity: 0, ignore: 0, palmMute: 0, hopo: 0, strum: "down",
          chordNotes: group.map((n) => Object.assign({}, n)) };
        lv.chords.push(c); made.push(c);
        lv.notes = lv.notes.filter((n) => !group.includes(n));
      }
      sortLevel(lv);
    });
    if (made.length) st.select(lane, "chord", made); else st.toast("Select two or more notes that start together");
  };
  RSC.breakChord = function (st, lane) {
    const doc = arrOf(st, lane).doc, lv = doc.levels[0], made = [];
    st.edit("Break chord", [keyOf(lane)], () => {
      for (const c of st.sel.items) {
        const tp = doc.chordTemplates[c.chordId];
        if (!tp) continue;
        tp.frets.forEach((f, s) => {
          if (f < 0) return;
          const cn = (c.chordNotes || []).find((q) => q.string === s) || {};
          const n = Object.assign({}, E.NOTE_DEFAULTS, cn, { time: c.time, string: s, fret: f, bendValues: cn.bendValues || [] });
          lv.notes.push(n); made.push(n);
        });
        lv.chords = lv.chords.filter((x) => x !== c);
      }
      sortLevel(lv);
    });
    st.select(lane, "note", made);
  };

  // ---- clipboard ----
  RSC.copy = function (st) {
    const lane = st.lanes.find((l) => l.id === st.sel.lane);
    if (!lane || !st.sel.items.length || (lane.kind !== "arr" && lane.kind !== "vocals")) return;
    const t0 = Math.min(...st.sel.items.map((i) => i.time));
    st.clip = { kind: st.sel.kind, lane: lane.kind, items: JSON.parse(JSON.stringify(st.sel.items)).map((i) => Object.assign(i, { time: r3(i.time - t0) })),
      templates: lane.kind === "arr" ? JSON.parse(JSON.stringify(arrOf(st, lane).doc.chordTemplates)) : null };
    st.toast("Copied " + st.sel.items.length);
  };
  RSC.paste = function (st) {
    const c = st.clip;
    if (!c) return;
    const lane = st.lanes.find((l) => l.id === st.sel.lane && l.kind === c.lane) || st.lanes.find((l) => l.kind === c.lane);
    if (!lane) return;
    const at = st.snapTime(st.audio.time());
    const items = JSON.parse(JSON.stringify(c.items)).map((i) => Object.assign(i, { time: r3(i.time + at) }));
    if (lane.kind === "arr") {
      const doc = arrOf(st, lane).doc;
      st.edit("Paste", [keyOf(lane)], () => {
        for (const it of items) {
          if (c.kind === "chord") { const tp = c.templates[it.chordId]; it.chordId = RSC.templateFor(doc, tp.frets, tp.fingers, tp.chordName); doc.levels[0].chords.push(it); }
          else if (it.string < lane.strings) doc.levels[0].notes.push(it);
        }
        sortLevel(doc.levels[0]);
      });
    } else {
      const p = st.project;
      if (!p.vocals) p.vocals = { id: null, syllables: [], origin: null, edited: true };
      st.edit("Paste", ["vocals"], () => { p.vocals.syllables.push(...items); p.vocals.syllables.sort((a, b) => a.time - b.time); });
    }
    st.select(lane, c.kind, items);
  };

  // ---- before saving: the structure Rocksmith expects -------------------------------------------
  /** Anchors where the hand moves, for a chart without (as the charting tools do). */
  E.autoAnchors = function (doc) {
    const lv = doc.levels[0], ev = [];
    for (const n of lv.notes) if (n.fret > 0) ev.push({ t: n.time, lo: n.fret, hi: Math.max(n.fret, n.slideTo || 0) });
    for (const c of lv.chords) { const tp = doc.chordTemplates[c.chordId]; if (!tp) continue; const fr = tp.frets.filter((f) => f > 0); if (fr.length) ev.push({ t: c.time, lo: Math.min(...fr), hi: Math.max(...fr) }); }
    ev.sort((a, b) => a.t - b.t);
    const out = [];
    let cur = null;
    for (const e of ev) {
      if (cur && e.lo >= cur.fret && e.hi <= cur.fret + 3) continue;
      const fret = Math.max(1, Math.min(21, e.hi - e.lo <= 3 ? e.lo : e.lo));
      if (!cur || fret !== cur.fret) { cur = { time: e.t, fret, width: Math.max(4, Math.min(6, e.hi - e.lo + 1)) }; out.push(cur); }
    }
    if (out.length && doc.levels[0].notes.concat(doc.levels[0].chords).length) {
      const first = Math.min(...lv.notes.map((n) => n.time).concat(lv.chords.map((c) => c.time)));
      if (out[0].time > first) out[0].time = first;
    }
    if (!out.length) out.push({ time: 0, fret: 1, width: 4 });
    return out;
  };
  /** Hand shapes for chords without one (chord time -> next event or its sustain). */
  E.autoHandShapes = function (doc) {
    const lv = doc.levels[0], hs = lv.handShapes.slice();
    const events = lv.notes.map((n) => n.time).concat(lv.chords.map((c) => c.time)).sort((a, b) => a - b);
    for (const c of lv.chords) {
      if (hs.some((h) => c.time >= h.startTime - 1e-4 && c.time < h.endTime)) continue;
      const next = events.find((t) => t > c.time + 1e-4);
      const sus = Math.max(0.1, ...(c.chordNotes || []).map((q) => q.sustain || 0));
      let end = c.time + sus;
      if (next != null) end = Math.min(Math.max(end, c.time + 0.1), next);
      // repeated strums of one chord share a hand shape
      const prev = hs.filter((h) => h.chordId === c.chordId && Math.abs(h.endTime - c.time) < 1e-3)[0];
      if (prev) prev.endTime = r3(Math.max(prev.endTime, end));
      else hs.push({ chordId: c.chordId, startTime: c.time, endTime: r3(end) });
    }
    return hs.sort((a, b) => a.startTime - b.startTime);
  };
  RSC.prepareForSave = function (project) {
    for (const a of project.arrangements) {
      if (!a.edited) continue;
      // phrases follow the sections (difficulty levels are carried over)
      if (!a.doc.phraseIterations.length || project.sectionsEdited || !a.origin) E.arrApplySections(a, project.sections);
      // every level (the view alone for a chart without difficulty levels)
      E.ddEachLevel(a, (lv) => {
        const d = Object.assign({}, a.doc, { levels: [lv] });
        sortLevel(lv);
        if (!lv.anchors.length && (lv.notes.length || lv.chords.length)) lv.anchors = E.autoAnchors(d);
        lv.handShapes = E.autoHandShapes(d);
        // every chord note must carry the chord's fret
        for (const c of lv.chords) { const tp = a.doc.chordTemplates[c.chordId]; if (tp) for (const q of c.chordNotes || []) if (tp.frets[q.string] >= 0) { q.fret = tp.frets[q.string]; q.time = c.time; } }
      });
    }
    if (project.vocals) {
      const S = project.vocals.syllables.sort((x, y) => x.time - y.time);
      if (S.length && !/\+$/.test(S[S.length - 1].lyric)) S[S.length - 1].lyric = S[S.length - 1].lyric.replace(/-$/, "") + "+";
    }
  };
})(typeof window !== "undefined" ? window : globalThis);

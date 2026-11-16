/* ---------------------------------------------------------------------------
 * overlays.js -- HTML overlays shared by both renderers:
 *   HudView        song card (album art, title, artist, tags) + section pill
 *   LyricsView     Rocksmith-style lyrics: current line with the sung part
 *                  highlighted, next line underneath
 *   CountdownView  practice lead-in countdown
 *   TransportView  play/restart, time, coloured section strip with playhead,
 *                  practice-loop band, speed/loop badges, per-section accuracy
 *   FeedbackView   "Perfect / Early / Late" flash at the strike line (scoring)
 *   ResultsView    end-of-song / loop-pass results card (scoring)
 * Each view only touches the DOM when what it shows actually changes.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const NS = (root.RSHighway = root.RSHighway || {});
  const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };
  function h(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }
  NS.fmtTime = fmt;

  // Section colours by type (strip + pill)
  const SECTION_COLORS = [
    [/^(intro|outro|fade)/, "#64748b"], [/^(pre|post)?chorus|modchorus/, "#a855f7"], [/verse|prevs|postvs/, "#3b82f6"],
    [/solo/, "#f59e0b"], [/bridge/, "#10b981"], [/riff|hook|melody|tapping/, "#14b8a6"],
    [/noguitar|silence|ambient/, "#334155"], [/breakdown|interlude|transition|vamp|buildup/, "#0ea5e9"],
  ];
  function sectionColor(name) {
    const k = String(name || "").toLowerCase();
    for (const [re, c] of SECTION_COLORS) if (re.test(k)) return c;
    return "#475569";
  }
  NS.sectionColor = sectionColor;
  /** red (0 %) -> amber -> green (100 %) */
  const accuracyColor = (a) => `hsl(${Math.round(120 * Math.max(0, Math.min(1, a)) ** 1.5)}, 75%, 55%)`;
  NS.accuracyColor = accuracyColor;

  // ---- song card + section pill -----------------------------------------------------
  class HudView {
    constructor(parent) {
      this.card = h("div", "rs-hw-card", parent);
      this.art = h("div", "rs-hw-art", this.card);
      const meta = h("div", "rs-hw-card-meta", this.card);
      this.title = h("div", "rs-hw-card-title", meta);
      this.sub = h("div", "rs-hw-card-sub", meta);
      this.tags = h("div", "rs-hw-card-tags", meta);
      this.pill = h("div", "rs-hw-pill", parent);
      const side = h("div", "rs-hw-side", parent);                  // right column under the pill
      this.score = h("div", "rs-hw-score", side);                  // judge stats (input active)
      this.score.style.display = "none";
      this.meter = h("div", "rs-hw-meter", side);                // input level (microphone source)
      this.meter.title = "Input level";
      this.meterBar = h("div", "rs-hw-meter-bar", this.meter);
      this.meter.style.display = "none";
      this._artKey = null; this._sec = null; this._lvl = -1;
    }
    setChart(c) {
      const m = c.meta || {};
      this.title.textContent = m.title || "Untitled";
      this.sub.textContent = [m.artist, m.album && m.album !== m.title ? m.album : null, m.year].filter(Boolean).join("  \u00b7  ");
      const tags = [m.arrangement, m.instrument_tag || m.tuning_name];
      if (m.capo > 0) tags.push(`Capo ${m.capo}`);
      if (m.max_difficulty > 0 && m.difficulty < 1) tags.push(`Difficulty ${Math.round(100 * m.difficulty)}%`);
      this.tags.innerHTML = "";
      for (const t of tags.filter(Boolean)) h("span", "rs-hw-tag", this.tags, t);
      if (c.art && this._artKey !== c.songKey) {
        this._artKey = c.songKey;
        let url = null;
        try { url = NS.ddsToDataURL(c.art); } catch (e) { url = null; }
        this.art.style.backgroundImage = url ? `url(${url})` : "";
        this.art.classList.toggle("is-empty", !url);
      } else if (!c.art) { this.art.style.backgroundImage = ""; this.art.classList.add("is-empty"); this._artKey = null; }
      this._sec = null;
      this.card.style.display = "";
    }
    hide() { this.card.style.display = "none"; this.pill.style.display = "none"; this.score.style.display = "none"; this.showMeter(false); }
    showMeter(on) { this.meter.style.display = on ? "" : "none"; if (!on) this._lvl = -1; }
    /** Input level: rms (0..1, linear) -> -60..0 dBFS bar; "clip" above -1 dBFS peak. */
    setLevel(rms, peak) {
      const db = 20 * Math.log10(Math.max(1e-6, rms)), u = Math.max(0, Math.min(1, (db + 60) / 60));
      const q = Math.round(u * 50) / 50;
      if (q === this._lvl) return;
      this._lvl = q;
      this.meterBar.style.transform = `scaleX(${1 - q})`;
      this.meter.classList.toggle("is-hot", peak > 0.89);
      this.meter.classList.toggle("is-low", db < -45);
    }
    /** Streak / accuracy chip; `sum` = HitJudge.summary() or null to hide. */
    setJudge(sum) {
      if (!sum) { this.score.style.display = "none"; return; }
      this.score.style.display = "";
      const acc = sum.accuracy == null ? "\u2013" : Math.round(100 * sum.accuracy) + "%";
      this.score.innerHTML = `<span class="rs-hw-score-streak">${sum.streak}</span><span>streak` +
        (sum.multiplier > 1 ? ` <b class="rs-hw-score-mult">\u00d7${sum.multiplier}</b>` : "") + `</span>` +
        `<span class="rs-hw-score-acc">${acc}</span><span>${sum.hits} hit \u00b7 ${sum.misses} missed</span>` +
        `<span class="rs-hw-score-pts">${(sum.score || 0).toLocaleString()}</span><span>points</span>`;
    }
    update(idx, sections) {
      if (idx === this._sec) return;
      this._sec = idx;
      if (idx < 0) { this.pill.style.display = "none"; return; }
      this.pill.style.display = "";
      this.pill.textContent = sections.label[idx] || sections.name[idx] || "";
      this.pill.style.setProperty("--sec", sectionColor(sections.name[idx]));
    }
  }

  // ---- lyrics -------------------------------------------------------------------------
  class LyricsView {
    constructor(parent) {
      this.root = h("div", "rs-hw-lyrics", parent);
      this.cur = h("div", "rs-hw-lyrics-cur", this.root);
      this.next = h("div", "rs-hw-lyrics-next", this.root);
      this.lines = []; this.visible = true; this._line = -2; this._word = -2;
    }
    setVocals(v) {
      this.lines = []; this._line = -2; this._word = -2;
      if (v && v.t && v.t.length) {
        for (let i = 0; i < v.t.length; i++) {
          const li = v.l[i];
          if (!this.lines[li]) this.lines[li] = { words: [] };
          this.lines[li].words.push({ t: v.t[i], d: v.d[i], w: v.w[i], j: !!v.j[i] });
        }
        this.lines = this.lines.filter(Boolean);
        for (const L of this.lines) {
          L.start = L.words[0].t;
          const last = L.words[L.words.length - 1];
          L.end = last.t + Math.max(last.d, 0.3);
          L.text = L.words.map((w) => w.w + (w.j ? "" : " ")).join("").trim();
        }
        this.starts = this.lines.map((L) => L.start);
      }
      this._render(-1, -1);
    }
    setVisible(v) { this.visible = v; this.root.style.display = v && this.lines.length ? "" : "none"; }
    update(t) {
      if (!this.visible || !this.lines.length) return;
      // The line being sung stays up until it has finished (or the next line is
      // 0.15 s away); then the next line is shown up to 1.2 s ahead. A finished
      // line lingers 1.5 s when nothing follows soon.
      const L = this.lines, n = L.length;
      let li = lowerBound(this.starts, t + 1e-6) - 1;          // last line that has started
      if (li < 0) li = L[0].start - t < 1.2 ? 0 : -1;
      else {
        const nx = li + 1 < n ? L[li + 1] : null;
        const soon = nx && nx.start - t < 1.2;
        if (soon && t >= Math.min(L[li].end, nx.start - 0.15)) li++;
        else if (t > L[li].end + 1.5) li = -1;
      }
      let wi = -1;
      if (li >= 0) {
        const W = this.lines[li].words;
        for (let k = 0; k < W.length && W[k].t <= t; k++) wi = k;
      }
      if (li !== this._line) this._render(li, wi);
      else if (wi !== this._word) this._mark(wi);
    }
    _render(li, wi) {
      this._line = li; this._word = -2;
      this.cur.innerHTML = ""; this.spans = [];
      if (li < 0) { this.next.textContent = ""; this.root.classList.add("is-idle"); return; }
      this.root.classList.remove("is-idle");
      for (const w of this.lines[li].words) {
        const sp = h("span", "rs-hw-syl", this.cur, w.w);
        this.spans.push(sp);
        if (!w.j) this.cur.appendChild(document.createTextNode(" "));
      }
      const nx = this.lines[li + 1];
      this.next.textContent = nx ? nx.text : "";
      this._mark(wi);
    }
    _mark(wi) {
      this._word = wi;
      this.spans.forEach((sp, k) => { sp.className = "rs-hw-syl" + (k < wi ? " is-sung" : k === wi ? " is-now" : ""); });
    }
  }

  // ---- practice lead-in countdown --------------------------------------------------------
  class CountdownView {
    constructor(parent) { this.root = h("div", "rs-hw-countdown", parent); this._v = null; }
    update(secondsLeft) {
      const v = secondsLeft == null ? null : Math.ceil(secondsLeft - 1e-3);
      if (v === this._v) return;
      this._v = v;
      this.root.style.display = v == null || v < 1 ? "none" : "block";   // (the stylesheet hides it by default)
      if (v != null && v >= 1) { this.root.textContent = v; this.root.classList.remove("is-tick"); void this.root.offsetWidth; this.root.classList.add("is-tick"); }
    }
  }

  // ---- transport -------------------------------------------------------------------------
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    restart: '<svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>',
    loop: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
  };
  class TransportView {
    constructor(parent, on) {
      this.on = on;
      const bar = (this.root = h("div", "rs-hw-transport", parent));
      this.btnPlay = this._btn(bar, "rs-hw-btn rs-hw-btn-play", ICON.play, "Play / pause (Space)", () => on.toggle());
      this._btn(bar, "rs-hw-btn", ICON.restart, "Back to start (Home) / loop start", () => on.restart());
      this.time = h("span", "rs-hw-time", bar);
      this.strip = h("div", "rs-hw-strip", bar);
      this.segs = h("div", "rs-hw-segs", this.strip);
      this.scores = h("div", "rs-hw-secscores", this.strip);      // per-section accuracy ticks
      this.loopBand = h("div", "rs-hw-loopband", this.strip);
      this.future = h("div", "rs-hw-future", this.strip);
      this.head = h("div", "rs-hw-head", this.strip);
      this.hover = h("div", "rs-hw-hovertip", this.strip);
      this.loopBadge = h("span", "rs-hw-badge rs-hw-badge-loop", bar);
      this.loopBadge.innerHTML = ICON.loop + "<b></b>";
      this.loopBadge.title = "Practice loop (L to toggle)";
      this.loopBadge.addEventListener("click", () => on.toggleLoop());
      this.rate = h("span", "rs-hw-badge rs-hw-badge-rate", bar);
      this.duration = 0; this.sections = null;
      this._bindStrip();
    }
    _btn(parent, cls, svg, title, fn) {
      const b = h("button", cls, parent);
      b.type = "button"; b.innerHTML = svg; b.title = title; b.setAttribute("aria-label", title);
      b.addEventListener("click", (e) => { fn(); e.currentTarget.blur(); });
      return b;
    }
    _bindStrip() {
      const at = (e) => { const r = this.strip.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * this.duration; };
      this.strip.addEventListener("pointerdown", (e) => {
        this.strip.setPointerCapture(e.pointerId);
        this.on.seek(at(e));
        const move = (ev) => this.on.seek(at(ev));
        const up = () => { this.strip.removeEventListener("pointermove", move); this.strip.removeEventListener("pointerup", up); };
        this.strip.addEventListener("pointermove", move);
        this.strip.addEventListener("pointerup", up);
      });
      this.strip.addEventListener("dblclick", (e) => { const i = this._sectionAt(at(e)); if (i >= 0) this.on.pickSection(i); });
      this.strip.addEventListener("mousemove", (e) => {
        const t = at(e), i = this._sectionAt(t), r = this.strip.getBoundingClientRect();
        this.hover.textContent = (i >= 0 ? this.sections.label[i] + "  \u00b7  " : "") + fmt(t);
        this.hover.style.left = Math.max(0, Math.min(r.width, e.clientX - r.left)) + "px";
      });
    }
    _sectionAt(t) {
      const s = this.sections;
      if (!s || !s.n) return -1;
      return Math.max(0, lowerBound(s.t, t + 1e-6) - 1);
    }
    setChart(chart, duration) {
      this.sections = chart ? chart.sections : null;
      this.duration = duration || 1;
      this.segs.innerHTML = "";
      this.setSectionScores(null);
      if (!chart) return;
      const s = chart.sections, d = this.duration;
      for (let i = 0; i < s.n; i++) {
        const t0 = s.t[i], t1 = i + 1 < s.n ? s.t[i + 1] : d;
        const seg = h("div", "rs-hw-seg", this.segs);
        seg.style.left = (100 * t0 / d) + "%";
        seg.style.width = Math.max(0, 100 * (t1 - t0) / d) + "%";
        seg.style.background = sectionColor(s.name[i]);
        seg.title = `${s.label[i] || s.name[i]}  \u00b7  ${fmt(t0)}\nclick: jump  \u00b7  double-click: practice this section`;
      }
    }
    /** Accuracy per section (array of 0..1 | null) as coloured ticks above the strip; null clears. */
    setSectionScores(acc) {
      const key = acc ? acc.map((a) => (a == null ? "-" : Math.round(a * 20))).join(",") : "";
      if (key === this._scoreKey) return;
      this._scoreKey = key;
      this.scores.innerHTML = "";
      const s = this.sections;
      if (!acc || !s) return;
      for (let i = 0; i < s.n && i < acc.length; i++) {
        if (acc[i] == null) continue;
        const t0 = s.t[i], t1 = i + 1 < s.n ? s.t[i + 1] : this.duration;
        const e = h("div", "rs-hw-secscore", this.scores);
        e.style.left = (100 * t0 / this.duration) + "%";
        e.style.width = Math.max(0, 100 * (t1 - t0) / this.duration) + "%";
        e.style.background = accuracyColor(acc[i]);
        e.title = `${s.label[i] || s.name[i]}: ${Math.round(100 * acc[i])}%`;
      }
    }
    setLoop(p) {
      const on = p && p.loop && p.end > p.start && this.duration > 0;
      this.loopBand.style.display = on ? "block" : "none";
      if (on) {
        this.loopBand.style.left = (100 * p.start / this.duration) + "%";
        this.loopBand.style.width = (100 * (p.end - p.start) / this.duration) + "%";
      }
      this.loopBadge.classList.toggle("is-on", !!on);
    }
    update(st) {
      // Swap the icon only when the state changes. update() runs every 100 ms; replacing
      // the button's SVG that often detached the element under a pressed mouse button, and
      // the browser then dropped the click (mousedown and mouseup on different nodes):
      // "the pause button sometimes does nothing, Space works". The CSS also makes the
      // icons transparent to the pointer, so the button itself is always the target.
      if (st.playing !== this._shownPlaying) {
        this._shownPlaying = st.playing;
        this.btnPlay.innerHTML = st.playing ? ICON.pause : ICON.play;
        this.btnPlay.classList.toggle("is-playing", st.playing);
      }
      this.time.textContent = `${fmt(st.t)} / ${fmt(st.duration)}`;
      this.root.classList.toggle("is-silent", !st.hasAudio);
      const u = st.duration ? Math.max(0, Math.min(1, st.t / st.duration)) : 0;
      this.head.style.left = (100 * u) + "%";
      this.future.style.left = (100 * u) + "%";
      this.rate.textContent = st.rate !== 1 ? `${Math.round(st.rate * 100)}%` : "";
      this.rate.style.display = st.rate !== 1 ? "" : "none";
      this.loopBadge.querySelector("b").textContent = st.loopCount ? `\u00d7${st.loopCount}` : "";
    }
  }

  // ---- hit feedback ("Perfect" / "Early" / "Late") ---------------------------------------
  class FeedbackView {
    constructor(parent) { this.root = h("div", "rs-hw-feedback", parent); this.visible = true; }
    /** r = HitJudge result ({type: "hit", grade, deltaMs} | {type: "miss"}) */
    show(r) {
      if (!this.visible || !r || (r.type !== "hit" && r.type !== "miss")) return;
      const g = r.type === "miss" ? "miss" : r.grade;
      this.root.textContent = g === "perfect" ? "Perfect" : g === "miss" ? "Missed"
        : `${g === "early" ? "Early" : "Late"} ${Math.abs(r.deltaMs)} ms`;
      this.root.className = "rs-hw-feedback is-" + g;
      void this.root.offsetWidth;                                   // restart the animation
      this.root.classList.add("is-on");
    }
    clear() { this.root.className = "rs-hw-feedback"; }
  }

  // ---- results card -------------------------------------------------------------------------
  /**
   * on = { close(), replay(), practice(sectionIndex) }. show(result, info):
   * result = HitJudge.result(); info = { kind: "song" | "loop", title, arrangement, pass }.
   * ack({ newBest, best, previous }) adds the personal-best line once R has stored the run.
   */
  class ResultsView {
    constructor(parent, on) {
      this.on = on;
      this.root = h("div", "rs-hw-results", parent);
      this.root.style.display = "none";
      this.root.addEventListener("pointerdown", (e) => { if (e.target === this.root) this.hide(); });
    }
    get open() { return this.root.style.display !== "none"; }
    hide() { if (this.open) { this.root.style.display = "none"; this.on.close && this.on.close(); } }
    show(r, info) {
      info = info || {};
      this.result = r;
      const pct = (x) => (x == null ? "\u2013" : Math.round(100 * x) + "%");
      const box = h("div", "rs-hw-results-card");
      this.root.innerHTML = ""; this.root.appendChild(box);
      h("div", "rs-hw-results-kicker", box, info.kind === "loop" ? `Practice loop \u00b7 pass ${info.pass || 1}` : "Song complete");
      h("div", "rs-hw-results-title", box, [info.title, info.arrangement].filter(Boolean).join(" \u00b7 "));
      const big = h("div", "rs-hw-results-big", box);
      const acc = h("span", "rs-hw-results-acc", big, pct(r.accuracy));
      acc.style.color = r.accuracy == null ? "" : accuracyColor(r.accuracy);
      h("span", "rs-hw-results-acc-label", big, "accuracy");
      this.best = h("div", "rs-hw-results-best", box);
      const grid = h("div", "rs-hw-results-grid", box);
      const stat = (v, label) => { const c = h("div", "rs-hw-results-stat", grid); h("b", null, c, v); h("span", null, c, label); };
      stat((r.score || 0).toLocaleString(), "points");
      stat(`${r.hits} / ${r.hits + r.misses}`, "notes hit");
      stat(String(r.bestStreak), "best streak");
      stat(String(r.perfect), "perfect (\u00b1" + Math.round(1000 * (info.perfectWindow || 0.04)) + " ms)");
      stat(`${r.early} / ${r.late}`, "early / late");
      stat(r.medianDeltaMs == null ? "\u2013" : `${r.medianDeltaMs > 0 ? "+" : ""}${r.medianDeltaMs} ms`, "median timing");
      const secs = (r.sections || []).filter((x) => x.total > 0);
      let weakest = null;
      if (secs.length > 1) {
        const list = h("div", "rs-hw-results-secs" + (secs.length > 8 ? " is-many" : ""), box);
        for (const x of secs) {
          const row = h("div", "rs-hw-results-sec", list);
          h("span", "rs-hw-results-sec-name", row, x.label);
          const bar = h("span", "rs-hw-results-sec-bar", row);
          const fill = h("i", null, bar);
          fill.style.width = (100 * x.accuracy) + "%"; fill.style.background = accuracyColor(x.accuracy);
          h("span", "rs-hw-results-sec-pct", row, pct(x.accuracy));
          if (x.total >= 3 && (!weakest || x.accuracy < weakest.accuracy)) weakest = x;
        }
      }
      const btns = h("div", "rs-hw-results-btns", box);
      const btn = (label, cls, fn) => { const b = h("button", "rs-hw-results-btn " + cls, btns, label); b.type = "button";
                                         b.addEventListener("click", () => { this.root.style.display = "none"; fn(); }); return b; };
      btn(info.kind === "loop" ? "Keep looping" : "Play again", "is-primary", () => this.on.replay && this.on.replay());
      if (weakest && weakest.accuracy < 0.95) btn(`Practise ${weakest.label} (${pct(weakest.accuracy)})`, "", () => this.on.practice && this.on.practice(weakest.index));
      btn("Close", "", () => this.on.close && this.on.close());
      this.root.style.display = "";
    }
    ack(a) {
      if (!this.open || !a) return;
      const pct = (x) => Math.round(100 * x) + "%";
      if (a.newBest) { this.best.textContent = a.previous != null ? `New personal best! (was ${pct(a.previous)})` : "First run recorded \u2014 new personal best!"; this.best.className = "rs-hw-results-best is-new"; }
      else if (a.best != null) { this.best.textContent = `Personal best: ${pct(a.best)}`; this.best.className = "rs-hw-results-best"; }
    }
  }

  Object.assign(NS, { HudView, LyricsView, CountdownView, TransportView, FeedbackView, ResultsView });
})(window);

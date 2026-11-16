/* ---------------------------------------------------------------------------
 * rsc-difficulty.js -- Dynamic Difficulty (DD): the difficulty levels of a chart.
 *
 * Rocksmith stores a chart once per difficulty level (<level difficulty="k">).
 * Every phrase has a max difficulty m; a player at level k plays, in each phrase
 * iteration, the content of level min(k, m). The hardest chart is every phrase
 * at its own m.
 *
 * In the Creator an arrangement `a` keeps:
 *   a.doc            the arrangement document the editor works on; a.doc.levels[0]
 *                    is the *view*: the chart at one difficulty (see below)
 *   a.dd             null (one level: no difficulty levels), or
 *                    { levels: [level 0 .. level M] (the stored difficulty levels),
 *                      view:   null (the hardest chart) | k (the chart at level k),
 *                      mode:   "keep" (save the levels as they are) |
 *                              "auto" (rebuild the easier levels from the hardest when saving) |
 *                              "flat" (save the hardest chart as one level),
 *                      auto:   options of the generator, dirty: {level: true} }
 *   a.doc.phrases[p].maxDifficulty, phraseIterations[i].heroLevels, newLinkedDiffs: as in the file.
 *
 * The view is cut out of the stored levels phrase iteration by phrase iteration
 * (E.ddExtract) and written back the same way (E.ddCommit), so an edit made while
 * looking at level 3 lands in level 3 of the phrases that have it (and in their
 * top level where m < 3).
 *
 * E.ddGenerate builds the levels of a chart from its hardest version -- the
 * "auto difficulty" -- with rules measured on hand-made DD in the sample songs:
 * easier levels keep a subset of the events (the metrically strongest first:
 * downbeats, beats, eighths...), ~12 % of them at level 0 rising linearly to all;
 * chords lose their upper strings (one note at the easiest levels); techniques,
 * frets and sustains of the notes that stay are kept; phrases with more events
 * get more levels (0 for one or two events); hero levels follow the toolkit's
 * rule (easy 1 or 2, hard = m, medium between).
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const E = root.RSCreator.engine;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const emptyLevel = (d) => ({ difficulty: d, notes: [], chords: [], fretHandMutes: [], anchors: [], handShapes: [] });
  E.ddEmptyLevel = emptyLevel;
  const KINDS = ["notes", "chords", "anchors", "handShapes", "fretHandMutes"];
  const tOf = (kind, x) => (kind === "handShapes" ? x.startTime : x.time);
  const byTime = (kind) => (p, q) => tOf(kind, p) - tOf(kind, q) || (kind === "notes" ? p.string - q.string : 0);

  // ---- phrase iterations as time ranges ---------------------------------------------------------------------
  /**
   * The phrase iterations of a document as time ranges, in time order:
   * [{i (index in phraseIterations), phraseId, start, t0, t1}]. The first range
   * starts at -Infinity (anything before the first phrase belongs to it), the
   * last ends at +Infinity.
   */
  E.ddRanges = function (doc) {
    const its = (doc.phraseIterations || []).map((it, i) => ({ i, phraseId: it.phraseId, start: it.time })).sort((a, b) => a.start - b.start || a.i - b.i);
    if (!its.length) return [{ i: -1, phraseId: -1, start: 0, t0: -Infinity, t1: Infinity }];
    return its.map((it, j) => Object.assign(it, { t0: j === 0 ? -Infinity : it.start, t1: j + 1 < its.length ? its[j + 1].start : Infinity }));
  };
  /** Max difficulty of a phrase, clamped to the levels there are (0 .. top). */
  function maxOf(doc, phraseId, top) {
    const p = doc.phrases && doc.phrases[phraseId];
    return Math.max(0, Math.min(top, p ? p.maxDifficulty | 0 : top));
  }
  /** The level a player at level k plays in a phrase with max difficulty m (k null: the hardest). */
  const effective = (k, m) => (k == null ? m : Math.min(k, m));
  const inRange = (r) => (t) => t >= r.t0 && t < r.t1;
  function slice(level, r) {
    const f = inRange(r), out = {};
    for (const k of KINDS) out[k] = (level[k] || []).filter((x) => f(tOf(k, x)));
    return out;
  }
  /** The anchor in force at time t in a level (the last one at or before t). */
  function anchorAt(level, t) {
    let a = null;
    for (const x of level.anchors) { if (x.time <= t + 1e-6) a = x; else break; }
    return a;
  }

  // ---- the view: the chart at one difficulty -----------------------------------------------------------------------
  /**
   * The chart a player at level k plays (k null: the hardest chart), as one level
   * (difficulty 0). Every phrase iteration starts with the anchor its level has
   * in force there (tagged _carry, dropped again when the view is written back).
   */
  E.ddExtract = function (levels, doc, k) {
    const top = levels.length - 1, out = emptyLevel(0);
    const byDiff = levels.slice().sort((a, b) => a.difficulty - b.difficulty);
    for (const r of E.ddRanges(doc)) {
      const lv = byDiff[effective(k, r.phraseId < 0 ? top : maxOf(doc, r.phraseId, top))];
      if (!lv) continue;
      const s = slice(lv, r);
      for (const kind of KINDS) for (const x of s[kind]) out[kind].push(clone(x));
      // the iteration's anchor
      if (r.i >= 0 && (s.notes.length || s.chords.length) && !s.anchors.some((a) => Math.abs(a.time - r.start) < 1e-3)) {
        const act = anchorAt(lv, r.start);
        if (act) out.anchors.push({ time: r.start, fret: act.fret, width: act.width, _carry: 1 });
      }
    }
    for (const kind of KINDS) out[kind].sort(byTime(kind));
    return out;
  };

  /** Sorted levels 0..M (missing ones empty) from a document's levels. */
  E.ddNormalizeLevels = function (levels) {
    const M = Math.max(0, ...levels.map((l) => l.difficulty | 0));
    const out = [];
    for (let d = 0; d <= M; d++) {
      const l = levels.find((x) => (x.difficulty | 0) === d);
      out.push(l ? Object.assign(emptyLevel(d), l, { difficulty: d }) : emptyLevel(d));
    }
    return out;
  };

  /**
   * Set up an arrangement from a full (multi-level) document: a.dd holds its
   * levels, a.doc the hardest chart as the view. One level: a.dd = null.
   */
  E.ddInit = function (a, doc) {
    const ds = (doc.levels || []).map((l) => l.difficulty | 0).sort((p, q) => p - q);
    if (ds.length <= 1 || ds.some((v, i) => v !== i)) { a.dd = null; a.doc = E.arrMergeLevels(doc); a.levels = Math.max(1, ds.length); return a; }
    const levels = E.ddNormalizeLevels(doc.levels);
    const d = clone(Object.assign({}, doc, { levels: [] }));
    d.levels = [E.ddExtract(levels, d, null)];
    a.doc = d;
    a.dd = { levels, view: null, mode: "keep", auto: {}, dirty: {} };
    a.levels = levels.length;
    return a;
  };

  /**
   * Write the view back into the stored levels (phrase iteration by phrase
   * iteration, into the level each one shows). -> true when something changed.
   */
  E.ddCommit = function (a) {
    if (!a.dd) return false;
    const doc = a.doc, view = doc.levels[0], levels = a.dd.levels, top = levels.length - 1;
    let changed = false;
    for (const r of E.ddRanges(doc)) {
      const e = effective(a.dd.view, r.phraseId < 0 ? top : maxOf(doc, r.phraseId, top));
      const lv = levels[e];
      if (!lv) continue;
      const nv = slice(view, r);
      // an anchor carried in by the view is dropped unless it was changed
      nv.anchors = nv.anchors.filter((x) => {
        if (!x._carry) return true;
        const act = anchorAt({ anchors: lv.anchors.filter((y) => y.time < x.time - 1e-6) }, x.time);
        return !(act && act.fret === x.fret && act.width === x.width);
      }).map((x) => { const y = clone(x); delete y._carry; return y; });
      const old = slice(lv, r);
      let same = true;
      for (const k of KINDS) if (canon(old[k]) !== canon(nv[k])) { same = false; break; }
      if (same) continue;
      const f = inRange(r);
      for (const k of KINDS) {
        lv[k] = (lv[k] || []).filter((x) => !f(tOf(k, x))).concat(clone(nv[k]));
        lv[k].sort(byTime(k));
      }
      a.dd.dirty = a.dd.dirty || {};
      a.dd.dirty[e] = true;
      changed = true;
    }
    return changed;
  };

  /** Order-independent text of a list of items (notes at one time come in any string order). */
  function canon(list) { return list.map((x) => JSON.stringify(x)).sort().join("\n"); }

  /** Show the chart at level k (null: the hardest) in the view. */
  E.ddShow = function (a, k) {
    if (!a.dd) return;
    E.ddCommit(a);
    const top = a.dd.levels.length - 1;
    a.dd.view = k == null ? null : Math.max(0, Math.min(top, k | 0));
    a.doc.levels[0] = E.ddExtract(a.dd.levels, a.doc, a.dd.view);
  };

  /** Re-cut the view from the stored levels (after they changed). */
  function refreshView(a) {
    if (!a.dd) return;
    const top = a.dd.levels.length - 1;
    if (a.dd.view != null && a.dd.view > top) a.dd.view = top;
    a.doc.levels[0] = E.ddExtract(a.dd.levels, a.doc, a.dd.view);
    a.levels = a.dd.levels.length;
  }

  // ---- hero levels (the game's easy / medium / hard per phrase) ---------------------------------------------------
  /** The toolkit's hero levels for a phrase of max difficulty m: easy 1 or 2, hard m, medium between. */
  E.ddHeroLevels = function (m) {
    if (!(m > 0)) return [];
    const easy = m <= 3 ? 1 : 2, hard = m, medium = Math.floor((easy + hard) / 2 + 0.5);
    return [{ difficulty: easy, hero: 1 }, { difficulty: medium, hero: 2 }, { difficulty: hard, hero: 3 }];
  };
  /** Hero levels of every iteration that has none or inconsistent ones (all, with force). */
  E.ddFixHeroLevels = function (doc, force) {
    for (const it of doc.phraseIterations || []) {
      const m = (doc.phrases[it.phraseId] || {}).maxDifficulty | 0;
      const h = it.heroLevels || [];
      const ok = m === 0 ? h.every((x) => x.difficulty === 0) :
        h.length === 3 && h.every((x) => x.difficulty >= 0 && x.difficulty <= m) && (h.find((x) => x.hero === 3) || {}).difficulty === m;
      if (force || !ok) it.heroLevels = E.ddHeroLevels(m);
    }
    return doc;
  };

  // ---- the document to save ------------------------------------------------------------------------------------------
  /** Remove what lies above each phrase's max difficulty, drop unused top levels. */
  function tidy(doc) {
    let levels = doc.levels;
    const top = levels.length - 1;
    for (const p of doc.phrases) p.maxDifficulty = Math.max(0, Math.min(top, p.maxDifficulty | 0));
    for (const r of E.ddRanges(doc)) {
      const m = r.phraseId < 0 ? top : maxOf(doc, r.phraseId, top), f = inRange(r);
      for (let d = m + 1; d <= top; d++) for (const k of KINDS) levels[d][k] = levels[d][k].filter((x) => !f(tOf(k, x)));
    }
    const used = Math.max(0, ...E.ddRanges(doc).map((r) => (r.phraseId < 0 ? 0 : maxOf(doc, r.phraseId, top))));
    doc.levels = levels.slice(0, used + 1);
    for (const l of doc.levels) for (const x of l.anchors) delete x._carry;
    return doc;
  }

  /**
   * The arrangement document to save (compile + serialise): the stored levels
   * ("keep"), levels rebuilt from the hardest chart ("auto"), or the hardest chart
   * as one level ("flat" or no levels).
   */
  E.ddSaveDoc = function (a) {
    if (!a.dd) {
      const d = clone(a.doc);
      for (const x of d.levels[0].anchors) delete x._carry;
      return d;
    }
    E.ddCommit(a);
    const d = clone(Object.assign({}, a.doc, { levels: [] }));
    const hard = E.ddExtract(a.dd.levels, a.doc, null);
    if (a.dd.mode === "flat") {
      for (const x of hard.anchors) delete x._carry;
      d.levels = [hard];
      d.phrases.forEach((p) => { p.maxDifficulty = 0; });
      d.phraseIterations.forEach((p) => { p.heroLevels = []; });
      d.newLinkedDiffs = []; d.linkedDiffs = [];
      return d;
    }
    if (a.dd.mode === "auto") {
      d.levels = [hard];
      return E.ddGenerate(d, a.dd.auto || {});
    }
    d.levels = clone(a.dd.levels);
    tidy(d);
    E.ddFixHeroLevels(d, false);
    if (d.levels.length <= 1) { d.newLinkedDiffs = []; d.linkedDiffs = []; }
    return d;
  };

  /** A summary: {levels, phrases: [{id, name, max, iterations: [times]}], counts: [events per level]}. */
  E.ddInfo = function (a) {
    const doc = a.doc, top = a.dd ? a.dd.levels.length - 1 : 0;
    const phrases = (doc.phrases || []).map((p, id) => ({ id, name: p.name, max: a.dd ? maxOf(doc, id, top) : 0, iterations: [] }));
    for (const r of E.ddRanges(doc)) if (r.phraseId >= 0 && phrases[r.phraseId]) phrases[r.phraseId].iterations.push(r.start);
    const counts = a.dd ? a.dd.levels.map((l) => l.notes.length + l.chords.length) : [doc.levels[0].notes.length + doc.levels[0].chords.length];
    return { levels: top + 1, view: a.dd ? a.dd.view : null, mode: a.dd ? a.dd.mode : "flat", phrases, counts };
  };
  /**
   * What the hardest chart has and the view leaves out (to draw as ghosts): the
   * notes and chords of every phrase the view shows below its top level that are
   * not in the view. -> {notes, chords}
   */
  E.ddGhost = function (a) {
    const out = { notes: [], chords: [] };
    if (!a.dd || a.dd.view == null) return out;
    const doc = a.doc, view = doc.levels[0], L = a.dd.levels, top = L.length - 1;
    const have = new Set(view.notes.map((n) => Math.round(n.time * 1000) + ":" + n.string));
    const haveC = new Set(view.chords.map((c) => Math.round(c.time * 1000)));
    for (const c of view.chords) for (const q of c.chordNotes || []) have.add(Math.round(c.time * 1000) + ":" + q.string);
    for (const r of E.ddRanges(doc)) {
      const m = r.phraseId < 0 ? top : maxOf(doc, r.phraseId, top);
      if (effective(a.dd.view, m) >= m) continue;
      const s = slice(L[m], r);
      for (const n of s.notes) if (!have.has(Math.round(n.time * 1000) + ":" + n.string)) out.notes.push(n);
      for (const c of s.chords) if (!haveC.has(Math.round(c.time * 1000))) out.chords.push(c);
    }
    return out;
  };

  /**
   * Notes and chords a player plays at each level 0..top (and, last, the full
   * chart): [n0, n1, ..., nTop, nFull]. Cached until the levels change.
   */
  E.ddPlayedCounts = function (a) {
    if (!a.dd) { const lv = a.doc.levels[0]; return [lv.notes.length + lv.chords.length]; }
    const L = a.dd.levels, doc = a.doc, top = L.length - 1;
    const key = L.map((l) => l.notes.length + "." + l.chords.length).join(",") + "|" + doc.phrases.map((p) => p.maxDifficulty).join(",") + "|" + doc.phraseIterations.length;
    if (a.dd._counts && a.dd._counts.key === key) return a.dd._counts.v;
    const R = E.ddRanges(doc).map((r) => Object.assign({}, r, { m: r.phraseId < 0 ? top : maxOf(doc, r.phraseId, top) }));
    const per = L.map((l) => R.map((r) => { const f = inRange(r); return l.notes.filter((x) => f(x.time)).length + l.chords.filter((x) => f(x.time)).length; }));
    const v = [];
    for (let k = 0; k <= top + 1; k++) v.push(R.reduce((s, r, j) => s + per[Math.min(k, r.m)][j], 0));
    Object.defineProperty(a.dd, "_counts", { value: { key, v }, enumerable: false, configurable: true, writable: true });
    return v;
  };

  /** The phrase iteration range at time t. */
  E.ddRangeAt = function (doc, t) {
    const R = E.ddRanges(doc);
    return R.find((r) => t >= r.t0 && t < r.t1) || R[0];
  };

  // ---- manual levels --------------------------------------------------------------------------------------------------
  const phraseSet = (doc, ids) => (ids == null ? new Set(doc.phrases.map((p, i) => i)) : new Set([].concat(ids)));
  /** Start levels on a chart that has one: level 0 = the chart (m = 0 everywhere). */
  function ensureDD(a) {
    if (a.dd) return;
    const lv = clone(a.doc.levels[0]);
    for (const x of lv.anchors) delete x._carry;
    lv.difficulty = 0;
    a.dd = { levels: [lv], view: null, mode: "keep", auto: {}, dirty: {} };
    for (const p of a.doc.phrases) p.maxDifficulty = 0;
  }

  /**
   * Insert a level in the phrases `ids` (null: all): level e = min(k, m) is
   * duplicated, the levels above it move up one, m grows by one. The new level
   * e is the copy to make easier; the hardest chart does not change.
   */
  E.ddInsertLevel = function (a, ids, k) {
    ensureDD(a);
    E.ddCommit(a);
    const doc = a.doc, L = a.dd.levels, set = phraseSet(doc, ids);
    const R = E.ddRanges(doc);
    for (const p of set) {
      const ph = doc.phrases[p];
      if (!ph) continue;
      const m = maxOf(doc, p, L.length - 1), e = Math.max(0, Math.min(m, k == null ? m : k | 0));
      if (m + 1 > L.length - 1) L.push(emptyLevel(L.length));
      for (const r of R) {
        if (r.phraseId !== p) continue;
        const f = inRange(r);
        for (let d = m; d >= e; d--) {
          const s = slice(L[d], r);
          for (const kd of KINDS) { L[d + 1][kd] = L[d + 1][kd].filter((x) => !f(tOf(kd, x))).concat(clone(s[kd])); L[d + 1][kd].sort(byTime(kd)); }
        }
      }
      ph.maxDifficulty = m + 1;
      for (let d = e; d <= m + 1; d++) a.dd.dirty[d] = true;
    }
    E.ddFixHeroLevels(doc, true);
    refreshView(a);
  };

  /**
   * Remove level e = min(k, m) from the phrases `ids` (null: all) that have more
   * than one: the levels above it move down one, m shrinks by one. Removing the
   * top level makes the level below it the hardest.
   */
  E.ddRemoveLevel = function (a, ids, k) {
    if (!a.dd) return;
    E.ddCommit(a);
    const doc = a.doc, L = a.dd.levels, set = phraseSet(doc, ids);
    const R = E.ddRanges(doc);
    for (const p of set) {
      const ph = doc.phrases[p];
      if (!ph) continue;
      const m = maxOf(doc, p, L.length - 1);
      if (m < 1) continue;
      const e = Math.max(0, Math.min(m, k == null ? m : k | 0));
      for (const r of R) {
        if (r.phraseId !== p) continue;
        const f = inRange(r);
        for (let d = e; d <= m; d++) {
          const s = d + 1 <= m ? slice(L[d + 1], r) : { notes: [], chords: [], anchors: [], handShapes: [], fretHandMutes: [] };
          for (const kd of KINDS) { L[d][kd] = L[d][kd].filter((x) => !f(tOf(kd, x))).concat(clone(s[kd])); L[d][kd].sort(byTime(kd)); }
        }
      }
      ph.maxDifficulty = m - 1;
      for (let d = e; d <= m; d++) a.dd.dirty[d] = true;
    }
    const used = Math.max(0, ...R.map((r) => (r.phraseId < 0 ? 0 : maxOf(doc, r.phraseId, L.length - 1))));
    a.dd.levels = L.slice(0, used + 1);
    E.ddFixHeroLevels(doc, true);
    if (a.dd.levels.length <= 1) { const lv = a.dd.levels[0]; a.dd = null; a.doc.levels[0] = clone(lv); a.levels = 1; return; }
    refreshView(a);
  };

  /**
   * How the levels are saved: "keep" (as they are), "auto" (rebuilt from the hardest
   * chart when saving; built now if the chart has none), "flat" (the hardest chart as
   * one level; the stored levels stay, to switch back).
   */
  E.ddSetMode = function (a, mode, opts) {
    if (mode === "flat") { if (a.dd) a.dd.mode = "flat"; return; }
    if (!a.dd) { if (mode !== "auto") return; E.ddAuto(a, opts || {}); if (!a.dd) return; }
    a.dd.mode = mode;
    if (opts && opts.maxLevels) a.dd.auto = Object.assign({}, a.dd.auto, { maxLevels: opts.maxLevels });
  };

  /** One level again: the hardest chart, no difficulty levels. */
  E.ddFlatten = function (a) {
    if (!a.dd) return;
    E.ddCommit(a);
    const hard = E.ddExtract(a.dd.levels, a.doc, null);
    for (const x of hard.anchors) delete x._carry;
    a.doc.levels[0] = hard;
    a.doc.phrases.forEach((p) => { p.maxDifficulty = 0; });
    a.doc.phraseIterations.forEach((p) => { p.heroLevels = []; });
    a.doc.newLinkedDiffs = []; a.doc.linkedDiffs = [];
    a.dd = null; a.levels = 1;
  };

  /** Apply fn(level) to every stored level (and the view), e.g. to move the whole chart in time. */
  E.ddEachLevel = function (a, fn) {
    if (!a.dd) { fn(a.doc.levels[0]); return; }
    E.ddCommit(a);
    for (const l of a.dd.levels) fn(l);
    refreshView(a);
  };

  /**
   * New phrases (e.g. from edited sections) for a chart with levels: every level
   * is first made complete (the chart at level k), then cut again along the new
   * phrase iterations; a new phrase gets the highest max difficulty of the old
   * iterations it overlaps. `rephrase(doc)` changes doc.phrases / phraseIterations.
   */
  E.ddRephrase = function (a, rephrase) {
    if (!a.dd) { rephrase(a.doc); return; }
    E.ddCommit(a);
    const oldDoc = { phrases: clone(a.doc.phrases), phraseIterations: clone(a.doc.phraseIterations) };
    const L = a.dd.levels, top = L.length - 1;
    const full = L.map((l, k) => E.ddExtract(L, oldDoc, k));
    const oldR = E.ddRanges(oldDoc).map((r) => Object.assign(r, { m: r.phraseId < 0 ? top : maxOf(oldDoc, r.phraseId, top) }));
    rephrase(a.doc);
    const doc = a.doc, newR = E.ddRanges(doc);
    const pm = new Array(doc.phrases.length).fill(0);
    for (const r of newR) {
      if (r.phraseId < 0) continue;
      let m = 0;
      for (const o of oldR) if (o.t0 < r.t1 && o.t1 > r.t0) m = Math.max(m, o.m);
      pm[r.phraseId] = Math.max(pm[r.phraseId], m);
    }
    doc.phrases.forEach((p, i) => { p.maxDifficulty = pm[i]; });
    const levels = L.map((l, k) => emptyLevel(k));
    for (const r of newR) {
      const m = r.phraseId < 0 ? top : pm[r.phraseId];
      for (let k = 0; k <= m; k++) {
        const s = slice(full[k], r);
        for (const kd of KINDS) for (const x of s[kd]) { const y = clone(x); delete y._carry; levels[k][kd].push(y); }
      }
    }
    for (const l of levels) for (const kd of KINDS) l[kd].sort(byTime(kd));
    a.dd.levels = levels;
    for (let k = 0; k < levels.length; k++) a.dd.dirty[k] = true;
    doc.newLinkedDiffs = []; doc.linkedDiffs = [];
    E.ddFixHeroLevels(doc, true);
    refreshView(a);
  };

  // ---- automatic levels -------------------------------------------------------------------------------------------------
  /** Metric weight of time t on a beat grid: downbeat 10, strong beat 8, beat 7, 8th 5, triplet 4, 16th 3, else 2. */
  function metricOf(beats, t) {
    if (beats.length < 2) return { w: 2, beatLen: 0.5 };
    let lo = 0, hi = beats.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (beats[mid].time <= t + 1e-4) lo = mid; else hi = mid - 1; }
    const b = beats[lo], nb = beats[Math.min(beats.length - 1, lo + 1)];
    const beatLen = nb.time > b.time ? nb.time - b.time : (lo > 0 ? b.time - beats[lo - 1].time : 0.5);
    const fr = (t - b.time) / beatLen;
    const near = (x, tol) => Math.abs(fr - x) < (tol || 0.07);
    if (t < b.time - 1e-4) return { w: 2, beatLen };
    if (near(0) || near(1)) {
      const on = near(1) && lo + 1 < beats.length ? beats[lo + 1] : b;
      const idx = near(1) ? lo + 1 : lo;
      if (on.measure >= 0) return { w: 10, beatLen };
      // beat position in the bar: the middle of an even bar is strong
      let s = idx; while (s > 0 && beats[s].measure < 0) s--;
      let e = idx + 1; while (e < beats.length && beats[e].measure < 0) e++;
      const per = e - s, pos = idx - s;
      return { w: per % 2 === 0 && pos === per / 2 ? 8 : 7, beatLen };
    }
    if (near(0.5)) return { w: 5, beatLen };
    if (near(1 / 3, 0.05) || near(2 / 3, 0.05)) return { w: 4, beatLen };
    if (near(0.25) || near(0.75)) return { w: 3, beatLen };
    return { w: 2, beatLen };
  }

  /** Weights of the event ranking (metric weight + these). */
  E.DD_WEIGHTS = { dur: 1, durCap: 1.5, first: 0.75, rest: 0.5, chord: 0.4, repeat: 0 };
  /** Same notes (strings and frets) in two events. */
  function sameAs(p, q) {
    const k = (e) => e.notes.map((n) => n.string + ":" + n.fret).concat(e.chords.map((c) => "c" + c.chordId)).sort().join(",");
    return k(p) === k(q);
  }
  /** Max difficulty for a phrase with n events (cap M): 0 for n <= 2, then M (1 - e^(-n/8)). */
  E.ddLevelsFor = function (n, M) {
    if (n <= 2) return 0;
    return Math.max(1, Math.min(M, Math.round(M * (1 - Math.exp(-n / 8)))));
  };
  /** Share of the events kept at relative level r (0..1): 12 % at level 0, all at the top (the samples' median). */
  E.ddKeepShare = (r) => Math.min(1, 0.12 + 0.88 * r);
  /** Notes a chord of n notes keeps at relative level r: n r^1.5, at least one. */
  E.ddChordSize = (n, r) => (r >= 1 ? n : Math.max(1, Math.min(n, Math.ceil(n * Math.pow(r, 1.5) - 1e-9))));

  function templateFor(doc, frets, fingers, name) {
    const key = frets.join(",");
    let i = doc.chordTemplates.findIndex((t) => t.frets.join(",") === key && (t.chordName || "") === (name || "") && !/arp$/.test(t.displayName || ""));
    if (i >= 0) return i;
    doc.chordTemplates.push({ chordName: name || "", displayName: name || "", frets: frets.slice(), fingers: fingers.slice() });
    return doc.chordTemplates.length - 1;
  }
  const NOTE_BASE = { linkNext: 0, accent: 0, bend: 0, fret: 0, hammerOn: 0, harmonic: 0, hopo: 0, ignore: 0, leftHand: -1, mute: 0, palmMute: 0, pluck: -1,
    pullOff: 0, slap: -1, slideTo: -1, string: 0, sustain: 0, tremolo: 0, harmonicPinch: 0, pickDirection: 0, rightHand: -1, slideUnpitchTo: -1, tap: 0, vibrato: 0, bendValues: [] };

  /** A chord cut down to its `size` lowest strings: a smaller chord, or one note. */
  function reduceChord(doc, c, size, bass) {
    const tp = doc.chordTemplates[c.chordId];
    if (!tp) return { chords: [clone(c)], notes: [] };
    const strings = tp.frets.map((f, s) => [s, f]).filter(([, f]) => f >= 0).map(([s]) => s);
    if (size >= strings.length) return { chords: [clone(c)], notes: [] };
    // prefer strings that sound (a fret-hand mute "x" note goes first)
    const cn = (s) => (c.chordNotes || []).find((q) => q.string === s);
    const order = strings.slice().sort((p, q) => ((cn(p) && cn(p).mute) - (cn(q) && cn(q).mute)) || p - q);
    const keep = order.slice(0, size).sort((p, q) => p - q);
    if (size === 1) {
      const s = keep[0], q = cn(s);
      const sus = Math.max(0, ...(c.chordNotes || []).map((x) => x.sustain || 0));
      const n = Object.assign({}, NOTE_BASE, q ? clone(q) : {}, { time: c.time, string: s, fret: tp.frets[s] });
      if (!q) n.sustain = sus;
      if (c.palmMute) n.palmMute = 1;
      if (c.accent) n.accent = 1;
      if (c.fretHandMute) n.mute = 1;
      if (c.ignore) n.ignore = 1;
      n.linkNext = q ? q.linkNext | 0 : 0;
      return { chords: [], notes: [n] };
    }
    const frets = tp.frets.map((f, s) => (keep.includes(s) ? f : -1)), fingers = tp.fingers.map((f, s) => (keep.includes(s) ? f : -1));
    let name = "";
    if (size >= 3) name = tp.chordName || "";
    else if (tp.chordName) {
      const m0 = E.midiNote(doc.tuning, keep[0], frets[keep[0]], bass, doc.capo), m1 = E.midiNote(doc.tuning, keep[1], frets[keep[1]], bass, doc.capo);
      const root = (tp.chordName.match(/^[A-G][#b]?/) || [""])[0];
      if (root && (m1 - m0) % 12 === 7) name = root + "5";
    }
    const out = clone(c);
    out.chordId = templateFor(doc, frets, fingers, name);
    out.chordNotes = (c.chordNotes || []).filter((q) => keep.includes(q.string)).map(clone);
    return { chords: [out], notes: [] };
  }

  /** A group of single notes at one time (a double stop without a chord) cut to its `size` lowest strings. */
  function reduceNotes(notes, size) {
    const order = notes.slice().sort((p, q) => (p.mute - q.mute) || p.string - q.string);
    return order.slice(0, size).map(clone).sort((p, q) => p.string - q.string);
  }

  /**
   * Difficulty levels for a document from its hardest chart (doc.levels[0] or,
   * with several levels, the merged hardest chart). -> a new document with levels
   * 0..M, phrase max difficulties and hero levels.
   * opts.maxLevels: the most levels a phrase gets above 0 (default 8).
   * opts.phrases: only these phrase ids get new levels; the others keep the ones in
   *   opts.keep (an array of levels, as stored), with their max difficulty.
   */
  E.ddGenerate = function (doc, opts) {
    opts = opts || {};
    const M = Math.max(1, Math.min(30, opts.maxLevels | 0 || 8));
    const bass = opts.bass != null ? !!opts.bass : (+((doc.properties || {}).pathBass) === 1 || /bass/i.test(doc.arrangement || ""));
    const d = clone(doc);
    const hard = d.levels.length > 1 ? E.ddExtract(E.ddNormalizeLevels(d.levels), d, null) : clone(d.levels[0] || emptyLevel(0));
    for (const x of hard.anchors) delete x._carry;
    const beats = (opts.beats || d.ebeats || []).slice().sort((p, q) => p.time - q.time);
    const R = E.ddRanges(d);
    const only = opts.phrases != null ? new Set([].concat(opts.phrases)) : null;
    const keep = opts.keep || null;
    const keepTop = keep ? keep.length - 1 : 0;
    const oldMax = d.phrases.map((p) => p.maxDifficulty | 0);

    // events per range
    const rangeEvents = R.map((r) => {
      const s = slice(hard, r), groups = new Map();
      const g = (t) => { const k = Math.round(t * 1000); if (!groups.has(k)) groups.set(k, { time: t, notes: [], chords: [] }); return groups.get(k); };
      for (const n of s.notes) g(n.time).notes.push(n);
      for (const c of s.chords) g(c.time).chords.push(c);
      const ev = Array.from(groups.values()).sort((p, q) => p.time - q.time);
      ev.forEach((e, i) => {
        const next = i + 1 < ev.length ? ev[i + 1].time : e.time + 2;
        const prev = i > 0 ? ev[i - 1].time : -Infinity;
        const mt = metricOf(beats, e.time);
        const sus = Math.max(0, ...e.notes.map((n) => n.sustain || 0), ...e.chords.flatMap((c) => (c.chordNotes || []).map((q) => q.sustain || 0)));
        const dur = Math.max(sus, next - e.time) / (mt.beatLen || 0.5);
        const W = E.DD_WEIGHTS;
        let score = mt.w + Math.min(W.durCap, W.dur * Math.log2(1 + dur));
        if (i === 0) score += W.first;
        if (e.time - prev > 1.5 * (mt.beatLen || 0.5)) score += W.rest;
        if (e.chords.length) score += W.chord;
        if (i > 0 && sameAs(ev[i - 1], e)) score -= W.repeat;
        const all = e.notes.concat(e.chords.flatMap((c) => c.chordNotes || []));
        if (all.length && all.every((n) => n.mute)) score -= 3;
        if (e.notes.length && e.notes.every((n) => n.ignore) || e.chords.some((c) => c.ignore)) score -= 5;
        if (dur < 0.3 && e.notes.some((n) => n.hammerOn || n.pullOff || n.tap)) score -= 1;
        e.score = score;
        e.order = i;
      });
      return ev;
    });
    // max difficulty per phrase: the largest its iterations call for
    const pm = d.phrases.map(() => 0);
    R.forEach((r, j) => { if (r.phraseId >= 0) pm[r.phraseId] = Math.max(pm[r.phraseId], E.ddLevelsFor(rangeEvents[j].length, M)); });
    if (only) d.phrases.forEach((p, i) => { if (!only.has(i)) pm[i] = keep ? Math.max(0, Math.min(keepTop, oldMax[i])) : pm[i]; });
    const top = Math.max(0, ...R.map((r) => (r.phraseId >= 0 ? pm[r.phraseId] : 0)));
    const levels = [];
    for (let k = 0; k <= top; k++) levels.push(emptyLevel(k));

    R.forEach((r, j) => {
      const m = r.phraseId >= 0 ? pm[r.phraseId] : 0;
      if (only && r.phraseId >= 0 && !only.has(r.phraseId) && keep) {
        // keep this phrase's own levels
        for (let k = 0; k <= m; k++) { const s = slice(keep[k], r); for (const kd of KINDS) for (const x of s[kd]) levels[k][kd].push(clone(x)); }
        return;
      }
      const ev = rangeEvents[j], n = ev.length;
      const s = slice(hard, r);
      const ranked = ev.slice().sort((p, q) => q.score - p.score || p.order - q.order);
      for (let k = 0; k <= m; k++) {
        const rel = m === 0 ? 1 : k / m;
        const count = k === m ? n : Math.max(n ? 1 : 0, Math.round(E.ddKeepShare(rel) * n));
        const kept = new Set(ranked.slice(0, count));
        // a note linked to the next one (linkNext) takes that one along
        let grew = true;
        while (grew) {
          grew = false;
          for (const e of Array.from(kept)) for (const nt of e.notes.concat(e.chords.flatMap((c) => c.chordNotes || []))) {
            if (!nt.linkNext) continue;
            const end = nt.time + (nt.sustain || 0);
            const nx = ev.find((x) => x.time > nt.time + 1e-4 && x.notes.some((q) => q.string === nt.string) && x.time <= end + 0.05);
            if (nx && !kept.has(nx)) { kept.add(nx); grew = true; }
          }
        }
        const L = levels[k];
        for (const e of ev) {
          if (!kept.has(e)) continue;
          if (e.chords.length) {
            for (const c of e.chords) {
              const tp = d.chordTemplates[c.chordId], size = tp ? tp.frets.filter((f) => f >= 0).length : 1;
              const red = reduceChord(d, c, E.ddChordSize(size, rel), bass);
              L.chords.push(...red.chords); L.notes.push(...red.notes);
            }
            if (k === m) L.notes.push(...e.notes.map(clone));
          } else {
            L.notes.push(...reduceNotes(e.notes, e.notes.length > 1 ? E.ddChordSize(e.notes.length, rel) : 1));
          }
        }
        // anchors: the hardest chart's, plus the one in force where the phrase starts
        const an = s.anchors.map(clone);
        if (r.i >= 0 && ev.length && !an.some((x) => Math.abs(x.time - r.start) < 1e-3)) {
          const act = anchorAt(hard, r.start);
          if (act) an.push({ time: r.start, fret: act.fret, width: act.width });
        }
        L.anchors.push(...an);
        // hand shapes: the hardest chart's, for the chords (or their smaller versions) still there
        for (const h of s.handShapes) {
          const tp = d.chordTemplates[h.chordId];
          if (tp && /arp$/.test(tp.displayName || "")) {
            if (L.notes.some((x) => x.time >= h.startTime - 1e-4 && x.time < h.endTime) || L.chords.some((x) => x.time >= h.startTime - 1e-4 && x.time < h.endTime)) L.handShapes.push(clone(h));
            continue;
          }
          const inside = L.chords.filter((x) => x.time >= h.startTime - 1e-4 && x.time < h.endTime);
          const ids = Array.from(new Set(inside.map((x) => x.chordId)));
          if (ids.length) L.handShapes.push(Object.assign(clone(h), { chordId: ids.includes(h.chordId) ? h.chordId : ids[0] }));
        }
        L.fretHandMutes.push(...(k === m ? s.fretHandMutes.map(clone) : []));
      }
    });
    for (const L of levels) {
      for (const kd of KINDS) L[kd].sort(byTime(kd));
      // a linked note whose partner is gone is not linked any more
      for (const nt of L.notes) {
        if (!nt.linkNext) continue;
        const end = nt.time + (nt.sustain || 0);
        if (!L.notes.some((q) => q !== nt && q.string === nt.string && q.time > nt.time + 1e-4 && q.time <= end + 0.05) &&
            !L.chords.some((c) => c.time > nt.time + 1e-4 && c.time <= end + 0.05 && (c.chordNotes || []).some((q) => q.string === nt.string))) nt.linkNext = 0;
      }
      for (const c of L.chords) {
        if (!c.linkNext) continue;
        const end = c.time + Math.max(0, ...(c.chordNotes || []).map((q) => q.sustain || 0));
        if (!L.notes.some((q) => q.time > c.time + 1e-4 && q.time <= end + 0.05) && !L.chords.some((q) => q !== c && q.time > c.time + 1e-4 && q.time <= end + 0.05)) {
          c.linkNext = 0;
          for (const q of c.chordNotes || []) q.linkNext = 0;
        }
      }
    }
    d.levels = levels;
    d.phrases.forEach((p, i) => { p.maxDifficulty = pm[i]; });
    d.newLinkedDiffs = []; d.linkedDiffs = [];
    E.ddFixHeroLevels(d, true);
    return d;
  };

  /**
   * Build the levels of an arrangement automatically (the whole chart, or the
   * phrases `opts.phrases`), from its hardest chart. The view stays on its level.
   */
  E.ddAuto = function (a, opts) {
    opts = Object.assign({}, opts || {});
    const had = !!a.dd;
    if (had) E.ddCommit(a);
    const base = clone(Object.assign({}, a.doc, { levels: [] }));
    base.levels = [had ? E.ddExtract(a.dd.levels, a.doc, null) : clone(a.doc.levels[0])];
    if (opts.phrases != null && had) opts.keep = a.dd.levels;
    else if (opts.phrases != null) { opts.keep = [base.levels[0]]; base.phrases.forEach((p) => { p.maxDifficulty = 0; }); }
    const g = E.ddGenerate(base, Object.assign({ bass: a.kind === "bass" }, opts));
    a.doc.chordTemplates = g.chordTemplates;
    a.doc.phrases = g.phrases;
    a.doc.phraseIterations = g.phraseIterations;
    a.doc.newLinkedDiffs = g.newLinkedDiffs; a.doc.linkedDiffs = [];
    const view = had ? a.dd.view : null;
    a.dd = { levels: g.levels, view, mode: had ? a.dd.mode : "keep", auto: { maxLevels: opts.maxLevels || (had && a.dd.auto ? a.dd.auto.maxLevels : undefined) }, dirty: {} };
    for (let k = 0; k < g.levels.length; k++) a.dd.dirty[k] = true;
    if (g.levels.length <= 1) { E.ddFlatten(a); return; }
    refreshView(a);
  };
})(typeof window !== "undefined" ? window : globalThis);

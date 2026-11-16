/* ---------------------------------------------------------------------------
 * karaoke-page.js -- standalone-page host for the karaoke player (the HTML
 * delivery format; karaoke_export_html() inlines it with karaoke.js).
 *
 * Reads <script id="rs-karaoke-data">{title, options, songs: [karaoke_json()
 * payloads]}; each song's audio is {embed: <id of a base64 <script>>, type},
 * {src: relative URL, type} or absent ("Load audio..." pairs a local file).
 * Catalogs (big libraries, karaoke_export_library()): a song is a stub
 * {id, meta, lyrics: "archive" | "web", src} and its payload is a script
 * loaded when the song is picked -- `RSKaraokeSong(id, payload)` -- which works
 * from disk (file://) as well as from a server (that may build it on demand).
 * View, text size and speed are remembered in localStorage, the lyrics timing
 * per song; so are lyrics found online by the browser, loaded .lrc files and the
 * offset found when syncing LRC lyrics to the recording (karaoke-sync.js).
 * ------------------------------------------------------------------------- */
(function () {
  "use strict";
  const K = window.RSKaraoke;
  const data = JSON.parse(document.getElementById("rs-karaoke-data").textContent || "{}");
  const songs = data.songs || [];
  const $ = (id) => document.getElementById(id);
  const STORE = "rs-karaoke-page";
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || "{}") || {}; } catch (e) { saved = {}; }
  const opts = Object.assign({ view: "stage", textScale: 1, playbackRate: 1 }, data.options || {}, saved.opts || {});
  const offsets = Object.assign({}, saved.offsets || {});
  const recent = Array.isArray(saved.recentRandom) ? saved.recentRandom : [];     // songs picked at random lately
  const synced = Object.assign({}, saved.synced || {});        // songKey -> offset (ms) found when syncing an LRC
  const lyricsSaved = Object.assign({}, saved.lyrics || {});   // songKey -> {lrc, source, lrcDuration}: found / loaded here
  let current = -1;

  const el = $("rs-karaoke");
  const player = new K.KaraokePlayer(el, {
    emptyHtml: "<b>No songs in this page</b>",
    onAligned: (a) => { synced[a.songKey] = a.offsetMs; save(); },
    onLyrics: (a) => { lyricsSaved[a.songKey] = { lrc: a.lyrics.lrc, source: a.lyrics.source, lrcDuration: a.lyrics.lrcDuration }; save(); },
  });
  window.karaokePage = { player, songs, load: (i) => loadSong(i) };          // (for scripting and tests)

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ opts: { view: opts.view, textScale: opts.textScale, playbackRate: opts.playbackRate },
                                                       offsets, synced, lyrics: lyricsSaved, song: songs[current] && ident(songs[current]),
                                                       recentRandom: recent })); } catch (e) { /* private mode, full */ }
  }
  function label(s) { const m = s.meta || {}; return [m.artist, m.title].filter(Boolean).join(" \u2014 ") || "Untitled"; }
  const key = () => (songs[current] ? songs[current].songKey : null);
  const ident = (s) => s.id || s.songKey;                     // catalog stubs have no songKey until loaded
  const webLyrics = (s) => s.lyrics === "web" || (s.lyrics && s.lyrics.source && s.lyrics.source !== "archive");

  // ---- controls -------------------------------------------------------------------------
  const sel = $("rs-kp-song"), find = $("rs-kp-find");
  /** The song picker; with many songs, grouped (lyrics in the file / from the web) and filtered by the search box. */
  function fillPicker(q) {
    const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (s) => { const t = label(s).toLowerCase(); return words.every((w) => t.includes(w)); };
    sel.innerHTML = "";
    const groups = songs.length > 20 && songs.some(webLyrics) && songs.some((s) => !webLyrics(s))
      ? [["Songs with lyrics", (s) => !webLyrics(s)], ["Lyrics from the web", webLyrics]] : [[null, () => true]];
    let n = 0;
    for (const [name, test] of groups) {
      const parent = name ? document.createElement("optgroup") : sel;
      if (name) parent.label = name;
      songs.forEach((s, i) => {
        if (!test(s) || (words.length && !hit(s) && i !== current)) return;
        const o = document.createElement("option"); o.value = i; o.textContent = label(s); parent.appendChild(o); n++;
      });
      if (name && parent.children.length) sel.appendChild(parent);
    }
    if (current >= 0) sel.value = String(current);
    return n;
  }
  fillPicker("");
  document.body.classList.toggle("is-single", songs.length < 2);
  document.body.classList.toggle("has-find", songs.length > 20);
  sel.addEventListener("change", () => { loadSong(+sel.value); sel.blur(); });
  if (find) {
    find.placeholder = `Search ${songs.length} songs\u2026`;
    find.addEventListener("input", () => fillPicker(find.value));
    find.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {                                   // Enter: the first match
        const o = [...sel.options].find((x) => +x.value !== current) || sel.options[0];
        if (o) loadSong(+o.value);
        find.blur(); e.preventDefault();
      } else if (e.key === "Escape") { find.value = ""; fillPicker(""); find.blur(); }
    });
  }

  function showView() { document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("is-on", b.dataset.view === opts.view)); }
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    opts.view = b.dataset.view; player.applyOptions({ view: opts.view }); showView(); save(); b.blur();
  }));
  const size = (f) => { opts.textScale = Math.max(0.5, Math.min(2.2, Math.round(opts.textScale * f * 100) / 100)); player.applyOptions({ textScale: opts.textScale }); save(); };
  $("rs-kp-smaller").addEventListener("click", (e) => { size(1 / 1.1); e.currentTarget.blur(); });
  $("rs-kp-bigger").addEventListener("click", (e) => { size(1.1); e.currentTarget.blur(); });

  const offLabel = $("rs-kp-offset");
  function showOffset() { const v = offsets[key()] || 0; offLabel.textContent = `${v > 0 ? "+" : ""}${v} ms`; }
  function nudge(ms) {
    const k = key(); if (!k) return;
    offsets[k] = Math.max(-2000, Math.min(2000, (offsets[k] || 0) + ms));
    player.applyOptions({ offsetMs: offsets[k] }); showOffset(); save();
  }
  $("rs-kp-earlier").addEventListener("click", (e) => { nudge(e.shiftKey ? -100 : -10); e.currentTarget.blur(); });
  $("rs-kp-later").addEventListener("click", (e) => { nudge(e.shiftKey ? 100 : 10); e.currentTarget.blur(); });
  offLabel.addEventListener("dblclick", () => nudge(-(offsets[key()] || 0)));

  const speed = $("rs-kp-speed");
  speed.value = String(opts.playbackRate);
  speed.addEventListener("change", () => { opts.playbackRate = +speed.value; player.applyOptions({ playbackRate: opts.playbackRate }); save(); speed.blur(); });

  $("rs-kp-audio").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f || !key()) return;
    player.deck.unload();                                  // replaces any embedded audio
    player.setAudio(URL.createObjectURL(f), key(), "full").then((ok) => {
      if (ok) player.status(`Playing along with \u201c${f.name}\u201d. If the words run early or late, adjust the timing (\u2212 / +).`, "info");
      setTimeout(() => player.status("", "clear"), 6000);
    });
    e.target.value = "";
  });
  $("rs-kp-lrc").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f || !key()) return;
    const lrc = await f.text(), k = key();
    if (!K.parseLRC(lrc).lines.length) { player.status(`\u201c${f.name}\u201d contains no lyrics.`, "error"); return; }
    lyricsSaved[k] = { lrc, source: "file" }; delete synced[k]; save();
    player.setLyrics({ lrc, source: "file", songKey: k });
    player.status(`Lyrics from \u201c${f.name}\u201d: syncing them to the song\u2026`, "info");
  });
  const full = () => { if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen(); };
  $("rs-kp-full").addEventListener("click", (e) => { full(); e.currentTarget.blur(); });
  document.addEventListener("keydown", (e) => {
    if (e.code === "KeyF" && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) { full(); e.preventDefault(); }
  });

  // ---- songs ------------------------------------------------------------------------------
  // catalog stubs: the payload script calls RSKaraokeSong(id, payload)
  const pending = {};
  window.RSKaraokeSong = (id, payload) => { if (pending[id]) pending[id](payload); };
  function fetchSong(i) {
    const stub = songs[i];
    return new Promise((resolve, reject) => {
      const tag = document.createElement("script");
      const done = () => { delete pending[stub.id]; tag.remove(); };
      pending[stub.id] = (payload) => { done(); resolve(payload); };
      tag.onerror = () => { done(); reject(new Error(stub.src)); };
      tag.src = stub.src;
      document.head.appendChild(tag);
    });
  }
  let loading = 0;
  function loadSong(i) {
    if (!songs[i]) return;
    if (!songs[i].vocals && songs[i].src) {                      // catalog: fetch the song first
      const ticket = ++loading;
      current = i; sel.value = String(i);
      player.status(`Loading \u201c${label(songs[i])}\u201d\u2026`, "info");
      fetchSong(i).then((payload) => {
        songs[i] = Object.assign(payload, { id: songs[i].id });
        if (ticket === loading) loadSong(i);
      }, (e) => {
        if (ticket === loading) player.status(`Could not load this song (${e.message}).`, "error");
      });
      return;
    }
    loading++;
    current = i; sel.value = String(i);
    const s = songs[i];
    // lyrics found / loaded here before, and the sync offset found before
    const ls = lyricsSaved[s.songKey];
    if (ls && (!s.lyrics || s.lyrics.source === "lookup" || ls.source === "file")) {
      s.vocals = { t: [], d: [], w: [], j: [], l: [] };
      s.lyrics = Object.assign({ align: true }, ls);
    }
    if (s.lyrics && s.lyrics.lrc && s.lyrics.offsetMs == null && synced[s.songKey] != null) s.lyrics.offsetMs = synced[s.songKey];
    player.load({ song: s, options: Object.assign({}, opts, { offsetMs: offsets[s.songKey] || 0 }) });
    document.title = songs.length > 1 ? `${label(s)} \u2014 karaoke` : (data.title || document.title);
    showOffset(); save();
    const a = s.audio;
    if (a && a.embed) {
      const node = document.getElementById(a.embed);
      if (node) player.setAudio(`data:${a.type || "audio/ogg"};base64,${node.textContent.trim()}`, s.songKey, "full");
    } else if (a && a.src) {
      player.setAudio(a.src, s.songKey, "full");
    } else {
      player.status("This page has no audio \u2014 use \u201cAudio\u2026\u201d to sing along with your own copy of the song.", "info");
      setTimeout(() => { if (!player.deck.audio && current === i) player.status("", "clear"); }, 8000);
    }
  }
  // ---- shuffle: every visit starts with a song picked at random (not one of the last few);
  // the button picks another one -------------------------------------------------------
  function pickRandom() {
    if (songs.length < 2) return 0;
    const fits = (s) => s.lyrics === "archive" || (s.vocals && arr(s.vocals.t).length);     // lyrics at hand
    let pool = songs.map((s, i) => i).filter((i) => i !== current && !recent.includes(ident(songs[i])));
    const sung = pool.filter((i) => fits(songs[i]));
    if (sung.length) pool = sung;
    if (!pool.length) pool = songs.map((s, i) => i).filter((i) => i !== current);
    const i = pool[Math.floor(Math.random() * pool.length)];
    recent.unshift(ident(songs[i])); recent.length = Math.min(recent.length, Math.min(10, Math.floor(songs.length / 2)));
    return i;
  }
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const shuffleBtn = $("rs-kp-shuffle");
  if (shuffleBtn) {
    shuffleBtn.addEventListener("click", (e) => { loadSong(pickRandom()); e.currentTarget.blur(); });
    shuffleBtn.style.display = songs.length > 1 ? "" : "none";
  }
  showView();
  if (songs.length) loadSong(pickRandom());
})();

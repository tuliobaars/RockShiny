/* ---------------------------------------------------------------------------
 * home.js -- RockShiny's home screen: the library by artist, album and genre,
 * playlists, recently played, search; a song (or a whole album / artist /
 * playlist) opens in the Instrument or the Karaoke mode.
 *
 * Layout after a streaming service's home page, in the app's own look: a
 * "Your library" panel on the left (playlists, artists, albums, genres), the
 * main view on the right (greeting, quick tiles, shelves of cards; detail pages
 * with a hero and a track list). Everything is rendered here from one JSON
 * payload; user actions go back to R as one Shiny input (<id>_action).
 *
 *   new RSHome.Home(el, {action(obj)})           plain JS (tests, other hosts)
 *   home.load({catalog, user, artUrl, status})    catalog: columns (R/home.R home_catalog_json())
 *   home.setUser(user) / home.setStatus(status)   playlists, recent, genres / library scan progress
 *   home.go({view: "artist", name}) ...           views: home, search, artist, album, genre,
 *                                                  playlist, all (a shelf in full), songs
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const NS = (root.RSHome = root.RSHome || {});

  // ---- helpers ---------------------------------------------------------------------------
  function h(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const fmt = (s) => { s = Math.round(+s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const fmtLong = (s) => { const m = Math.round((+s || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  /** R's artist_key(): lower case, without "(ft ...)", single spaces. */
  NS.artistKey = (a) => String(a || "").trim().toLowerCase().replace(/\s*[([].*$/, "").replace(/\s+/g, " ");
  function hash(s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
  // placeholder art: the app's palette (amber, ember, indigo, teal, plum, steel)
  const PAL = [["#f5a524", "#7a3b06"], ["#ff7a45", "#5c1d0c"], ["#6c7cff", "#1d2260"], ["#2bb3a3", "#0d3a36"],
               ["#c266d6", "#3b1644"], ["#8aa0c8", "#232d44"], ["#e0566b", "#4a1420"], ["#9bc45a", "#27380f"]];
  const pal = (s) => PAL[hash(String(s || "")) % PAL.length];
  /** A genre's tile colours: its own hue (golden-angle steps keep neighbours apart). */
  const genreColors = (g) => { const hue = Math.round((hash("genre:" + g) % 64) * 137.5) % 360;
    return [`hsl(${hue} 62% 46%)`, `hsl(${(hue + 25) % 360} 55% 22%)`]; };
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    guitar: '<svg viewBox="0 0 24 24"><path d="M19.6 2.4l2 2-1.3 1.3-.9-.1-4.6 4.6c.9 1.5.8 3.3-.4 4.5-.6.6-1.4.9-2.2 1-.4 1.3-1.1 2.6-2.2 3.6-2.3 2.3-5.4 2.9-7 1.3s-1-4.7 1.3-7c1-1 2.3-1.8 3.6-2.2.1-.8.4-1.6 1-2.2 1.2-1.2 3-1.3 4.5-.4l4.6-4.6-.1-.9 1.7-1.3zM7.4 13.1a1.6 1.6 0 1 0 2.3 2.3 1.6 1.6 0 0 0-2.3-2.3z"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15.4 5.4L14 4l-8 8 8 8 1.4-1.4L8.8 12z"/></svg>',
    fwd: '<svg viewBox="0 0 24 24"><path d="M8.6 5.4L10 4l8 8-8 8-1.4-1.4 6.6-6.6z"/></svg>',
    search: '<svg viewBox="0 0 24 24"><path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/></svg>',
    lib: '<svg viewBox="0 0 24 24"><path d="M4 3h2v18H4zm5 0h2v18H9zm5.2.6l1.9-.7 5.9 16.9-1.9.7z"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M3 5h14v2H3zm0 6h14v2H3zm0 6h9v2H3zm16-6l4 3-4 3z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24"><path d="M17 3l4 4-4 4V8h-2.6l-3 3.9-1.3-1.6L13.4 6H17zM3 6h4.6l8.8 11H17v-3l4 4-4 4v-3h-1.6L6.6 8H3zm0 10h3.6l2-2.6 1.3 1.6L7.6 18H3z"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8zm14.7-7.5a1 1 0 0 0 0-1.4l-2-2a1 1 0 0 0-1.4 0l-1.5 1.5 2.8 2.8z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 1h4v2H4V4h4zm-3 5h12l-1 13H7z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M18.3 5.7L16.9 4.3 12 9.2 7.1 4.3 5.7 5.7 10.6 12l-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z"/></svg>',
    grip: '<svg viewBox="0 0 24 24"><path d="M8 6h2v2H8zm6 0h2v2h-2zM8 11h2v2H8zm6 0h2v2h-2zm-6 5h2v2H8zm6 0h2v2h-2z"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15 15 0 0 0-1.3-4A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8 8 0 0 1 0-4h3.3a16 16 0 0 0 0 4zm.8 2h3a15 15 0 0 0 1.3 4A8 8 0 0 1 5.1 16zM8 8H5.1a8 8 0 0 1 4.3-4A15 15 0 0 0 8 8zm4 12c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14 14 0 0 1 0-4h4.6a14 14 0 0 1 0 4zm.3 6a15 15 0 0 0 1.3-4h3a8 8 0 0 1-4.3 4zm1.8-6a16 16 0 0 0 0-4h3.3a8 8 0 0 1 0 4z"/></svg>',
  };
  NS.ICON = ICON;
  const GENRE_SUGGEST = ["Rock", "Classic Rock", "Hard Rock", "Blues", "Blues Rock", "Metal", "Punk", "Grunge", "Alternative",
    "Progressive Rock", "Pop", "Funk & Soul", "Jazz", "Country", "Folk", "Latin", "Reggae", "Hip Hop", "Electronic"];

  // ---- album art: fetched when a card scrolls into view, decoded once (dds.js) ------------
  class ArtStore {
    constructor(urlTemplate) { this.tpl = urlTemplate || ""; this.cache = new Map(); this.pending = new Map(); }
    url(id, size) { return this.tpl ? this.tpl.replace("{id}", encodeURIComponent(id)).replace("{size}", size) : null; }
    /** -> Promise<{url, color}> (or null: no art). */
    get(id, size) {
      const k = id + "@" + size;
      if (this.cache.has(k)) return Promise.resolve(this.cache.get(k));
      if (this.pending.has(k)) return this.pending.get(k);
      const u = this.url(id, size);
      if (!u || !root.RSHighway || !root.RSHighway.decodeDDS) return Promise.resolve(null);
      const p = fetch(u).then((r) => (r.ok ? r.arrayBuffer() : null)).then((buf) => {
        if (!buf || buf.byteLength < 128) return null;
        const img = root.RSHighway.decodeDDS(new Uint8Array(buf));
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        c.getContext("2d").putImageData(img, 0, 0);
        // average colour (for the hero backdrop), a coarse sample
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < img.data.length; i += 4 * 37) { r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
        const color = n ? [r / n, g / n, b / n].map((v) => Math.round(v)) : null;
        return new Promise((res) => c.toBlob((blob) => res(blob ? { url: URL.createObjectURL(blob), color } : null), "image/png"));
      }).catch(() => null).then((v) => { this.cache.set(k, v); this.pending.delete(k); return v; });
      this.pending.set(k, p);
      return p;
    }
  }

  // ---- the component -------------------------------------------------------------------------
  class Home {
    constructor(el, hooks) {
      this.el = el; this.hooks = hooks || {};
      this.songs = []; this.byId = new Map(); this.user = { playlists: [], recent: [], artistGenres: {}, songGenres: {} };
      this.route = { view: "home" }; this.past = []; this.future = [];
      this.libFilter = "playlists"; this.libQuery = "";
      try { this.mode = localStorage.getItem("rs-home-mode") || "instrument"; } catch (e) { this.mode = "instrument"; }
      this.art = new ArtStore("");
      this._scroll = {};
      this._build();
      this.io = "IntersectionObserver" in root ? new IntersectionObserver((es) => es.forEach((e) => {
        if (e.isIntersecting) { this.io.unobserve(e.target); this._paintArt(e.target); }
      }), { root: null, rootMargin: "300px" }) : null;
    }

    // ---- data ----------------------------------------------------------------------------------
    load(data) {
      const d = typeof data === "string" ? JSON.parse(data) : data || {};
      this.art = new ArtStore(d.artUrl || "");
      const c = d.catalog || {}, ids = arr(c.id);
      const col = (k) => arr(c[k]);
      const t = col("title"), a = col("artist"), al = col("album"), y = col("year"), len = col("length"), ly = col("lyrics"),
        kind = col("kind"), src = col("source"), added = col("added");
      this.songs = ids.map((id, i) => ({ id, title: t[i] || "Untitled", artist: a[i] || "", album: al[i] || "", year: y[i] || "",
        length: +len[i] || 0, lyrics: ly[i] || "", kind: kind[i] || "psarc", source: src[i] || "library", added: +added[i] || 0 }));
      this.byId = new Map(this.songs.map((s) => [s.id, s]));
      if (d.user) this.user = Object.assign(this.user, d.user);
      if (d.status) this.status = d.status;
      const again = this._loaded;                                   // new data for the page on screen: keep its place
      this._loaded = true;
      this._index();
      this.render(again);
    }
    setUser(u) {
      this.user = Object.assign(this.user, u || {});
      this._index();
      const made = u && u.created;                                   // a playlist made from here: open it
      if (made && this._pendingNew && made.token === this._pendingNew) { this._pendingNew = null; this.go({ view: "playlist", id: made.id }); return; }
      if (this.route.view === "playlist" && !this._playlist(this.route.id)) { this.go({ view: "home" }, false); return; }
      this.render(true);
    }
    setStatus(st) { this.status = st || {}; this._renderStatus(); }

    _index() {
      const G = this.user.artistGenres || {}, SG = this.user.songGenres || {};
      const artists = new Map(), albums = new Map(), genres = new Map();
      for (const s of this.songs) {
        s.genre = SG[s.id] || G[NS.artistKey(s.artist)] || "";
        const ak = s.artist || "Unknown artist";
        if (s.artist) {                                              // (songs without an artist, e.g. MIDI files, are not an artist)
          if (!artists.has(ak)) artists.set(ak, { name: ak, songs: [] });
          artists.get(ak).songs.push(s);
        }
        if (s.album) {
          const k = ak + "\u0001" + s.album;
          if (!albums.has(k)) albums.set(k, { key: k, artist: ak, album: s.album, year: s.year, songs: [] });
          albums.get(k).songs.push(s);
        }
        if (s.genre) { if (!genres.has(s.genre)) genres.set(s.genre, { name: s.genre, songs: [] }); genres.get(s.genre).songs.push(s); }
      }
      const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      this.artists = [...artists.values()].sort(byName);
      this.albums = [...albums.values()].sort((a, b) => a.album.localeCompare(b.album, undefined, { sensitivity: "base" }));
      this.genres = [...genres.values()].sort((a, b) => b.songs.length - a.songs.length || byName(a, b));
      this.artistMap = artists; this.albumMap = albums; this.genreMap = genres;
    }
    _playlist(id) { return (this.user.playlists || []).find((p) => p.id === id) || null; }
    _plSongs(p) { return arr(p.songs).map((id) => (id ? this.byId.get(id) : null)); }
    _recent() {
      const seen = new Set(), out = [];
      for (const r of arr(this.user.recent)) { const s = this.byId.get(r.id); if (s && !seen.has(s.id)) { seen.add(s.id); out.push(s); } }
      return out;
    }

    // ---- actions -------------------------------------------------------------------------------
    _act(o) { if (this.hooks.action) this.hooks.action(Object.assign({ nonce: Date.now() + Math.random() }, o)); }
    /** Play songs (from `start`) in a mode; karaoke skips what cannot be sung (MIDI). */
    play(songs, start, mode, context, shuffle) {
      mode = mode || this.mode;
      let list = songs.filter((s) => s && (mode !== "karaoke" || s.kind === "psarc"));
      if (!list.length) { this.toast(mode === "karaoke" ? "None of these songs can be sung (MIDI files have no recording)." : "Nothing to play."); return; }
      let i = Math.max(0, list.indexOf(songs[start || 0]));
      if (shuffle) {
        list = list.slice(); const first = list.splice(i, 1)[0];
        for (let k = list.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [list[k], list[j]] = [list[j], list[k]]; }
        list.unshift(first); i = 0;
      }
      this._act({ op: "play", ids: list.map((s) => s.id), start: i, mode, context: context || null });
      this.toast(`${mode === "karaoke" ? "Singing" : "Playing"} \u201c${list[i].title}\u201d` +
                 (list.length > 1 ? ` \u2014 ${plural(list.length, "song")} in the queue` : ""));
    }
    setMode(m) {
      this.mode = m === "karaoke" ? "karaoke" : "instrument";
      try { localStorage.setItem("rs-home-mode", this.mode); } catch (e) { /* private mode */ }
      this.modeBtns.forEach((b) => b.classList.toggle("is-on", b.dataset.mode === this.mode));
      this.el.dataset.mode = this.mode;
    }
    newPlaylist(ids, open) {
      const token = "t" + Date.now();
      if (open !== false) this._pendingNew = token;
      this._act({ op: "playlist_new", name: "", ids: ids || [], token });
    }

    // ---- navigation ----------------------------------------------------------------------------
    go(route, push) {
      if (push !== false && JSON.stringify(route) !== JSON.stringify(this.route)) {
        this._scroll[this._rk(this.route)] = this.view.scrollTop;
        this.past.push(this.route); this.future = [];
      }
      this.route = route;
      this.render();
      this.view.scrollTop = push === false ? (this._scroll[this._rk(route)] || 0) : 0;
    }
    back() { if (!this.past.length) return; this._scroll[this._rk(this.route)] = this.view.scrollTop; this.future.push(this.route); this.go(this.past.pop(), false); }
    forward() { if (!this.future.length) return; this.past.push(this.route); this.go(this.future.pop(), false); }
    _rk(r) { return JSON.stringify(r); }

    // ---- skeleton ------------------------------------------------------------------------------
    _build() {
      const el = this.el;
      el.innerHTML = "";
      el.classList.add("rs-home");
      el.dataset.mode = this.mode;
      // left: your library
      const side = (this.side = h("aside", "rs-h-side", el));
      const head = h("div", "rs-h-side-head", side);
      const t = h("div", "rs-h-side-title", head); t.innerHTML = ICON.lib + "<span>Your library</span>";
      const add = h("button", "rs-h-iconbtn", head); add.type = "button"; add.innerHTML = ICON.plus; add.title = "Create a playlist";
      add.addEventListener("click", () => this.newPlaylist([]));
      const chips = (this.chips = h("div", "rs-h-chips", side));
      for (const [k, label] of [["playlists", "Playlists"], ["artists", "Artists"], ["albums", "Albums"], ["genres", "Genres"]]) {
        const c = h("button", "rs-h-chip", chips, label); c.type = "button"; c.dataset.k = k;
        c.addEventListener("click", () => { this.libFilter = k; this._renderSide(); });
      }
      const f = (this.sideFind = h("input", "rs-h-side-find", side)); f.type = "search"; f.placeholder = "Find in your library";
      f.addEventListener("input", () => { this.libQuery = f.value; this._renderSide(); });
      this.sideList = h("div", "rs-h-side-list", side);
      this.sideFoot = h("div", "rs-h-side-foot", side);          // the app puts its library status here
      // right: top bar + view
      const main = (this.main = h("section", "rs-h-main", el));
      const top = h("div", "rs-h-top", main);
      const nav = h("div", "rs-h-nav", top);
      this.btnBack = h("button", "rs-h-round", nav); this.btnBack.type = "button"; this.btnBack.innerHTML = ICON.back; this.btnBack.title = "Back";
      this.btnFwd = h("button", "rs-h-round", nav); this.btnFwd.type = "button"; this.btnFwd.innerHTML = ICON.fwd; this.btnFwd.title = "Forward";
      this.btnBack.addEventListener("click", () => this.back());
      this.btnFwd.addEventListener("click", () => this.forward());
      const sb = h("label", "rs-h-search", top); sb.innerHTML = ICON.search;
      const q = (this.search = h("input", "", sb)); q.type = "search"; q.placeholder = "What do you want to play?"; q.setAttribute("aria-label", "Search songs, artists, albums");
      q.addEventListener("input", () => {
        const v = q.value.trim();
        if (v) { if (this.route.view === "search") { this.route = { view: "search", q: v }; this.render(); } else this.go({ view: "search", q: v }); }
        else if (this.route.view === "search") this.back();
      });
      q.addEventListener("keydown", (e) => { if (e.key === "Escape") { q.value = ""; if (this.route.view === "search") this.back(); } });
      this.statusEl = h("div", "rs-h-status", top);
      const seg = h("div", "rs-h-mode", top); seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Open songs in");
      h("span", "rs-h-mode-label", seg, "Open in");
      this.modeBtns = [["instrument", ICON.guitar, "Instrument"], ["karaoke", ICON.mic, "Karaoke"]].map(([m, ic, label]) => {
        const b = h("button", "rs-h-mode-btn", seg); b.type = "button"; b.dataset.mode = m; b.innerHTML = ic + `<span>${label}</span>`;
        b.title = `Play and Play buttons open songs in the ${label.toLowerCase()} mode`;
        b.addEventListener("click", () => this.setMode(m));
        return b;
      });
      this.setMode(this.mode);
      this.view = h("div", "rs-h-view", main);
      this.view.addEventListener("scroll", () => main.classList.toggle("is-scrolled", this.view.scrollTop > 40), { passive: true });
      this.toastEl = h("div", "rs-h-toast", el);
      this.menu = null;
      document.addEventListener("pointerdown", (e) => { if (this.menu && !this.menu.contains(e.target)) this._closeMenu(); }, true);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this._closeMenu();
        if ((e.altKey && e.key === "ArrowLeft") || (e.key === "Backspace" && !/INPUT|TEXTAREA/.test(e.target.tagName) && !e.target.isContentEditable)) { this.back(); e.preventDefault(); }
      });
    }

    toast(text) {
      this.toastEl.textContent = text;
      this.toastEl.classList.add("is-on");
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => this.toastEl.classList.remove("is-on"), 2600);
    }

    // ---- rendering -----------------------------------------------------------------------------
    render(keepScroll) {
      const st = keepScroll ? this.view.scrollTop : null;
      this._renderSide();
      this._renderStatus();
      this.btnBack.disabled = !this.past.length; this.btnFwd.disabled = !this.future.length;
      const v = this.view;
      v.innerHTML = "";
      v.dataset.view = this.route.view;
      const r = this.route;
      if (!this.songs.length) this._viewEmpty();
      else if (r.view === "artist" && this.artistMap.has(r.name)) this._viewArtist(this.artistMap.get(r.name));
      else if (r.view === "album" && this.albumMap.has(r.key)) this._viewAlbum(this.albumMap.get(r.key));
      else if (r.view === "genre" && this.genreMap.has(r.name)) this._viewGenre(this.genreMap.get(r.name));
      else if (r.view === "playlist" && this._playlist(r.id)) this._viewPlaylist(this._playlist(r.id));
      else if (r.view === "search") this._viewSearch(r.q || "");
      else if (r.view === "all") this._viewAll(r.kind);
      else { this.route = { view: "home" }; this._viewHome(); }
      if (st != null) v.scrollTop = st;
    }

    _renderStatus() {
      const s = this.status || {};
      this.statusEl.textContent = s.pending ? `Checking your library\u2026 ${s.total - s.pending}/${s.total}` : "";
      this.statusEl.style.display = s.pending ? "" : "none";
    }

    _renderSide() {
      this.chips.querySelectorAll(".rs-h-chip").forEach((c) => c.classList.toggle("is-on", c.dataset.k === this.libFilter));
      const L = this.sideList; L.innerHTML = "";
      const q = this.libQuery.trim().toLowerCase();
      const hit = (t) => !q || t.toLowerCase().includes(q);
      const row = (art, title, sub, onClick, active, round) => {
        const r = h("button", "rs-h-row" + (active ? " is-on" : ""), L); r.type = "button";
        if (round) art.classList.add("is-round");
        r.appendChild(art);
        const tx = h("div", "rs-h-row-text", r); h("b", "", tx, title); h("span", "", tx, sub);
        r.addEventListener("click", onClick);
        return r;
      };
      const R = this.route;
      if (this.libFilter === "playlists") {
        const pls = (this.user.playlists || []).filter((p) => hit(p.name));
        if (!pls.length && !q) {
          const e = h("div", "rs-h-side-empty", L);
          h("b", "", e, "Create your first playlist");
          h("span", "", e, "Add songs from any album, artist or search with the + button.");
          const b = h("button", "rs-h-pill is-light", e, "Create playlist"); b.type = "button";
          b.addEventListener("click", () => this.newPlaylist([]));
        }
        for (const p of pls) {
          row(this._mosaic(this._plSongs(p).filter(Boolean), p.name, 48), p.name, `Playlist \u00b7 ${plural(arr(p.songs).length, "song")}`,
              () => this.go({ view: "playlist", id: p.id }), R.view === "playlist" && R.id === p.id);
        }
      } else if (this.libFilter === "artists") {
        for (const a of this.artists.filter((a) => hit(a.name)).slice(0, 500)) {
          row(this._art(a.songs[0], 64, a.name), a.name, `Artist \u00b7 ${plural(a.songs.length, "song")}`,
              () => this.go({ view: "artist", name: a.name }), R.view === "artist" && R.name === a.name, true);
        }
      } else if (this.libFilter === "albums") {
        for (const a of this.albums.filter((a) => hit(a.album + " " + a.artist)).slice(0, 500)) {
          row(this._art(a.songs[0], 64, a.album), a.album, `Album \u00b7 ${a.artist}`,
              () => this.go({ view: "album", key: a.key }), R.view === "album" && R.key === a.key);
        }
      } else {
        if (!this.genres.length) { const e = h("div", "rs-h-side-empty", L); h("b", "", e, "No genres yet"); h("span", "", e, "Open an artist and set its genre, or let the app look genres up online."); }
        for (const g of this.genres.filter((g) => hit(g.name))) {
          row(this._genreArt(g.name, 48), g.name, `Genre \u00b7 ${plural(g.songs.length, "song")}`,
              () => this.go({ view: "genre", name: g.name }), R.view === "genre" && R.name === g.name);
        }
      }
    }

    // art: a <div> with a placeholder (colour + initials), the real art painted when visible
    _art(song, size, label) {
      const d = document.createElement("div");
      d.className = "rs-h-art";
      const [c1, c2] = pal((song && (song.album || song.artist)) || label);
      d.style.setProperty("--a1", c1); d.style.setProperty("--a2", c2);
      const initials = String(label || (song && song.title) || "?").replace(/[^\p{L}\p{N} ]/gu, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
      d.innerHTML = `<span class="rs-h-art-ph">${song && song.kind === "midi" ? ICON.note : initials || ICON.note}</span>`;
      if (song && song.kind === "psarc") {
        d.dataset.art = song.id; d.dataset.size = size > 128 ? 256 : size > 64 ? 128 : 64;
        if (this.io) this.io.observe(d); else this._paintArt(d);
      }
      return d;
    }
    _paintArt(d) {
      this.art.get(d.dataset.art, d.dataset.size).then((a) => {
        if (!a) return;
        d.style.backgroundImage = `url("${a.url}")`;
        d.classList.add("has-art");
        if (d._onColor && a.color) d._onColor(a.color);
      });
    }
    _mosaic(songs, label, size) {
      const withArt = [], seen = new Set();
      for (const s of songs) if (s && s.kind === "psarc" && !seen.has(s.album || s.id)) { seen.add(s.album || s.id); withArt.push(s); }
      if (withArt.length < 4) return this._art(withArt[0] || null, size, label);
      const d = h("div", "rs-h-art rs-h-mosaic");
      for (const s of withArt.slice(0, 4)) d.appendChild(this._art(s, size / 2, s.album));
      return d;
    }
    _genreArt(name, size) {
      const d = h("div", "rs-h-art rs-h-genre-art");
      const [c1, c2] = genreColors(name);
      d.style.setProperty("--a1", c1); d.style.setProperty("--a2", c2);
      h("span", "rs-h-art-ph", d, name.slice(0, 2));
      return d;
    }

    // cards -------------------------------------------------------------------------------------
    _card(parent, o) {                  // o: {art, title, sub, onOpen, onPlay, round}
      const c = h("div", "rs-h-card" + (o.round ? " is-round" : ""), parent);
      c.tabIndex = 0; c.setAttribute("role", "button"); c.setAttribute("aria-label", o.title);
      const w = h("div", "rs-h-card-art", c);
      w.appendChild(o.art);
      if (o.onPlay) {
        const p = h("button", "rs-h-playfab", w); p.type = "button"; p.innerHTML = this.mode === "karaoke" && o.canSing !== false ? ICON.mic : ICON.play;
        p.title = this.mode === "karaoke" ? "Sing (karaoke)" : "Play (instrument)";
        p.addEventListener("click", (e) => { e.stopPropagation(); o.onPlay(); });
      }
      h("b", "rs-h-card-title", c, o.title);
      if (o.sub) h("span", "rs-h-card-sub", c, o.sub);
      c.addEventListener("click", () => o.onOpen());
      c.addEventListener("keydown", (e) => { if (e.key === "Enter") o.onOpen(); });
      return c;
    }
    _shelf(title, items, mk, kind, max) {
      if (!items.length) return null;
      const s = h("section", "rs-h-shelf", this.view);
      const hd = h("div", "rs-h-shelf-head", s);
      h("h2", "", hd, title);
      const lim = max || 12;
      if (kind && items.length > 6) {
        const a = h("button", "rs-h-link", hd, "Show all"); a.type = "button";
        a.addEventListener("click", () => this.go({ view: "all", kind }));
      }
      const row = h("div", "rs-h-shelf-row", s);
      items.slice(0, lim).forEach((x) => mk(row, x));
      return s;
    }
    _songCard(row, s, context) {
      return this._card(row, { art: this._art(s, 256, s.title), title: s.title, sub: s.artist || (s.kind === "midi" ? "MIDI" : ""),
        canSing: s.kind === "psarc",
        onOpen: () => (s.album ? this.go({ view: "album", key: (s.artist || "Unknown artist") + "\u0001" + s.album }) : this.play([s], 0)),
        onPlay: () => this.play([s], 0, null, context) });
    }
    _albumCard(row, a) {
      return this._card(row, { art: this._art(a.songs[0], 256, a.album), title: a.album, sub: [a.year, a.artist].filter(Boolean).join(" \u00b7 "),
        onOpen: () => this.go({ view: "album", key: a.key }), onPlay: () => this.play(a.songs, 0, null, { type: "album", name: a.album }) });
    }
    _artistCard(row, a) {
      return this._card(row, { art: this._art(a.songs[0], 256, a.name), title: a.name, sub: "Artist", round: true,
        onOpen: () => this.go({ view: "artist", name: a.name }), onPlay: () => this.play(a.songs, 0, null, { type: "artist", name: a.name }) });
    }
    _genreCard(row, g) {
      const c = h("button", "rs-h-genre", row); c.type = "button";
      const [c1, c2] = genreColors(g.name);
      c.style.setProperty("--a1", c1); c.style.setProperty("--a2", c2);
      h("b", "", c, g.name); h("span", "", c, plural(g.songs.length, "song"));
      const art = this._art(g.songs[0], 128, g.name); art.classList.add("rs-h-genre-tilt"); c.appendChild(art);
      c.addEventListener("click", () => this.go({ view: "genre", name: g.name }));
      return c;
    }
    _playlistCard(row, p) {
      const songs = this._plSongs(p).filter(Boolean);
      return this._card(row, { art: this._mosaic(songs, p.name, 256), title: p.name, sub: `Playlist \u00b7 ${plural(arr(p.songs).length, "song")}`,
        onOpen: () => this.go({ view: "playlist", id: p.id }), onPlay: songs.length ? () => this.play(songs, 0, null, { type: "playlist", name: p.name, id: p.id }) : null });
    }

    // views -------------------------------------------------------------------------------------
    _viewEmpty() {
      const e = h("div", "rs-h-emptyview", this.view);
      e.innerHTML = `<div class="rs-h-emptyicon">${ICON.note}</div>`;
      h("h1", "", e, "Your library is empty");
      h("p", "", e, "Choose the folder with your Rocksmith .psarc files (\u201cChange\u2026\u201d at the bottom left), or drop a file on the Instrument or Karaoke sidebar.");
    }

    _viewHome() {
      const v = this.view;
      const hero = h("div", "rs-h-homehero", v);
      const hr = new Date().getHours();
      const top = h("div", "rs-h-homehead", hero);
      h("h1", "", top, hr < 5 ? "Late night session" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening");
      const sh = h("button", "rs-h-pill rs-h-shuffleall", top); sh.type = "button";
      sh.innerHTML = ICON.shuffle + "<span>Shuffle</span>";
      sh.title = "Play the whole library in random order (in the mode chosen top right)";
      sh.addEventListener("click", () => {
        const pool = this.mode === "karaoke" ? this.songs.filter((s) => s.lyrics === "archive") : this.songs.filter((s) => s.kind === "psarc");
        if (pool.length) this.play(pool, Math.floor(Math.random() * pool.length), null, { type: "shuffle", name: "the whole library" }, true);
      });
      // quick tiles: recently played songs and playlists
      const recent = this._recent();
      const tiles = [];
      for (const p of (this.user.playlists || []).slice(0, 2)) tiles.push({ kind: "playlist", p });
      for (const s of recent) { if (tiles.length >= 8) break; tiles.push({ kind: "song", s }); }
      if (tiles.length < 8) for (const a of this.albums.slice(0, 8 - tiles.length)) tiles.push({ kind: "album", a });
      const grid = h("div", "rs-h-quick", hero);
      for (const t of tiles) {
        const q = h("div", "rs-h-quicktile", grid); q.tabIndex = 0; q.setAttribute("role", "button");
        let art, title, open, play;
        if (t.kind === "playlist") { const songs = this._plSongs(t.p).filter(Boolean); art = this._mosaic(songs, t.p.name, 64); title = t.p.name;
          open = () => this.go({ view: "playlist", id: t.p.id }); play = songs.length ? () => this.play(songs, 0, null, { type: "playlist", name: t.p.name, id: t.p.id }) : null; }
        else if (t.kind === "song") { art = this._art(t.s, 64, t.s.title); title = t.s.title; open = () => this.play([t.s], 0); play = open; }
        else { art = this._art(t.a.songs[0], 64, t.a.album); title = t.a.album; open = () => this.go({ view: "album", key: t.a.key }); play = () => this.play(t.a.songs, 0, null, { type: "album", name: t.a.album }); }
        q.appendChild(art); h("b", "", q, title);
        if (play) { const b = h("button", "rs-h-playfab is-small", q); b.type = "button"; b.innerHTML = ICON.play; b.title = "Play";
          b.addEventListener("click", (e) => { e.stopPropagation(); play(); }); }
        q.addEventListener("click", open);
        q.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
      }
      if (recent.length) this._shelf("Jump back in", recent, (row, s) => this._songCard(row, s, { type: "recent" }), "recent");
      const pls = this.user.playlists || [];
      const sp = this._shelf("Your playlists", pls.length ? pls : [null], (row, p) => {
        if (p) return this._playlistCard(row, p);
        const c = this._card(row, { art: (() => { const d = h("div", "rs-h-art rs-h-newpl"); d.innerHTML = ICON.plus; return d; })(), title: "Create playlist",
          sub: "Mix songs from anywhere in your library", onOpen: () => this.newPlaylist([]) });
        return c;
      }, "playlists");
      if (sp && pls.length) {                      // a "new playlist" card after the playlists
        const row = sp.querySelector(".rs-h-shelf-row");
        const c = this._card(row, { art: (() => { const d = h("div", "rs-h-art rs-h-newpl"); d.innerHTML = ICON.plus; return d; })(),
          title: "New playlist", sub: "", onOpen: () => this.newPlaylist([]) });
        c.classList.add("is-new");
      }
      const sing = this.songs.filter((s) => s.lyrics === "archive");
      this._shelf("Sing along", sing, (row, s) => this._songCard(row, s, { type: "sing" }), "sing");
      this._shelf("Artists", this.artists, (row, a) => this._artistCard(row, a), "artists");
      this._shelf("Albums", this.albums, (row, a) => this._albumCard(row, a), "albums");
      if (this.genres.length) this._shelf("Genres", this.genres, (row, g) => this._genreCard(row, g), "genres", 8);
      const added = this.songs.slice().sort((a, b) => b.added - a.added);
      this._shelf("Recently added", added, (row, s) => this._songCard(row, s, { type: "added" }), "added");
    }

    _collection(kind) {
      switch (kind) {
        case "recent": return { title: "Jump back in", items: this._recent(), mk: (r, s) => this._songCard(r, s) };
        case "playlists": return { title: "Your playlists", items: this.user.playlists || [], mk: (r, p) => this._playlistCard(r, p) };
        case "sing": return { title: "Sing along", items: this.songs.filter((s) => s.lyrics === "archive"), mk: (r, s) => this._songCard(r, s) };
        case "artists": return { title: "Artists", items: this.artists, mk: (r, a) => this._artistCard(r, a) };
        case "albums": return { title: "Albums", items: this.albums, mk: (r, a) => this._albumCard(r, a) };
        case "genres": return { title: "Genres", items: this.genres, mk: (r, g) => this._genreCard(r, g) };
        default: return { title: "Recently added", items: this.songs.slice().sort((a, b) => b.added - a.added), mk: (r, s) => this._songCard(r, s) };
      }
    }
    _viewAll(kind) {
      const c = this._collection(kind);
      h("h1", "rs-h-pagetitle", this.view, c.title);
      const g = h("div", "rs-h-grid" + (kind === "genres" ? " is-genres" : ""), this.view);
      // big collections are built in chunks as you scroll
      let n = 0;
      const more = () => { c.items.slice(n, n + 60).forEach((x) => c.mk(g, x)); n += 60; if (n < c.items.length) this._sentinel(g, more); };
      more();
    }
    _sentinel(parent, fn) {
      const s = h("div", "rs-h-sentinel", parent);
      if (!this.io) { fn(); return; }
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); s.remove(); fn(); } }, { rootMargin: "600px" });
      io.observe(s);
    }

    _hero(o) {                         // o: {art, type, title, meta, color}
      const hero = h("div", "rs-h-hero", this.view);
      hero.style.setProperty("--hero", o.color || pal(o.colorKey || o.title)[0]);
      const a = h("div", "rs-h-hero-art" + (o.round ? " is-round" : ""), hero);
      o.art._onColor = (rgb) => hero.style.setProperty("--hero", `rgb(${rgb.join(",")})`);
      a.appendChild(o.art);
      const tx = h("div", "rs-h-hero-text", hero);
      h("span", "rs-h-hero-type", tx, o.type);
      const t = h("h1", "rs-h-hero-title", tx, o.title);
      if (o.title.length > 28) t.classList.add("is-long");
      const meta = h("div", "rs-h-hero-meta", tx);
      if (o.meta) meta.innerHTML = o.meta;
      return { hero, title: t, meta, text: tx };
    }
    _actions(songs, context, extra) {
      const bar = h("div", "rs-h-actions", this.view);
      const singable = songs.filter((s) => s.kind === "psarc").length;
      const big = h("button", "rs-h-bigplay", bar); big.type = "button"; big.innerHTML = this.mode === "karaoke" ? ICON.mic : ICON.play;
      big.title = this.mode === "karaoke" ? "Sing all (karaoke)" : "Play all (instrument)";
      big.addEventListener("click", () => this.play(songs, 0, null, context, this._shuffle));
      const p1 = h("button", "rs-h-pill", bar); p1.type = "button"; p1.innerHTML = ICON.guitar + "<span>Play</span>"; p1.title = "Play on the note highway (instrument mode)";
      p1.addEventListener("click", () => this.play(songs, 0, "instrument", context, this._shuffle));
      const p2 = h("button", "rs-h-pill", bar); p2.type = "button"; p2.innerHTML = ICON.mic + "<span>Sing</span>"; p2.title = "Sing along (karaoke mode)";
      p2.disabled = !singable;
      p2.addEventListener("click", () => this.play(songs, 0, "karaoke", context, this._shuffle));
      const sh = h("button", "rs-h-iconbtn is-big" + (this._shuffle ? " is-on" : ""), bar); sh.type = "button"; sh.innerHTML = ICON.shuffle; sh.title = "Shuffle";
      sh.setAttribute("aria-pressed", this._shuffle ? "true" : "false");
      sh.addEventListener("click", () => { this._shuffle = !this._shuffle; sh.classList.toggle("is-on", this._shuffle); sh.setAttribute("aria-pressed", String(!!this._shuffle)); });
      if (songs.length) {
        const add = h("button", "rs-h-iconbtn is-big", bar); add.type = "button"; add.innerHTML = ICON.plus; add.title = "Add all to a playlist";
        add.addEventListener("click", (e) => this._addMenu(e.currentTarget, songs.map((s) => s.id)));
      }
      if (extra) extra(bar);
      return bar;
    }
    _meta(parts) { return parts.filter(Boolean).map((p) => `<span>${p}</span>`).join('<i class="rs-h-dot"></i>'); }
    _esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

    _viewAlbum(a) {
      const total = a.songs.reduce((x, s) => x + s.length, 0);
      this._hero({ art: this._art(a.songs[0], 256, a.album), type: "Album", title: a.album, colorKey: a.album,
        meta: this._meta([`<b class="rs-h-metalink" data-artist="${this._esc(a.artist)}">${this._esc(a.artist)}</b>`, a.year, plural(a.songs.length, "song"), fmtLong(total)]) });
      this._actions(a.songs, { type: "album", name: a.album });
      this._tracks(a.songs, { context: { type: "album", name: a.album }, showAlbum: false });
      const more = (this.artistMap.get(a.artist) || { songs: [] }).songs.filter((s) => s.album !== a.album);
      if (more.length) {
        const albums = [...new Set(more.map((s) => s.artist + "\u0001" + s.album))].map((k) => this.albumMap.get(k)).filter(Boolean);
        this._shelf(`More by ${a.artist}`, albums.length ? albums : more, albums.length ? (r, x) => this._albumCard(r, x) : (r, s) => this._songCard(r, s));
      }
      this._wireMetaLinks();
    }
    _viewArtist(a) {
      const total = a.songs.reduce((x, s) => x + s.length, 0);
      const genre = this.user.artistGenres && this.user.artistGenres[NS.artistKey(a.name)] || (a.songs.find((s) => s.genre) || {}).genre || "";
      const H = this._hero({ art: this._art(a.songs[0], 256, a.name), type: "Artist", title: a.name, round: true, colorKey: a.name,
        meta: this._meta([plural(a.songs.length, "song"), fmtLong(total)]) });
      const g = h("button", "rs-h-genrechip" + (genre ? "" : " is-empty"), H.meta); g.type = "button";
      g.innerHTML = (genre ? `<span>${this._esc(genre)}</span>` : "<span>Set genre</span>") + ICON.edit;
      g.title = "The artist's genre (for the Genres shelf); set it by hand, it wins over the one found online";
      g.addEventListener("click", () => this._editGenre(g, a.name, genre));
      this._actions(a.songs, { type: "artist", name: a.name });
      this._tracks(a.songs, { context: { type: "artist", name: a.name }, showAlbum: true, title: "Songs" });
      const albums = [...new Set(a.songs.filter((s) => s.album).map((s) => a.name + "\u0001" + s.album))].map((k) => this.albumMap.get(k)).filter(Boolean);
      this._shelf("Albums", albums, (r, x) => this._albumCard(r, x));
      if (genre && this.genreMap.has(genre)) {
        const like = this.artists.filter((x) => x.name !== a.name && x.songs.some((s) => s.genre === genre));
        this._shelf(`More ${genre}`, like, (r, x) => this._artistCard(r, x));
      }
    }
    _viewGenre(g) {
      const total = g.songs.reduce((x, s) => x + s.length, 0);
      this._hero({ art: this._genreArt(g.name, 256), type: "Genre", title: g.name, colorKey: "genre:" + g.name, color: genreColors(g.name)[0],
        meta: this._meta([plural(new Set(g.songs.map((s) => s.artist)).size, "artist"), plural(g.songs.length, "song"), fmtLong(total)]) });
      this._actions(g.songs, { type: "genre", name: g.name });
      const artists = this.artists.filter((x) => x.songs.some((s) => s.genre === g.name));
      this._shelf("Artists", artists, (r, x) => this._artistCard(r, x));
      this._tracks(g.songs, { context: { type: "genre", name: g.name }, showAlbum: true, title: "Songs" });
    }
    _viewPlaylist(p) {
      const songs = this._plSongs(p);
      const ok = songs.filter(Boolean), total = ok.reduce((x, s) => x + s.length, 0);
      const H = this._hero({ art: this._mosaic(ok, p.name, 256), type: "Playlist", title: p.name, colorKey: p.name,
        meta: this._meta([plural(songs.length, "song"), total ? fmtLong(total) : "", songs.length > ok.length ? `${songs.length - ok.length} not in the library` : ""]) });
      H.title.title = "Click to rename";
      H.title.classList.add("is-editable");
      H.title.addEventListener("click", () => this._rename(H.title, p));
      this._actions(ok, { type: "playlist", name: p.name, id: p.id }, (bar) => {
        const ed = h("button", "rs-h-iconbtn is-big", bar); ed.type = "button"; ed.innerHTML = ICON.edit; ed.title = "Rename";
        ed.addEventListener("click", () => this._rename(H.title, p));
        const del = h("button", "rs-h-iconbtn is-big is-danger", bar); del.type = "button"; del.innerHTML = ICON.trash; del.title = "Delete this playlist";
        del.addEventListener("click", () => this._confirm(del, `Delete \u201c${p.name}\u201d?`, () => { this._act({ op: "playlist_delete", pid: p.id }); this.go({ view: "home" }); }));
      });
      if (!songs.length) {
        const e = h("div", "rs-h-plempty", this.view);
        h("b", "", e, "Let's find something for your playlist");
        h("span", "", e, "Use + on any song, album or artist \u2014 or search below.");
        const s = h("input", "rs-h-plsearch", e); s.type = "search"; s.placeholder = "Search for songs";
        const res = h("div", "", this.view);
        s.addEventListener("input", () => {
          res.innerHTML = ""; const q = s.value.trim().toLowerCase(); if (!q) return;
          const hits = this.songs.filter((x) => (x.title + " " + x.artist + " " + x.album).toLowerCase().includes(q)).slice(0, 30);
          const save = this.view; this.view = res; this._tracks(hits, { addTo: p.id }); this.view = save;
        });
        return;
      }
      this._tracks(songs, { context: { type: "playlist", name: p.name, id: p.id }, showAlbum: true, playlist: p });
    }
    _viewSearch(q) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const match = (t) => { t = t.toLowerCase(); return words.every((w) => t.includes(w)); };
      const songs = this.songs.filter((s) => match(`${s.title} ${s.artist} ${s.album} ${s.genre}`));
      const artists = this.artists.filter((a) => match(a.name));
      const albums = this.albums.filter((a) => match(`${a.album} ${a.artist}`));
      const pls = (this.user.playlists || []).filter((p) => match(p.name));
      const genres = this.genres.filter((g) => match(g.name));
      h("h1", "rs-h-pagetitle", this.view, songs.length + artists.length + albums.length + pls.length ? `Results for \u201c${q}\u201d` : `Nothing found for \u201c${q}\u201d`);
      if (songs.length) this._tracks(songs.slice(0, 50), { context: { type: "search", name: q }, showAlbum: true, title: "Songs" + (songs.length > 50 ? ` (first 50 of ${songs.length})` : "") });
      this._shelf("Artists", artists, (r, a) => this._artistCard(r, a));
      this._shelf("Albums", albums, (r, a) => this._albumCard(r, a));
      this._shelf("Playlists", pls, (r, p) => this._playlistCard(r, p));
      this._shelf("Genres", genres, (r, g) => this._genreCard(r, g));
    }
    _wireMetaLinks() {
      this.view.querySelectorAll(".rs-h-metalink[data-artist]").forEach((b) =>
        b.addEventListener("click", () => this.go({ view: "artist", name: b.dataset.artist })));
    }

    // track list ----------------------------------------------------------------------------------
    _tracks(songs, o) {
      o = o || {};
      const wrap = h("div", "rs-h-tracks" + (o.showAlbum ? " has-album" : ""), this.view);
      if (o.title) h("h2", "rs-h-tracks-title", wrap, o.title);
      const head = h("div", "rs-h-track is-head", wrap);
      head.innerHTML = `<span class="rs-h-tn">#</span><span>Title</span>${o.showAlbum ? "<span>Album</span>" : ""}<span class="rs-h-tl" title="Lyrics">Lyrics</span><span class="rs-h-td">\u23F1</span><span></span>`;
      const list = songs;
      const mkRow = (s, i) => {
        const r = h("div", "rs-h-track" + (s ? "" : " is-missing"), wrap);
        r.dataset.i = i;
        if (!s) {
          const e = o.playlist && arr(o.playlist.missing)[i];
          r.innerHTML = `<span class="rs-h-tn">${i + 1}</span><span class="rs-h-tt"><b>${this._esc((e && e.title) || "Missing song")}</b><span>not in the library any more</span></span>`;
          if (o.showAlbum) h("span", "", r);
          h("span", "", r); h("span", "", r);
          const acts = h("span", "rs-h-tacts", r);
          if (o.playlist) this._rowBtn(acts, ICON.close, "Remove from this playlist", () => this._act({ op: "playlist_remove", pid: o.playlist.id, index: i + 1 }));
          return;
        }
        const n = h("span", "rs-h-tn", r);
        h("span", "rs-h-tnum", n, String(i + 1));
        const pb = h("button", "rs-h-tplay", n); pb.type = "button"; pb.innerHTML = ICON.play; pb.title = this.mode === "karaoke" ? "Sing" : "Play";
        pb.addEventListener("click", (e) => { e.stopPropagation(); this.play(list.filter(Boolean), list.filter(Boolean).indexOf(s), null, o.context); });
        const tt = h("span", "rs-h-tt", r);
        tt.appendChild(this._art(s, 64, s.title));
        const tx = h("span", "rs-h-tt-text", tt);
        h("b", "", tx, s.title);
        const sub = h("span", "", tx);
        if (s.artist) { const l = h("button", "rs-h-textlink", sub, s.artist); l.type = "button"; l.addEventListener("click", (e) => { e.stopPropagation(); this.go({ view: "artist", name: s.artist }); }); }
        else sub.textContent = s.kind === "midi" ? "MIDI file" : "";
        if (o.showAlbum) {
          const al = h("span", "rs-h-talb", r);
          if (s.album) { const l = h("button", "rs-h-textlink", al, s.album); l.type = "button";
            l.addEventListener("click", (e) => { e.stopPropagation(); this.go({ view: "album", key: (s.artist || "Unknown artist") + "\u0001" + s.album }); }); }
        }
        const ly = h("span", "rs-h-tl", r);
        if (s.lyrics === "archive") { ly.innerHTML = ICON.mic; ly.title = "Lyrics in the file: sing along"; ly.classList.add("is-yes"); }
        else if (s.lyrics === "web") { ly.innerHTML = ICON.globe; ly.title = "No lyrics in the file: looked up online when you sing it"; }
        h("span", "rs-h-td", r, s.length ? fmt(s.length) : "");
        const acts = h("span", "rs-h-tacts", r);
        this._rowBtn(acts, ICON.guitar, "Play (instrument mode)", () => this.play([s], 0, "instrument", o.context));
        const m = this._rowBtn(acts, ICON.mic, "Sing (karaoke mode)", () => this.play([s], 0, "karaoke", o.context));
        if (s.kind !== "psarc") m.disabled = true;
        if (o.addTo) this._rowBtn(acts, ICON.plus, "Add to this playlist", () => { this._act({ op: "playlist_add", pid: o.addTo, ids: [s.id] }); this.toast(`Added \u201c${s.title}\u201d`); });
        else this._rowBtn(acts, ICON.plus, "Add to a playlist", (b) => this._addMenu(b, [s.id]));
        if (o.playlist) {
          this._rowBtn(acts, ICON.close, "Remove from this playlist", () => this._act({ op: "playlist_remove", pid: o.playlist.id, index: i + 1 }));
          r.draggable = true;
          r.classList.add("is-draggable");
        }
        r.addEventListener("dblclick", () => this.play(list.filter(Boolean), list.filter(Boolean).indexOf(s), null, o.context));
      };
      let n = 0;
      const more = () => { for (const end = Math.min(list.length, n + 120); n < end; n++) mkRow(list[n], n); if (n < list.length) this._sentinel(wrap, more); };
      more();
      if (o.playlist) this._dnd(wrap, o.playlist);
      return wrap;
    }
    _rowBtn(parent, icon, title, fn) {
      const b = h("button", "rs-h-rowbtn", parent); b.type = "button"; b.innerHTML = icon; b.title = title; b.setAttribute("aria-label", title);
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
      return b;
    }
    /** Drag a row of a playlist to move it. */
    _dnd(wrap, p) {
      let from = null;
      wrap.addEventListener("dragstart", (e) => { const r = e.target.closest(".rs-h-track"); if (!r) return; from = +r.dataset.i; r.classList.add("is-dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(from)); });
      wrap.addEventListener("dragend", (e) => { const r = e.target.closest(".rs-h-track"); if (r) r.classList.remove("is-dragging"); wrap.querySelectorAll(".is-dropbefore,.is-dropafter").forEach((x) => x.classList.remove("is-dropbefore", "is-dropafter")); });
      wrap.addEventListener("dragover", (e) => {
        const r = e.target.closest(".rs-h-track:not(.is-head)"); if (from == null || !r) return;
        e.preventDefault();
        wrap.querySelectorAll(".is-dropbefore,.is-dropafter").forEach((x) => x.classList.remove("is-dropbefore", "is-dropafter"));
        const b = r.getBoundingClientRect(); r.classList.add(e.clientY < b.top + b.height / 2 ? "is-dropbefore" : "is-dropafter");
      });
      wrap.addEventListener("drop", (e) => {
        const r = e.target.closest(".rs-h-track:not(.is-head)"); if (from == null || !r) return;
        e.preventDefault();
        const b = r.getBoundingClientRect(); let to = +r.dataset.i + (e.clientY < b.top + b.height / 2 ? 0 : 1);
        if (to > from) to -= 1;
        if (to !== from) this._act({ op: "playlist_move", pid: p.id, from: from + 1, to: to + 1 });
        from = null;
      });
    }

    // small popovers --------------------------------------------------------------------------------
    _popover(anchor, build) {
      this._closeMenu();
      const m = (this.menu = h("div", "rs-h-menu", this.el));
      build(m);
      const a = anchor.getBoundingClientRect(), r = this.el.getBoundingClientRect();
      m.style.left = Math.min(a.left - r.left, r.width - 260) + "px";
      m.style.top = (a.bottom - r.top + 6) + "px";
      const mb = m.getBoundingClientRect();
      if (mb.bottom > r.bottom - 8) m.style.top = Math.max(8, a.top - r.top - mb.height - 6) + "px";
      return m;
    }
    _closeMenu() { if (this.menu) { this.menu.remove(); this.menu = null; } }
    _addMenu(anchor, ids) {
      this._popover(anchor, (m) => {
        h("div", "rs-h-menu-title", m, `Add ${ids.length > 1 ? plural(ids.length, "song") : "to a playlist"}`);
        const nw = h("button", "rs-h-menu-item is-new", m); nw.type = "button"; nw.innerHTML = ICON.plus + "<span>New playlist</span>";
        nw.addEventListener("click", () => { this._closeMenu(); this.newPlaylist(ids, false); this.toast(`New playlist with ${plural(ids.length, "song")}`); });
        for (const p of this.user.playlists || []) {
          const b = h("button", "rs-h-menu-item", m); b.type = "button";
          b.appendChild(this._mosaic(this._plSongs(p).filter(Boolean), p.name, 32));
          h("span", "", b, p.name);
          b.addEventListener("click", () => { this._closeMenu(); this._act({ op: "playlist_add", pid: p.id, ids }); this.toast(`Added to \u201c${p.name}\u201d`); });
        }
      });
    }
    _confirm(anchor, text, yes) {
      this._popover(anchor, (m) => {
        h("div", "rs-h-menu-title", m, text);
        const row = h("div", "rs-h-menu-row", m);
        const n = h("button", "rs-h-pill", row, "Cancel"); n.type = "button"; n.addEventListener("click", () => this._closeMenu());
        const y = h("button", "rs-h-pill is-danger", row, "Delete"); y.type = "button"; y.addEventListener("click", () => { this._closeMenu(); yes(); });
      });
    }
    _rename(titleEl, p) {
      const input = document.createElement("input");
      input.className = "rs-h-rename"; input.value = p.name; input.maxLength = 100;
      titleEl.replaceWith(input); input.focus(); input.select();
      let done = false;
      const finish = (save) => {
        if (done) return; done = true;
        const v = input.value.trim();
        if (save && v && v !== p.name) { p.name = v; this._act({ op: "playlist_rename", pid: p.id, name: v }); }
        this.render(true);
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); e.stopPropagation(); });
      input.addEventListener("blur", () => finish(true));
    }
    _editGenre(chip, artist, current) {
      this._popover(chip, (m) => {
        h("div", "rs-h-menu-title", m, `Genre of ${artist}`);
        const input = h("input", "rs-h-menu-input", m); input.value = current || ""; input.placeholder = "e.g. Blues Rock";
        const dl = h("div", "rs-h-menu-chips", m);
        const known = [...new Set([...this.genres.map((g) => g.name), ...GENRE_SUGGEST])];
        for (const g of known.slice(0, 24)) { const b = h("button", "rs-h-chip", dl, g); b.type = "button"; b.addEventListener("click", () => { input.value = g; save(); }); }
        const row = h("div", "rs-h-menu-row", m);
        if (current) { const c = h("button", "rs-h-pill", row, "Clear"); c.type = "button"; c.addEventListener("click", () => { input.value = ""; save(); }); }
        const ok = h("button", "rs-h-pill is-light", row, "Save"); ok.type = "button";
        const save = () => { this._closeMenu(); this._act({ op: "genre_set", artist, genre: input.value.trim() }); this.toast(input.value.trim() ? `${artist}: ${input.value.trim()}` : `Genre of ${artist} cleared`); };
        ok.addEventListener("click", save);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); e.stopPropagation(); });
        setTimeout(() => input.focus(), 0);
      });
    }
  }
  NS.Home = Home;
  NS.homes = NS.homes || new Map();

  // ---- Shiny output binding (only when Shiny is on the page) ----------------------------------------
  if (root.Shiny && root.Shiny.OutputBinding) {
    const B = new root.Shiny.OutputBinding();
    root.$.extend(B, {
      find: (scope) => root.$(scope).find(".rs-home-output"),
      renderValue(el, value) {
        let home = NS.homes.get(el.id);
        if (!home) {
          home = new Home(el, { action: (o) => root.Shiny.setInputValue(el.id + "_action", o, { priority: "event" }) });
          NS.homes.set(el.id, home);
          const foot = document.getElementById(el.dataset.foot || "");      // the app's library status line
          if (foot) {
            home.sideFoot.appendChild(foot);
            root.$(foot).trigger("shown");                                // Shiny renders outputs that became visible
            root.dispatchEvent(new Event("resize"));
          }
        }
        if (value) home.load(value);
      },
    });
    root.Shiny.outputBindings.register(B, "rockshiny.home");
    root.Shiny.addCustomMessageHandler("rs-home", (m) => {
      const home = NS.homes.get(m.id);
      if (!home) return;
      if (m.cmd === "user") home.setUser(m.user);
      else if (m.cmd === "status") home.setStatus(m.status);
      else if (m.cmd === "go") home.go(m.route);
    });
  }
})(window);

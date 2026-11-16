/* ---------------------------------------------------------------------------
 * rsc-shiny.js -- the studio in a Shiny app (creator/R/mod_studio.R).
 *
 * R -> JS: custom message "rsc-studio" {id, cmd, ...}
 *   config {upload}                   the session's upload URL (POST)
 *   open {url, name}                  fetch a .psarc from R and open it
 *   new {audioUrl, audioName, ...}    a new song from an audio file on the server
 *   save {platform, action, token}    build the package: "download" here, or
 *                                     "library": POST it to R (then <id>_saved)
 *   lyrics {requestId, result}        answer to <id>_lyrics_request
 *   import-lyrics {text, name}        lyrics from an uploaded .lrc
 *   stems {}                          run the separation
 *   save-stems {token}                POST every stem (then <id>_stems_saved)
 *   audio {requestId, url}            answer to <id>_audio_request (audio fallback)
 * JS -> R: inputs <id>_state (song, changes, stems...), <id>_saved,
 *   <id>_lyrics_request, <id>_stems_saved, <id>_audio_request, <id>_error
 * Bytes never travel on the websocket: R serves files by URL and receives
 * packages by POST.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const RSC = root.RSCreator, E = RSC.engine;
  const studios = new Map(), configs = new Map(), pending = new Map();
  let seq = 0;
  const set = (name, value) => root.Shiny && Shiny.setInputValue && Shiny.setInputValue(name, value, { priority: "event" });

  function request(id, kind, payload, ms) {
    const requestId = ++seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => { pending.delete(requestId); resolve(null); }, ms || 30000);
      pending.set(requestId, (v) => { clearTimeout(t); resolve(v); });
      set(id + "_" + kind + "_request", Object.assign({ requestId }, payload));
    });
  }
  async function post(id, params, bytes) {
    const cfg = configs.get(id);
    if (!cfg || !cfg.upload) throw new Error("The server did not give an upload address.");
    const url = cfg.upload + (cfg.upload.includes("?") ? "&" : "?") + new URLSearchParams(params);
    const r = await fetch(url, { method: "POST", body: bytes, headers: { "Content-Type": "application/octet-stream" } });
    if (!r.ok) throw new Error("Upload failed (" + r.status + "): " + (await r.text()).slice(0, 200));
  }

  // "Help & tour" in the sidebar (creator/R/mod_creator.R): <button data-rsc-help="<studio id>" data-rsc-what="help|tour">
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-rsc-help]");
    if (!b) return;
    const st = studios.get(b.dataset.rscHelp) || init(document.getElementById(b.dataset.rscHelp));
    if (!st) return;
    if (b.dataset.rscWhat === "tour") RSC.tour.start(st);
    else if (b.dataset.rscWhat === "demo") RSC.openDemo(st).catch((e) => st.toast(e.message, "error"));
    else RSC.help.open(st, b.dataset.rscSection);
  });

  function init(el) {
    if (!el) return null;
    if (el._rsc) return el._rsc;
    const id = el.id;
    const prefix = id.replace(/studio-studio$/, "");      // the Creator module's namespace ("creator-")
    const host = {
      name: "shiny",
      tour: { open: ["#" + prefix + "project-file", ".rs-dropzone"], library: "#" + prefix + "project-library + .selectize-control", save: "#" + prefix + "export-save" },
      fetchLyrics: (q) => request(id, "lyrics", q, 30000),
      saveStems: async (files) => {
        const token = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        for (const f of files) await post(id, { token, kind: "stem", part: f.id }, f.bytes);
        set(id + "_stems_saved", { token, ids: files.map((f) => f.id), title: st.project.meta.title, artist: st.project.meta.artist });
        return "Stems sent to the server";
      },
      audioFallback: async () => {
        const r = await request(id, "audio", {}, 180000);
        if (!r || !r.url) return null;
        return new Uint8Array(await (await fetch(r.url)).arrayBuffer());
      }
    };
    const st = new RSC.Studio(el, { host });
    el._rsc = st;
    studios.set(id, st);
    const report = () => {
      const p = st.project;
      set(id + "_state", p ? {
        open: true, title: p.meta.title, artist: p.meta.artist, album: p.meta.album, year: p.meta.year, key: p.key, platform: p.platform,
        dirty: !!st.dirty, charts: p.arrangements.map((a) => a.name), lyrics: p.vocals ? p.vocals.syllables.length : 0,
        stems: st.audio.stems ? st.audio.stems.ids : [], duration: st.audio.duration || 0, file: st.fileName || null,
        suggested: { pc: E.packageFileName(p, "pc"), mac: E.packageFileName(p, "mac") }, nonce: Date.now()
      } : { open: false, nonce: Date.now() });
    };
    let timer = null;
    st.on((type) => {
      if (type === "open" || type === "save" || type === "stems") report();
      if (type === "change") { clearTimeout(timer); timer = setTimeout(report, 400); }
    });
    report();
    return st;
  }

  async function handle(m) {
    const el = document.getElementById(m.id);
    const st = studios.get(m.id) || init(el);
    if (!st) return;
    try {
      switch (m.cmd) {
        case "config": configs.set(m.id, { upload: m.upload }); break;
        case "open": {
          st.busy("Opening " + (m.name || "the song") + "\u2026", "Downloading from the server");
          const r = await fetch(m.url);
          if (!r.ok) throw new Error("the server answered " + r.status);
          const bytes = new Uint8Array(await r.arrayBuffer());
          st.busy("Opening " + (m.name || "the song") + "\u2026", "Unpacking the archive");
          const made = await E.projectFromPsarc(bytes);
          st.fileName = m.name || null;
          await st.open(made);
          break;
        }
        case "new": {
          st.busy("Creating the song\u2026", "Downloading the audio");
          const bytes = new Uint8Array(await (await fetch(m.audioUrl)).arrayBuffer());
          const isWem = /\.wem$/i.test(m.audioName || "");
          await RSC.newSong(st, {
            title: m.title, artist: m.artist, album: m.album, year: m.year, platform: m.platform || "pc", bpm: m.bpm || undefined,
            arrangements: (m.arrangements || ["lead"]).map((k) => ({ kind: k, tuning: RSC.TUNINGS[m.tuning] || RSC.TUNINGS["E standard"] })),
            file: isWem ? null : bytes, wem: isWem ? bytes : null, draft: !!m.draft
          });
          st.fileName = null;
          break;
        }
        case "save": {
          const bytes = await st.save({ platform: m.platform });
          const name = E.packageFileName(st.project, m.platform || st.project.platform);
          if (m.action === "download") RSC.download(bytes, name, "application/octet-stream");
          else {
            st.busy("Saving to the library\u2026", (bytes.length / 1e6).toFixed(1) + " MB");
            try { await post(m.id, { token: m.token, kind: "psarc" }, bytes); } finally { st.busy(null); }
            set(m.id + "_saved", { token: m.token, name, size: bytes.length, platform: m.platform || st.project.platform });
          }
          break;
        }
        case "lyrics": { const f = pending.get(m.requestId); if (f) { pending.delete(m.requestId); f(m.result || null); } break; }
        case "audio": { const f = pending.get(m.requestId); if (f) { pending.delete(m.requestId); f(m); } break; }
        case "import-lyrics": RSC.importLyrics(st, m.text, m.name); break;
        case "stems": st.insTab = "stems"; st.renderInspector(); await RSC.toolAct(st, "stems:run"); break;
        case "save-stems": {
          if (!st.audio.stems) { st.toast("Separate the stems first", "error"); break; }
          await RSC.toolAct(st, "stems:save");
          break;
        }
        case "tab": st.insTab = m.tab; st.renderInspector(); break;
        case "toast": st.toast(m.text, m.level, m.ms); break;
        case "pause": st.audio.pause(); break;
      }
    } catch (err) {
      st.busy(null);
      st.toast(String(err && err.message || err), "error", 7000);
      set(m.id + "_error", { cmd: m.cmd, message: String(err && err.message || err), nonce: Date.now() });
    }
  }

  if (root.Shiny && Shiny.addCustomMessageHandler) Shiny.addCustomMessageHandler("rsc-studio", handle);
  const boot = () => document.querySelectorAll(".rsc-shiny").forEach(init);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
  if (root.jQuery) jQuery(document).on("shiny:connected", boot);
  RSC.shinyStudios = studios;
})(typeof window !== "undefined" ? window : globalThis);

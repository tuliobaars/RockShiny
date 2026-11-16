/* ---------------------------------------------------------------------------
 * rsc-page.js -- RockShiny Creator as one offline HTML page: the sidebar (open,
 * new song, save) around the studio. Everything happens in the page: the
 * .psarc is read, edited and written by the engine; nothing is uploaded.
 * (The Shiny app has the same sidebar in R: creator/R/mod_*.R.)
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const RSC = root.RSCreator, E = RSC.engine, esc = RSC.esc;
  const ICON = {
    open: '<svg viewBox="0 0 24 24"><path d="M19 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2zM12 9l-4 4h3v4h2v-4h3z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
    song: RSC.ICON.song, keys: '<svg viewBox="0 0 24 24"><path d="M20 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm-9 3h2v2h-2zm0 3h2v2h-2zM8 8h2v2H8zm0 3h2v2H8zm-1 2H5v-2h2zm0-3H5V8h2zm9 7H8v-2h8zm0-4h-2v-2h2zm0-3h-2V8h2zm3 3h-2v-2h2zm0-3h-2V8h2z"/></svg>'
  };

  function build(studio) {
    const side = document.getElementById("rscp-side");
    side.innerHTML =
      '<details class="rscp-sec" open><summary>' + ICON.song + 'Song</summary><div class="rscp-body">' +
      '<div class="rscp-drop" tabindex="0" role="button" data-role="drop"><div class="rscp-drop-icon">' + ICON.open + '</div><div><strong>Drop a .psarc or an audio file</strong>' +
      '<span>or click to browse \u2014 a .psarc opens for editing, audio starts a new song</span></div></div>' +
      '<input type="file" hidden data-role="file" accept=".psarc,audio/*,.wem,.mp3,.ogg,.wav,.flac,.m4a,.aac,.opus">' +
      '<div class="rscp-hint">Rocksmith 2014 packages (PC <code>_p</code> or Mac <code>_m</code>). Files never leave this computer.</div>' +
      '<button class="rscp-btn" data-role="demo">' + ICON.plus + "Open the demo song</button></div></details>" +
      '<details class="rscp-sec" data-role="newsec"><summary>' + ICON.plus + 'New song</summary><div class="rscp-body">' +
      '<div class="rscp-fieldset"><label class="rscp-label">Audio</label><input class="rscp-input" style="padding-top:6px" type="file" data-role="newaudio" accept="audio/*,.wem,.mp3,.ogg,.wav,.flac,.m4a,.aac,.opus"></div>' +
      '<div class="rscp-fieldset"><label class="rscp-label">Title</label><input class="rscp-input" data-role="n-title" placeholder="Song title"></div>' +
      '<div class="rscp-fieldset"><label class="rscp-label">Artist</label><input class="rscp-input" data-role="n-artist" placeholder="Artist"></div>' +
      '<div class="rscp-row2"><div class="rscp-fieldset"><label class="rscp-label">Album</label><input class="rscp-input" data-role="n-album"></div>' +
      '<div class="rscp-fieldset"><label class="rscp-label">Year</label><input class="rscp-input" data-role="n-year" inputmode="numeric"></div></div>' +
      '<div class="rscp-fieldset"><label class="rscp-label">Charts</label><div class="rscp-checks">' +
      ["lead", "rhythm", "bass"].map((k, i) => '<label><input type="checkbox" data-role="n-arr" value="' + k + '"' + (i !== 1 ? " checked" : "") + ">" + k[0].toUpperCase() + k.slice(1) + "</label>").join("") + "</div></div>" +
      '<div class="rscp-row2"><div class="rscp-fieldset"><label class="rscp-label">Tuning</label><select class="rscp-select" data-role="n-tuning">' +
      Object.keys(RSC.TUNINGS).map((n) => "<option>" + n + "</option>").join("") + '</select></div>' +
      '<div class="rscp-fieldset"><label class="rscp-label">Tempo (BPM)</label><input class="rscp-input" data-role="n-bpm" placeholder="detect" inputmode="decimal"></div></div>' +
      '<label class="rscp-check"><input type="checkbox" data-role="n-draft"> Draft the rhythm and bass charts from the audio (rough)</label>' +
      '<button class="rscp-btn is-primary" data-role="create">' + ICON.plus + "Create the song</button>" +
      '<div class="rscp-hint">The beats are found in the audio (or set by the tempo); the audio is stored as 16-bit PCM (a Wwise .wem is used as it is).</div></div></details>' +
      '<details class="rscp-sec" open><summary>' + ICON.save + 'Save</summary><div class="rscp-body">' +
      '<label class="rscp-label">Package for</label><div class="rscp-seg" data-role="plat"><button data-p="pc">PC</button><button data-p="mac">Mac</button></div>' +
      '<button class="rscp-btn is-primary" data-role="save" disabled>' + ICON.save + "Download .psarc</button>" +
      '<button class="rscp-btn" data-role="check" disabled>' + ICON.check + "Check the package</button>" +
      '<div data-role="report"></div>' +
      '<div class="rscp-hint">Unchanged files are written back byte for byte; edited charts get a new XML and a compiled SNG, with their difficulty levels as the Levels tab says.</div></div></details>' +
      '<details class="rscp-sec"><summary>' + ICON.keys + 'Shortcuts</summary><div class="rscp-body"><div class="rscp-keys">' +
      [["Space", "play / pause"], ["D", "draw"], ["V", "select"], ["E", "erase"], ["0\u20139", "fret"], ["H P B S", "techniques"], ["Ctrl Z", "undo"], ["L", "loop"], ["+ \u2212", "zoom"]]
        .map(([k, t]) => "<span><kbd>" + k + "</kbd>" + t + "</span>").join("") + "</div></div></details>";

    const $ = (r) => side.querySelector('[data-role="' + r + '"]');
    let platform = "pc";
    const setPlat = (p) => { platform = p; side.querySelectorAll("[data-p]").forEach((b) => b.classList.toggle("is-on", b.dataset.p === p)); };
    setPlat("pc");
    side.querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => setPlat(b.dataset.p)));
    const fileInp = $("file"), drop = $("drop");
    drop.addEventListener("click", () => fileInp.click());
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInp.click(); } });
    fileInp.addEventListener("change", () => { if (fileInp.files[0]) openFile(fileInp.files[0]); fileInp.value = ""; });
    for (const t of [document.body]) {
      t.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("is-over"); });
      t.addEventListener("dragleave", (e) => { if (e.target === document.body || !e.relatedTarget) drop.classList.remove("is-over"); });
      t.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("is-over"); const f = e.dataTransfer.files[0]; if (f) openFile(f); });
    }
    let pendingAudio = null;
    $("newaudio").addEventListener("change", (e) => { pendingAudio = e.target.files[0] || null; guessFromName(pendingAudio); });

    async function openFile(f) {
      if (studio.dirty && root.confirm && !root.confirm("Discard the unsaved changes of the song that is open?")) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (/\.psarc$/i.test(f.name) || E.latin1(bytes.subarray(0, 4)) === "PSAR") {
        studio.busy("Opening " + f.name + "\u2026", "Unpacking the archive");
        try {
          const made = await E.projectFromPsarc(bytes);
          studio.fileName = f.name;
          setPlat(made.project.platform);
          await studio.open(made);
        } catch (err) { studio.busy(null); studio.toast("Could not open " + f.name + ": " + err.message, "error", 7000); }
        return;
      }
      // audio: start a new song with it
      pendingAudio = f;
      guessFromName(f);
      side.querySelector('[data-role="newsec"]').open = true;
      $("n-title").focus();
      studio.toast("New song: check the title and artist, then \u201cCreate the song\u201d");
    }
    function guessFromName(f) {
      if (!f) return;
      const base = f.name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
      const m = /^(.*?)\s+-\s+(.*)$/.exec(base);
      if (m) { if (!$("n-artist").value) $("n-artist").value = m[1].trim(); if (!$("n-title").value) $("n-title").value = m[2].trim(); }
      else if (!$("n-title").value) $("n-title").value = base;
    }
    $("create").addEventListener("click", async () => {
      if (!pendingAudio) { studio.toast("Choose the song's audio first", "error"); return; }
      const arrs = Array.from(side.querySelectorAll('[data-role="n-arr"]:checked')).map((c) => c.value);
      const tuning = RSC.TUNINGS[$("n-tuning").value] || RSC.TUNINGS["E standard"];
      const bytes = new Uint8Array(await pendingAudio.arrayBuffer()), isWem = /\.wem$/i.test(pendingAudio.name);
      try {
        await RSC.newSong(studio, {
          title: $("n-title").value.trim() || "Untitled", artist: $("n-artist").value.trim() || "Unknown Artist", album: $("n-album").value.trim(),
          year: $("n-year").value.trim(), platform, bpm: +$("n-bpm").value || undefined,
          arrangements: (arrs.length ? arrs : ["lead"]).map((k) => ({ kind: k, tuning })),
          file: isWem ? null : bytes, wem: isWem ? bytes : null, draft: $("n-draft").checked
        });
        studio.fileName = null;
        side.querySelector('[data-role="newsec"]').open = false;
      } catch (err) { studio.toast("Could not create the song: " + err.message, "error", 7000); }
    });
    $("save").addEventListener("click", async () => {
      try {
        const bytes = await studio.save({ platform });
        RSC.download(bytes, E.packageFileName(studio.project, platform), "application/octet-stream");
        report(await checkPackage(bytes), bytes.length);
      } catch (err) { studio.toast("Could not save: " + err.message, "error", 7000); }
    });
    $("check").addEventListener("click", async () => {
      try { const bytes = await studio.save({ platform }); report(await checkPackage(bytes), bytes.length); }
      catch (err) { studio.toast("Check failed: " + err.message, "error", 7000); }
    });
    function report(r, size) {
      const el = $("report");
      el.className = "rscp-report " + (r.ok ? "is-ok" : "is-error");
      el.innerHTML = (r.ok ? "<b>Package OK</b> \u2014 " : "<b>Problems</b> \u2014 ") + esc(r.lines.join(" \u00b7 ")) + " \u00b7 " + (size / 1e6).toFixed(1) + " MB";
    }
    studio.on((type) => {
      if (type === "open" || type === "change" || type === "save") { $("save").disabled = !studio.project; $("check").disabled = !studio.project; }
    });
  }

  /** Read a package back with the engine: every chart compiles and parses, the audio decodes. */
  async function checkPackage(bytes) {
    const lines = [];
    let ok = true;
    try {
      const { project, source } = await E.projectFromPsarc(bytes);
      lines.push(project.arrangements.length + " chart(s)");
      for (const a of project.arrangements) {
        if (!a.origin.sng) { ok = false; lines.push(a.name + ": no SNG"); continue; }
        const s = E.sngParse((await E.sngDecrypt(await source.read(a.origin.sng), project.platform)).body);
        const n = a.doc.levels[0].notes.length + a.doc.levels[0].chords.length;
        if (s.arrangements.length < 1 || (n && !s.arrangements.some((l) => l.notes.length))) { ok = false; lines.push(a.name + ": empty SNG"); }
      }
      if (project.vocals) lines.push(project.vocals.syllables.length + " syllables");
      if (project.audio.song) { const info = E.wemInfo((await source.read(project.audio.song)).subarray(0, 4096)); lines.push("audio " + info.codec + " " + info.sampleRate + " Hz"); }
      else { ok = false; lines.push("no audio"); }
    } catch (e) { ok = false; lines.push(e.message); }
    return { ok, lines };
  }

  function start() {
    const studio = new RSC.Studio(document.getElementById("rsc-studio"), { host: { name: "page", tour: { open: ".rscp-drop", save: '[data-role="save"]' } } });
    const demoBtn = document.querySelector('[data-role="demo"]');
    if (demoBtn) demoBtn.addEventListener("click", () => RSC.openDemo(studio).catch((e) => studio.toast(e.message, "error")));
    const helpBtn = document.querySelector('[data-role="help"]');
    if (helpBtn) helpBtn.addEventListener("click", () => RSC.help.open(studio));
    root.creator = studio;
    build(studio);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})(typeof window !== "undefined" ? window : globalThis);

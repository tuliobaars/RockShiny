/* Drag & drop onto the whole .rs-dropzone area. The dropped File is forwarded
 * to the Shiny fileInput inside the zone, so Shiny's own (chunked) uploader,
 * progress bar and input$<id> all work unchanged.
 *
 * While a file is on its way the zone shows it: "Uploading <name> 42 %" with a
 * progress bar (mirrored from Shiny's own bar), then "Opening <name>..." with an
 * indeterminate bar until the app reports the song open (RSDropzone.done()) or
 * failed (RSDropzone.fail()); app.js does that from the server's "rs-loading"
 * messages and the players' ready events. */
(function () {
  "use strict";
  const Z = (window.RSDropzone = window.RSDropzone || {});
  function ui(zone) {
    let st = zone.querySelector(".rs-dropzone-status");
    if (!st) {
      st = document.createElement("div");
      st.className = "rs-dropzone-status";
      st.innerHTML = '<div class="rs-dropzone-status-text"><span class="rs-dz-msg"></span><b class="rs-dz-pct"></b></div>' +
                     '<div class="rs-dropzone-bar"><i></i></div>';
      zone.appendChild(st);
    }
    return st;
  }
  function set(zone, state, msg, pct) {
    const st = ui(zone);
    zone.classList.remove("is-uploading", "is-opening", "is-done", "is-failed");
    if (state) zone.classList.add("is-" + state);
    zone.classList.toggle("is-busy", state === "uploading" || state === "opening");
    zone.setAttribute("aria-busy", zone.classList.contains("is-busy") ? "true" : "false");
    st.querySelector(".rs-dz-msg").textContent = msg || "";
    st.querySelector(".rs-dz-pct").textContent = pct == null ? "" : Math.round(pct) + "%";
    st.querySelector(".rs-dropzone-bar > i").style.width = pct == null ? "" : pct + "%";
    clearTimeout(zone._rsTimer);
    if (state === "done" || state === "failed") zone._rsTimer = setTimeout(() => set(zone, null), state === "done" ? 2500 : 7000);
    if (state === "opening") zone._rsTimer = setTimeout(() => set(zone, null), 90000);   // never stuck
  }
  /** The file input inside a zone, or the zone of an input id. */
  const zoneOf = (x) => (typeof x === "string" ? document.getElementById(x) : x)?.closest?.(".rs-dropzone") || null;
  Z.opening = (x, name) => { const z = zoneOf(x); if (z) set(z, "opening", `Opening ${name || "the song"}\u2026`); };
  Z.done = (x, text) => { const z = zoneOf(x); if (z && z.classList.contains("is-busy")) set(z, "done", text || "Ready"); };
  Z.fail = (x, text) => { const z = zoneOf(x); if (z) set(z, "failed", text || "Could not open the file"); };
  Z.busy = (x) => { const z = zoneOf(x); return !!z && z.classList.contains("is-busy"); };

  // Shiny's own progress bar for the upload: mirror it into the zone
  document.addEventListener("change", (e) => {
    const input = e.target;
    if (!input || input.type !== "file") return;
    const zone = input.closest(".rs-dropzone"), f = input.files && input.files[0];
    if (!zone || !f) return;
    const name = f.name, mb = f.size / 1e6;
    set(zone, "uploading", `Uploading ${name}${mb >= 1 ? ` (${mb.toFixed(0)} MB)` : ""}`, 0);
    const bar = zone.querySelector(".progress .progress-bar");
    if (zone._rsObs) zone._rsObs.disconnect();
    if (!bar) return;
    zone._rsObs = new MutationObserver(() => {
      if (!zone.classList.contains("is-uploading")) return;
      const pct = parseFloat(bar.style.width) || 0;
      if (/complete/i.test(bar.textContent) || pct >= 100) {
        zone._rsObs.disconnect();
        Z.opening(zone, name);
      } else set(zone, "uploading", `Uploading ${name}${mb >= 1 ? ` (${mb.toFixed(0)} MB)` : ""}`, pct);
    });
    zone._rsObs.observe(bar, { attributes: true, attributeFilter: ["style"], childList: true, characterData: true, subtree: true });
  }, true);
  function fileInputOf(zone) { return zone.querySelector("input[type=file]"); }
  function accepted(zone, file) {
    const exts = (zone.dataset.accept || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return !exts.length || exts.some((x) => file.name.toLowerCase().endsWith(x));
  }
  document.addEventListener("dragover", (e) => {
    const zone = e.target.closest && e.target.closest(".rs-dropzone");
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    zone.classList.add("is-over");
  });
  document.addEventListener("dragleave", (e) => {
    const zone = e.target.closest && e.target.closest(".rs-dropzone");
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove("is-over");
  });
  document.addEventListener("drop", (e) => {
    const zone = e.target.closest && e.target.closest(".rs-dropzone");
    if (!zone) return;
    zone.classList.remove("is-over");
    // Shiny's fileInput has its own drop target (.input-group): don't upload twice
    if (e.defaultPrevented || e.target.closest(".input-group")) return;
    e.preventDefault();
    const input = fileInputOf(zone);
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!input || !file) return;
    if (!accepted(zone, file)) { alert("Please drop a " + zone.dataset.accept + " file."); return; }
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  document.addEventListener("keydown", (e) => {       // keyboard: Enter/Space on the zone = browse
    const zone = e.target.classList && e.target.classList.contains("rs-dropzone") ? e.target : null;
    if (!zone || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    const input = fileInputOf(zone);
    if (input) input.click();
  });
  document.addEventListener("click", (e) => {        // click anywhere in the zone = browse
    const zone = e.target.closest && e.target.closest(".rs-dropzone");
    if (!zone || e.target.closest("input, label, button, .btn")) return;
    const input = fileInputOf(zone);
    if (input) input.click();
  });
})();

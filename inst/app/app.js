/* ---------------------------------------------------------------------------
 * app.js -- app-level glue for the Instrument | Karaoke switch (app.R).
 *
 * After a click on a mode tab, keyboard focus stays on the tab link, and
 * Bootstrap's tabs treat arrow keys / Home / End on a focused tab as "go to the
 * next tab" (and stop the event): the players' shortcuts (left/right = -/+5 s,
 * Home = restart) then switched the mode instead -- which pauses the player.
 * So the visible player takes the focus whenever a mode is shown (or its tab
 * is clicked again); Tab still reaches the switch for keyboard users.
 * ------------------------------------------------------------------------- */
(function () {
  "use strict";
  const PLAYER = ".rs-karaoke, .rs-highway, .rsc-studio";   // .rsc-studio: the Creator (creator/)
  function paneOf(link) {
    const sel = link.getAttribute("data-bs-target") || link.getAttribute("href");
    try { return sel && sel.charAt(0) === "#" ? document.querySelector(sel) : null; } catch (e) { return null; }
  }
  function focusPlayer(link) {
    const pane = paneOf(link), el = pane && pane.querySelector(PLAYER);
    if (el && el.getClientRects().length) el.focus({ preventScroll: true });
  }
  const isModeTab = (el) => el && el.closest && el.closest("#mode") && el.closest("[data-bs-toggle='tab'], [data-toggle='tab']");
  document.addEventListener("shown.bs.tab", (e) => { const link = isModeTab(e.target); if (link) focusPlayer(link); });
  document.addEventListener("click", (e) => {          // a click on the tab that is already active
    const link = isModeTab(e.target);
    if (link && link.classList.contains("active")) setTimeout(() => focusPlayer(link), 0);
  });
})();

/* ---------------------------------------------------------------------------
 * Loading overlay on a player while a song is being opened.
 *
 * R sends "rs-loading" {target: <player output id>, state: "start" | "error" |
 * "end", text, zone: <file input id>} (rs_loading() in R/mod_home.R); the overlay
 * goes away when the player reports the new song (<target>_ready, a Shiny input
 * the players set), on "end" / "error", or after 90 s at the latest. The
 * dropzone of an upload (dropzone.js) follows the same states.
 * ------------------------------------------------------------------------- */
(function () {
  "use strict";
  const L = (window.RSLoading = window.RSLoading || {});
  const zones = {};                                   // target -> file input id of an upload in progress
  function host(target) {
    const el = document.getElementById(target);
    return el ? el.parentElement : null;
  }
  /** The song a player shows now (its ready event for a *new* song ends the overlay). */
  function keyOf(target) {
    try {
      const k = window.RSKaraoke && RSKaraoke.players && RSKaraoke.players.get(target);
      if (k) return k.song ? k.song.songKey : null;
      const c = window.RSHighway && RSHighway.controllers && RSHighway.controllers.get(target);
      return c ? c.songKey : null;
    } catch (e) { return null; }
  }
  const shown = {};                                   // target -> {key, at}
  L.show = function (target, text, sub) {
    const h = host(target);
    if (!h) return;
    shown[target] = { key: keyOf(target), at: performance.now() };
    h.classList.add("rs-loading-host");
    let o = h.querySelector(":scope > .rs-loading");
    if (!o) {
      o = document.createElement("div");
      o.className = "rs-loading";
      o.setAttribute("role", "status");
      o.innerHTML = '<div class="rs-loading-card"><div class="rs-loading-spin" aria-hidden="true"><i></i><i></i><i></i><i></i></div>' +
                    '<div class="rs-loading-text"><b></b><span></span></div></div>';
      h.appendChild(o);
    }
    o.querySelector("b").textContent = text || "Loading\u2026";
    o.querySelector("span").textContent = sub || "";
    o.classList.remove("is-error");
    void o.offsetWidth;                               // restart the fade-in
    o.classList.add("is-on");
    clearTimeout(o._t);
    o._t = setTimeout(() => L.hide(target), 90000);
  };
  L.hide = function (target) {
    const h = host(target), o = h && h.querySelector(":scope > .rs-loading");
    if (o) { o.classList.remove("is-on"); clearTimeout(o._t); }
    if (zones[target] && window.RSDropzone) { RSDropzone.done(zones[target], "Opened"); delete zones[target]; }
  };
  L.error = function (target, text) {
    const h = host(target), o = h && h.querySelector(":scope > .rs-loading");
    if (o) { o.classList.remove("is-on"); clearTimeout(o._t); }
    if (zones[target] && window.RSDropzone) { RSDropzone.fail(zones[target], text); delete zones[target]; }
  };
  L.message = function (m) {
    if (!m || !m.target) return;
    if (m.zone) zones[m.target] = m.zone;
    if (m.state === "start") {
      L.show(m.target, m.text, m.sub);
      if (m.zone && window.RSDropzone) RSDropzone.opening(m.zone, m.name);
    } else if (m.state === "error") L.error(m.target, m.text);
    else L.hide(m.target);
  };
  if (window.Shiny && Shiny.addCustomMessageHandler) Shiny.addCustomMessageHandler("rs-loading", L.message);
  if (window.jQuery) {
    jQuery(document).on("shiny:inputchanged", (e) => {         // a player has its new song
      const m = /^(.*)_ready$/.exec(e.name || "");
      if (!m || !document.getElementById(m[1]) || !shown[m[1]]) return;
      // a ready event for the song already on screen (e.g. the player becoming visible) is not
      // the new song -- unless it comes late (the same file opened again under another name)
      const s = shown[m[1]], key = e.value && e.value.songKey;
      if (key == null || key !== s.key || performance.now() - s.at > 1500) { delete shown[m[1]]; L.hide(m[1]); }
    });
  }
})();


/* ---------------------------------------------------------------------------
 * karaoke-shiny.js -- Shiny host for the karaoke player (karaoke.js).
 *
 *   renderValue(el, {song: "<json>", options})   output value (once per song)
 *   custom message "rs-karaoke" {id, cmd, args}   audio / settings / play / pause / seek / status
 *   input <id>_ready   {songKey, audio, formats, nonce}   song on screen: R sends the audio
 *   input <id>_latency {outputMs, routed, auto}           output latency compensation
 *   input <id>_aligned {songKey, offsetMs, confidence}    LRC lyrics synced to the recording
 *   input <id>_lyrics  {songKey, lyrics}                  lyrics found online by the browser
 *   input <id>_ended   {songKey, nonce}                   the song played to its end
 *   input <id>_voice   {volume, mute, available}          the original voice's volume changed (player controls)
 *   input <id>_sing    {on, mode, error}                  microphone scoring switched on / off
 *   input <id>_score   {score, rating, pitch, timing, lines, mode, complete, finished, songKey}   a scored run
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const K = root.RSKaraoke;
  const players = new Map();
  function setInput(name, value) {
    if (root.Shiny && root.Shiny.setInputValue) root.Shiny.setInputValue(name, value, { priority: "event" });
  }
  function playerFor(el) {
    let p = players.get(el.id);
    if (!p || p.el !== el) {
      if (p) p.destroy();
      p = new K.KaraokePlayer(el, {
        onReady: (info) => setInput(el.id + "_ready", info),
        onLatency: (info) => setInput(el.id + "_latency", info),
        onAligned: (info) => setInput(el.id + "_aligned", info),
        onLyrics: (info) => setInput(el.id + "_lyrics", info),
        onEnded: (info) => setInput(el.id + "_ended", info),
        onVoice: (info) => setInput(el.id + "_voice", info),
        onSingState: (info) => setInput(el.id + "_sing", info),
        onScore: (info) => setInput(el.id + "_score", info),
        onDestroy: (pl) => { if (players.get(el.id) === pl) players.delete(el.id); },
      });
      players.set(el.id, p);
    }
    return p;
  }
  K.players = players;
  K.playerFor = playerFor;

  function register() {
    const Shiny = root.Shiny;
    const binding = new Shiny.OutputBinding();
    Object.assign(binding, {
      find: (scope) => $(scope).find(".rs-karaoke"),
      renderValue: (el, data) => playerFor(el).load(data),
      renderError: (el, err) => playerFor(el).status(err.message, "error"),
      clearError: (el) => playerFor(el).status("", "clear"),
    });
    Shiny.outputBindings.register(binding, "rockshiny.karaoke");
    Shiny.addCustomMessageHandler("rs-karaoke", (msg) => {
      const el = document.getElementById(msg.id);
      if (el) playerFor(el).command(msg);
    });
  }
  if (root.Shiny && root.Shiny.OutputBinding) register();
  else document.addEventListener("DOMContentLoaded", () => { if (root.Shiny) register(); });
})(window);

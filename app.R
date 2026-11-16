# -----------------------------------------------------------------------------
# RockShiny -- Rocksmith-style note highway in Shiny, plus a karaoke mode.
#
#   R  (R/)            : PSARC unpack -> XML/SNG parse -> chart JSON, audio convert
#   JS (inst/highway/) : output binding, audio-master clock, renderers, overlays
#   JS (inst/karaoke/) : synchronized lyrics on the same clock (Shiny + standalone HTML)
#
# Four pages in the navbar; the two modes each have their own sidebar and player:
#   Home        mod_home                  (library by artist / album / genre, playlists, search;
#                                          songs and playlists open in either mode)
#   Instrument  mod_import + mod_player   (note highway: guitar, bass, piano, harmonica)
#   Karaoke     mod_karaoke               (songs with lyrics only; HTML export)
#   Creator     mod_creator (creator/)    (the song studio: edit or make .psarc songs, stems,
#                                          lyrics sync; also runs on its own: shiny::runApp("creator"))
#
# Run: shiny::runApp()
# -----------------------------------------------------------------------------
library(shiny)

# Always (re)load the current R/ files into this app's environment. Shiny's own
# R/ auto-loading is switched off in .Rprofile because this folder is also an
# R package; stale copies in the global environment are shadowed here.
for (f in list.files("R", pattern = "[.]R$", full.names = TRUE)) sys.source(f, envir = environment())
options(rockshiny.root = normalizePath("."))   # assets (inst/) are found relative to this

# RockShiny Creator (creator/): the song studio as a page of this app (an isolated module).
# options(rockshiny.creator = FALSE) leaves it out, e.g. for a public player.
creator_on <- isTRUE(getOption("rockshiny.creator", TRUE)) && file.exists("creator/global.R")
if (creator_on) source("creator/global.R", local = TRUE)

options(
  shiny.maxRequestSize = 512 * 1024^2    # .psarc files are 2-70 MB (default cap is 5 MB)
)
# The song library: options(rockshiny.library_dir = "...") or the folder chosen in the
# app ("Change..." in either sidebar; remembered), else songs/. Big libraries
# (> getOption("rockshiny.library_lazy_threshold", 50) files) open at once and are
# scanned in the background; each song loads fully when it is picked (R/library.R).

# Converted audio is served straight from the cache by httpuv (no R involvement).
addResourcePath(AUDIO_URL_PREFIX, cache_root())

# Pre-decode the library's audio in the background (quick-start clips first) --
# small libraries only (up to getOption("rockshiny.library_lazy_threshold", 50) songs).
# Disable with options(rockshiny.prewarm = FALSE).
audio_prewarm_library(library_current())

rs_theme <- bslib::bs_theme(
  version = 5, bg = "#0b0d13", fg = "#e8eaf1", primary = "#f5a524", secondary = "#3a4256",
  base_font = bslib::font_collection("Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"),
  "font-size-base" = "0.9rem", "border-radius" = "0.55rem", "input-bg" = "#141824",
  "input-border-color" = "rgba(255,255,255,0.10)", "accordion-bg" = "transparent"
)

app_dependency <- htmltools::htmlDependency(
  "rockshiny-app", "0.1.0", src = c(file = asset_dir("app")), stylesheet = "app.css",
  script = "app.js"                     # mode switch: the shown player takes the keyboard focus
)

brand <- htmltools::div(
  class = "rs-brand", app_dependency,
  htmltools::HTML('<svg viewBox="0 0 32 32" class="rs-logo" aria-hidden="true"><defs><linearGradient id="rsg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffc46b"/><stop offset="1" stop-color="#f08a00"/></linearGradient></defs>
    <path fill="url(#rsg)" d="M16 2C9 2 4 5 4 10c0 8 7 17 12 20 5-3 12-12 12-20 0-5-5-8-12-8z"/>
    <path fill="#1a1206" d="M13 9h6v2h-2v9.3a3 3 0 1 1-2-2.8V11h-2z"/></svg>'),
  htmltools::span(class = "rs-brand-name", "RockShiny"),
  htmltools::span(class = "rs-brand-sub", "play \u00b7 sing")
)

shortcuts <- htmltools::div(
  class = "rs-shortcuts",
  htmltools::span(htmltools::tags$kbd("Space"), "play / pause"),
  htmltools::span(htmltools::tags$kbd("\u2190"), htmltools::tags$kbd("\u2192"), "\u00b15 s"),
  htmltools::span(htmltools::tags$kbd("Home"), "restart"),
  htmltools::span(htmltools::tags$kbd("L"), "loop")
)

karaoke_shortcuts <- htmltools::div(
  class = "rs-shortcuts",
  htmltools::span(htmltools::tags$kbd("Space"), "play / pause"),
  htmltools::span(htmltools::tags$kbd("\u2190"), htmltools::tags$kbd("\u2192"), "\u00b15 s"),
  htmltools::span(htmltools::tags$kbd("\u2191"), htmltools::tags$kbd("\u2193"), "previous / next line"),
  htmltools::span(htmltools::tags$kbd("Home"), "restart")
)

# ui as a function (per session); the song lists are filled by the server (they
# follow the library folder and its background scan).
# Instrument | Karaoke in the navbar switch between two complete interfaces.
ui <- function(req) {
  mode_layout <- function(sidebar, main) {
    bslib::layout_sidebar(
      sidebar = bslib::sidebar(width = 340, class = "rs-sidebar", sidebar),
      border = FALSE, border_radius = FALSE, fillable = TRUE,
      main
    )
  }
  bslib::page_navbar(
    title = brand,
    id = "mode",
    window_title = "RockShiny",
    theme = rs_theme,
    fillable = TRUE,
    padding = 0,
    gap = 0,
    navbar_options = bslib::navbar_options(underline = FALSE, collapsible = FALSE),   # the mode switch: a pill, always visible (app.css)
    bslib::nav_panel(                                   # the first page: the library, playlists, search
      "Home", value = "home", icon = shiny::icon("house"),
      mod_home_ui("home")
    ),
    bslib::nav_panel(
      "Instrument", value = "instrument", icon = shiny::icon("guitar"),
      mode_layout(
        htmltools::tagList(
          mod_home_queue_ui("home", "instrument"),
          mod_player_controls_ui("player", import_ui = htmltools::tagList(
            mod_import_ui("import", library_ui = mod_library_bar_ui("library", "instrument")), shiny::uiOutput("sing_along"))),
          shortcuts
        ),
        mod_player_highway_ui("player")
      )
    ),
    bslib::nav_panel(
      "Karaoke", value = "karaoke", icon = shiny::icon("microphone-lines"),
      mode_layout(
        htmltools::tagList(mod_home_queue_ui("home", "karaoke"),
                           mod_karaoke_controls_ui("karaoke", extra_ui = shiny::uiOutput("play_along"),
                                                   library_ui = mod_library_bar_ui("library", "karaoke")), karaoke_shortcuts),
        mod_karaoke_stage_ui("karaoke")
      )
    ),
    if (creator_on) bslib::nav_panel(                   # the song studio (creator/R/mod_creator.R)
      "Creator", value = "creator", icon = shiny::icon("wand-magic-sparkles"),
      mod_creator_ui("creator")
    )
  )
}

server <- function(input, output, session) {
  lib <- mod_library_server("library")                       # the song folder (shared by all pages)
  home <- mod_home_server("home", lib, ended = list(
    instrument = shiny::reactive(input[["player-highway_ended"]]),
    karaoke = shiny::reactive(input[["karaoke-stage_ended"]])))
  play <- shiny::reactiveVal(NULL)                           # songs opened from the home page
  song <- mod_import_server("import", lib, request = play, stage = "player-highway")
  mod_player_server("player", song)
  sing <- shiny::reactiveVal(NULL)
  karaoke <- mod_karaoke_server("karaoke", request = sing, lib = lib)

  # Home -> a mode: the song (or the next one of a playlist) opens there
  shiny::observeEvent(home$request(), {
    r <- home$request()
    if (identical(r$mode, "karaoke")) sing(r) else play(r)
    bslib::nav_select("mode", r$mode)
  })
  # Shuffle: every session starts with a song picked at random (one with lyrics, so both
  # modes have it), a different one each time the app is opened
  first <- random_song(shiny::isolate(lib()), "lyrics")
  if (!is.null(first)) {
    r <- list(path = first, name = basename(first), nonce = as.numeric(Sys.time()))
    play(c(r, mode = "instrument"))
    sing(c(r, mode = "karaoke"))
  }
  # recently played (home page; not the random first song); a song opened by hand stops the play queue
  shiny::observe({ s <- song(); if (!is.null(s) && !identical(s$path, first)) home$record(s$path, "instrument") })
  shiny::observe({ k <- karaoke(); if (!is.null(k) && !identical(k$path, first)) home$record(k$path, "karaoke") })

  # Instrument -> Karaoke: songs whose archive has lyrics can be sung
  output$sing_along <- shiny::renderUI({
    s <- song()
    if (is.null(s$arc)) return(NULL)                          # MIDI songs have no recording to sing with
    has <- lyrics_present(song_vocals_raw(s)) || karaoke_lyrics_known(s$arc$path)
    if (!has && !isTRUE(getOption("rockshiny.lyrics_online", TRUE))) return(NULL)
    shiny::actionButton("sing_along_go", if (has) "Sing along in karaoke mode" else "Sing along (lyrics from the web)",
                        icon = shiny::icon("microphone-lines"), class = "btn-sm btn-outline-primary w-100 mb-3")
  })
  shiny::observeEvent(input$sing_along_go, {
    s <- shiny::req(song())
    sing(list(path = s$arc$path, name = s$name, nonce = Sys.time()))
    bslib::nav_select("mode", "karaoke")
  })
  # Karaoke -> Instrument: play the song's guitar / bass parts (library songs)
  output$play_along <- shiny::renderUI({
    k <- shiny::req(karaoke())
    shiny::req(library_has(lib(), k$path))
    shiny::actionButton("play_along_go", "Play it in instrument mode", icon = shiny::icon("guitar"),
                        class = "btn-sm btn-outline-secondary w-100 mb-3")
  })
  shiny::observeEvent(input$play_along_go, {
    k <- shiny::req(karaoke())
    shiny::updateSelectizeInput(session, "import-library", selected = k$path)
    bslib::nav_select("mode", "instrument")
  })
  # Creator: songs saved to the library can be played / sung here at once
  if (creator_on) {
    creator <- mod_creator_server("creator", lib = lib, on_play = function(path, mode) {
      r <- list(path = path, name = basename(path), nonce = as.numeric(Sys.time()), mode = mode)
      if (identical(mode, "karaoke")) sing(r) else play(r)
      bslib::nav_select("mode", mode, session = session)      # the app's navbar (not the module's namespace)
    })
  }
  # one mode plays at a time (and none on the home page)
  shiny::observeEvent(input$mode, {
    if (!identical(input$mode, "instrument")) highway_pause(session, "player-highway")
    if (!identical(input$mode, "karaoke")) karaoke_pause(session, "karaoke-stage")
    if (creator_on && !identical(input$mode, "creator")) creator$pause()
  }, ignoreInit = TRUE)
}

shinyApp(ui, server)

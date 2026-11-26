# -----------------------------------------------------------------------------
# mod_creator.R -- RockShiny Creator as one Shiny module: a sidebar (Song,
# Lyrics, Stems, Save) and the studio, in RockShiny's layout and look.
#
# Standalone:        shiny::runApp("creator")        (creator/app.R)
# Inside RockShiny (app.R):
#   source("creator/global.R", local = TRUE)
#   bslib::nav_panel("Creator", value = "creator", icon = shiny::icon("wand-magic-sparkles"),
#                    mod_creator_ui("creator"))
#   creator <- mod_creator_server("creator", lib = lib, on_play = function(path, mode) ...)
#
# Isolation: every input lives in the module's namespace, every class and
# global in the Creator's own (.rsc-*, RSCreator), its assets are its own
# htmlDependencies, and the only options it sets are its own
# (rockshiny.creator.*) and a large enough shiny.maxRequestSize.
# -----------------------------------------------------------------------------

#' The Creator's sidebar + studio.
#' @param id module id.
#' @param sidebar_width sidebar width in pixels (RockShiny's modes use 340).
#' @param library_ui optional library status/switcher bar (`mod_library_bar_ui()`).
#' @export
mod_creator_ui <- function(id, sidebar_width = 340, library_ui = NULL) {
  ns <- shiny::NS(id)
  bslib::layout_sidebar(
    sidebar = bslib::sidebar(
      width = sidebar_width, class = "rs-sidebar rsc-sidebar",
      bslib::accordion(
        class = "rs-accordion", id = ns("sections"), multiple = TRUE, open = c("song", "save"),
        mod_project_ui(ns("project"), library_ui = library_ui),
        mod_lyrics_ui(ns("lyrics")),
        mod_stems_ui(ns("stems")),
        mod_export_ui(ns("export"))
      ),
      creator_help_buttons(ns("studio-studio")),
      creator_shortcuts()
    ),
    border = FALSE, border_radius = FALSE, fillable = TRUE, class = "rsc-main",
    mod_studio_ui(ns("studio"))
  )
}

#' @param id module id.
#' @param lib reactive rs_library (RockShiny's mod_library_server()), or NULL: the app's library folder.
#' @param on_play function(path, mode) opening a saved song in RockShiny, or NULL (standalone).
#' @return list(state = reactive studio state, saved = reactive path of the last package saved,
#'   open(path, name) to open a song, pause() to stop the studio's playback).
#' @export
mod_creator_server <- function(id, lib = NULL, on_play = NULL) {
  shiny::moduleServer(id, function(input, output, session) {
    studio <- mod_studio_server("studio")
    mod_project_server("project", studio, lib)
    mod_lyrics_server("lyrics", studio)
    mod_stems_server("stems", studio, lib)
    saved <- mod_export_server("export", studio, lib, on_play)
    list(state = studio$state, saved = saved, open = studio$open, pause = function() studio$send("pause"))
  })
}

#' "Help" and "Take the tour" under the sidebar: they open the studio's Help dialog
#' and guided tour (inst/studio/rsc-help.js, wired in rsc-shiny.js).
#' @param studio_id the studio element's id.
#' @noRd
creator_help_buttons <- function(studio_id) {
  htmltools::div(class = "rsc-helprow",
    htmltools::tags$button(type = "button", class = "btn btn-sm rs-shuffle", `data-rsc-help` = studio_id, `data-rsc-what` = "help",
                           title = "What the Creator can and can't do, how to use it (? key)", shiny::icon("circle-question"), "Help"),
    htmltools::tags$button(type = "button", class = "btn btn-sm rs-shuffle", `data-rsc-help` = studio_id, `data-rsc-what` = "tour",
                           title = "A two-minute guided tour of the studio", shiny::icon("route"), "Take the tour"))
}

#' Keyboard shortcuts under the sidebar (RockShiny's .rs-shortcuts).
#' @noRd
creator_shortcuts <- function() {
  k <- function(keys, what) htmltools::span(lapply(keys, htmltools::tags$kbd), what)
  htmltools::div(class = "rs-shortcuts",
    k("Space", "play / pause"), k(c("D", "V", "E"), "draw / select / erase"), k("0\u20139", "fret"),
    k(c("Ctrl", "Z"), "undo"), k("L", "loop"), k(c("+", "\u2212"), "zoom"), k("?", "help"))
}

# ---- the standalone app: RockShiny's theme, brand and chrome ---------------------------------

#' RockShiny's bslib theme (the values of RockShiny's app.R).
#' @noRd
creator_theme <- function() {
  bslib::bs_theme(
    version = 5, bg = "#0b0d13", fg = "#e8eaf1", primary = "#f5a524", secondary = "#3a4256",
    base_font = bslib::font_collection("Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"),
    "font-size-base" = "0.9rem", "border-radius" = "0.55rem", "input-bg" = "#141824",
    "input-border-color" = "rgba(255,255,255,0.10)", "accordion-bg" = "transparent"
  )
}

#' RockShiny's brand (logo + name) with the Creator tag.
#' @noRd
creator_brand <- function() {
  htmltools::div(
    class = "rs-brand",
    htmltools::htmlDependency("rockshiny-app", "0.1.0", src = c(file = asset_dir("app")), stylesheet = "app.css", script = "app.js"),
    htmltools::HTML('<svg viewBox="0 0 32 32" class="rs-logo" aria-hidden="true"><defs><linearGradient id="rsg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffc46b"/><stop offset="1" stop-color="#f08a00"/></linearGradient></defs>
      <path fill="url(#rsg)" d="M16 2C9 2 4 5 4 10c0 8 7 17 12 20 5-3 12-12 12-20 0-5-5-8-12-8z"/>
      <path fill="#1a1206" d="M13 9h6v2h-2v9.3a3 3 0 1 1-2-2.8V11h-2z"/></svg>'),
    htmltools::span(class = "rs-brand-name", "RockShiny"),
    htmltools::span(class = "rs-brand-tag", "Creator"),
    htmltools::span(class = "rs-brand-sub", "create \u00b7 edit")
  )
}

#' The standalone Creator page (creator/app.R).
#' @noRd
creator_page <- function(id = "creator", library_ui = NULL) {
  bslib::page_navbar(
    title = creator_brand(), id = "creator_nav", window_title = "RockShiny Creator", theme = creator_theme(),
    fillable = TRUE, padding = 0, gap = 0,
    navbar_options = if (exists("navbar_options", envir = asNamespace("bslib"))) bslib::navbar_options(underline = FALSE, collapsible = FALSE),
    bslib::nav_panel("Studio", value = "studio", icon = shiny::icon("wand-magic-sparkles"),
                     mod_creator_ui(id, library_ui = library_ui))
  )
}

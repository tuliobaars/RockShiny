# -----------------------------------------------------------------------------
# mod_lyrics.R -- "Lyrics": where lyrics come from on the server side.
#
# The studio's Lyrics tab does the editing and the syncing (in the browser,
# with RockShiny's karaoke-sync.js). This module answers its "find online"
# requests from R -- a .lrc next to the song file first, then LRCLIB with
# RockShiny's lrclib_search() (only artist and title are sent) -- and imports
# .lrc / .txt files.
#
#   UI:     mod_lyrics_ui("lyrics")
#   server: mod_lyrics_server("lyrics", studio)
# -----------------------------------------------------------------------------

#' @noRd
mod_lyrics_ui <- function(id) {
  ns <- shiny::NS(id)
  bslib::accordion_panel(
    "Lyrics", value = "lyrics", icon = shiny::icon("microphone-lines"),
    shiny::checkboxInput(ns("online"), "Look lyrics up online (LRCLIB)", value = isTRUE(getOption("rockshiny.lyrics_online", TRUE))),
    shiny::fileInput(ns("lrc"), "Import lyrics (.lrc or .txt)", accept = c(".lrc", ".txt", "text/plain"), width = "100%"),
    shiny::actionButton(ns("find"), "Find online now", icon = shiny::icon("magnifying-glass"), class = "btn-sm rs-shuffle"),
    shiny::uiOutput(ns("status")),
    htmltools::div(class = "rs-hint", "The studio's Lyrics tab syncs them to the recording (auto-sync, tap-sync, stretch) and edits them syllable by syllable.")
  )
}

#' Lyrics for the song that is open: a sidecar .lrc (next to its file), then LRCLIB.
#' @param query list(artist, title, album, duration) from the studio.
#' @param path the song's file (or NULL).
#' @param online look up LRCLIB.
#' @param fetch HTTP function for LRCLIB (tests pass a fake).
#' @return list(lrc, synced, source, lrcDuration) | list(offline = TRUE) | NULL
#' @noRd
creator_lyrics_lookup <- function(query, path = NULL, online = TRUE, fetch = lrclib_fetch) {
  if (!is.null(path) && file.exists(path)) {
    f <- sidecar_lrc(path)
    if (!is.na(f)) return(list(lrc = read_text(f), synced = "line", source = "file", lrcDuration = NULL))
  }
  if (!isTRUE(online)) return(NULL)
  meta <- list(title = query$title %||% "", artist = query$artist %||% "", album = query$album %||% "",
               song_length = as.numeric(query$duration %||% NA))
  r <- tryCatch(lrclib_search(meta, fetch = fetch), error = function(e) structure(list(), class = "offline"))
  if (inherits(r, "offline")) return(list(offline = TRUE))
  if (is.null(r)) return(NULL)
  list(lrc = r$lrc, synced = r$synced, source = r$source, lrcDuration = r$lrc_duration)
}

#' @noRd
mod_lyrics_server <- function(id, studio, fetch = lrclib_fetch) {
  shiny::moduleServer(id, function(input, output, session) {
    last <- shiny::reactiveVal(NULL)
    shiny::observeEvent(studio$lyrics_request(), {
      q <- studio$lyrics_request()
      cur <- studio$current()
      res <- creator_lyrics_lookup(q, if (!is.null(cur)) cur$path, online = isTRUE(input$online), fetch = fetch)
      last(list(query = q, result = res, online = isTRUE(input$online)))
      studio$send("lyrics", requestId = q$requestId, result = res)
    })
    shiny::observeEvent(input$find, {
      studio$send("tab", tab = "lyrics")
      studio$send("toast", text = "Lyrics tab \u2192 \u201cFind online\u201d looks them up and syncs them")
    })
    shiny::observeEvent(input$lrc, {
      f <- input$lrc
      txt <- tryCatch(read_text(f$datapath), error = function(e) "")
      if (!nzchar(txt)) { shiny::showNotification("That file has no text.", type = "warning"); return() }
      studio$send("import-lyrics", text = txt, name = f$name)
      studio$send("tab", tab = "lyrics")
    })
    output$status <- shiny::renderUI({
      l <- last()
      if (is.null(l)) return(NULL)
      r <- l$result
      txt <- if (is.null(r)) (if (l$online) "No lyrics found online for this song." else "Online lookup is off; import a .lrc.")
             else if (isTRUE(r$offline)) "LRCLIB could not be reached from the server."
             else paste0("Lyrics from ", if (identical(r$source, "file")) "the .lrc next to the song" else "LRCLIB",
                         if (identical(r$synced, "none")) " (no timing)" else " (timed per line)", ".")
      htmltools::div(class = "rsc-state", txt)
    })
  })
}

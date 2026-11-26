# -----------------------------------------------------------------------------
# mod_library.R -- the library folder: a status bar in each mode's sidebar and
# a dialog to choose the folder (typed, or picked in a small folder browser on
# the machine running the app). The library is app-wide (library.R): every
# session sees the same folder, and big libraries are scanned in the background.
#
#   UI:     mod_library_bar_ui("library", "instrument")   (one per mode)
#   server: lib <- mod_library_server("library")           reactive rs_library
#
# options(rockshiny.library_picker = FALSE) hides "Change..." (e.g. on a shared
# server, where users should not browse its folders).
# -----------------------------------------------------------------------------

mod_library_bar_ui <- function(id, where) {
  ns <- shiny::NS(id)
  picker <- isTRUE(getOption("rockshiny.library_picker", TRUE))    # FALSE on shared servers: no folder browsing
  htmltools::div(
    class = "rs-libbar",
    htmltools::div(
      class = "rs-libbar-row",
      shiny::icon("folder-open"),
      htmltools::div(class = "rs-libbar-text", shiny::uiOutput(ns(paste0("bar_", where)), inline = TRUE)),
      if (picker)
        shiny::actionLink(ns(paste0("change_", where)), "Change\u2026", class = "rs-libbar-change",
                          title = "Choose the folder with your .psarc files")
    ),
    if (picker) shiny::uiOutput(ns(paste0("src_", where)), class = "rs-libbar-sources")
  )
}

#' Short form of a folder path for the status bar.
#' @noRd
library_short_dir <- function(dir, width = 34) {
  home <- normalizePath("~", mustWork = FALSE)
  d <- dir
  if (startsWith(d, home)) d <- paste0("~", substring(d, nchar(home) + 1L))
  if (nchar(d) > width) d <- paste0("\u2026", substring(d, nchar(d) - width + 2L))
  d
}

#' One line about the library: folder, songs, scanning progress.
#' @noRd
library_status_text <- function(lib) {
  s <- lib$songs
  n <- nrow(s)
  txt <- sprintf("%d song%s", n, if (n == 1) "" else "s")
  if (lib$pending) txt <- sprintf("%s \u00b7 checking %d/%d\u2026", txt, n - lib$pending, n)
  else if (lib$lazy) txt <- paste(txt, "\u00b7 large library: each song loads when picked")
  txt
}

mod_library_server <- function(id) {
  shiny::moduleServer(id, function(input, output, session) {
    ns <- session$ns
    lib <- shiny::reactivePoll(500, session, checkFunc = library_version, valueFunc = library_current)
    lists <- shiny::throttle(lib, 2000)          # song lists: at most every 2 s while a scan runs

    places <- c("instrument", "karaoke", "home", "creator")

    bar <- function() shiny::renderUI({
      l <- lib()
      dlc <- library_dlc_dir()
      is_dlc <- !is.null(dlc) && library_same_dir(l$dir, dlc)
      label <- if (is_dlc) paste0("DLC (", library_short_dir(l$dir, 26), ")") else library_short_dir(l$dir)
      htmltools::tagList(
        htmltools::span(class = "rs-libbar-dir", title = l$dir, label),
        htmltools::span(class = "rs-libbar-count", library_status_text(l))
      )
    })

    src_bar <- function() shiny::renderUI({
      dlc <- library_dlc_dir()
      if (is.null(dlc)) return(NULL)
      l <- lib()
      def <- library_default_dir()
      on_dlc <- library_same_dir(l$dir, dlc)
      on_def <- !on_dlc && library_same_dir(l$dir, def)
      btn <- function(kind, label, icon_name, active, title) {
        htmltools::tags$button(
          type = "button",
          class = paste("rs-libsrc", if (active) "is-active"),
          title = title,
          onclick = sprintf("Shiny.setInputValue('%s', {kind: '%s', n: Date.now()}, {priority: 'event'})", ns("source"), kind),
          shiny::icon(icon_name), " ", label
        )
      }
      htmltools::tagList(
        btn("songs", "Local (songs)", "folder", on_def, paste("Use project songs folder:", def)),
        btn("dlc", "DLC alias", "compact-disc", on_dlc, paste("Read from root dlc alias:", dlc))
      )
    })

    for (w in places) {
      output[[paste0("bar_", w)]] <- bar()
      output[[paste0("src_", w)]] <- src_bar()
    }

    switch_library <- function(d, rec, label = NULL) {
      if (!dir.exists(d)) {
        resolved <- resolve_path_alias(d)
        if (!is.null(resolved)) d <- resolved
      }
      if (!nzchar(d) || !dir.exists(d)) {
        msg <- if (!is.null(label)) sprintf("%s folder does not exist: %s", label, d) else "That folder does not exist."
        shiny::showNotification(msg, type = "error", duration = 6)
        return(invisible(FALSE))
      }
      l <- shiny::withProgress(message = "Opening the library\u2026", value = 0.5, {
        library_set_dir(d, rec)
        library_use(normalizePath(d), rec)
      })
      audio_prewarm_library(l)
      prefix <- if (!is.null(label)) paste0(label, ": ") else ""
      shiny::showNotification(
        if (!nrow(l$songs)) paste0(prefix, "No .psarc or MIDI files in that folder.")
        else if (l$pending) sprintf("%s%d songs. Their titles and lyrics are being checked in the background.", prefix, nrow(l$songs))
        else sprintf("%s%d songs.", prefix, nrow(l$songs)),
        type = if (nrow(l$songs)) "message" else "warning", duration = 6)
      invisible(TRUE)
    }

    shiny::observeEvent(input$source, {
      kind <- input$source$kind %||% ""
      if (identical(kind, "dlc")) {
        dlc <- library_dlc_dir()
        if (is.null(dlc)) {
          shiny::showNotification("Could not resolve the root dlc alias.", type = "error", duration = 6)
          return()
        }
        switch_library(dlc, TRUE, label = "DLC library")
      } else if (identical(kind, "songs")) {
        switch_library(library_default_dir(), FALSE, label = "Local library")
      }
    })

    # ---- the dialog ---------------------------------------------------------------------
    open_dialog <- function() {
      l <- shiny::isolate(lib())
      dlc <- library_dlc_dir()
      def <- library_default_dir()
      preset_btn <- function(path, rec, label, icon_name, title) {
        htmltools::tags$button(
          type = "button", class = "rs-libpreset", title = title,
          onclick = sprintf("Shiny.setInputValue('%s', {dir: %s, recursive: %s, n: Date.now()}, {priority: 'event'})",
                            ns("preset"), jsonlite::toJSON(path, auto_unbox = TRUE), if (rec) "true" else "false"),
          shiny::icon(icon_name), " ", label
        )
      }
      shiny::showModal(shiny::modalDialog(
        title = "Song library", size = "m", easyClose = TRUE,
        htmltools::p(class = "rs-hint", style = "margin: 0 0 .8rem",
                     "A folder with your Rocksmith .psarc files (and MIDI files) on the computer running RockShiny. ",
                     sprintf("Libraries of more than %d songs are mapped at once and read song by song when you pick one.",
                             as.integer(getOption("rockshiny.library_lazy_threshold", 50)))),
        if (!is.null(dlc))
          htmltools::div(
            class = "rs-libpresets",
            preset_btn(def, FALSE, "Project songs/", "folder", def),
            preset_btn(dlc, TRUE, paste0("DLC alias (", library_short_dir(dlc, 32), ")"), "compact-disc", dlc)
          ),
        shiny::textInput(ns("dir"), "Folder", value = normalizePath(l$dir, mustWork = FALSE), width = "100%"),
        shiny::checkboxInput(ns("recursive"), "Include subfolders", value = l$recursive),
        shiny::uiOutput(ns("browse")),
        footer = htmltools::tagList(
          shiny::modalButton("Cancel"),
          shiny::actionButton(ns("apply"), "Use this folder", class = "btn-primary", icon = shiny::icon("check"))
        )
      ))
    }
    for (w in places) local({
      id_btn <- paste0("change_", w)
      shiny::observeEvent(input[[id_btn]], open_dialog())
    })
    shiny::observeEvent(input$pick, shiny::updateTextInput(session, "dir", value = input$pick))
    shiny::observeEvent(input$preset, {
      p <- input$preset
      shiny::updateTextInput(session, "dir", value = p$dir)
      shiny::updateCheckboxInput(session, "recursive", value = isTRUE(p$recursive))
    })

    dir_typed <- shiny::debounce(shiny::reactive(path.expand(trimws(input$dir %||% ""))), 300)
    output$browse <- shiny::renderUI({
      d <- dir_typed()
      shiny::req(nzchar(d))
      via <- NULL
      if (!dir.exists(d) && file.exists(d)) {
        resolved <- resolve_path_alias(d)
        if (!is.null(resolved)) { via <- resolved; d <- resolved }
      }
      if (!dir.exists(d)) return(htmltools::div(class = "rs-libdir-msg is-error", "No such folder."))
      d <- normalizePath(d)
      subs <- tryCatch(list.dirs(d, full.names = TRUE, recursive = FALSE), error = function(e) character())
      subs <- subs[!startsWith(basename(subs), ".")]
      here <- length(library_files(d, FALSE))
      deep <- if (isTRUE(input$recursive)) length(library_files(d, TRUE)) else NA
      pick <- function(path, label, cls = "") {
        htmltools::tags$button(
          type = "button", class = paste("rs-libdir", cls), title = path,
          onclick = sprintf("Shiny.setInputValue('%s', %s, {priority: 'event'})", ns("pick"),
                            jsonlite::toJSON(path, auto_unbox = TRUE)),
          label)
      }
      up <- dirname(d)
      htmltools::tagList(
        htmltools::div(class = "rs-libdir-msg",
          if (!is.null(via)) paste0("Alias \u2192 ", library_short_dir(via, 48), " \u00b7 "),
          if (is.na(deep)) sprintf("%d song file%s in this folder.", here, if (here == 1) "" else "s")
          else sprintf("%d song files here, %d with subfolders.", here, deep)),
        htmltools::div(
          class = "rs-libdirs",
          if (!identical(up, d)) pick(up, htmltools::tagList(shiny::icon("arrow-up"), " Up"), "is-up"),
          lapply(utils::head(subs, 300), function(s) pick(s, htmltools::tagList(shiny::icon("folder"), " ", basename(s))))
        )
      )
    })

    shiny::observeEvent(input$apply, {
      d <- path.expand(trimws(input$dir %||% ""))
      if (!dir.exists(d) && file.exists(d)) {
        resolved <- resolve_path_alias(d)
        if (!is.null(resolved)) d <- resolved
      }
      if (!nzchar(d) || !dir.exists(d)) {
        shiny::showNotification("That folder does not exist.", type = "error", duration = 5)
        return()
      }
      shiny::removeModal()
      switch_library(d, isTRUE(input$recursive))
    })

    lists
  })
}

# -----------------------------------------------------------------------------
# mod_home.R -- the home screen (the app's first page): the library by artist,
# album and genre, playlists, recently played and search, after a streaming
# service's home page; songs, albums, artists, genres and playlists open in the
# Instrument or the Karaoke mode, one after the other (a play queue).
#
#   UI:     mod_home_ui("home")                          the page (inst/home/home.js)
#           mod_home_queue_ui("home", "instrument")      "Playing from ..." bar in a mode's sidebar
#   server: h <- mod_home_server("home", lib, ended = list(instrument = reactive(...), karaoke = ...))
#           h$request()   list(mode, path, name, nonce): the song to open, and where
#           h$record(path, mode)   remember an opened song (recently played)
#
# The browser gets the catalog once (home_catalog(): ~250 bytes per song) and the
# user's data (playlists, recently played, genres) whenever it changes; album art
# is served per song on request (session$registerDataObj(), album art of 64 / 128 /
# 256 px, cached in <cache>/art), so only the visible covers are read.
# -----------------------------------------------------------------------------

home_dependency <- function() {
  htmltools::htmlDependency(
    name = "rockshiny-home", version = "0.1.0", src = c(file = asset_dir("home")),
    script = "home.js", stylesheet = "home.css"
  )
}

#' Home screen output (fills its container).
#' @param outputId output id.
#' @param foot id of an element to show at the bottom of the library panel (e.g. the library status line).
#' @export
homeOutput <- function(outputId, foot = NULL) {
  htmltools::tagList(
    rs_core_dependency(), home_dependency(),
    htmltools::bindFillRole(htmltools::div(id = outputId, class = "rs-home-output", `data-foot` = foot,
                                           style = "width:100%;height:100%"), item = TRUE)
  )
}

#' Render the home screen: `expr` returns list(catalog = home_catalog_json(),
#' user = home_user_json(), artUrl = a URL template (id and size placeholders), status = list(pending, total)).
#' @param expr expression.
#' @param env environment.
#' @param quoted is `expr` quoted?
#' @export
renderHome <- function(expr, env = parent.frame(), quoted = FALSE) {
  func <- shiny::exprToFunction(expr, env, quoted)
  shiny::createRenderFunction(func, function(value, session, name, ...) {
    if (is.null(value)) return(NULL)
    as.character(jsonlite::toJSON(c(list(format = HOME_FORMAT), value), auto_unbox = TRUE, null = "null", na = "null", digits = NA))
  }, homeOutput)
}

home_send <- function(session, outputId, cmd, ...) {
  session$sendCustomMessage("rs-home", list(id = session$ns(outputId), cmd = cmd, ...))
}

#' The user's part of the home payload: playlists (song ids; NA = not in the
#' library), recently played (ids), genres by artist key and by song id.
#' @noRd
home_user_json <- function(cat, created = NULL) {
  pl <- lapply(playlists_read(), function(q) {
    paths <- playlist_resolve(q, cat)
    ids <- cat$id[match(paths, cat$path)]
    missing <- lapply(seq_along(ids), function(i) if (is.na(ids[i])) list(title = q$songs[[i]]$title %||% "", artist = q$songs[[i]]$artist %||% "") else NULL)
    list(id = q$id, name = q$name, created = q$created, songs = as.list(ids), missing = missing)
  })
  h <- history_read()
  rec <- lapply(h, function(e) {
    i <- match(e$path %||% "", cat$path)
    if (is.na(i)) NULL else list(id = cat$id[i], mode = e$mode %||% "", time = e$time %||% "")
  })
  rec <- Filter(Negate(is.null), rec)
  u <- genres_user()
  online <- genres_online_cache()
  ag <- c(Filter(function(g) !is.null(g) && !is.na(g), lapply(online, function(e) e$genre)), u$artists)
  ag <- ag[!duplicated(names(ag), fromLast = TRUE)]                 # hand-set (later) wins
  sg <- u$songs
  sg <- sg[names(sg) %in% cat$path]
  names(sg) <- cat$id[match(names(sg), cat$path)]
  out <- list(playlists = pl, recent = rec, artistGenres = if (length(ag)) ag else structure(list(), names = character()),
              songGenres = if (length(sg)) sg else structure(list(), names = character()))
  if (!is.null(created)) out$created <- created
  out
}

#' Album art of a song as DDS bytes (64, 128 or 256 px), cached in <cache>/art.
#' @noRd
home_art <- function(path, size = 128L) {
  size <- if (size >= 256) 256L else if (size >= 128) 128L else 64L
  f <- file.path(cache_root(), "art", paste0(song_id(path), "-", size, ".dds"))
  if (file.exists(f) && file.mtime(f) >= file.mtime(path)) return(readBin(f, "raw", file.size(f)))
  arc <- psarc_open(path)
  dds <- psarc_find(arc, "album_art/.*\\.dds$")
  if (!length(dds)) return(NULL)
  pick <- dds[grepl(paste0("_", size, "\\.dds$"), dds)][1]
  if (is.na(pick)) pick <- dds[which.max(arc$entries$length[match(dds, arc$entries$name)])]
  raw <- psarc_read(arc, pick)
  dir.create(dirname(f), showWarnings = FALSE, recursive = TRUE)
  writeBin(raw, f)
  raw
}

mod_home_ui <- function(id) {
  ns <- shiny::NS(id)
  htmltools::bindFillRole(htmltools::div(
    class = "rs-homepage",
    homeOutput(ns("home"), foot = ns("foot")),
    # the library status line; home.js moves it to the bottom of the library panel
    htmltools::div(id = ns("foot"), class = "rs-home-foot", mod_library_bar_ui("library", "home"))
  ), container = TRUE, item = TRUE)
}

#' "Playing from <playlist> - 3 of 12" with previous / next, in a mode's sidebar.
#' @noRd
mod_home_queue_ui <- function(id, where) {
  shiny::uiOutput(shiny::NS(id, paste0("queue_", where)))
}

#' @param lib reactive rs_library (mod_library_server()).
#' @param ended named list of reactives: the players' `<id>_ended` inputs
#'   (list(instrument = reactive(input[["player-highway_ended"]]), karaoke = ...)).
#' @return list(request = reactive: list(mode, path, name, nonce) of the song to
#'   open; record = function(path, mode) for recently played; go = function(route)).
#' @noRd
mod_home_server <- function(id, lib, ended = list()) {
  shiny::moduleServer(id, function(input, output, session) {
    catalog <- shiny::reactive(home_catalog(lib()))
    art_cat <- new.env(parent = emptyenv())
    art_url <- session$registerDataObj("rs-home-art", art_cat, function(data, req) {
      q <- shiny::parseQueryString(req$QUERY_STRING %||% "")
      cat <- data$cat
      i <- if (is.null(cat)) NA else match(q$id %||% "", cat$id)
      raw <- if (is.na(i)) NULL else tryCatch(home_art(cat$path[i], as.integer(q$s %||% 128)), error = function(e) NULL)
      if (is.null(raw)) return(shiny::httpResponse(404L, "text/plain", "no album art"))
      shiny::httpResponse(200L, "application/octet-stream", raw, headers = list(`Cache-Control` = "private, max-age=86400"))
    })

    output$home <- renderHome({
      cat <- catalog()
      art_cat$cat <- cat
      l <- lib()
      list(catalog = home_catalog_json(cat), user = shiny::isolate(home_user_json(cat)),
           artUrl = paste0(art_url, "&id={id}&s={size}"), status = list(pending = l$pending %||% 0L, total = nrow(l$songs)))
    })

    # the user's data follows changes made here and in other sessions
    user_version <- shiny::reactivePoll(1000, session, checkFunc = home_version, valueFunc = home_version)
    push_user <- function(created = NULL) home_send(session, "home", "user", user = home_user_json(shiny::isolate(catalog()), created))
    shiny::observeEvent(user_version(), push_user(), ignoreInit = TRUE)
    shiny::observe({
      l <- lib()
      home_send(session, "home", "status", status = list(pending = l$pending %||% 0L, total = nrow(l$songs)))
    })
    shiny::observe({                                       # genres of the library's artists (MusicBrainz), in the background
      genres_background(catalog()$artist)
    })

    # ---- actions from the page ----------------------------------------------------------
    queue <- shiny::reactiveVal(NULL)                     # list(paths, pos, mode, context)
    request <- shiny::reactiveVal(NULL)
    path_of <- function(ids) {
      cat <- catalog()
      p <- cat$path[match(unlist(ids), cat$id)]
      p[!is.na(p)]
    }
    play_at <- function(q, pos) {
      pos <- max(1L, min(length(q$paths), pos))
      q$pos <- pos
      queue(q)
      request(list(mode = q$mode, path = q$paths[pos], name = basename(q$paths[pos]), nonce = as.numeric(Sys.time())))
    }
    shiny::observeEvent(input$home_action, {
      a <- input$home_action
      res <- tryCatch(switch(a$op %||% "",
        play = {
          paths <- path_of(a$ids)
          if (!length(paths)) stop("These songs are not in the library any more.")
          mode <- if (identical(a$mode, "karaoke")) "karaoke" else "instrument"
          play_at(list(paths = paths, mode = mode, context = a$context), as.integer(a$start %||% 0) + 1L)
        },
        playlist_new = { id <- playlist_create(a$name %||% "", path_of(a$ids)); list(created = list(token = a$token %||% "", id = id)) },
        playlist_rename = playlist_rename(a$pid, a$name %||% ""),
        playlist_delete = playlist_delete(a$pid),
        playlist_add = playlist_add(a$pid, path_of(a$ids)),
        playlist_remove = playlist_remove(a$pid, a$index),
        playlist_move = playlist_move(a$pid, a$from, a$to),
        genre_set = {
          if (!is.null(a$artist)) genre_set_artist(a$artist, a$genre %||% "")
          else if (!is.null(a$id)) genre_set_song(path_of(a$id), a$genre %||% "")
        },
        NULL), error = function(e) e)
      if (inherits(res, "error")) shiny::showNotification(conditionMessage(res), type = "warning", duration = 6)
      else if (!identical(a$op, "play")) push_user(if (is.list(res)) res$created)     # at once (the poll catches other sessions)
    })

    # ---- the queue: previous / next, and the next song when one ends ------------------------
    step <- function(by) {
      q <- queue()
      if (is.null(q)) return()
      n <- q$pos + by
      if (n >= 1L && n <= length(q$paths)) play_at(q, n) else if (by > 0) queue(NULL)
    }
    shiny::observeEvent(input$queue, {
      switch(input$queue$op %||% "", prev = step(-1L), `next` = step(1L), clear = queue(NULL), NULL)
    })
    for (m in names(ended)) local({
      mode <- m
      shiny::observeEvent(ended[[mode]](), {
        q <- queue()
        if (!is.null(q) && identical(q$mode, mode)) step(1L)
      }, ignoreInit = TRUE)
    })
    queue_bar <- function(where) shiny::renderUI({
      q <- queue()
      if (is.null(q) || !identical(q$mode, where)) return(NULL)
      cur <- q$paths[q$pos]
      ctx <- q$context
      from <- if (is.null(ctx$name) || !nzchar(ctx$name %||% "")) "your selection"
              else paste0(switch(ctx$type %||% "", playlist = "playlist ", album = "album ", artist = "", genre = "", ""), "\u201c", ctx$name, "\u201d")
      js <- function(op) sprintf("Shiny.setInputValue('%s', {op: '%s', n: Date.now()}, {priority: 'event'})", session$ns("queue"), op)
      btn <- function(op, icon, title, disabled = FALSE) htmltools::tags$button(
        type = "button", class = "rs-queue-btn", title = title, `aria-label` = title, onclick = js(op),
        disabled = if (disabled) NA else NULL, shiny::icon(icon))
      htmltools::div(
        class = "rs-queue",
        htmltools::div(class = "rs-queue-text",
          htmltools::span(class = "rs-queue-from", sprintf("Playing from %s \u00b7 %d of %d", from, q$pos, length(q$paths))),
          htmltools::span(class = "rs-queue-song", song_label(cur))),
        btn("prev", "backward-step", "Previous song", q$pos <= 1L),
        btn("next", "forward-step", "Next song", q$pos >= length(q$paths)),
        btn("clear", "xmark", "Stop playing the queue")
      )
    })
    output$queue_instrument <- queue_bar("instrument")
    output$queue_karaoke <- queue_bar("karaoke")

    list(
      request = request,
      record = function(path, mode) {                    # a song was opened in a mode
        if (is.null(path) || is.na(path)) return(invisible())
        q <- shiny::isolate(queue())                       # another song than the queue's: the queue stops
        if (!is.null(q) && identical(q$mode, mode) && !identical(normalizePath(path, winslash = "/", mustWork = FALSE),
                                                                   normalizePath(q$paths[q$pos], winslash = "/", mustWork = FALSE))) queue(NULL)
        if (path %in% shiny::isolate(catalog())$path) history_add(path, mode)
      },
      go = function(route) home_send(session, "home", "go", route = route)
    )
  })
}

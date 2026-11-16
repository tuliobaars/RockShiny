# -----------------------------------------------------------------------------
# mod_studio.R -- the studio (the timeline editor) in Shiny, and its bridge.
#
# The studio runs in the browser (creator/inst/studio + the engine); R gives it
# files and takes packages back:
#
#   R  --custom message "rsc-studio"-->  studio   open / new / save / lyrics / stems
#   R  --GET  session URL--------------> studio   the .psarc or audio file to open
#   R  <-POST session upload URL-------  studio   a saved package, stems
#   R  <-inputs <id>_state, _saved, _lyrics_request, _stems_saved, _audio_request
#
# mod_studio_server() returns the handle the other modules use:
#   $open(path, name), $new_song(spec), $save(platform, action) -> token,
#   $send(cmd, ...), $state(), $saved(), $lyrics_request(), $stems_saved(),
#   $uploaded(token, kind, part) (path of an uploaded file), $current()
# -----------------------------------------------------------------------------

#' @param id module id.
#' @param height CSS height (the studio fills its container by default).
#' @noRd
mod_studio_ui <- function(id, height = "100%") {
  ns <- shiny::NS(id)
  htmltools::tagList(
    creator_dependencies(),
    htmltools::bindFillRole(
      htmltools::div(id = ns("studio"), class = "rsc-host rsc-shiny", tabindex = "0",
                     style = htmltools::css(height = htmltools::validateCssUnit(height))),
      item = TRUE
    )
  )
}

#' Receive a POSTed file into the session's upload folder:
#' ?token=...&kind=psarc|stem&part=... -> <dir>/<token>-<kind>[-<part>]
#' @noRd
creator_upload_filter <- function(dir, req) {
  if (!identical(req$REQUEST_METHOD, "POST")) return(shiny::httpResponse(405L, "text/plain", "POST only"))
  q <- shiny::parseQueryString(req$QUERY_STRING %||% "")
  ok <- function(x) !is.null(x) && grepl("^[A-Za-z0-9_.-]{1,64}$", x)
  if (!ok(q$token) || !q$kind %in% c("psarc", "stem") || (!is.null(q$part) && !ok(q$part))) {
    return(shiny::httpResponse(400L, "text/plain", "bad upload parameters"))
  }
  dest <- file.path(dir, paste0(q$token, "-", q$kind, if (!is.null(q$part)) paste0("-", q$part)))
  con <- file(dest, "wb")
  on.exit(close(con), add = TRUE)
  inp <- req$rook.input
  repeat {
    b <- inp$read(4 * 1024^2)
    if (!length(b)) break
    writeBin(b, con)
  }
  shiny::httpResponse(200L, "application/json", '{"ok":true}')
}

#' @noRd
mod_studio_server <- function(id) {
  shiny::moduleServer(id, function(input, output, session) {
    sid <- session$ns("studio")
    up_dir <- tempfile("rsc-upload-")
    dir.create(up_dir, recursive = TRUE)
    session$onSessionEnded(function() unlink(up_dir, recursive = TRUE))
    upload_url <- session$registerDataObj("rsc_upload", up_dir, creator_upload_filter)
    serve <- function(path, type = "application/octet-stream") {
      session$registerDataObj("rsc_file", list(path = path, type = type), function(data, req) {
        if (!file.exists(data$path)) return(shiny::httpResponse(404L, "text/plain", "gone"))
        shiny::httpResponse(200L, data$type, readBin(data$path, "raw", file.size(data$path)))
      })
    }
    send <- function(cmd, ...) session$sendCustomMessage("rsc-studio", c(list(id = sid, cmd = cmd), list(...)))
    send("config", upload = upload_url)
    current <- shiny::reactiveVal(NULL)               # list(path, name) of the song file that is open

    # audio fallback (a browser that cannot decode Ogg Vorbis, e.g. older Safari): RockShiny converts
    shiny::observeEvent(input$studio_audio_request, {
      r <- input$studio_audio_request
      cur <- current()
      url <- NULL
      if (!is.null(cur) && grepl("\\.psarc$", cur$name, ignore.case = TRUE)) {
        out <- tryCatch(song_audio(load_song(cur$path, cur$name), browser = c("m4a", "wav")), error = function(e) NULL)
        if (!is.null(out)) url <- session$registerDataObj("rsc_audio", out, function(data, req) {
          shiny::httpResponse(200L, if (grepl("m4a$", data)) "audio/mp4" else "audio/wav", readBin(data, "raw", file.size(data)))
        })
      }
      send("audio", requestId = r$requestId, url = url)
    })

    list(
      open = function(path, name = basename(path)) {
        current(list(path = normalizePath(path, winslash = "/", mustWork = FALSE), name = name))
        send("open", url = serve(path), name = name)
      },
      new_song = function(spec) {
        current(NULL)
        send("new", audioUrl = serve(spec$audio_path), audioName = spec$audio_name, title = spec$title, artist = spec$artist,
             album = spec$album, year = spec$year, platform = spec$platform, arrangements = as.list(spec$arrangements),
             tuning = spec$tuning, bpm = spec$bpm, draft = isTRUE(spec$draft))
      },
      save = function(platform, action = c("library", "download")) {
        action <- match.arg(action)
        token <- paste0("p", as.integer(Sys.time()), sample.int(1e9, 1))
        send("save", platform = platform, action = action, token = token)
        token
      },
      send = send,
      state = shiny::reactive(input$studio_state),
      saved = shiny::reactive(input$studio_saved),
      errors = shiny::reactive(input$studio_error),
      lyrics_request = shiny::reactive(input$studio_lyrics_request),
      stems_saved = shiny::reactive(input$studio_stems_saved),
      uploaded = function(token, kind, part = NULL) file.path(up_dir, paste0(token, "-", kind, if (!is.null(part)) paste0("-", part))),
      current = current
    )
  })
}

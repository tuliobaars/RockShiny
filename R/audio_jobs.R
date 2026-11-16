# -----------------------------------------------------------------------------
# audio_jobs.R -- background audio pre-decoding (never blocks the Shiny process).
#
# Each job runs inst/bin/rs-convert.sh in a separate process (system2(wait =
# FALSE)); R only polls the job's status file with later::later(). A job
# writes, into the song's cache directory:
#   head.<ext>   first AUDIO_HEAD_SECONDS (available after ~1-2 s) -> playback
#                starts immediately while ...
#   audio.<ext>  ... the whole song is encoded; the browser then hands over
#                seamlessly (binding.js: _handoverTo()).
# At app start every library song is queued: quick-start clips for all songs
# first, then full files, so most songs are ready before they are opened. The
# cache is persistent (cache_root()), so this happens once per song.
# Without `sh` + vgmstream-cli (e.g. plain Windows) the synchronous
# song_audio() path is used instead.
# -----------------------------------------------------------------------------

AUDIO_HEAD_SECONDS <- 30

.jobs <- new.env(parent = emptyenv())
.jobs$queue <- list()        # pending jobs: list(path, key, full, priority)
# Two slots: the song the user is waiting for never queues behind background
# pre-warming (each slot: list(path, key, dir, full, started) or NULL)
.jobs$slots <- list(priority = NULL, background = NULL)
.jobs$loop <- FALSE          # is a later() poll scheduled?
.jobs$browser <- NULL        # formats the last connected browser can play
.jobs$keys <- list()         # psarc path -> content key (md5), filled lazily
.jobs$library <- character() # library paths being pre-warmed (progress display)

convert_script <- function() file.path(asset_dir("bin"), "rs-convert.sh")

#' Can conversions run in the background on this machine?
#' @noRd
background_supported <- function(tools = audio_tools()) {
  !is.na(tools$vgmstream) && !is.na(tools$ffmpeg) && nzchar(Sys.which("sh")) &&
    file.exists(convert_script())
}

#' Remember what the browser can play; background jobs encode for it.
#' @noRd
audio_set_browser_formats <- function(formats) {
  if (length(formats)) .jobs$browser <- as.character(formats)
  invisible(NULL)
}

#' "ext:ffmpeg,args" spec understood by rs-convert.sh.
#' @noRd
ffmpeg_spec <- function(id) paste0(AUDIO_FORMATS[[id]]$ext, ":", paste(AUDIO_FORMATS[[id]]$args, collapse = ","))

job_status_line <- function(dir) {
  f <- file.path(dir, "job.status")
  if (!file.exists(f)) return("")
  st <- tryCatch(readLines(f, n = 1L, warn = FALSE)[1], error = function(e) "")
  if (length(st) != 1L || is.na(st)) "" else st                   # empty file -> NA -> ""
}

#' What is cached for a song, in the given formats (best first)?
#' @param key content key (md5 of the .psarc).
#' @param formats candidate format ids, best first (`audio_format_candidates()`).
#' @return list(full, head = path or NULL, state = "running"|"queued"|"error"|"idle", message)
#' @export
audio_cache_state <- function(key, formats = NULL) {
  dir <- file.path(cache_root(), key)
  ids <- intersect(formats %||% names(AUDIO_FORMATS), names(AUDIO_FORMATS))
  ext <- vapply(AUDIO_FORMATS[ids], function(f) f$ext, character(1))
  find <- function(prefix) {
    p <- file.path(dir, paste0(prefix, ".", ext))
    p <- p[file.exists(p)]
    p <- p[file.size(p) > 0]
    if (length(p)) p[1] else NULL
  }
  st <- job_status_line(dir)
  running <- any(vapply(.jobs$slots, function(r) !is.null(r) && identical(r$key, key), logical(1)))
  queued <- any(vapply(.jobs$queue, function(j) identical(j$key, key), logical(1)))
  list(
    full = find("audio"), head = find("head"),
    state = if (running) "running" else if (queued) "queued" else if (startsWith(st, "error")) "error" else "idle",
    message = sub("^error ", "", st)
  )
}

#' Queue a song for background conversion.
#' @param path .psarc path.
#' @param key content key if known (md5).
#' @param full FALSE = quick-start clip only.
#' @param priority TRUE = the user is waiting: runs in its own slot, right away.
#' @export
audio_job_enqueue <- function(path, key = NULL, full = TRUE, priority = FALSE) {
  job <- list(path = normalizePath(path, mustWork = TRUE), key = key, full = isTRUE(full), priority = isTRUE(priority))
  covers <- function(j) !is.null(j) && identical(j$path, job$path) && (isTRUE(j$full) || !job$full)
  if (any(vapply(.jobs$slots, covers, logical(1)))) return(invisible(FALSE))     # already converting
  hit <- which(vapply(.jobs$queue, covers, logical(1)))
  if (length(hit)) {
    if (job$priority) {                      # promote: front of the queue, priority slot
      j <- .jobs$queue[[hit[1]]]
      j$priority <- TRUE
      .jobs$queue <- c(list(j), .jobs$queue[-hit[1]])
    }
  } else {
    .jobs$queue <- if (job$priority) c(list(job), .jobs$queue) else c(.jobs$queue, list(job))
  }
  audio_jobs_pump()
  invisible(TRUE)
}

#' Advance the queue: reap finished jobs, fill free slots, keep polling.
#' @noRd
audio_jobs_pump <- function() {
  for (slot in names(.jobs$slots)) {
    r <- .jobs$slots[[slot]]
    if (is.null(r)) next
    st <- job_status_line(r$dir)
    finished <- grepl("^(done|error)", st) || (!r$full && grepl("^head", st))
    timed_out <- as.numeric(difftime(Sys.time(), r$started, units = "secs")) > 600
    if (finished || timed_out) {
      if (!finished) writeLines("error conversion timed out", file.path(r$dir, "job.status"))
      unlink(file.path(r$dir, "audio.wem"))
      .jobs$slots[slot] <- list(NULL)       # (`[<-` with list(NULL) keeps the slot name)
    }
  }
  next_job <- function(prio) {                # first queued job of that kind, removed from the queue
    i <- which(vapply(.jobs$queue, function(j) isTRUE(j$priority) == prio, logical(1)))[1]
    if (is.na(i)) return(NULL)
    job <- .jobs$queue[[i]]
    .jobs$queue <- .jobs$queue[-i]
    job
  }
  for (slot in c("priority", "background")) {
    while (is.null(.jobs$slots[[slot]])) {
      job <- next_job(slot == "priority")
      if (is.null(job)) break
      tryCatch(audio_job_start(job, slot), error = function(e) {
        message("RockShiny: audio job for ", basename(job$path), " failed: ", conditionMessage(e))
      })
    }
  }
  busy <- any(!vapply(.jobs$slots, is.null, logical(1))) || length(.jobs$queue) > 0L
  if (busy && !isTRUE(.jobs$loop)) {
    .jobs$loop <- TRUE
    later::later(function() {
      .jobs$loop <- FALSE
      tryCatch(audio_jobs_pump(), error = function(e) message("RockShiny: audio queue: ", conditionMessage(e)))
    }, 0.5)
  }
  invisible(busy)
}

audio_job_start <- function(job, slot = "background") {
  tools <- audio_tools()
  key <- job$key %||% .jobs$keys[[job$path]] %||% unname(tools::md5sum(job$path))
  .jobs$keys[[job$path]] <- key
  dir <- file.path(cache_root(), key)
  dir.create(dir, recursive = TRUE, showWarnings = FALSE)
  formats <- audio_format_candidates(tools, .jobs$browser)
  st <- audio_cache_state(key, formats)
  if (!is.null(st$full) || (!job$full && !is.null(st$head))) return(invisible(FALSE))   # already there

  arc <- psarc_open(job$path)
  wem <- file.path(dir, "audio.wem")
  psarc_read(arc, find_song_wem(arc), out = wem)
  unlink(file.path(dir, "job.status"))
  head_seconds <- if (is.null(st$head)) getOption("rockshiny.head_seconds", AUDIO_HEAD_SECONDS) else 0
  args <- c(shQuote(convert_script()), shQuote(tools$vgmstream), shQuote(tools$ffmpeg), shQuote(wem),
            shQuote(dir), head_seconds, if (job$full) 1L else 0L,
            shQuote(vapply(formats, ffmpeg_spec, character(1))))
  system2("sh", args, wait = FALSE, stdout = FALSE, stderr = FALSE)
  .jobs$slots[[slot]] <- list(path = job$path, key = key, dir = dir, full = job$full, started = Sys.time())
  invisible(TRUE)
}

#' Pre-decode every song in the library folder in the background:
#' quick-start clips for all songs first, then the full files. Small libraries
#' only (see library.R); in big ones a song's audio is converted when it is picked.
#' @param lib a library (`library_open()`) or a folder.
#' @export
audio_prewarm_library <- function(lib = library_current()) {
  if (!isTRUE(getOption("rockshiny.prewarm", TRUE)) || !background_supported()) return(invisible(0L))
  files <- if (inherits(lib, "rs_library")) lib$songs$path[lib$songs$kind == "psarc"]
           else normalizePath(list.files(lib, pattern = "\\.psarc$", full.names = TRUE, ignore.case = TRUE))
  if (length(files) > getOption("rockshiny.library_lazy_threshold", 50)) {   # big library: audio when a song is picked
    .jobs$library <- NULL
    return(invisible(0L))
  }
  .jobs$library <- files
  for (f in files) audio_job_enqueue(f, full = FALSE)
  for (f in files) audio_job_enqueue(f, full = TRUE)
  invisible(length(files))
}

#' Library pre-decoding progress: list(total, ready) or NULL.
#' @export
audio_prewarm_progress <- function() {
  lib <- .jobs$library
  if (!length(lib)) return(NULL)
  ready <- vapply(lib, function(p) {
    key <- .jobs$keys[[p]]
    !is.null(key) && !is.null(audio_cache_state(key, audio_format_candidates(audio_tools(), .jobs$browser))$full)
  }, logical(1))
  list(total = length(lib), ready = sum(ready))
}

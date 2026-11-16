# -----------------------------------------------------------------------------
# scores.R -- persistent results of scored runs (microphone / keyboard input).
#
# One CSV row per run, appended to <data dir>/scores.csv, where the data dir is
# getOption("rockshiny.data_dir") or tools::R_user_dir("RockShiny", "data").
# A run arrives from the browser as input$<highway>_result (see binding.js
# _finishRun / _finishPass); score_save() normalises, stores and compares it
# with the personal best.
#
# Personal best = highest accuracy of a *complete* song run at full speed:
# kind "song", coverage >= 0.9 (the player went through >= 90 % of the notes)
# and playback rate >= 1. Loop passes and slowed-down runs are kept in the
# history but never count as a best.
# -----------------------------------------------------------------------------

SCORE_COLUMNS <- c("time", "song_key", "title", "artist", "arrangement", "difficulty", "kind", "source",
                   "rate", "accuracy", "score", "hits", "misses", "perfect", "best_streak", "coverage",
                   "median_delta_ms")

score_dir <- function() getOption("rockshiny.data_dir", tools::R_user_dir("RockShiny", "data"))
score_file <- function() file.path(score_dir(), "scores.csv")

#' One-row data frame (SCORE_COLUMNS) from a browser result list.
#' @noRd
score_row <- function(r, time = Sys.time()) {
  num <- function(x, default = NA_real_) {
    v <- suppressWarnings(as.numeric(x %||% default))
    if (length(v) != 1L) default else v
  }
  chr <- function(x) { v <- as.character(x %||% ""); if (length(v) != 1L || is.na(v)) "" else v }
  data.frame(
    time = format(time, "%Y-%m-%d %H:%M:%S"),
    song_key = chr(r$songKey), title = chr(r$title), artist = chr(r$artist), arrangement = chr(r$arrangement),
    difficulty = num(r$difficulty, 1), kind = chr(r$kind %||% "song"), source = chr(r$source),
    rate = num(r$rate, 1), accuracy = num(r$accuracy), score = num(r$score, 0),
    hits = num(r$hits, 0), misses = num(r$misses, 0), perfect = num(r$perfect, 0),
    best_streak = num(r$bestStreak, 0), coverage = num(r$coverage, 0),
    median_delta_ms = num(r$medianDeltaMs),
    stringsAsFactors = FALSE
  )
}

#' All stored runs (optionally for one song / arrangement / kind), newest first.
#' @noRd
score_history <- function(song_key = NULL, arrangement = NULL, kind = NULL, file = score_file()) {
  empty <- score_row(list())[0, ]
  if (!file.exists(file)) return(empty)
  d <- tryCatch(utils::read.csv(file, stringsAsFactors = FALSE, colClasses = c(song_key = "character")),
                error = function(e) empty)
  if (!nrow(d)) return(empty)
  for (col in setdiff(SCORE_COLUMNS, names(d))) d[[col]] <- NA      # files written by older versions
  d <- d[, SCORE_COLUMNS]
  keep <- rep(TRUE, nrow(d))
  if (!is.null(song_key)) keep <- keep & d$song_key %in% song_key
  if (!is.null(arrangement)) keep <- keep & d$arrangement %in% arrangement
  if (!is.null(kind)) keep <- keep & d$kind %in% kind
  d <- d[keep, , drop = FALSE]
  d[order(d$time, decreasing = TRUE), , drop = FALSE]
}

#' Does a run qualify for the personal best?
#' @noRd
score_counts_for_best <- function(d, min_coverage = 0.9) {
  d$kind == "song" & !is.na(d$accuracy) & !is.na(d$coverage) & d$coverage >= min_coverage &
    !is.na(d$rate) & d$rate >= 0.999
}

#' Best accuracy (0..1) of qualifying runs, or NULL.
#' @noRd
score_best <- function(song_key, arrangement, file = score_file()) {
  d <- score_history(song_key, arrangement, kind = "song", file = file)
  d <- d[score_counts_for_best(d), , drop = FALSE]
  if (!nrow(d)) NULL else max(d$accuracy)
}

#' Append a run; returns list(row, previous = best before, best = best after, new_best).
#' @noRd
score_save <- function(r, file = score_file(), time = Sys.time()) {
  row <- score_row(r, time)
  previous <- score_best(row$song_key, row$arrangement, file = file)
  dir.create(dirname(file), recursive = TRUE, showWarnings = FALSE)
  existed <- file.exists(file)        # (evaluated now: write.table's arguments are lazy)
  utils::write.table(row, file, sep = ",", append = existed, col.names = !existed,
                     row.names = FALSE, qmethod = "double")
  new_best <- isTRUE(score_counts_for_best(row)) && (is.null(previous) || row$accuracy > previous)
  list(row = row, previous = previous, best = if (new_best) row$accuracy else previous, new_best = new_best)
}

# ---- singing (karaoke mode, karaoke-sing.js) -------------------------------------------
# A sung run is stored in the same file: kind "sing", arrangement "vocals",
# score = points (0..10 000), accuracy = points / 10 000, hits / misses = lines sung /
# not sung, perfect = lines rated "Perfect!", coverage = lines sung / all lines.
# A best needs the whole song, sung from the start (no jumps), at full speed.

#' Store a sung run from input$<karaoke>_score; list(row, previous, best, new_best) in points.
#' @noRd
sing_score_save <- function(r, song = NULL, file = score_file(), time = Sys.time()) {
  lines <- unlist(lapply(r$lines %||% list(), function(x) if (is.null(x)) NA_real_ else as.numeric(x)))
  row <- score_row(list(
    songKey = r$songKey, title = song$meta$title %||% "", artist = song$meta$artist %||% "", arrangement = "vocals",
    difficulty = 1, kind = "sing", source = paste0("microphone/", r$mode %||% ""), rate = r$rate %||% 1,
    accuracy = as.numeric(r$score %||% 0) / 10000, score = r$score %||% 0,
    hits = r$linesSung %||% 0, misses = (r$linesTotal %||% 0) - (r$linesSung %||% 0),
    perfect = sum(lines >= 0.85, na.rm = TRUE), bestStreak = r$bestCombo %||% 0,
    coverage = if (isTRUE(r$complete) && isTRUE(r$finished)) (r$linesSung %||% 0) / max(1, r$linesTotal %||% 1) else 0
  ), time)
  previous <- sing_score_best(row$song_key, file = file)
  dir.create(dirname(file), recursive = TRUE, showWarnings = FALSE)
  existed <- file.exists(file)
  utils::write.table(row, file, sep = ",", append = existed, col.names = !existed, row.names = FALSE, qmethod = "double")
  counts <- isTRUE(row$coverage >= 0.9 && row$rate >= 0.999)
  new_best <- counts && (is.null(previous) || row$score > previous)
  list(row = row, previous = previous, best = if (new_best) row$score else previous, new_best = new_best)
}

#' Best sung score (points) of a song, or NULL.
#' @noRd
sing_score_best <- function(song_key, file = score_file()) {
  d <- score_history(song_key, "vocals", kind = "sing", file = file)
  d <- d[!is.na(d$coverage) & d$coverage >= 0.9 & !is.na(d$rate) & d$rate >= 0.999, , drop = FALSE]
  if (!nrow(d)) NULL else max(d$score)
}

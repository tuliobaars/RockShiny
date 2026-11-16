# -----------------------------------------------------------------------------
# chart.R -- source-independent chart model + the JSON contract with the JS.
#
# Both parse_arrangement_xml() and parse_arrangement_sng() return a "raw chart":
#   meta              list(title, artist, ..., song_length, tuning, is_bass)
#   beats             data.frame(time, measure)          measure = -1 for non-downbeats
#   sections          data.frame(name, time)
#   phrases           data.frame(max_difficulty, name)
#   phrase_iterations data.frame(time, phrase_id)
#   templates         list(name = chr, frets = int matrix [n x 6], -1 = unused)
#   notes             data.frame(level, time, string, fret, sustain, slide_to,
#                                slide_unp, bend, tech, chord_key)
#   chords            data.frame(level, time, template, high_density, key)
#   anchors           data.frame(level, time, fret, width)
#   bends             data.frame(key, time, step)        bend curve points; key = notes$bend_key
#                     (notes also carry bend_key: unique per note, NA = no curve)
#
# build_chart() collapses the difficulty levels into the max-difficulty chart
# and chart_json() serialises it column-wise for the frontend.
# -----------------------------------------------------------------------------

#' Technique bit flags -- MUST stay in sync with TECH in inst/highway/renderer.js
#' @noRd
TECH <- c(
  hammer_on = 1L, pull_off = 2L, palm_mute = 4L, fret_hand_mute = 8L,
  harmonic = 16L, pinch_harmonic = 32L, vibrato = 64L, tremolo = 128L,
  accent = 256L, link_next = 512L, tap = 1024L, bend = 2048L, slide = 4096L,
  slide_unpitched = 8192L, chord = 16384L, ignore = 32768L
)

empty_notes <- function() data.frame(
  level = integer(), time = numeric(), string = integer(), fret = integer(),
  sustain = numeric(), slide_to = integer(), slide_unp = integer(),
  bend = numeric(), tech = integer(), chord_key = integer(), bend_key = character(),
  stringsAsFactors = FALSE
)
empty_bends <- function() data.frame(key = character(), time = numeric(), step = numeric(),
                                     stringsAsFactors = FALSE)
empty_chords <- function() data.frame(
  level = integer(), time = numeric(), template = integer(),
  high_density = logical(), key = integer()
)

#' Difficulty level to use for every phrase iteration: `difficulty` (0..1) of
#' the phrase's maxDifficulty (1 = full chart, as in the game's Riff Repeater),
#' clamped to the levels that actually exist.
#' @noRd
phrase_levels <- function(raw, pit, difficulty = 1) {
  avail <- sort(unique(c(raw$notes$level, raw$chords$level, raw$anchors$level)))
  if (!length(avail)) return(rep(0L, nrow(pit)))
  target <- raw$phrases$max_difficulty[pit$phrase_id + 1L]
  target[is.na(target)] <- max(avail)
  target <- round(target * max(0, min(1, difficulty)))
  vapply(target, function(t) {
    ok <- avail[avail <= t]
    if (length(ok)) max(ok) else min(avail)
  }, numeric(1))
}

#' Dynamic Difficulty: keep an event iff it belongs to the level selected for
#' the phrase iteration it falls in ([start_i, start_{i+1})).
#' @noRd
select_max_difficulty <- function(time, level, pi_time, pi_level) {
  if (!length(time)) return(logical(0))
  if (!length(pi_time)) return(level == max(level))
  idx <- pmax(findInterval(time, pi_time), 1L)
  level == pi_level[idx]
}

#' Raw chart -> playable chart (single difficulty, sorted, chord links resolved).
#' @param difficulty 0..1 share of each phrase's max difficulty (1 = full chart).
#' @param raw a raw chart from `parse_arrangement_xml()` or `parse_arrangement_sng()`.
#' @export
build_chart <- function(raw, difficulty = 1) {
  pit <- raw$phrase_iterations[order(raw$phrase_iterations$time), , drop = FALSE]
  lv  <- phrase_levels(raw, pit, difficulty)

  notes   <- raw$notes[select_max_difficulty(raw$notes$time, raw$notes$level, pit$time, lv), , drop = FALSE]
  chords  <- raw$chords[select_max_difficulty(raw$chords$time, raw$chords$level, pit$time, lv), , drop = FALSE]
  anchors <- raw$anchors[select_max_difficulty(raw$anchors$time, raw$anchors$level, pit$time, lv), , drop = FALSE]

  notes <- notes[!is.na(notes$string) & notes$string >= 0L & notes$string <= 5L, , drop = FALSE]
  chords <- chords[order(chords$time), , drop = FALSE]
  notes$chord <- match(notes$chord_key, chords$key) - 1L          # 0-based for JS
  notes$chord[is.na(notes$chord)] <- -1L
  notes <- notes[order(notes$time, notes$string), , drop = FALSE]
  anchors <- anchors[order(anchors$time), , drop = FALSE]
  anchors <- anchors[!duplicated(anchors$time, fromLast = TRUE), , drop = FALSE]

  # bend curves -> 0-based index of the final (sorted) note they belong to
  b <- raw$bends %||% empty_bends()
  owner <- match(b$key, notes$bend_key)
  bends <- data.frame(note = owner[!is.na(owner)] - 1L, time = b$time[!is.na(owner)],
                      step = b$step[!is.na(owner)])
  bends <- bends[order(bends$note, bends$time), , drop = FALSE]
  if (nrow(bends)) {   # a curve, when present, defines the bend (XML attributes can be rounded up)
    mx <- tapply(bends$step, bends$note, max)
    notes$bend[as.integer(names(mx)) + 1L] <- as.numeric(mx)
  }

  chords$name <- raw$templates$name[chords$template + 1L]
  chords$name[is.na(chords$name)] <- ""

  meta <- raw$meta
  n_strings <- if (isTRUE(meta$is_bass)) 4L else 6L
  if (nrow(notes)) n_strings <- max(n_strings, max(notes$string) + 1L)
  meta$n_strings <- n_strings
  meta$n_notes <- nrow(notes)
  meta$max_difficulty <- max(c(0L, raw$phrases$max_difficulty), na.rm = TRUE)
  meta$difficulty <- difficulty
  meta$tuning_name <- tuning_name(meta$tuning, n_strings)
  meta$max_fret <- max(c(notes$fret, notes$slide_to, 12L), na.rm = TRUE)
  if (is.null(meta$song_length) || is.na(meta$song_length)) {
    meta$song_length <- max(c(notes$time + notes$sustain, raw$beats$time, 0))
  }

  list(
    meta = meta,
    notes = notes[, c("time", "string", "fret", "sustain", "slide_to", "slide_unp", "bend", "tech", "chord")],
    chords = chords[, c("time", "template", "name", "high_density")],
    anchors = anchors[, c("time", "fret", "width")],
    beats = raw$beats[order(raw$beats$time), , drop = FALSE],
    sections = section_labels(raw$sections[order(raw$sections$time), , drop = FALSE]),
    bends = bends
  )
}

SECTION_NAMES <- c(
  noguitar = "No guitar", prechorus = "Pre-chorus", postchorus = "Post-chorus", modchorus = "Mod. chorus",
  modverse = "Mod. verse", prevs = "Pre-verse", postvs = "Post-verse", fadein = "Fade in",
  fadeout = "Fade out", buildup = "Build-up", breakdown = "Breakdown", interlude = "Interlude"
)

#' Human-readable section labels ("verse" #2 -> "Verse 2"); numbers are only
#' shown for names that occur more than once.
#' @noRd
section_labels <- function(sec) {
  if (!nrow(sec)) { sec$label <- character(0); return(sec) }
  key <- tolower(sec$name)
  pretty <- ifelse(key %in% names(SECTION_NAMES), SECTION_NAMES[key],
                   paste0(toupper(substr(key, 1, 1)), substring(key, 2)))
  num <- if (is.null(sec$number)) stats::ave(seq_along(key), key, FUN = seq_along) else sec$number
  dup <- key %in% key[duplicated(key)]
  sec$label <- unname(ifelse(dup, paste(pretty, num), pretty))
  sec
}

#' Tuning name from per-string semitone offsets ("E Standard", "Drop D", ...).
#' @param tuning integer semitone offsets per string.
#' @param n_strings number of strings (4 for bass).
#' @export
tuning_name <- function(tuning, n_strings = 6L) {
  notes <- c("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
  base <- if (n_strings == 4L) c(28, 33, 38, 43) else c(40, 45, 50, 55, 59, 64)
  t <- as.integer(tuning[seq_len(length(base))])
  t[is.na(t)] <- 0L
  open <- notes[(base + t) %% 12 + 1]
  if (all(t == t[1])) return(paste(open[1], "Standard"))
  if (all(t[-1] == t[2]) && t[1] == t[2] - 2L) return(paste("Drop", open[1]))
  paste(open, collapse = " ")
}

#' Serialise a chart to the column-oriented JSON the frontend expects.
#'
#' Columns (not rows) keep the payload small and let the JS turn each column
#' straight into a typed array. auto_unbox is OFF so a 1-note chart still
#' yields arrays; scalar metadata is unboxed explicitly.
#' @param vocals optional vocals_lines() data.frame (lyrics)
#' @param art optional base64 string of the album-art .dds (decoded in JS)
#' @param chart a chart from `song_chart()` / `build_chart()`.
#' @param song_key the song's key (md5), echoed to the browser.
#' @export
chart_json <- function(chart, song_key = NULL, vocals = NULL, art = NULL) {
  unbox_scalars <- function(l) {
    l <- l[!vapply(l, is.null, logical(1))]
    lapply(l, function(v) if (is.atomic(v) && length(v) == 1L) jsonlite::unbox(v) else v)
  }
  if (!is.null(chart$instrument) && !identical(chart$instrument, "guitar")) {
    payload <- lane_chart_payload(chart, song_key, unbox_scalars)
    return(finish_chart_json(payload, vocals, art))
  }
  n <- chart$notes
  payload <- list(
    format = jsonlite::unbox("rockshiny-chart/1"),
    songKey = jsonlite::unbox(song_key %||% NA_character_),
    meta = unbox_scalars(chart$meta),
    notes = list(
      t = round(n$time, 3), s = n$string, f = n$fret, sus = round(n$sustain, 3),
      tech = n$tech, slide = n$slide_to, slideU = n$slide_unp,
      bend = round(n$bend, 2), chord = n$chord
    ),
    chords = list(t = round(chart$chords$time, 3), name = chart$chords$name,
                  hd = as.integer(chart$chords$high_density)),
    bends = list(n = chart$bends$note %||% integer(0), t = round(chart$bends$time %||% numeric(0), 3),
                 s = round(chart$bends$step %||% numeric(0), 2)),
    anchors = list(t = round(chart$anchors$time, 3), fret = chart$anchors$fret,
                   width = chart$anchors$width),
    beats = list(t = round(chart$beats$time, 3), m = chart$beats$measure),
    sections = list(t = round(chart$sections$time, 3), name = chart$sections$name,
                    label = chart$sections$label %||% chart$sections$name)
  )
  finish_chart_json(payload, vocals, art)
}

finish_chart_json <- function(payload, vocals = NULL, art = NULL) {
  if (!is.null(vocals) && nrow(vocals)) {
    payload$vocals <- list(t = round(vocals$time, 3), d = round(vocals$length, 3), w = vocals$text,
                           j = as.integer(vocals$join), l = vocals$line)
  }
  if (!is.null(art)) payload$art <- jsonlite::unbox(art)
  jsonlite::toJSON(payload, auto_unbox = FALSE, digits = NA, na = "null", null = "null")
}

#' Lane charts (piano, harmonica; see instruments.R): notes carry a MIDI pitch
#' and the instrument position (piano: hand; harmonica: hole, blow, bend, ob).
#' @noRd
lane_chart_payload <- function(chart, song_key, unbox_scalars) {
  n <- chart$notes
  notes <- list(t = round(n$time, 3), sus = round(n$sustain, 3), midi = as.integer(n$midi),
                chord = as.integer(n$chord))
  if (chart$instrument == "piano") notes$hand <- as.integer(n$hand)
  if (chart$instrument == "harmonica") {
    notes$hole <- as.integer(n$hole); notes$blow <- as.integer(n$blow)
    notes$bend <- as.integer(n$bend); notes$ob <- as.integer(n$ob)
  }
  ch <- chart$chords
  list(
    format = jsonlite::unbox("rockshiny-chart/1"),
    instrument = jsonlite::unbox(chart$instrument),
    songKey = jsonlite::unbox(song_key %||% NA_character_),
    meta = unbox_scalars(chart$meta),
    notes = notes,
    chords = list(t = round(ch$time, 3), name = as.character(ch$name), hd = as.integer(ch$high_density)),
    beats = list(t = round(chart$beats$time, 3), m = chart$beats$measure),
    sections = list(t = round(chart$sections$time, 3), name = chart$sections$name,
                    label = chart$sections$label %||% chart$sections$name)
  )
}

# -----------------------------------------------------------------------------
# arrangement_xml.R -- Rocksmith 2014 arrangement XML (songs/arr/*.xml).
#
# CDLC built with the Custom Song Toolkit / EOF ships these next to the SNGs.
# Notes live in /song/levels/level[@difficulty]/{notes,chords,anchors}; with
# Dynamic Difficulty (DD) there is one <level> per difficulty and the full
# chart has to be re-assembled per phrase (see chart.R: select_max_difficulty).
# NB: <transcriptionTrack> also contains <notes>/<chords>, hence the explicit
# /song/levels XPath everywhere.
# -----------------------------------------------------------------------------

xml_num <- function(nodes, attr, default = NA_real_) {
  v <- suppressWarnings(as.numeric(xml2::xml_attr(nodes, attr)))
  v[is.na(v)] <- default
  v
}
xml_int <- function(nodes, attr, default = NA_integer_) {
  v <- suppressWarnings(as.integer(xml2::xml_attr(nodes, attr)))
  v[is.na(v)] <- default
  v
}
xml_flag <- function(nodes, attr) xml_int(nodes, attr, 0L) > 0L

#' Technique bitmask from the boolean/int attributes of <note>/<chordNote>.
#' @noRd
xml_note_tech <- function(nodes) {
  n <- length(nodes)
  tech <- integer(n)
  add <- function(on, bit) ifelse(on, TECH[[bit]], 0L)
  tech <- tech +
    add(xml_flag(nodes, "hammerOn"), "hammer_on") +
    add(xml_flag(nodes, "pullOff"), "pull_off") +
    add(xml_flag(nodes, "palmMute"), "palm_mute") +
    add(xml_flag(nodes, "mute"), "fret_hand_mute") +
    add(xml_flag(nodes, "harmonic"), "harmonic") +
    add(xml_flag(nodes, "harmonicPinch"), "pinch_harmonic") +
    add(xml_flag(nodes, "vibrato"), "vibrato") +
    add(xml_flag(nodes, "tremolo"), "tremolo") +
    add(xml_flag(nodes, "accent"), "accent") +
    add(xml_flag(nodes, "linkNext"), "link_next") +
    add(xml_flag(nodes, "tap"), "tap") +
    add(xml_num(nodes, "bend", 0) > 0, "bend") +
    add(xml_int(nodes, "slideTo", -1L) >= 0L, "slide") +
    add(xml_int(nodes, "slideUnpitchTo", -1L) >= 0L, "slide_unpitched") +
    add(xml_flag(nodes, "ignore"), "ignore")
  as.integer(tech)
}

#' Bend curves of a nodeset of <note>/<chordNote>: one row per <bendValue>,
#' keyed by the XPath of the owning note (unique in the document).
#' @noRd
xml_bends <- function(nodes) {
  bv <- xml2::xml_find_all(nodes, "./bendValues/bendValue")
  if (!length(bv)) return(empty_bends())
  data.frame(key = sub("/bendValues/bendValue(\\[[0-9]+\\])?$", "", xml2::xml_path(bv)),
             time = xml_num(bv, "time"), step = xml_num(bv, "step", 0), stringsAsFactors = FALSE)
}

#' Columns shared by single notes and chord notes.
#' @noRd
xml_note_frame <- function(nodes, level) {
  data.frame(
    level     = rep(level, length(nodes)),
    time      = xml_num(nodes, "time"),
    string    = xml_int(nodes, "string"),
    fret      = xml_int(nodes, "fret", 0L),
    sustain   = xml_num(nodes, "sustain", 0),
    slide_to  = xml_int(nodes, "slideTo", -1L),
    slide_unp = xml_int(nodes, "slideUnpitchTo", -1L),
    bend      = xml_num(nodes, "bend", 0),
    tech      = xml_note_tech(nodes),
    chord_key = rep(NA_integer_, length(nodes)),
    bend_key  = xml2::xml_path(nodes),                   # links bend curve points (xml_bends)
    stringsAsFactors = FALSE
  )
}

#' Parse an arrangement XML (file path, string or raw vector).
#' @param x arrangement XML: raw vector, string or file path.
#' @return The intermediate "raw chart" consumed by build_chart().
#' @export
parse_arrangement_xml <- function(x) {
  doc  <- xml2::read_xml(x)
  song <- xml2::xml_root(doc)
  if (!identical(xml2::xml_name(song), "song")) {
    stop("Not a Rocksmith arrangement XML (root element <", xml2::xml_name(song), ">).")
  }
  txt <- function(xpath) {
    node <- xml2::xml_find_first(song, xpath)
    if (inherits(node, "xml_missing")) NA_character_ else xml2::xml_text(node)
  }
  tuning_node <- xml2::xml_find_first(song, "./tuning")
  props <- xml2::xml_find_first(song, "./arrangementProperties")
  arr_name <- txt("./arrangement")

  meta <- list(
    title         = txt("./title"),
    artist        = txt("./artistName"),
    album         = txt("./albumName"),
    year          = txt("./albumYear"),
    arrangement   = arr_name,
    song_length   = as.numeric(txt("./songLength")),
    average_tempo = as.numeric(txt("./averageTempo")),
    cent_offset   = as.numeric(txt("./centOffset")) %||% 0,
    capo          = as.integer(txt("./capo")) %||% 0L,
    tuning        = unname(vapply(paste0("string", 0:5), function(a) xml_int(tuning_node, a, 0L), integer(1))),
    is_bass       = grepl("bass", arr_name, ignore.case = TRUE) || isTRUE(xml_flag(props, "pathBass")),
    source        = "xml"
  )

  # ---- global timeline -------------------------------------------------------
  ebeats <- xml2::xml_find_all(song, "./ebeats/ebeat")
  sections <- xml2::xml_find_all(song, "./sections/section")
  phrases <- xml2::xml_find_all(song, "./phrases/phrase")
  pis <- xml2::xml_find_all(song, "./phraseIterations/phraseIteration")
  tmpl <- xml2::xml_find_all(song, "./chordTemplates/chordTemplate")

  tmpl_name <- xml2::xml_attr(tmpl, "chordName")
  no_name <- is.na(tmpl_name) | !nzchar(tmpl_name)
  tmpl_name[no_name] <- xml2::xml_attr(tmpl, "displayName")[no_name]
  templates <- list(
    name  = tmpl_name,
    frets = matrix(vapply(paste0("fret", 0:5), function(a) xml_int(tmpl, a, -1L), integer(length(tmpl))),
                   ncol = 6L)
  )

  # ---- per-difficulty levels -----------------------------------------------
  levels <- xml2::xml_find_all(song, "./levels/level")
  note_parts <- list(); chord_parts <- list(); anchor_parts <- list(); bend_parts <- list()
  chord_key_base <- 0L
  for (i in seq_along(levels)) {
    lv <- levels[[i]]
    d <- xml_int(lv, "difficulty", 0L)

    single_nodes <- xml2::xml_find_all(lv, "./notes/note")
    note_parts[[length(note_parts) + 1L]] <- xml_note_frame(single_nodes, d)
    bend_parts[[length(bend_parts) + 1L]] <- xml_bends(single_nodes)

    ch <- xml2::xml_find_all(lv, "./chords/chord")
    if (length(ch)) {
      res <- xml_chords(ch, d, templates, chord_key_base)
      chord_key_base <- chord_key_base + length(ch)
      chord_parts[[length(chord_parts) + 1L]] <- res$chords
      note_parts[[length(note_parts) + 1L]] <- res$notes
      bend_parts[[length(bend_parts) + 1L]] <- res$bends
    }

    an <- xml2::xml_find_all(lv, "./anchors/anchor")
    anchor_parts[[length(anchor_parts) + 1L]] <- data.frame(
      level = rep(d, length(an)), time = xml_num(an, "time"),
      fret = xml_int(an, "fret", 1L), width = xml_num(an, "width", 4)
    )
  }

  list(
    meta = meta,
    beats = data.frame(time = xml_num(ebeats, "time"), measure = xml_int(ebeats, "measure", -1L)),
    sections = data.frame(name = xml2::xml_attr(sections, "name"), time = xml_num(sections, "startTime"),
                          number = xml_int(sections, "number", 1L), stringsAsFactors = FALSE),
    phrases = data.frame(max_difficulty = xml_int(phrases, "maxDifficulty", 0L),
                         name = xml2::xml_attr(phrases, "name"), stringsAsFactors = FALSE),
    phrase_iterations = data.frame(time = xml_num(pis, "time"), phrase_id = xml_int(pis, "phraseId", 0L)),
    templates = templates,
    notes = do.call(rbind, note_parts) %||% empty_notes(),
    chords = do.call(rbind, chord_parts) %||% empty_chords(),
    anchors = do.call(rbind, anchor_parts) %||%
      data.frame(level = integer(), time = numeric(), fret = integer(), width = numeric()),
    bends = do.call(rbind, bend_parts) %||% empty_bends()
  )
}

#' Chords -> (chord table, expanded chord notes).
#'
#' Semantics match the game's XML->SNG compiler: the chord TEMPLATE decides
#' which strings/frets sound; <chordNote> children (often only present for
#' strings that carry a technique, e.g. one muted string) only override the
#' per-string sustain / slide / bend / techniques. Strings without a
#' chordNote inherit the chord's longest sustain.
#' @noRd
xml_chords <- function(ch, level, templates, key_base) {
  n <- length(ch)
  chords <- data.frame(
    level = rep(level, n),
    time = xml_num(ch, "time"),
    template = xml_int(ch, "chordId", 0L),
    high_density = xml_flag(ch, "highDensity")
  )
  chords$key <- key_base + seq_len(n)

  chord_tech <- ifelse(xml_flag(ch, "palmMute"), TECH[["palm_mute"]], 0L) +
    ifelse(xml_flag(ch, "fretHandMute"), TECH[["fret_hand_mute"]], 0L) +
    ifelse(xml_flag(ch, "accent"), TECH[["accent"]], 0L)

  # explicit chord notes, mapped to their parent chord through the XPath of
  # the node (".../chord[15]/chordNote[2]" -> ".../chord[15]")
  cn_nodes <- xml2::xml_find_all(ch, "./chordNote")
  cn <- xml_note_frame(cn_nodes, level)
  cn$owner <- match(sub("/chordNote(\\[[0-9]+\\])?$", "", xml2::xml_path(cn_nodes)), xml2::xml_path(ch))
  chord_sus <- vapply(split(cn$sustain, factor(cn$owner, levels = seq_len(n))),
                      function(v) if (length(v)) max(v) else 0, numeric(1))

  # template expansion: one row per fretted string
  k <- rep(seq_len(n), each = 6L)
  s <- rep(0:5, times = n)
  fr <- template_frets(templates$frets, chords$template[k], s)
  keep <- !is.na(fr) & fr >= 0L
  k <- k[keep]; s <- s[keep]; fr <- fr[keep]
  nk <- length(k)                                                      # may be 0: no scalars below
  notes <- data.frame(
    level = rep(level, nk), time = chords$time[k], string = s, fret = fr,
    sustain = unname(chord_sus[k]), slide_to = rep(-1L, nk), slide_unp = rep(-1L, nk), bend = rep(0, nk),
    tech = as.integer(chord_tech[k]), chord_key = chords$key[k], bend_key = rep(NA_character_, nk),
    stringsAsFactors = FALSE
  )

  # overlay per-string details from matching chordNotes
  m <- match(paste(k, s), paste(cn$owner, cn$string))
  hit <- !is.na(m)
  cols <- c("sustain", "slide_to", "slide_unp", "bend", "bend_key")
  notes[hit, cols] <- cn[m[hit], cols]
  notes$tech[hit] <- bitwOr(notes$tech[hit], cn$tech[m[hit]])

  # chordNotes on strings the template does not use (rare): keep them too
  extra <- cn[!(seq_len(nrow(cn)) %in% m), , drop = FALSE]
  if (nrow(extra)) {
    extra$time <- chords$time[extra$owner]
    extra$chord_key <- chords$key[extra$owner]
    extra$tech <- bitwOr(extra$tech, as.integer(chord_tech[extra$owner]))
    notes <- rbind(notes, extra[, names(notes)])
  }
  notes$tech <- notes$tech + TECH[["chord"]]
  list(chords = chords, notes = notes, bends = xml_bends(cn_nodes))
}

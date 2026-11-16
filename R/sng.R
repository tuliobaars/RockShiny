# -----------------------------------------------------------------------------
# sng.R -- Rocksmith 2014 compiled note charts (.sng).
#
# Official DLC ships *only* SNG (no XML), so this is the universal fallback.
# Container: u32 magic (0x4A) | u32 flags | 16-byte IV | AES-CTR payload | sig
#   decrypted payload = u32 uncompressed_length | zlib stream
# Body: a sequence of length-prefixed (u32 count) arrays of packed
# little-endian structs. Fixed-size arrays are skipped/decoded in one shot; only
# notes (variable-size because of trailing bend data) need a pointer walk.
# -----------------------------------------------------------------------------

# Struct sizes (bytes) of fixed-size SNG records.
SNG_SIZE <- c(
  beat = 16L, phrase = 44L, chord = 72L, chord_notes = 2376L, vocal = 60L,
  sym_header = 32L, sym_texture = 144L, sym_def = 44L, phrase_iter = 24L,
  phrase_extra = 16L, action = 260L, event = 260L, tone = 8L, dna = 8L,
  section = 88L, anchor = 28L, anchor_ext = 12L, fingerprint = 20L,
  note_fixed = 63L, bend_value = 12L
)

# SNG note-mask bits -> our technique bits (see chart.R: TECH).
SNG_MASK <- c(
  chord = 0x02, fret_hand_mute = 0x08, tremolo = 0x10, harmonic = 0x20,
  palm_mute = 0x40, hammer_on = 0x200, pull_off = 0x400, slide = 0x800,
  bend = 0x1000, tap = 0x4000, pinch_harmonic = 0x8000, vibrato = 0x10000,
  mute = 0x20000, ignore = 0x40000, slide_unpitched = 0x400000,
  accent = 0x4000000, link_next = 0x8000000
)

#' Decrypt + inflate an SNG file. `platform` picks the key ("mac" / "pc");
#' "auto" tries the other key if the first one does not yield a zlib stream.
#' @param data raw vector with the .sng file.
#' @param platform "pc", "mac" or "auto" (try both).
#' @export
sng_decrypt <- function(data, platform = c("auto", "mac", "pc")) {
  platform <- match.arg(platform)
  if (length(data) < 28L || le_u32(data, 0) != 0x4A) stop("Not a Rocksmith SNG file.")
  iv <- data[9:24]
  payload <- data[-(1:24)]
  keys <- switch(platform,
    mac = RS_KEYS["sng_mac"], pc = RS_KEYS["sng_pc"], auto = RS_KEYS[c("sng_pc", "sng_mac")]
  )
  for (key in keys) {
    plain <- aes_ctr_decrypt_raw(payload, hex_to_raw(key), iv)
    if (length(plain) > 6L && plain[5] == as.raw(0x78)) {
      out <- tryCatch(memDecompress(plain[-(1:4)], type = "gzip"), error = function(e) NULL)
      if (!is.null(out)) return(out)
    }
  }
  stop("Could not decrypt SNG (wrong platform key?)")
}

#' Parse a decrypted SNG body into the same intermediate structure that
#' parse_arrangement_xml() produces (see chart.R for the schema).
#' @param buf raw vector with the (decrypted) file contents.
#' @export
parse_arrangement_sng <- function(buf) {
  pos <- 0
  count <- function() { n <- le_u32(buf, pos); pos <<- pos + 4; n }
  # Return 0-based offsets of each record of a fixed-size array and advance.
  fixed_array <- function(size) {
    n <- count()
    offs <- pos + size * seq_len(n) - size
    pos <<- pos + size * n
    offs
  }

  beats  <- fixed_array(SNG_SIZE[["beat"]])
  phr    <- fixed_array(SNG_SIZE[["phrase"]])
  tmpl   <- fixed_array(SNG_SIZE[["chord"]])
  cnotes <- fixed_array(SNG_SIZE[["chord_notes"]])
  if (length(fixed_array(SNG_SIZE[["vocal"]])) > 0L) {   # symbol tables only follow vocals
    fixed_array(SNG_SIZE[["sym_header"]]); fixed_array(SNG_SIZE[["sym_texture"]]); fixed_array(SNG_SIZE[["sym_def"]])
  }
  pis <- fixed_array(SNG_SIZE[["phrase_iter"]])
  fixed_array(SNG_SIZE[["phrase_extra"]])
  for (i in seq_len(count())) { pos <- pos + 4; fixed_array(4L) }   # newLinkedDiffs
  fixed_array(SNG_SIZE[["action"]]); fixed_array(SNG_SIZE[["event"]])
  fixed_array(SNG_SIZE[["tone"]]);   fixed_array(SNG_SIZE[["dna"]])
  secs <- fixed_array(SNG_SIZE[["section"]])

  # ---- levels (one per difficulty) -----------------------------------------
  n_levels <- count()
  lvl_notes <- vector("list", n_levels)
  lvl_anchors <- vector("list", n_levels)
  lvl_bends <- vector("list", n_levels)
  for (L in seq_len(n_levels)) {
    difficulty <- le_i32(buf, pos); pos <- pos + 4
    anc <- fixed_array(SNG_SIZE[["anchor"]])
    fixed_array(SNG_SIZE[["anchor_ext"]])
    fixed_array(SNG_SIZE[["fingerprint"]]); fixed_array(SNG_SIZE[["fingerprint"]])

    n_notes <- count()
    note_off <- numeric(n_notes)
    bend_n <- numeric(n_notes)
    for (k in seq_len(n_notes)) {                        # pointer walk
      note_off[k] <- pos
      pos <- pos + SNG_SIZE[["note_fixed"]]
      bend_n[k] <- le_u32(buf, pos)
      pos <- pos + 4 + SNG_SIZE[["bend_value"]] * bend_n[k]
    }
    # single-note bend curves (BendValue: f32 time, f32 step, 4 bytes unused)
    has_b <- bend_n > 0
    bend_key <- rep(NA_character_, n_notes)
    bend_key[has_b] <- sprintf("s%.0f", note_off[has_b])          # sprintf: no "1e+05"
    boff <- rep(note_off[has_b] + SNG_SIZE[["note_fixed"]] + 4, bend_n[has_b]) +
      SNG_SIZE[["bend_value"]] * (sequence(bend_n[has_b]) - 1)
    lvl_bends[[L]] <- data.frame(key = rep(bend_key[has_b], bend_n[has_b]), time = le_f32(buf, boff),
                                 step = le_f32(buf, boff + 4), stringsAsFactors = FALSE)
    fixed_array(4L); fixed_array(4L); fixed_array(4L)   # notes-per-iteration stats

    lvl_anchors[[L]] <- data.frame(
      level = rep(difficulty, length(anc)),
      time  = le_f32(buf, anc),
      fret  = u8(buf, anc + 16),
      width = le_i32(buf, anc + 20)
    )
    o <- note_off
    lvl_notes[[L]] <- data.frame(
      level       = rep(difficulty, n_notes),
      mask        = le_u32(buf, o),
      time        = le_f32(buf, o + 12),
      string      = u8(buf, o + 16),
      fret        = u8(buf, o + 17),
      chord_id    = le_i32(buf, o + 20),
      chord_notes = le_i32(buf, o + 24),
      slide_to    = i8(buf, o + 46),
      slide_unp   = i8(buf, o + 47),
      sustain     = le_f32(buf, o + 55),
      bend        = le_f32(buf, o + 59),
      bend_key    = bend_key,
      stringsAsFactors = FALSE
    )
  }

  # ---- metadata (after the levels) ------------------------------------------
  pos <- pos + 32 + 4 + 4                                   # 4 x f64, firstBeatLength, startTime
  capo <- i8(buf, pos); pos <- pos + 1 + 32 + 2             # capo, lastConversionDateTime, part
  song_length <- le_f32(buf, pos); pos <- pos + 4
  n_tuning <- count()
  tuning <- le_i16(buf, pos + 2 * seq_len(n_tuning) - 2)

  # ---- chord templates -------------------------------------------------------
  tmpl_frets <- if (length(tmpl)) matrix(i8(buf, as.vector(outer(4:9, tmpl, "+"))), ncol = 6L, byrow = TRUE) else matrix(integer(0), 0L, 6L)
  templates <- list(name = c_string(buf, tmpl + 40, 32L), frets = tmpl_frets)

  if (!n_levels) stop("SNG contains no difficulty levels (vocals/showlights file?)")
  notes <- do.call(rbind, lvl_notes)
  cn <- sng_expand_chords(buf, notes, tmpl_frets, cnotes)

  list(
    meta = list(song_length = song_length, capo = max(capo, 0L), tuning = tuning,
                arrangement = NA_character_, source = "sng"),
    beats = data.frame(
      time    = le_f32(buf, beats),
      measure = ifelse(has_bit(le_u32(buf, beats + 12), 1), le_u16(buf, beats + 4), -1L)
    ),
    sections = data.frame(name = c_string(buf, secs, 32L), time = le_f32(buf, secs + 36),
                          number = le_i32(buf, secs + 32), stringsAsFactors = FALSE),
    phrases = data.frame(max_difficulty = le_i32(buf, phr + 4), name = c_string(buf, phr + 12, 32L), stringsAsFactors = FALSE),
    phrase_iterations = data.frame(time = le_f32(buf, pis + 4), phrase_id = le_i32(buf, pis)),
    templates = templates,
    notes = cn$notes,
    chords = cn$chords,
    anchors = do.call(rbind, lvl_anchors),
    bends = rbind(do.call(rbind, lvl_bends), cn$bends)
  )
}

#' Split SNG "notes" into single notes + chords, expanding each chord to one
#' row per fretted string using its template (frets) and, when present, its
#' chordNotes record (per-string technique masks and slides).
#' @noRd
sng_expand_chords <- function(buf, notes, tmpl_frets, cnotes) {
  is_chord <- notes$chord_id >= 0
  singles <- notes[!is_chord, , drop = FALSE]
  ch <- notes[is_chord, , drop = FALSE]

  chords <- data.frame(
    level = ch$level, time = ch$time, template = ch$chord_id,
    high_density = has_bit(ch$mask, 0x200000), stringsAsFactors = FALSE
  )
  chords$key <- seq_len(nrow(chords))

  # one candidate row per (chord, string); keep strings the template frets
  k  <- rep(seq_len(nrow(ch)), each = 6L)
  s  <- rep(0:5, times = nrow(ch))
  fr <- template_frets(tmpl_frets, ch$chord_id[k], s)
  keep <- !is.na(fr) & fr >= 0
  k <- k[keep]; s <- s[keep]; fr <- fr[keep]

  cn_id <- ch$chord_notes[k]
  cn_off <- cnotes[pmax(cn_id, 0L) + 1L]
  has_cn <- cn_id >= 0 & !is.na(cn_off)
  mask  <- ch$mask[k]
  slide <- rep(-1L, length(k)); sunp <- rep(-1L, length(k))
  if (any(has_cn)) {
    mask[has_cn]  <- le_u32(buf, cn_off[has_cn] + 4 * s[has_cn])
    slide[has_cn] <- i8(buf, cn_off[has_cn] + 2352 + s[has_cn])
    sunp[has_cn]  <- i8(buf, cn_off[has_cn] + 2358 + s[has_cn])
  }
  chord_mask <- ch$mask[k]

  chord_notes <- data.frame(
    level = ch$level[k], time = ch$time[k], string = s, fret = fr,
    sustain = ch$sustain[k], slide_to = slide, slide_unp = sunp,
    bend = rep(0, length(k)), mask = mask, chord_key = chords$key[k]   # rep(): k may be empty
  )
  # per-string bend curves from the (shared!) chordNotes record: 32 BendValues
  # + i32 used-count per string. Keys are per note row, because several chords
  # may reference the same chordNotes record.
  chord_notes$bend_key <- sprintf("c%d:%d", chords$key[k], s)
  bd <- cn_off + 24 + 388 * s                              # BendData of string s
  used <- rep(0, length(k))
  if (any(has_cn)) used[has_cn] <- pmax(0, pmin(32, le_i32(buf, bd[has_cn] + 384)))
  has_b <- used > 0
  boff <- rep(bd[has_b], used[has_b]) + 12 * (sequence(used[has_b]) - 1)
  bends <- data.frame(key = rep(chord_notes$bend_key[has_b], used[has_b]), time = le_f32(buf, boff),
                      step = le_f32(buf, boff + 4), stringsAsFactors = FALSE)
  if (nrow(bends)) {
    mx <- tapply(bends$step, bends$key, max)
    chord_notes$bend <- unname(ifelse(is.na(mx[chord_notes$bend_key]), 0, mx[chord_notes$bend_key]))
  }
  chord_notes$bend_key[!has_b] <- NA_character_

  # chord-level techniques (palm mute / fret-hand mute / accent) apply to all strings
  chord_level_bits <- c("palm_mute", "fret_hand_mute", "mute", "accent")
  for (b in chord_level_bits) {
    add <- has_bit(chord_mask, SNG_MASK[[b]]) & !has_bit(chord_notes$mask, SNG_MASK[[b]])
    chord_notes$mask[add] <- chord_notes$mask[add] + SNG_MASK[[b]]
  }

  singles$chord_key <- rep(NA_integer_, nrow(singles))                # nrow may be 0
  cols <- c("level", "time", "string", "fret", "sustain", "slide_to", "slide_unp", "bend", "mask", "chord_key", "bend_key")
  all_notes <- rbind(singles[, cols], chord_notes[, cols])
  all_notes$tech <- sng_mask_to_tech(all_notes$mask, is_chord_note = !is.na(all_notes$chord_key))
  all_notes$mask <- NULL
  list(notes = all_notes, chords = chords, bends = bends)
}

sng_mask_to_tech <- function(mask, is_chord_note) {
  tech <- integer(length(mask))
  map <- c(hammer_on = "hammer_on", pull_off = "pull_off", palm_mute = "palm_mute",
           fret_hand_mute = "fret_hand_mute", mute = "fret_hand_mute", harmonic = "harmonic",
           pinch_harmonic = "pinch_harmonic", vibrato = "vibrato", tremolo = "tremolo",
           accent = "accent", link_next = "link_next", tap = "tap", bend = "bend",
           slide = "slide", slide_unpitched = "slide_unpitched", ignore = "ignore")
  for (src in names(map)) {
    on <- has_bit(mask, SNG_MASK[[src]]) & !bitwAnd(tech, TECH[[map[[src]]]])
    tech[on] <- tech[on] + TECH[[map[[src]]]]
  }
  tech + ifelse(is_chord_note, TECH[["chord"]], 0L)
}

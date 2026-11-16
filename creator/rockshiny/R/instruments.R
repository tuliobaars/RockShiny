# -----------------------------------------------------------------------------
# instruments.R -- play a song on piano or harmonica.
#
# Rocksmith archives only chart guitar and bass (plus lyrics), so the other
# instruments are *derived* from a pitched source part:
#
#   guitar / bass arrangement --chart_pitch_events()--> (time, midi, sustain)
#   pitched vocals (melody)   --vocal_pitch_events()--> (time, midi, sustain)
#   MIDI file track (midi.R)  --midi_part_events()----> (time, midi, sustain)
#                                      |
#            +-------------------------+--------------------------+
#      events_to_piano()                                  events_to_harmonica()
#      exact pitches (+ octave),                          melody line (top note),
#      hands split at middle C                            mapped onto a 10-hole
#                                                         Richter harp: hole,
#                                                         blow/draw, bends,
#                                                         overblows; best key
#
# The result is a "lane chart" (notes carry a MIDI pitch and an instrument
# position instead of string/fret) with the source's beats, sections and chord
# names; chart_json() serialises it for inst/highway/renderer-lanes.js.
# -----------------------------------------------------------------------------

INSTRUMENT_LABELS <- c(guitar = "Guitar / bass", piano = "Piano", harmonica = "Harmonica")

OPEN_MIDI_6 <- c(40L, 45L, 50L, 55L, 59L, 64L)     # E2 A2 D3 G3 B3 E4
OPEN_MIDI_4 <- c(28L, 33L, 38L, 43L)               # E1 A1 D2 G2
# natural harmonic at fret f sounds this many semitones above the open string
HARMONIC_FRETS <- c(12L, 7L, 19L, 5L, 24L, 4L, 9L, 16L, 3L)
HARMONIC_SEMIS <- c(12L, 19L, 19L, 24L, 24L, 28L, 28L, 28L, 31L)

NOTE_NAMES <- c("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
midi_name <- function(m) paste0(NOTE_NAMES[m %% 12L + 1L], m %/% 12L - 1L)   # 60 -> "C4"

#' Sounding MIDI pitch of every note of a built guitar/bass chart (tuning,
#' capo on open strings, natural harmonics, pre-bends). Mirrors HitJudge.setChart
#' in inst/highway/input.js.
#' @param chart a chart from `song_chart()` / `build_chart()`.
#' @export
chart_note_midi <- function(chart) {
  n <- chart$notes
  m <- chart$meta
  open <- if (identical(as.integer(m$n_strings), 4L)) OPEN_MIDI_4 else OPEN_MIDI_6
  tun <- as.integer(m$tuning %||% integer(0))
  tun <- c(tun, integer(6))[1:6]
  tun[is.na(tun)] <- 0L
  s <- n$string + 1L
  base <- open[s] + tun[s]
  capo <- as.integer(m$capo %||% 0L)
  if (!length(capo) || is.na(capo)) capo <- 0L
  semis <- base + ifelse(n$fret == 0L, capo, n$fret)
  harm <- has_bit(n$tech, TECH[["harmonic"]]) & n$fret %in% HARMONIC_FRETS
  semis[harm] <- base[harm] + HARMONIC_SEMIS[match(n$fret[harm], HARMONIC_FRETS)]
  as.integer(semis)
}

empty_events <- function() data.frame(time = numeric(), midi = integer(), sustain = numeric(), chord = integer())

#' Pitched events of a guitar/bass chart: fret-hand mutes dropped, pre-bends
#' sound at their bent pitch, and a bend that is held (at least 0.9 semitones,
#' reached at least 50 ms after the onset) adds its target as a second note, so bluesy lines
#' keep their melody. Unisons at the same time are merged.
#' @param chart a chart from `song_chart()` / `build_chart()`.
#' @export
chart_pitch_events <- function(chart) {
  n <- chart$notes
  if (!nrow(n)) return(empty_events())
  midi <- chart_note_midi(chart)
  sus <- n$sustain
  extra <- empty_events()
  b <- chart$bends
  if (!is.null(b) && nrow(b)) {
    owner <- b$note + 1L                                   # 1-based note row
    rel <- b$time - n$time[owner]
    first <- !duplicated(owner)
    pre <- first & rel < 0.01 & b$step > 0
    pre_amt <- numeric(nrow(n))
    pre_amt[owner[pre]] <- b$step[pre]
    midi <- midi + as.integer(round(pre_amt))
    for (i in unique(owner)) {
      k <- which(owner == i)
      mx <- max(b$step[k])
      if (mx - pre_amt[i] < 0.9) next
      tb <- b$time[k][which(b$step[k] >= mx - 0.05)[1]]
      if (tb - n$time[i] < 0.05) next
      end <- n$time[i] + n$sustain[i]
      extra <- rbind(extra, data.frame(time = tb, midi = midi[i] - as.integer(round(pre_amt[i])) + as.integer(round(mx)),
                                       sustain = max(0, end - tb), chord = -1L))
      sus[i] <- max(0, tb - n$time[i] - 0.01)
    }
  }
  ev <- data.frame(time = n$time, midi = midi, sustain = sus, chord = as.integer(n$chord))
  ev <- ev[!has_bit(n$tech, TECH[["fret_hand_mute"]]), , drop = FALSE]
  dedupe_events(rbind(ev, extra))
}

#' Sort by (time, pitch) and merge unisons at the same instant (longest sustain wins).
#' @noRd
dedupe_events <- function(ev) {
  if (!nrow(ev)) return(ev)
  ev <- ev[order(ev$time, ev$midi, -ev$sustain), , drop = FALSE]
  slot <- cumsum(c(TRUE, diff(ev$time) > 0.002))          # same instant (+/- 2 ms)
  ev <- ev[!duplicated(paste(slot, ev$midi)), , drop = FALSE]
  rownames(ev) <- NULL
  ev
}

#' Pitched vocal notes (Rocksmith marks unpitched syllables with note 254).
#' @param v raw vocals: data.frame(time, length, lyric, note).
#' @export
vocal_pitch_events <- function(v) {
  if (is.null(v) || !nrow(v) || is.null(v$note)) return(empty_events())
  v <- v[!is.na(v$note) & v$note > 0 & v$note < 128, , drop = FALSE]
  # (rep(): a scalar column would make data.frame() fail when no syllable is pitched)
  dedupe_events(data.frame(time = v$time, midi = as.integer(v$note), sustain = pmax(0, v$length),
                           chord = rep(-1L, nrow(v))))
}

# ---- piano ---------------------------------------------------------------------------------

#' Keyboard range to draw: whole octaves from the C at/below the lowest note to
#' the C above the highest, at least two octaves, within A0..C8.
#' @noRd
piano_range <- function(midi) {
  if (!length(midi)) return(c(48L, 72L))
  lo <- 12L * (min(midi) %/% 12L)
  hi <- 12L * (max(midi) %/% 12L + 1L)
  if (hi - lo < 24L) hi <- lo + 24L
  c(max(21L, lo), min(108L, hi))
}

#' Piano part: exact pitches, shifted by `octave` octaves, left hand below `split`.
#' @param src the source chart (for beats, sections and metadata).
#' @param ev pitched events (`chart_pitch_events()`, `vocal_pitch_events()`).
#' @param octave transpose by this many octaves.
#' @param split MIDI pitch that splits the left and right hand.
#' @export
events_to_piano <- function(src, ev, octave = 0L, split = 60L) {
  ev$midi <- ev$midi + 12L * as.integer(octave)
  ev <- ev[ev$midi >= 21L & ev$midi <= 108L, , drop = FALSE]
  ev$hand <- as.integer(ev$midi >= split)                # 1 = right hand
  rng <- piano_range(ev$midi)
  lane_chart(src, ev, "piano", list(
    piano_octave = as.integer(octave), range_lo = rng[1], range_hi = rng[2],
    instrument_tag = sprintf("Keys %s\u2013%s", midi_name(rng[1]), midi_name(rng[2]))
  ))
}

# ---- harmonica -----------------------------------------------------------------------------

#' Harmonica keys: semitones from C (G..B harps are pitched below C, Db..F# above).
#' @noRd
HARP_KEYS <- stats::setNames(-5:6, c("G", "Ab", "A", "Bb", "B", "C", "Db", "D", "Eb", "E", "F", "F#"))

#' Every note a 10-hole Richter harmonica in `key` can play:
#' data.frame(midi, hole, blow (1 = blow, 0 = draw), bend (semitones), ob
#' (1 = overblow / overdraw), cost (difficulty: 0 natural ... 3 overblow)).
#' @param key harp key, e.g. "C".
#' @export
harp_layout <- function(key = "C") {
  off <- HARP_KEYS[[key]]
  blow <- c(60L, 64L, 67L, 72L, 76L, 79L, 84L, 88L, 91L, 96L)   # C harp
  draw <- c(62L, 67L, 71L, 74L, 77L, 81L, 83L, 86L, 89L, 93L)
  rows <- list(data.frame(midi = blow, hole = 1:10, blow = 1L, bend = 0L, ob = 0L, cost = 0),
               data.frame(midi = draw, hole = 1:10, blow = 0L, bend = 0L, ob = 0L, cost = 0))
  for (h in 1:10) {
    hi <- max(blow[h], draw[h]); lo <- min(blow[h], draw[h])
    k <- seq_len(hi - lo - 1L)                          # bends: the higher reed bends down
    if (length(k)) rows[[length(rows) + 1L]] <- data.frame(midi = hi - k, hole = h, blow = as.integer(blow[h] > draw[h]),
                                                           bend = k, ob = 0L, cost = 0.6 + 0.4 * k)
  }
  # overblows (holes 1, 4, 5, 6) and overdraws (7, 9, 10): one semitone above the higher reed
  ob <- c(1L, 4L, 5L, 6L); od <- c(7L, 9L, 10L)
  rows[[length(rows) + 1L]] <- data.frame(midi = draw[ob] + 1L, hole = ob, blow = 1L, bend = 0L, ob = 1L, cost = 3)
  rows[[length(rows) + 1L]] <- data.frame(midi = blow[od] + 1L, hole = od, blow = 0L, bend = 0L, ob = 1L, cost = 3)
  lay <- do.call(rbind, rows)
  lay$midi <- lay$midi + off
  lay <- lay[order(lay$midi, lay$cost, lay$hole), , drop = FALSE]
  rownames(lay) <- NULL
  lay
}

UNPLAYABLE_COST <- 10

#' Melody line: the top note of every chord; each note ends where the next
#' begins. `min_gap` (s) thins runs faster than a wind player can articulate
#' (a note is kept only if it starts >= min_gap after the previous kept one).
#' @noRd
melody_line <- function(ev, min_gap = 0) {
  if (!nrow(ev)) return(ev)
  ev <- ev[order(ev$time, -ev$midi), , drop = FALSE]
  slot <- cumsum(c(TRUE, diff(ev$time) > 0.002))
  ev <- ev[!duplicated(slot), , drop = FALSE]
  if (min_gap > 0 && nrow(ev) > 1L) {
    keep <- logical(nrow(ev)); last <- -Inf
    for (i in seq_len(nrow(ev))) if (ev$time[i] - last >= min_gap) { keep[i] <- TRUE; last <- ev$time[i] }
    ev <- ev[keep, , drop = FALSE]
  }
  nxt <- c(ev$time[-1], Inf)
  ev$sustain <- pmax(0, pmin(ev$sustain, nxt - ev$time - 0.02))
  ev$chord <- -1L
  rownames(ev) <- NULL
  ev
}

#' Best harmonica key and octave shift for a melody: the lowest total
#' difficulty (natural notes free, bends cheap, overblows dear, unplayable
#' notes very dear). `key` fixes the key ("auto" tries all 12).
#' @param midi MIDI pitches of the part.
#' @param key harp key, or "auto" to choose the best one.
#' @return list(key, octave, cost, unplayable)
#' @export
harp_choose <- function(midi, key = "auto") {
  keys <- if (identical(key, "auto")) names(HARP_KEYS) else key
  u <- sort(unique(midi))
  w <- tabulate(match(midi, u), length(u))                  # occurrences of each pitch
  best <- NULL
  for (k in keys) {
    lay <- harp_layout(k)
    cheapest <- tapply(lay$cost, lay$midi, min)
    for (oct in -3:3) {
      m <- u + 12L * oct
      cost <- cheapest[as.character(m)]
      cost[is.na(cost)] <- UNPLAYABLE_COST
      total <- sum(cost * w)
      bad <- sum(w[cost >= UNPLAYABLE_COST])
      # ties: fewer unplayable notes, then no transposition, then the familiar C harp
      score <- c(total, bad, abs(oct), abs(HARP_KEYS[[k]]))
      if (is.null(best) || compare_lex(score, best$score) < 0) {
        best <- list(key = k, octave = oct, cost = total, unplayable = bad, score = score)
      }
    }
  }
  best$score <- NULL
  best
}

compare_lex <- function(a, b) {
  d <- which(a != b)
  if (!length(d)) 0 else sign(a[d[1]] - b[d[1]])
}

#' Assign every (playable) note a hole / breath: cheapest technique plus
#' as little hand movement as possible (Viterbi over the options per note).
#' @return `ev` with hole, blow, bend, ob; unplayable notes removed.
#' @noRd
harp_assign <- function(ev, lay) {
  opts <- lapply(ev$midi, function(p) which(lay$midi == p))
  ok <- lengths(opts) > 0L
  ev <- ev[ok, , drop = FALSE]; opts <- opts[ok]
  n <- nrow(ev)
  if (!n) return(cbind(ev, hole = integer(0), blow = integer(0), bend = integer(0), ob = integer(0)))
  move <- 0.15                                               # cost per hole of hand movement
  cost <- list(lay$cost[opts[[1]]]); back <- list(integer(length(opts[[1]])))
  for (i in seq_len(n)[-1]) {
    prev <- opts[[i - 1L]]; cur <- opts[[i]]
    trans <- outer(cost[[i - 1L]], rep(0, length(cur)), "+") + move * abs(outer(lay$hole[prev], lay$hole[cur], "-"))
    back[[i]] <- apply(trans, 2L, which.min)
    cost[[i]] <- trans[cbind(back[[i]], seq_along(cur))] + lay$cost[cur]
  }
  pick <- integer(n)
  pick[n] <- which.min(cost[[n]])
  for (i in rev(seq_len(n - 1L))) pick[i] <- back[[i + 1L]][pick[i + 1L]]
  row <- vapply(seq_len(n), function(i) opts[[i]][pick[i]], integer(1))
  ev$hole <- lay$hole[row]; ev$blow <- lay$blow[row]; ev$bend <- lay$bend[row]; ev$ob <- lay$ob[row]
  ev
}

HARP_MIN_GAP <- 0.09   # s: ~11 notes / s, about the fastest clean articulation on a harmonica

#' Harmonica part: the melody line mapped onto a Richter harp (key chosen
#' automatically unless given; octaves shifted to fit). Runs faster than
#' HARP_MIN_GAP are thinned; notes the harp cannot play are left out (both
#' counted in meta: harp_thinned, harp_dropped).
#' @param src the source chart (for beats, sections and metadata).
#' @param ev pitched events (`chart_pitch_events()`, `vocal_pitch_events()`).
#' @param key harp key ("C", "G", ...) or "auto".
#' @export
events_to_harmonica <- function(src, ev, key = "auto") {
  full <- melody_line(ev)
  mel <- melody_line(ev, min_gap = HARP_MIN_GAP)
  ch <- if (nrow(mel)) harp_choose(mel$midi, key) else list(key = if (identical(key, "auto")) "C" else key, octave = 0L, unplayable = 0)
  mel$midi <- mel$midi + 12L * as.integer(ch$octave)
  lay <- harp_layout(ch$key)
  out <- harp_assign(mel, lay)
  lane_chart(src, out, "harmonica", list(
    harp_key = ch$key, harp_octave = as.integer(ch$octave), harp_dropped = nrow(mel) - nrow(out),
    harp_thinned = nrow(full) - nrow(mel),
    harp_auto = identical(key, "auto"), instrument_tag = sprintf("Key of %s", ch$key)
  ))
}

# ---- lane chart --------------------------------------------------------------------------

#' Assemble a lane chart from pitched events and the source chart's timeline.
#' `src` needs meta, beats, sections and chords (data.frame(time, name, high_density)).
#' @noRd
lane_chart <- function(src, ev, instrument, meta_extra = list()) {
  meta <- src$meta
  meta[c("tuning", "capo", "cent_offset", "n_strings", "tuning_name", "max_fret", "is_bass")] <- NULL
  meta$instrument <- instrument
  meta$source_arrangement <- meta$arrangement %||% ""
  lab <- INSTRUMENT_LABELS[[instrument]]
  src_lab <- meta$arrangement %||% ""
  meta$arrangement <- if (startsWith(src_lab, lab)) src_lab else sprintf("%s \u00b7 %s", lab, src_lab)
  meta$n_notes <- nrow(ev)
  if (nrow(ev)) meta$lowest_midi <- min(ev$midi)
  meta <- utils::modifyList(meta, meta_extra)
  ev <- ev[order(ev$time, ev$midi), , drop = FALSE]
  rownames(ev) <- NULL
  chords <- src$chords %||% data.frame(time = numeric(), name = character(), high_density = logical())
  list(instrument = instrument, meta = meta, notes = ev, chords = chords,
       beats = src$beats, sections = src$sections, bends = NULL)
}

#' Convert a chart (or pitched events with the chart's timeline) to `instrument`.
#' @param ev pitched events; default: the chart's own notes (chart_pitch_events).
#' @param chart a chart from `song_chart()` / `build_chart()`.
#' @param instrument "guitar", "piano" or "harmonica".
#' @param octave piano: transpose by octaves.
#' @param harp_key harmonica key or "auto".
#' @export
chart_for_instrument <- function(chart, instrument = c("guitar", "piano", "harmonica"), ev = NULL,
                                 octave = 0L, harp_key = "auto") {
  instrument <- match.arg(instrument)
  if (instrument == "guitar") return(chart)
  if (is.null(ev)) ev <- chart_pitch_events(chart)
  if (instrument == "piano") events_to_piano(chart, ev, octave = octave)
  else events_to_harmonica(chart, ev, key = harp_key)
}

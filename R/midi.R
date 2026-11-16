# -----------------------------------------------------------------------------
# midi.R -- Standard MIDI Files (.mid / .midi) as songs for piano / harmonica.
#
#   read_midi()        header, tracks, running status, meta/sysex events,
#                      tempo map (ticks -> seconds), time signatures, markers
#   midi_parts()       one playable part per (track, channel) with notes
#                      (drums on channel 10 are skipped)
#   load_midi_song()   an rs_song (kind = "midi") -- same interface as a .psarc
#   midi_part_events() (time, midi, sustain) of one part -> instruments.R
#
# Beats come from the time signatures, sections from marker / cue-point
# events (or one every 8 bars). MIDI has no recording: the browser can play
# the part with guide tones (inst/highway/guide.js).
# -----------------------------------------------------------------------------

MIDI_FAMILIES <- c("Piano", "Chromatic percussion", "Organ", "Guitar", "Bass", "Strings", "Ensemble", "Brass",
                   "Reed", "Pipe", "Synth lead", "Synth pad", "Synth effects", "Ethnic", "Percussive", "Sound effects")
MIDI_HARMONICA <- 22L                                     # General MIDI program 23 (0-based 22)

#' Parse a Standard MIDI File (path or raw vector).
#' @param x path of a Standard MIDI File, or its bytes as a raw vector.
#' @return list(format, division, tracks = list(list(name, notes, meta)), tempos,
#'   time_sigs, markers, length (s), seconds = function(tick))
#' @export
read_midi <- function(x) {
  buf <- if (is.raw(x)) x else readBin(x, "raw", n = file.info(x)$size)
  b <- as.integer(buf)
  nb <- length(b)
  be <- function(pos, n) sum(b[pos + seq_len(n)] * 256^((n - 1):0))      # pos: 0-based
  is_id <- function(pos, id) pos + 4 <= nb && identical(b[pos + 1:4], as.integer(charToRaw(id)))
  if (nb < 14 || !is_id(0, "MThd")) stop("Not a Standard MIDI File (no MThd header).")
  fmt <- be(8, 2); ntrk <- be(10, 2); division <- be(12, 2)
  pos <- 8 + be(4, 4)
  tracks <- list()
  while (pos + 8 <= nb && length(tracks) < ntrk) {
    len <- be(pos + 4, 4)
    if (is_id(pos, "MTrk")) tracks[[length(tracks) + 1L]] <- midi_parse_track(b, pos + 8, min(nb, pos + 8 + len))
    pos <- pos + 8 + len                                  # unknown chunks are skipped
  }
  if (!length(tracks)) stop("The MIDI file has no tracks.")
  
  metas <- do.call(rbind, lapply(tracks, function(tr) tr$meta))
  seconds <- midi_clock(metas, division)
  end_tick <- max(vapply(tracks, function(tr) tr$end_tick, numeric(1)))
  tracks <- lapply(tracks, function(tr) {
    notes <- midi_pair_notes(tr$events, tr$end_tick)
    notes$time <- seconds(notes$start)
    notes$sustain <- seconds(notes$end) - notes$time
    names <- tr$meta$text[tr$meta$type == 3L]
    list(name = if (length(names)) trimws(names[1]) else "", notes = notes,
         programs = tr$events[tr$events$type == 12L, c("tick", "ch", "d1"), drop = FALSE])
  })
  ts <- metas[metas$type == 88L, , drop = FALSE]
  mk <- metas[metas$type %in% c(6L, 7L) & nzchar(trimws(metas$text)), , drop = FALSE]
  list(format = fmt, division = division, tracks = tracks, seconds = seconds, end_tick = end_tick,
       length = seconds(end_tick),
       time_sigs = data.frame(tick = ts$tick, nn = ts$v1, dd = ts$v2),
       markers = data.frame(time = seconds(mk$tick), text = trimws(mk$text), stringsAsFactors = FALSE))
}

#' One MTrk chunk -> channel events data.frame(tick, type (status high nibble),
#' ch, d1, d2) + meta events data.frame(tick, type, v1, v2, text).
#' @noRd
midi_parse_track <- function(b, start, end) {
  cap <- max(64L, (end - start) %/% 2L)
  tick <- numeric(cap); type <- integer(cap); ch <- integer(cap); d1 <- integer(cap); d2 <- integer(cap)
  n <- 0L
  m_tick <- numeric(0); m_type <- integer(0); m_v1 <- numeric(0); m_v2 <- numeric(0); m_text <- character(0)
  pos <- start; t <- 0; status <- 0L
  vlq <- function() {                                      # variable-length quantity at pos
    v <- 0
    repeat {
      byte <- b[pos + 1L]; pos <<- pos + 1L
      v <- v * 128 + byte %% 128L
      if (byte < 128L || pos >= end) break
    }
    v
  }
  while (pos < end) {
    t <- t + vlq()
    if (pos >= end) break
    byte <- b[pos + 1L]
    if (byte >= 128L) { st <- byte; pos <- pos + 1L } else {
      if (status == 0L) stop("Corrupt MIDI track (data byte without a status byte).")
      st <- status                                         # running status
    }
    if (st == 255L) {                                      # meta event
      mt <- b[pos + 1L]; pos <- pos + 1L
      len <- vlq()
      data <- b[pos + seq_len(min(len, end - pos))]
      pos <- pos + len
      v1 <- NA_real_; v2 <- NA_real_; txt <- ""
      if (mt == 81L && length(data) >= 3L) v1 <- sum(data[1:3] * c(65536, 256, 1))        # tempo (us / quarter)
      else if (mt == 88L && length(data) >= 2L) { v1 <- data[1]; v2 <- 2^data[2] }        # time signature
      else if (mt >= 1L && mt <= 7L) txt <- midi_text(data)
      if (mt == 47L) break                                 # end of track
      m_tick <- c(m_tick, t); m_type <- c(m_type, mt); m_v1 <- c(m_v1, v1); m_v2 <- c(m_v2, v2); m_text <- c(m_text, txt)
    } else if (st == 240L || st == 247L) {                 # sysex: skip
      pos <- pos + vlq()
    } else if (st >= 128L && st < 240L) {                  # channel message
      status <- st
      hi <- st %/% 16L
      nd <- if (hi == 12L || hi == 13L) 1L else 2L
      if (pos + nd > end) break
      n <- n + 1L
      if (n > cap) {                                       # grow (rare: estimate is generous)
        cap <- 2L * cap
        length(tick) <- cap; length(type) <- cap; length(ch) <- cap; length(d1) <- cap; length(d2) <- cap
      }
      tick[n] <- t; type[n] <- hi; ch[n] <- st %% 16L; d1[n] <- b[pos + 1L]
      d2[n] <- if (nd == 2L) b[pos + 2L] else 0L
      pos <- pos + nd
    } else break                                           # system common/real-time: not in files
  }
  s <- seq_len(n)
  list(events = data.frame(tick = tick[s], type = type[s], ch = ch[s], d1 = d1[s], d2 = d2[s]),
       meta = data.frame(tick = m_tick, type = m_type, v1 = m_v1, v2 = m_v2, text = m_text, stringsAsFactors = FALSE),
       end_tick = t)
}

#' Text meta event bytes -> UTF-8 (Latin-1 fallback; NULs dropped).
#' @noRd
midi_text <- function(data) {
  data <- data[data != 0L]
  if (!length(data)) return("")
  s <- rawToChar(as.raw(data))
  if (!validUTF8(s)) s <- iconv(s, "latin1", "UTF-8")
  Encoding(s) <- "UTF-8"
  s
}

#' Tempo map -> function(tick) seconds. SMPTE divisions use fixed frames.
#' @noRd
midi_clock <- function(metas, division) {
  if (division >= 32768) {                                 # SMPTE: -fps (high byte), ticks per frame
    fps <- 256 - division %/% 256
    if (fps == 29) fps <- 29.97
    tpf <- division %% 256
    return(function(tick) tick / (fps * tpf))
  }
  tp <- metas[metas$type == 81L & !is.na(metas$v1) & metas$v1 > 0, , drop = FALSE]
  tp <- tp[order(tp$tick), , drop = FALSE]
  tp <- tp[!duplicated(tp$tick, fromLast = TRUE), , drop = FALSE]   # last tempo at a tick wins
  tt <- c(0, tp$tick); us <- c(500000, tp$v1)                        # default 120 bpm until the first
  keep <- !duplicated(tt, fromLast = TRUE)
  tt <- tt[keep]; us <- us[keep]
  sec_at <- c(0, cumsum(diff(tt) * us[-length(us)] / (1e6 * division)))
  function(tick) {
    i <- findInterval(tick, tt)
    sec_at[i] + (tick - tt[i]) * us[i] / (1e6 * division)
  }
}

#' Pair note-ons with note-offs (velocity-0 note-ons are offs) first-in,
#' first-out per channel and key; notes still on at the end of the track end there.
#' @noRd
midi_pair_notes <- function(ev, end_tick) {
  on <- ev$type == 9L & ev$d2 > 0L
  off <- ev$type == 8L | (ev$type == 9L & ev$d2 == 0L)
  pending <- vector("list", 16L * 128L)
  out <- 0L
  s_tick <- numeric(sum(on)); s_end <- numeric(sum(on)); s_key <- integer(sum(on)); s_ch <- integer(sum(on)); s_vel <- integer(sum(on))
  for (i in which(on | off)) {
    k <- ev$ch[i] * 128L + ev$d1[i] + 1L
    if (on[i]) {
      out <- out + 1L
      s_tick[out] <- ev$tick[i]; s_end[out] <- NA; s_key[out] <- ev$d1[i]; s_ch[out] <- ev$ch[i]; s_vel[out] <- ev$d2[i]
      pending[[k]] <- c(pending[[k]], out)
    } else if (length(pending[[k]])) {
      s_end[pending[[k]][1]] <- ev$tick[i]
      pending[[k]] <- pending[[k]][-1]
    }
  }
  s_end[is.na(s_end)] <- end_tick
  notes <- data.frame(start = s_tick, end = s_end, midi = s_key, channel = s_ch, velocity = s_vel)
  notes[order(notes$start, notes$midi), , drop = FALSE]
}

#' Playable parts: one per (track, channel) with >= 4 notes, drums (channel 10) excluded.
#' @param mid a MIDI file read by `read_midi()`.
#' @return data.frame(id, label, name, track, channel, program, n_notes, instrument, family);
#'   with >= 2 piano parts, a first row "piano_all" (track 0) plays them together.
#' @export
midi_parts <- function(mid) {
  rows <- list()
  for (ti in seq_along(mid$tracks)) {
    tr <- mid$tracks[[ti]]
    chans <- sort(unique(tr$notes$channel))
    for (chn in setdiff(chans, 9L)) {
      nn <- sum(tr$notes$channel == chn)
      if (nn < 4L) next
      pg <- tr$programs$d1[tr$programs$ch == chn]
      if (!length(pg)) {                                   # program set on another track (format 1)
        all_pg <- do.call(rbind, lapply(mid$tracks, function(x) x$programs))
        pg <- all_pg$d1[all_pg$ch == chn]
      }
      prog <- if (length(pg)) pg[1] else 0L
      fam <- if (prog == MIDI_HARMONICA) "Harmonica" else MIDI_FAMILIES[prog %/% 8L + 1L]
      name <- if (nzchar(tr$name)) tr$name else fam
      rows[[length(rows) + 1L]] <- data.frame(
        id = sprintf("t%dc%d", ti, chn + 1L), name = name, track = ti, channel = chn + 1L, program = prog,
        n_notes = nn, instrument = if (prog == MIDI_HARMONICA) "harmonica" else "piano", family = fam,
        stringsAsFactors = FALSE)
    }
  }
  if (!length(rows)) return(data.frame(id = character(), label = character(), name = character(), track = integer(),
                                       channel = integer(), program = integer(), n_notes = integer(),
                                       instrument = character(), family = character(), stringsAsFactors = FALSE))
  df <- do.call(rbind, rows)
  multi <- df$track %in% df$track[duplicated(df$track)]
  df$name[multi] <- sprintf("%s (ch %d)", df$name[multi], df$channel[multi])
  # piano family first, then the busiest parts
  df <- df[order(df$family != "Piano", -df$n_notes), , drop = FALSE]
  # several piano parts (e.g. one track per hand): offer them together, first
  pianos <- df$family == "Piano"
  if (sum(pianos) >= 2L) {
    all <- df[which(pianos)[1], , drop = FALSE]
    all$id <- "piano_all"; all$name <- "Piano (all parts)"; all$track <- 0L; all$channel <- 0L
    all$n_notes <- sum(df$n_notes[pianos])
    df <- rbind(all, df)
  }
  df$label <- make_unique_labels(df$name)
  rownames(df) <- NULL
  df
}

#' (time, midi, sustain) of one part (track 0 = every piano-family part together).
#' @param mid a MIDI file read by `read_midi()`.
#' @param part a part (track/channel) from `midi_parts()`.
#' @export
midi_part_events <- function(mid, part) {
  if (part$track == 0L) {
    parts <- midi_parts(mid)
    parts <- parts[parts$family == "Piano" & parts$track > 0L, , drop = FALSE]
    return(dedupe_events(do.call(rbind, lapply(seq_len(nrow(parts)), function(k) midi_part_events(mid, parts[k, ])))))
  }
  tr <- mid$tracks[[part$track]]
  nt <- tr$notes[tr$notes$channel == part$channel - 1L, , drop = FALSE]
  dedupe_events(data.frame(time = nt$time, midi = as.integer(nt$midi), sustain = pmax(0, nt$sustain),
                           chord = rep(-1L, nrow(nt))))
}

#' Beat grid from the time signatures (measure = bar number on downbeats, else -1).
#' @noRd
midi_beats <- function(mid) {
  ts <- mid$time_sigs
  ts <- ts[order(ts$tick), , drop = FALSE]
  ts <- ts[!duplicated(ts$tick, fromLast = TRUE), , drop = FALSE]
  if (!nrow(ts) || ts$tick[1] > 0) ts <- rbind(data.frame(tick = 0, nn = 4, dd = 4), ts)
  if (mid$division >= 32768) return(data.frame(time = numeric(), measure = integer()))
  ticks <- numeric(0); down <- logical(0)
  for (j in seq_len(nrow(ts))) {
    s0 <- ts$tick[j]
    s1 <- if (j < nrow(ts)) ts$tick[j + 1L] else mid$end_tick + 1
    step <- mid$division * 4 / ts$dd[j]
    if (s1 <= s0 || step <= 0) next
    tk <- seq(s0, s1 - 1e-9, by = step)
    ticks <- c(ticks, tk)
    down <- c(down, (seq_along(tk) - 1L) %% max(1, ts$nn[j]) == 0L)
  }
  data.frame(time = mid$seconds(ticks), measure = ifelse(down, cumsum(down), -1L))
}

#' Sections from marker / cue-point events, else one "Part" every 8 bars.
#' @noRd
midi_sections <- function(mid, beats) {
  mk <- mid$markers
  if (nrow(mk)) {
    key <- tolower(gsub("[^A-Za-z]+", "", mk$text))
    key[!nzchar(key)] <- "part"
    sec <- data.frame(name = key, time = mk$time, stringsAsFactors = FALSE)
  } else {
    bars <- beats$time[beats$measure > 0 & (beats$measure - 1L) %% 8L == 0L]
    if (!length(bars)) bars <- 0
    sec <- data.frame(name = rep("part", length(bars)), time = bars, stringsAsFactors = FALSE)
  }
  section_labels(sec[order(sec$time), , drop = FALSE])
}

#' Open a .mid as an rs_song (kind "midi"): parts act as arrangements.
#' @param path path of the MIDI file.
#' @param display_name name shown in messages (uploads arrive with a temporary path).
#' @export
load_midi_song <- function(path, display_name = basename(path)) {
  mid <- read_midi(path)
  parts <- midi_parts(mid)
  if (!nrow(parts)) stop("No melodic notes in ", display_name)
  beats <- midi_beats(mid)
  title <- gsub("[_]+", " ", tools::file_path_sans_ext(display_name))
  structure(list(
    key = unname(tools::md5sum(path)), name = display_name, path = normalizePath(path, winslash = "/", mustWork = FALSE),
    kind = "midi", arc = NULL, midi = mid,
    cache_dir = NULL, arrangements = parts, beats = beats, sections = midi_sections(mid, beats),
    meta = list(title = title, artist = NA, album = NA, year = NA, song_length = mid$length)
  ), class = "rs_song")
}

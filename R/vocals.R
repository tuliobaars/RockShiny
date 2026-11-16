# -----------------------------------------------------------------------------
# vocals.R -- lyrics (songs/arr/*_vocals.xml, or the vocals .sng).
#
# Each <vocal> is one syllable: time, length, lyric. Rocksmith conventions:
#   "word+"  last syllable of a display line
#   "syl-"   syllable continues into the next one (no space), e.g. "le-" "gend"
# The game shows the current line at the top of the screen, highlighting the
# syllable being sung, with the next line underneath.
# -----------------------------------------------------------------------------

#' Parse a vocals XML (lyrics): data.frame(time, length, lyric, note).
#' @param x vocals XML: raw vector, string or file path.
#' @export
parse_vocals_xml <- function(x) {
  v <- xml2::xml_find_all(xml2::read_xml(x), "/vocals/vocal")
  data.frame(time = xml_num(v, "time"), length = xml_num(v, "length", 0),
             lyric = xml2::xml_attr(v, "lyric"), note = xml_num(v, "note", 254),
             stringsAsFactors = FALSE)
}

#' Vocals SNG: the lyrics are the 5th array (beats, phrases, chords and
#' chordNotes are present but empty); record = f32 time, i32 note, f32 length,
#' `char[48]` lyric.
#' @param buf raw vector with the (decrypted) file contents.
#' @export
parse_vocals_sng <- function(buf) {
  pos <- 0
  for (size in c(16, 44, 72, 2376)) pos <- pos + 4 + size * le_u32(buf, pos)
  n <- le_u32(buf, pos)
  off <- pos + 4 + 60 * (seq_len(n) - 1)
  data.frame(time = le_f32(buf, off), length = le_f32(buf, off + 8),
             lyric = c_string(buf, off + 12, 48L), note = le_i32(buf, off + 4), stringsAsFactors = FALSE)
}

#' Split syllables into display lines. Uses the "+" markers; charts without
#' them (or with lines of more than 14 words between them) are broken at pauses
#' longer than 1.2 s or after 8 words.
#' @param v raw vocals: data.frame(time, length, lyric, note).
#' @return data.frame(time, length, text, join, line) -- `join` = no space
#'   before the next syllable; `line` = 0-based line index.
#' @export
vocals_lines <- function(v) {
  v <- v[order(v$time), , drop = FALSE]
  n <- nrow(v)
  raw <- v$lyric
  raw[is.na(raw)] <- ""
  ends <- grepl("\\+$", raw)
  text <- sub("\\+$", "", raw)
  join <- grepl("-$", text)
  text <- sub("-$", "", text)
  if (n) {
    # charts without "+" markers -- or with too few (a line of more than 14 words, e.g. a
    # single "+" at the very end) -- are broken at pauses > 1.2 s or after 8 words
    gap <- c(v$time[-1] - (v$time[-n] + v$length[-n]), Inf)
    seg <- c(0L, cumsum(ends)[-n])
    long <- tapply(!join, seg, sum) > 14L
    redo <- !any(ends) | long[as.character(seg)]
    words <- 0L
    for (i in seq_len(n)) {
      if (!redo[i]) { words <- 0L; next }
      if (!join[i]) words <- words + 1L
      if (gap[i] > 1.2 || (words >= 8L && !join[i])) { ends[i] <- TRUE; words <- 0L }
    }
  }
  line <- if (n) c(0L, cumsum(ends)[-n]) else integer(0)
  data.frame(time = v$time, length = v$length, text = text, join = join, line = as.integer(line),
             stringsAsFactors = FALSE)
}

#' Lyrics for a song (NULL if it has none). Prefers the XML, falls back to the
#' SNG; skips Japanese "jvocals" when regular vocals exist.
#' @param song a song from `load_song()` (or `load_karaoke_song()`).
#' @export
song_vocals <- function(song) {
  v <- song_vocals_raw(song)
  if (is.null(v) || !nrow(v)) return(NULL)
  vocals_lines(v)
}

#' Raw vocals (time, length, lyric, note) of a song, or NULL.
#' @noRd
song_vocals_raw <- function(song) {
  if (is.null(song$arc)) return(NULL)                     # MIDI songs
  files <- song$arc$entries$name
  pick <- function(pattern) {
    f <- files[grepl(pattern, files)]
    f[order(grepl("jvocals", f))][1]
  }
  xml <- pick("^songs/arr/.*vocals\\.xml$")
  sng <- pick("^songs/bin/.*vocals\\.sng$")
  v <- tryCatch(
    if (!is.na(xml)) parse_vocals_xml(psarc_read(song$arc, xml))
    else if (!is.na(sng)) parse_vocals_sng(sng_decrypt(psarc_read(song$arc, sng)))
    else NULL,
    error = function(e) NULL
  )
  if (is.null(v) || !nrow(v)) return(NULL)
  v
}

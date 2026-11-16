# -----------------------------------------------------------------------------
# creator_package.R -- Rocksmith packages on the R side: write a .psarc from
# files (the counterpart of RockShiny's psarc_open()/psarc_read()), read all of
# an archive's files, and check a package with RockShiny's own readers.
#
# The studio builds packages in the browser (creator/inst/engine); R keeps them,
# checks them, and can (re)pack archives itself for scripts:
#
#   files <- creator_psarc_files("songs/Dire-Straits_Sultans-of-Swing_v443_m.psarc")
#   files[["toolkit.version"]] <- charToRaw("...")
#   creator_psarc_write(files, "out_m.psarc")
#   creator_validate("out_m.psarc")
# -----------------------------------------------------------------------------

#' All files of an archive: a named list of raw vectors (archive order).
#' @param path a .psarc file.
#' @export
creator_psarc_files <- function(path) {
  arc <- psarc_open(path)
  stats::setNames(lapply(arc$entries$name, function(n) psarc_read(arc, n)), arc$entries$name)
}

#' AES-CFB128 encryption (the PSARC table of contents), from the same single-block
#' primitive as RockShiny's decryption (crypto.R): C_i = P_i XOR E_k(C_{i-1}).
#' @noRd
aes_cfb128_encrypt <- function(data, key, iv) {
  n <- length(data)
  if (n == 0L) return(raw(0))
  out <- raw(n)
  prev <- iv
  for (start in seq(1L, n, by = 16L)) {
    idx <- start:min(start + 15L, n)
    ks <- aes_encrypt_block(prev, key)
    out[idx] <- xor(data[idx], ks[seq_along(idx)])
    if (length(idx) == 16L) prev <- out[idx]
  }
  out
}

#' Big-endian bytes of unsigned integers (`width` bytes each).
#' @noRd
be_bytes <- function(x, width) {
  x <- as.numeric(x)
  as.raw(unlist(lapply(x, function(v) (v %/% 256^((width - 1):0)) %% 256)))
}

#' Write a Rocksmith 2014 .psarc.
#'
#' The layout RockShiny's psarc_open() reads: "PSAR" 1.4 zlib, 30-byte entries, 64 KiB
#' blocks, the table of contents encrypted (AES-256-CFB), entry 0 = the file names.
#' Blocks are zlib-compressed unless that does not make them smaller (then stored raw);
#' .wem audio is stored raw, as the toolkit does.
#' @param files named list of raw vectors (names = paths inside the archive), in order.
#' @param file output path.
#' @return `file`, invisibly.
#' @export
creator_psarc_write <- function(files, file) {
  stopifnot(is.list(files), length(names(files)) == length(files), all(nzchar(names(files))))
  block <- 65536
  names_raw <- charToRaw(enc2utf8(paste(names(files), collapse = "\n")))
  all <- c(list(names_raw), unname(files))
  compress <- c(TRUE, !grepl("\\.wem$", names(files), ignore.case = TRUE))
  zlen <- integer(0); blobs <- list(); meta <- vector("list", length(all))
  for (i in seq_along(all)) {
    d <- all[[i]]
    zindex <- length(zlen)
    stored <- 0
    if (length(d)) {
      for (s in seq(1, length(d), by = block)) {
        chunk <- d[s:min(length(d), s + block - 1)]
        b <- chunk
        if (compress[i]) {
          z <- memCompress(chunk, type = "gzip")
          if (length(z) < length(chunk)) b <- z
        }
        zlen <- c(zlen, if (length(b) == block) 0L else length(b))
        blobs[[length(blobs) + 1L]] <- b
        stored <- stored + length(b)
      }
    }
    md5 <- if (i == 1L) raw(16) else hex_to_raw(as.character(openssl::md5(names(files)[i - 1L])))
    meta[[i]] <- list(md5 = md5, zindex = zindex, length = length(d), stored = stored)
  }
  toc_len <- 32 + length(all) * 30 + length(zlen) * 2
  offset <- toc_len
  toc <- vector("list", length(all))
  for (i in seq_along(all)) {
    m <- meta[[i]]
    toc[[i]] <- c(m$md5, be_bytes(m$zindex, 4), be_bytes(m$length, 5), be_bytes(offset, 5))
    offset <- offset + m$stored
  }
  toc_raw <- c(unlist(toc), be_bytes(zlen, 2))
  toc_raw <- aes_cfb128_encrypt(toc_raw, hex_to_raw(RS_KEYS$psarc_toc_key), hex_to_raw(RS_KEYS$psarc_toc_iv))
  head <- c(charToRaw("PSAR"), be_bytes(1, 2), be_bytes(4, 2), charToRaw("zlib"), be_bytes(toc_len, 4), be_bytes(30, 4),
            be_bytes(length(all), 4), be_bytes(block, 4), be_bytes(4, 4))
  dir.create(dirname(normalizePath(file, mustWork = FALSE)), showWarnings = FALSE, recursive = TRUE)
  con <- file(file, "wb")
  on.exit(close(con), add = TRUE)
  writeBin(head, con); writeBin(toc_raw, con)
  for (b in blobs) writeBin(b, con)
  invisible(file)
}

#' Check a package with RockShiny's readers (an implementation independent of the
#' Creator's engine): every chart parses from its XML and from its SNG and both give
#' the same notes -- at full difficulty and, for charts with difficulty levels, at
#' 0, 1/3 and 2/3 of it (RockShiny's difficulty slider) -- lyrics load in the karaoke,
#' the album art and the audio are there.
#' @param path a .psarc file.
#' @param audio also decode the audio (needs vgmstream-cli + ffmpeg, slow): FALSE.
#' @return list(ok, lines (character), charts (data.frame: id, label, notes_xml,
#'   notes_sng, agree, levels)).
#' @export
creator_validate <- function(path, audio = FALSE) {
  lines <- character(); ok <- TRUE
  note <- function(...) lines <<- c(lines, paste0(...))
  s <- tryCatch(load_song(path, basename(path)), error = function(e) e)
  if (inherits(s, "error")) return(list(ok = FALSE, lines = paste("RockShiny cannot open it:", conditionMessage(s)), charts = NULL))
  note(s$meta$artist %|NA|% "?", " \u2014 ", s$meta$title %|NA|% "?")
  arr <- s$arrangements[!s$arrangements$melody_only, , drop = FALSE]
  charts <- data.frame(id = arr$id, label = arr$label, notes_xml = NA_integer_, notes_sng = NA_integer_, agree = NA,
                       levels = NA_integer_, stringsAsFactors = FALSE)
  # same notes; a chord's notes are compared by the chord's longest sustain (an SNG keeps one per chord)
  agree <- function(x, y) {
    nx <- x$notes; ny <- y$notes
    if (nrow(nx) != nrow(ny)) return(FALSE)
    if (!nrow(nx)) return(TRUE)
    cols <- c("time", "string", "fret", "tech")
    if (!isTRUE(all.equal(nx[, cols], ny[, cols], tolerance = 1e-3, check.attributes = FALSE))) return(FALSE)
    sus <- function(n) ifelse(n$chord < 0, n$sustain, stats::ave(n$sustain, round(n$time, 3), FUN = max))
    isTRUE(all.equal(sus(nx), sus(ny), tolerance = 1e-3, check.attributes = FALSE))
  }
  for (i in seq_len(nrow(arr))) {
    a <- arr[i, ]
    cx <- if (!is.na(a$xml)) tryCatch(song_chart(s, a$id, source = "xml"), error = function(e) NULL)
    cs <- if (!is.na(a$sng)) tryCatch(song_chart(s, a$id, source = "sng"), error = function(e) NULL)
    if (!is.null(cx)) charts$notes_xml[i] <- nrow(cx$notes)
    if (!is.null(cs)) charts$notes_sng[i] <- nrow(cs$notes)
    if (is.null(cs)) { ok <- FALSE; note(a$label, ": the SNG does not parse"); next }
    charts$levels[i] <- (cs$meta$max_difficulty %||% 0L) + 1L
    if (!is.null(cx)) {
      same <- agree(cx, cs)
      # difficulty levels: the easier charts (RockShiny's difficulty slider) must agree too
      if (same && charts$levels[i] > 1L) for (d in c(0, 1 / 3, 2 / 3)) {
        lx <- tryCatch(song_chart(s, a$id, source = "xml", difficulty = d), error = function(e) NULL)
        ls <- tryCatch(song_chart(s, a$id, source = "sng", difficulty = d), error = function(e) NULL)
        if (is.null(lx) || is.null(ls) || !agree(lx, ls)) { same <- FALSE; note(a$label, ": XML and SNG disagree at difficulty ", round(100 * d), "%"); break }
      }
      charts$agree[i] <- same
      if (!same) { ok <- FALSE; note(a$label, ": XML and SNG disagree") }
    }
  }
  note(nrow(arr), " chart", if (nrow(arr) == 1) "" else "s", ", ", sum(charts$notes_sng, na.rm = TRUE), " notes")
  if (any(charts$levels > 1L, na.rm = TRUE)) {
    dd <- charts[!is.na(charts$levels) & charts$levels > 1L, , drop = FALSE]
    note("difficulty levels: ", paste0(dd$label, " ", dd$levels, collapse = ", "))
  }
  v <- song_vocals_raw(s)
  if (!is.null(v)) {
    k <- tryCatch(load_karaoke_song(path, basename(path), online = FALSE), error = function(e) e)
    if (inherits(k, "error")) { ok <- FALSE; note("lyrics: ", conditionMessage(k)) }
    else note(length(unique(k$vocals$line)), " lyric lines")
  }
  if (is.null(song_album_art(s))) note("no album art")
  wem <- tryCatch(find_song_wem(s$arc), error = function(e) NULL)
  if (is.null(wem)) { ok <- FALSE; note("no audio") }
  else if (isTRUE(audio)) {
    a <- tryCatch(song_audio(s), error = function(e) e)
    if (inherits(a, "error")) note("audio not decoded here: ", conditionMessage(a)) else note("audio decodes")
  }
  list(ok = ok, lines = lines, charts = charts)
}

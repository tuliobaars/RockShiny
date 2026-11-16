# -----------------------------------------------------------------------------
# audio.R -- locate the song's .wem and turn it into something a browser plays.
#
# IMPORTANT: Rocksmith .wem files are RIFF containers with format tag 0xFFFF
# ("Wwise Vorbis": Vorbis packets with stripped headers + external codebooks).
# FFmpeg has NO decoder for this, so `ffmpeg -i song.wem` fails. The working
# pipelines are:
#
#   A) vgmstream-cli  song.wem -> song.wav     (decodes Wwise Vorbis)
#      ffmpeg         song.wav -> song.ogg     (or .m4a / keep .wav)
#   B) ww2ogg --pcb packed_codebooks_aoTuV_603.bin song.wem -> song.ogg
#      revorb song.ogg                         (fixes granule positions)
#
# A is preferred (single binary, robust). B is lossless but needs 2 tools +
# the codebook file. Tool paths can be overridden with options() or env vars.
# -----------------------------------------------------------------------------

#' Locate external tools. Override via options(rockshiny.vgmstream = ...,
#' rockshiny.ffmpeg = ..., rockshiny.ww2ogg = ..., rockshiny.revorb = ...,
#' rockshiny.ww2ogg_codebooks = ...) or the matching upper-case env vars.
#' @export
audio_tools <- function() {
  find_tool <- function(opt, env, candidates) {
    for (p in c(getOption(opt), Sys.getenv(env, ""))) {
      if (nzchar(p %||% "") && file.exists(p)) return(normalizePath(p))
    }
    hits <- Sys.which(candidates)
    hits <- hits[nzchar(hits)]
    if (length(hits)) unname(hits[[1]]) else NA_character_
  }
  list(
    vgmstream = find_tool("rockshiny.vgmstream", "VGMSTREAM_CLI", c("vgmstream-cli", "vgmstream_cli", "vgmstream")),
    ffmpeg    = find_tool("rockshiny.ffmpeg", "FFMPEG", "ffmpeg"),
    ww2ogg    = find_tool("rockshiny.ww2ogg", "WW2OGG", "ww2ogg"),
    revorb    = find_tool("rockshiny.revorb", "REVORB", "revorb"),
    codebooks = getOption("rockshiny.ww2ogg_codebooks", Sys.getenv("WW2OGG_CODEBOOKS", NA_character_))
  )
}

#' Which .wem is the full song? The song soundbank (song_<key>.bnk, not the
#' *_preview.bnk) references its wem by 32-bit little-endian id, so search the
#' bank bytes for each candidate id. Falls back to the largest wem.
#' @param arc an opened archive (`psarc_open()`).
#' @export
find_song_wem <- function(arc) {
  wems <- psarc_find(arc, "\\.wem$")
  if (!length(wems)) stop("No .wem audio found in ", basename(arc$path))
  ids <- as.numeric(sub("\\.wem$", "", basename(wems)))

  banks <- psarc_find(arc, "\\.bnk$")
  song_bank <- banks[!grepl("_preview\\.bnk$", banks)]
  for (bnk in song_bank) {
    bytes <- psarc_read(arc, bnk)
    for (i in seq_along(wems)) {
      if (is.na(ids[i])) next
      id_le <- as.raw((ids[i] %/% 256^(0:3)) %% 256)
      if (length(grepRaw(id_le, bytes, fixed = TRUE))) return(wems[i])
    }
  }
  sizes <- arc$entries$length[match(wems, arc$entries$name)]
  wems[which.max(sizes)]
}

run_tool <- function(cmd, args) {
  out <- suppressWarnings(system2(cmd, args, stdout = TRUE, stderr = TRUE))
  status <- attr(out, "status") %||% 0L
  if (status != 0L) {
    stop(basename(cmd), " failed (exit ", status, "):\n", paste(utils::tail(out, 15), collapse = "\n"), call. = FALSE)
  }
  invisible(out)
}

# ---- delivery formats ---------------------------------------------------------
# In order of preference. `encoder` must be listed by `ffmpeg -encoders`
# (NA = always available). All were verified sample-aligned after decoding
# (click-track test, see docs): Vorbis/Opus/FLAC/WAV have no start offset and
# ffmpeg writes an MP4 edit list that hides AAC's encoder priming.
AUDIO_FORMATS <- list(
  ogg  = list(ext = "ogg",  encoder = "libvorbis", args = c("-c:a", "libvorbis", "-q:a", "5")),
  m4a  = list(ext = "m4a",  encoder = "aac",       args = c("-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart")),
  opus = list(ext = "opus", encoder = "libopus",   args = c("-c:a", "libopus", "-b:a", "160k", "-f", "ogg")),
  flac = list(ext = "flac", encoder = "flac",      args = c("-c:a", "flac")),          # lossless, ~25 MB/song
  wav  = list(ext = "wav",  encoder = NA,          args = c("-c:a", "pcm_s16le"))      # last resort, ~45 MB/song
)

.rs_cache <- new.env(parent = emptyenv())

#' Audio encoders compiled into this ffmpeg (builds differ: e.g. some
#' Homebrew/conda builds ship without libvorbis). Cached per binary.
#' @noRd
ffmpeg_encoders <- function(ffmpeg) {
  if (is.na(ffmpeg) || !nzchar(ffmpeg)) return(character())
  key <- paste0("encoders:", ffmpeg)
  if (is.null(.rs_cache[[key]])) {
    out <- tryCatch(suppressWarnings(system2(ffmpeg, c("-hide_banner", "-encoders"), stdout = TRUE, stderr = TRUE)),
                    error = function(e) character())
    m <- regmatches(out, regexec("^\\s*A[A-Z.]{5}\\s+(\\S+)", out))
    enc <- vapply(m[lengths(m) == 2L], function(x) x[2L], character(1))
    .rs_cache[[key]] <- setdiff(enc, "=")
  }
  .rs_cache[[key]]
}

#' Formats we can produce AND the browser can play, best first.
#' @param browser formats reported by the client (canPlayType), or NULL.
#' @param preferred "auto" or a format id to try first.
#' @param tools audio tools as found by `audio_tools()`.
#' @export
audio_format_candidates <- function(tools = audio_tools(), browser = NULL,
                                    preferred = getOption("rockshiny.audio_format", "auto")) {
  ids <- names(AUDIO_FORMATS)
  if (!identical(preferred, "auto") && preferred %in% ids) ids <- c(preferred, setdiff(ids, preferred))
  enc <- ffmpeg_encoders(tools$ffmpeg)
  if (is.na(tools$vgmstream) && !is.na(tools$ww2ogg)) enc <- c(enc, "libvorbis")   # ww2ogg emits Vorbis directly
  can_make <- vapply(ids, function(id) {
    e <- AUDIO_FORMATS[[id]]$encoder
    (is.na(e) || e %in% enc) && (id == "wav" || !is.na(tools$ffmpeg) || id == "ogg")
  }, logical(1))
  can_play <- if (length(browser)) ids %in% browser else rep(TRUE, length(ids))
  out <- ids[can_make & can_play]
  if (!length(out)) out <- "wav"
  out
}

run_tool <- function(cmd, args) {
  out <- suppressWarnings(system2(cmd, args, stdout = TRUE, stderr = TRUE))
  status <- attr(out, "status") %||% 0L
  if (status != 0L) {
    stop(basename(cmd), " failed (exit ", status, "):\n", paste(utils::tail(out, 15), collapse = "\n"), call. = FALSE)
  }
  invisible(out)
}

ffmpeg_encode <- function(ffmpeg, input, output, format) {
  run_tool(ffmpeg, c("-y", "-hide_banner", "-loglevel", "error", "-i", shQuote(input),
                     "-vn", AUDIO_FORMATS[[format]]$args, shQuote(output)))
}

#' Convert a Wwise .wem to a web-playable file.
#'
#' Step 1 decodes Wwise Vorbis once (vgmstream -> WAV, or ww2ogg+revorb ->
#' Ogg Vorbis). Step 2 tries each candidate format in order and keeps the
#' first that encodes, so a missing/broken encoder degrades to the next format
#' instead of failing.
#' @param formats candidate format ids (see audio_format_candidates()).
#' @param wem path of the Wwise .wem file.
#' @param out_base output path without extension (the format's extension is added).
#' @param tools audio tools as found by `audio_tools()`.
#' @return Path of the converted file (its extension tells the format).
#' @export
convert_wem <- function(wem, out_base, formats = audio_format_candidates(tools), tools = audio_tools()) {
  has <- function(x) !is.na(tools[[x]]) && nzchar(tools[[x]])

  if (has("vgmstream")) {
    src <- tempfile(fileext = ".wav")
    on.exit(unlink(src), add = TRUE)
    run_tool(tools$vgmstream, c("-o", shQuote(src), shQuote(wem)))
  } else if (has("ww2ogg") && has("revorb") && !is.na(tools$codebooks) && file.exists(tools$codebooks)) {
    src <- tempfile(fileext = ".ogg")
    on.exit(unlink(src), add = TRUE)
    run_tool(tools$ww2ogg, c(shQuote(wem), "-o", shQuote(src), "--pcb", shQuote(tools$codebooks)))
    run_tool(tools$revorb, shQuote(src))
  } else {
    stop(
      "No Wwise decoder found. FFmpeg alone cannot decode Rocksmith .wem (Wwise Vorbis).\n",
      "Install vgmstream-cli (https://vgmstream.org) and put it on PATH, or set\n",
      "options(rockshiny.vgmstream = '/path/to/vgmstream-cli').",
      call. = FALSE
    )
  }
  if (!file.exists(src) || file.size(src) == 0) stop("Wwise decoding produced no output.")
  src_kind <- if (grepl("\\.wav$", src)) "wav" else "ogg"

  errors <- character()
  for (id in formats) {
    f <- AUDIO_FORMATS[[id]]
    final <- paste0(out_base, ".", f$ext)
    part <- paste0(out_base, ".partial.", f$ext)          # renamed only on success (cache safety)
    ok <- tryCatch({
      if (id == src_kind) {
        file.copy(src, part, overwrite = TRUE)            # already in this format: no re-encode
      } else {
        if (!has("ffmpeg")) stop("ffmpeg not found")
        ffmpeg_encode(tools$ffmpeg, src, part, id)
      }
      file.exists(part) && file.size(part) > 0 && file.rename(part, final)
    }, error = function(e) {
      errors[[id]] <<- conditionMessage(e)
      FALSE
    })
    unlink(part)
    if (isTRUE(ok)) return(final)
  }
  stop("Could not produce audio in any browser-playable format (tried ",
       paste(formats, collapse = ", "), "):\n", paste(names(errors), errors, sep = ": ", collapse = "\n"),
       call. = FALSE)
}

# Reproduces "Unknown encoder 'libvorbis'" with stand-in tools: a fake
# vgmstream-cli that writes a WAV, and an ffmpeg wrapper that hides the
# optional external encoders (libvorbis, libopus) like a minimal build does,
# so the expected choices do not depend on how the local ffmpeg was built.
fake_tools <- function(dir) {
  real <- Sys.which("ffmpeg")
  vgm <- file.path(dir, "vgmstream-cli")
  writeLines(c("#!/bin/sh", "# usage: vgmstream-cli -o OUT IN",
               sprintf("exec '%s' -y -loglevel error -f lavfi -i sine=frequency=440:duration=1 -ac 2 \"$2\"", real)), vgm)
  ff <- file.path(dir, "ffmpeg")
  writeLines(c("#!/bin/sh",
               sprintf("case \"$*\" in *-encoders*) '%s' \"$@\" | grep -v -e libvorbis -e libopus; exit 0;; esac", real),
               "case \"$*\" in *libvorbis*|*libopus*) echo \"[aost#0:0] Unknown encoder 'libvorbis'\" >&2; exit 8;; esac",
               sprintf("exec '%s' \"$@\"", real)), ff)
  Sys.chmod(c(vgm, ff), "0755")
  list(vgmstream = vgm, ffmpeg = ff, ww2ogg = NA_character_, revorb = NA_character_, codebooks = NA_character_)
}

test_that("format negotiation skips encoders this ffmpeg lacks and formats the browser can't play", {
  skip_on_os("windows")
  skip_if(!nzchar(Sys.which("ffmpeg")), "ffmpeg not on PATH")
  tools <- fake_tools(withr::local_tempdir())
  expect_false(any(c("libvorbis", "libopus") %in% ffmpeg_encoders(tools$ffmpeg)))
  expect_true(all(c("aac", "flac") %in% ffmpeg_encoders(tools$ffmpeg)))
  expect_identical(audio_format_candidates(tools, browser = c("ogg", "m4a", "flac", "wav"))[1], "m4a")
  # open-source Chromium: no AAC -> FLAC
  expect_identical(audio_format_candidates(tools, browser = c("ogg", "opus", "flac", "wav"))[1], "flac")
  expect_identical(audio_format_candidates(tools, browser = character(), preferred = "flac")[1], "flac")
})

test_that("convert_wem falls back to the next format when an encoder fails", {
  skip_on_os("windows")
  skip_if(!nzchar(Sys.which("ffmpeg")), "ffmpeg not on PATH")
  dir <- withr::local_tempdir()
  tools <- fake_tools(dir)
  wem <- file.path(dir, "in.wem"); writeBin(charToRaw("RIFF"), wem)
  # force the failing format first: must not error, must land on the next one
  out <- convert_wem(wem, file.path(dir, "audio"), formats = c("ogg", "flac", "wav"), tools = tools)
  expect_match(out, "audio\\.flac$")
  expect_gt(file.size(out), 1000)
  expect_false(file.exists(file.path(dir, "audio.ogg")))
  expect_length(list.files(dir, "partial"), 0)            # no half-written cache entries
  # and the negotiated default goes straight to m4a
  out2 <- convert_wem(wem, file.path(dir, "audio2"), formats = audio_format_candidates(tools), tools = tools)
  expect_match(out2, "audio2\\.m4a$")
})

test_that("background pre-decoding: quick-start clip, then full file, via the job queue", {
  skip_on_os("windows")
  skip_if(!nzchar(Sys.which("ffmpeg")) || !nzchar(Sys.which("sh")), "needs ffmpeg and sh")
  skip_if_no_songs()
  dir <- withr::local_tempdir()
  tools <- fake_tools(dir)
  withr::local_options(rockshiny.vgmstream = tools$vgmstream, rockshiny.ffmpeg = tools$ffmpeg,
                       rockshiny.cache_dir = file.path(dir, "cache"), rockshiny.head_seconds = 0.5)
  .jobs$browser <- NULL
  f <- sample_songs()[1]
  key <- unname(tools::md5sum(f))
  expect_true(background_supported())
  audio_job_enqueue(f, key = key, full = TRUE, priority = TRUE)
  deadline <- Sys.time() + 90
  repeat {                                     # no Shiny event loop here: pump by hand
    audio_jobs_pump()
    st <- audio_cache_state(key)
    if (!is.null(st$full) || identical(st$state, "error") || Sys.time() > deadline) break
    Sys.sleep(0.25)
  }
  audio_jobs_pump()
  expect_match(st$full, "audio\\.m4a$")        # libvorbis missing -> AAC
  expect_match(st$head, "head\\.m4a$")
  expect_identical(job_status_line(file.path(cache_root(), key)), "done m4a")
  expect_length(list.files(file.path(cache_root(), key), "partial"), 0)
  expect_false(file.exists(file.path(cache_root(), key, "audio.wem")))   # cleaned up
  expect_true(all(vapply(.jobs$slots, is.null, logical(1))))
  expect_false(audio_job_start(list(path = normalizePath(f), key = key, full = TRUE)))   # already cached: no-op
})

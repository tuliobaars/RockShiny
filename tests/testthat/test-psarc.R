test_that("TOC decrypts: every entry's md5 equals md5(file name)", {
  skip_if_no_songs()
  for (f in sample_songs()) {
    arc <- psarc_open(f)
    expect_gt(nrow(arc$entries), 5)
    expect_identical(arc$entries$md5, as.character(openssl::md5(arc$entries$name)), info = basename(f))
  }
})

test_that("entries extract to their declared length", {
  skip_if_no_songs()
  arc <- psarc_open(sample_songs()[1])
  small <- arc$entries[!grepl("\\.wem$", arc$entries$name), ]
  for (i in seq_len(nrow(small))) {
    expect_length(psarc_read(arc, small$name[i]), small$length[i])
  }
  wem <- find_song_wem(arc)
  out <- tempfile(fileext = ".wem")
  psarc_read(arc, wem, out = out)
  expect_equal(file.size(out), arc$entries$length[arc$entries$name == wem])
  expect_identical(readBin(out, "raw", 4), charToRaw("RIFF"))
})

test_that("the song wem is the one the song soundbank lists (its DIDX), not the preview's", {
  skip_if_no_songs()
  didx <- function(b) {                       # the DIDX entries of a soundbank, read here on their own
    o <- 1L; ids <- numeric(0)
    while (o + 7L <= length(b)) {
      n <- sum(as.numeric(b[(o + 4L):(o + 7L)]) * 256^(0:3))
      if (identical(rawToChar(b[o:(o + 3L)]), "DIDX")) {
        for (k in seq(0, n - 12, by = 12)) ids <- c(ids, sum(as.numeric(b[(o + 8L + k):(o + 11L + k)]) * 256^(0:3)))
      }
      o <- o + 8L + n
    }
    ids
  }
  for (f in sample_songs()) {
    arc <- psarc_open(f)
    banks <- psarc_find(arc, "\\.bnk$")
    song <- unlist(lapply(banks[!grepl("_preview\\.bnk$", banks)], function(b) didx(psarc_read(arc, b))))
    prev <- unlist(lapply(banks[grepl("_preview\\.bnk$", banks)], function(b) didx(psarc_read(arc, b))))
    w <- find_song_wem(arc)
    id <- as.numeric(sub("\\.wem$", "", basename(w)))
    wems <- as.numeric(sub("\\.wem$", "", basename(psarc_find(arc, "\\.wem$"))))
    if (any(song %in% wems)) expect_true(id %in% song, info = basename(f))
    if (length(setdiff(song[song %in% wems], prev))) expect_false(id %in% setdiff(prev, song), info = basename(f))
  }
})

test_that("find_song_wem(): a song bank that also names the preview's wem still gives the song's", {
  # a synthetic archive: two wems, the song bank lists both in DIDX (the preview first), the preview bank one
  mk_bank <- function(ids) {
    le <- function(x) as.raw((x %/% 256^(0:3)) %% 256)
    didx <- unlist(lapply(ids, function(i) c(le(i), le(0), le(100))))
    c(charToRaw("BKHD"), le(4), le(0), charToRaw("DIDX"), le(length(didx)), didx)
  }
  files <- list("audio/mac/111.wem" = as.raw(rep(1, 100)), "audio/mac/222.wem" = as.raw(rep(2, 5000)),
                "audio/mac/song_x.bnk" = mk_bank(c(111, 222)), "audio/mac/song_x_preview.bnk" = mk_bank(111))
  arc <- list(path = "x.psarc", entries = data.frame(name = names(files), length = lengths(files), stringsAsFactors = FALSE))
  f <- find_song_wem                            # the archive reads, served from `files`
  e <- new.env(parent = environment(find_song_wem))
  e$psarc_find <- function(arc, pattern) grep(pattern, arc$entries$name, value = TRUE)
  e$psarc_read <- function(arc, name, ...) files[[name]]
  environment(f) <- e
  expect_identical(f(arc), "audio/mac/222.wem")
})

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

test_that("the song wem is the one referenced by the song soundbank", {
  skip_if_no_songs()
  for (f in sample_songs()) {
    arc <- psarc_open(f)
    wems <- psarc_find(arc, "\\.wem$")
    sizes <- arc$entries$length[match(wems, arc$entries$name)]
    expect_identical(find_song_wem(arc), wems[which.max(sizes)], info = basename(f))   # song > preview
  }
})

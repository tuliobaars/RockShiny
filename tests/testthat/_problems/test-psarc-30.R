# Extracted from test-psarc.R:30

# setup ------------------------------------------------------------------------
library(testthat)
test_env <- simulate_test_env(package = "RockShiny", path = "..")
attach(test_env, warn.conflicts = FALSE)

# test -------------------------------------------------------------------------
skip_if_no_songs()
for (f in sample_songs()) {
    arc <- psarc_open(f)
    wems <- psarc_find(arc, "\\.wem$")
    sizes <- arc$entries$length[match(wems, arc$entries$name)]
    expect_identical(find_song_wem(arc), wems[which.max(sizes)], info = basename(f))   # song > preview
  }

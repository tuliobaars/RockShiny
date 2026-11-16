# Extracted from test-library.R:22

# setup ------------------------------------------------------------------------
library(testthat)
test_env <- simulate_test_env(package = "RockShiny", path = "..")
attach(test_env, warn.conflicts = FALSE)

# prequel ----------------------------------------------------------------------
local_library <- function(env = parent.frame()) {
  withr::local_options(list(rockshiny.cache_dir = withr::local_tempdir(.local_envir = env),
                            rockshiny.config_dir = withr::local_tempdir(.local_envir = env),
                            rockshiny.data_dir = withr::local_tempdir(.local_envir = env)), .local_envir = env)
}

# test -------------------------------------------------------------------------
skip_if_no_songs()
local_library()
lib <- library_open(songs_dir())
n <- length(sample_songs())
expect_false(lib$lazy)

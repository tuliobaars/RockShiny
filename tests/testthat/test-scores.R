run <- function(acc, kind = "song", coverage = 1, rate = 1, key = "abc123", arrangement = "Lead", ...) {
  utils::modifyList(list(songKey = key, title = "Song, with a comma", artist = "Artist \"Q\"", arrangement = arrangement,
                         difficulty = 1, kind = kind, source = "microphone", rate = rate, accuracy = acc, score = 1000,
                         hits = 90, misses = 10, perfect = 50, bestStreak = 40, coverage = coverage,
                         medianDeltaMs = -4), list(...))
}

test_that("score_row normalises a browser result (missing fields, NULLs)", {
  r <- score_row(run(0.8))
  expect_identical(names(r), SCORE_COLUMNS)
  expect_identical(nrow(r), 1L)
  expect_equal(r$accuracy, 0.8)
  expect_identical(r$best_streak, 40)
  e <- score_row(list(accuracy = NULL, songKey = NULL))
  expect_true(is.na(e$accuracy))
  expect_identical(e$song_key, "")
  expect_identical(e$kind, "song")
})

test_that("score_save appends runs and tracks the personal best", {
  f <- tempfile(fileext = ".csv")
  on.exit(unlink(f))
  t0 <- as.POSIXct("2024-05-01 20:00:00")
  a <- score_save(run(0.70), file = f, time = t0)
  expect_true(a$new_best)
  expect_null(a$previous)
  expect_equal(a$best, 0.70)

  b <- score_save(run(0.60), file = f, time = t0 + 60)
  expect_false(b$new_best)
  expect_equal(b$best, 0.70)

  # loop passes, partial runs and slowed-down runs never count as a best
  expect_false(score_save(run(0.99, kind = "loop"), file = f, time = t0 + 120)$new_best)
  expect_false(score_save(run(0.99, coverage = 0.5), file = f, time = t0 + 180)$new_best)
  expect_false(score_save(run(0.99, rate = 0.8), file = f, time = t0 + 240)$new_best)
  expect_equal(score_best("abc123", "Lead", file = f), 0.70)

  d <- score_save(run(0.85), file = f, time = t0 + 300)
  expect_true(d$new_best)
  expect_equal(d$previous, 0.70)
  expect_equal(score_best("abc123", "Lead", file = f), 0.85)

  # other arrangements / songs are separate
  expect_true(score_save(run(0.3, arrangement = "Bass"), file = f, time = t0 + 360)$new_best)
  expect_null(score_best("zzz", "Lead", file = f))

  h <- score_history("abc123", "Lead", file = f)
  expect_identical(nrow(h), 6L)
  expect_equal(h$accuracy[1], 0.85)                      # newest first
  expect_identical(h$title[1], "Song, with a comma")     # quoting survives the round trip
  expect_identical(h$artist[1], "Artist \"Q\"")
  expect_identical(nrow(score_history(kind = "loop", file = f)), 1L)
  expect_identical(nrow(score_history(file = f)), 7L)
})

test_that("score_history copes with a missing file and older column sets", {
  f <- tempfile(fileext = ".csv")
  on.exit(unlink(f))
  expect_identical(nrow(score_history(file = f)), 0L)
  utils::write.csv(data.frame(time = "2024-01-01 10:00:00", song_key = "k", arrangement = "Lead", kind = "song",
                              accuracy = 0.5, coverage = 1, rate = 1), f, row.names = FALSE)
  h <- score_history(file = f)
  expect_identical(names(h), SCORE_COLUMNS)
  expect_true(is.na(h$score))
  expect_equal(score_best("k", "Lead", file = f), 0.5)
})

test_that("the data directory follows options(rockshiny.data_dir)", {
  d <- tempfile("rs-data")
  old <- options(rockshiny.data_dir = d)
  on.exit({ options(old); unlink(d, recursive = TRUE) })
  expect_identical(score_file(), file.path(d, "scores.csv"))
  score_save(run(0.9))
  expect_true(file.exists(file.path(d, "scores.csv")))
})

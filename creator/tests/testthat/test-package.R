test_that("creator_psarc_write() packs what RockShiny's psarc_open() reads, file for file", {
  f <- song_or_demo("Daft-Punk_Derezzed_v1_m.psarc")
  files <- creator_psarc_files(f)
  out <- tempfile(fileext = ".psarc")
  creator_psarc_write(files, out)
  arc <- psarc_open(out)
  expect_identical(arc$entries$name, names(files))
  expect_identical(arc$entries$md5, as.character(openssl::md5(arc$entries$name)))
  for (n in names(files)) expect_identical(psarc_read(arc, n), files[[n]], info = n)
  s <- load_song(out)
  expect_equal(sum(!s$arrangements$melody_only), 3)
})

test_that("a package R writes is read by the Creator's engine (JavaScript), byte for byte", {
  skip_if_no_node()
  f <- song_or_demo("Daft-Punk_Derezzed_v1_m.psarc")
  files <- creator_psarc_files(f)
  files[["toolkit.version"]] <- charToRaw("Toolkit version: RockShiny Creator test\r\n")
  out <- tempfile(fileext = ".psarc")
  creator_psarc_write(files, out)
  lst <- jsonlite::fromJSON(paste(engine("list", out), collapse = ""))
  expect_identical(lst$name, names(files))
  expect_identical(lst$md5, vapply(files, function(x) as.character(openssl::md5(x)), "", USE.NAMES = FALSE))
})

test_that("packages the engine writes pass RockShiny's checks (edited, converted, new)", {
  skip_if_no_node()
  f <- song_or_demo("Dire-Straits_Sultans-of-Swing_v443_m.psarc")
  edited <- tempfile(fileext = "_m.psarc"); engine("edit", f, edited)
  v <- creator_validate(edited)
  expect_true(v$ok, info = paste(v$lines, collapse = " | "))
  expect_true(all(v$charts$agree), info = "XML and compiled SNG give the same notes")
  expect_match(paste(v$lines, collapse = " "), "lyric lines")
  s <- load_song(edited)
  expect_identical(s$meta$title, paste(load_song(f)$meta$title, "(edit)"))

  pc <- tempfile(fileext = "_p.psarc"); engine("resave", song_or_demo("Daft-Punk_Derezzed_v1_m.psarc"), pc, "pc")
  arc <- psarc_open(pc)
  expect_true(any(grepl("^songs/bin/generic/", arc$entries$name)))
  expect_false(any(grepl("macos|audio/mac/", arc$entries$name)))
  expect_true(creator_validate(pc)$ok)

  fresh <- tempfile(fileext = "_p.psarc"); engine("new", fresh)
  v <- creator_validate(fresh)
  expect_true(v$ok, info = paste(v$lines, collapse = " | "))
  expect_equal(v$charts$notes_sng[v$charts$label == "Lead"], 6)
  k <- load_karaoke_song(fresh, online = FALSE)
  expect_identical(karaoke_lines(k), "Hello")
})

test_that("an unchanged song re-saved by the engine keeps every file byte for byte", {
  skip_if_no_node()
  f <- song_or_demo("Eric-Clapton_Riding-With-The-King_v2_DD_m.psarc", "dd")
  out <- tempfile(fileext = ".psarc"); engine("resave", f, out)
  a <- creator_psarc_files(f); b <- creator_psarc_files(out)
  expect_setequal(names(b), names(a))
  for (n in names(a)) expect_identical(b[[n]], a[[n]], info = n)
})

test_that("creator_validate() reports a broken package", {
  f <- song_or_demo("Daft-Punk_Derezzed_v1_m.psarc")
  files <- creator_psarc_files(f)
  sng <- grep("lead\\.sng$", names(files), value = TRUE)
  files[[sng]][200:260] <- as.raw(0)                         # damage the encrypted chart
  out <- tempfile(fileext = ".psarc")
  creator_psarc_write(files, out)
  v <- creator_validate(out)
  expect_false(v$ok)
  expect_match(paste(v$lines, collapse = " "), "Lead")
})

test_that("difficulty levels kept, built and flattened by the engine pass RockShiny's checks at every difficulty", {
  skip_if_no_node()
  rwtk <- song_or_demo("Eric-Clapton_Riding-With-The-King_v2_DD_m.psarc", "dd")
  lead_of <- function(f) { s <- load_song(f); s$arrangements$id[s$arrangements$label == "Lead"][1] }
  kept <- tempfile(fileext = "_m.psarc"); engine("dd-edit", rwtk, kept)
  v <- creator_validate(kept)
  expect_true(v$ok, info = paste(v$lines, collapse = " | "))
  expect_true(all(v$charts$levels[v$charts$label != "Vocals"] > 1L))
  expect_equal(v$charts$levels, creator_validate(rwtk)$charts$levels)       # kept: as many levels as before
  expect_match(paste(v$lines, collapse = " "), "difficulty levels: Lead")

  src <- song_or_demo("Dire-Straits_Sultans-of-Swing_v443_m.psarc")
  built <- tempfile(fileext = "_m.psarc"); engine("dd-auto", src, built, "6")
  v <- creator_validate(built)
  expect_true(v$ok, info = paste(v$lines, collapse = " | "))
  expect_true(all(v$charts$levels > 1L & v$charts$levels <= 7L))   # up to 0-6: busy parts get the most
  # RockShiny's difficulty slider: fewer notes at the easy end, the whole chart at 100 %
  s <- load_song(built); id <- lead_of(built)
  full <- nrow(song_chart(s, id, difficulty = 1)$notes)
  easy <- nrow(song_chart(s, id, difficulty = 0)$notes)
  half <- nrow(song_chart(s, id, difficulty = 0.5)$notes)
  orig <- nrow(song_chart(load_song(src), lead_of(src))$notes)
  expect_equal(full, orig)
  expect_true(easy < half && half < full)
  expect_true(easy > 0)

  flat <- tempfile(fileext = "_m.psarc"); engine("dd-flat", rwtk, flat)
  v <- creator_validate(flat)
  expect_true(v$ok, info = paste(v$lines, collapse = " | "))
  expect_true(all(v$charts$levels == 1L))
  expect_equal(nrow(song_chart(load_song(flat), lead_of(flat))$notes), nrow(song_chart(load_song(rwtk), lead_of(rwtk))$notes))
})

test_that("the demo song the engine makes from scratch passes RockShiny's checks (no songs needed)", {
  skip_if_no_node()
  demo <- tempfile(fileext = "_m.psarc"); engine("demo", demo, "mac")
  v <- creator_validate(demo, audio = FALSE)
  expect_true(v$ok, info = paste(v$lines, collapse = " | "))
  expect_equal(v$charts$label, c("Lead", "Rhythm", "Bass"))
  expect_true(all(v$charts$agree))
  expect_match(paste(v$lines, collapse = " "), "8 lyric lines")
  s <- load_song(demo)
  expect_identical(s$meta$title, "Night Drive")
  k <- load_karaoke_song(demo, online = FALSE)
  expect_match(karaoke_lines(k)[1], "Neon lights across the bay")
})

test_that("the bundled copy of RockShiny (creator/rockshiny/) matches RockShiny when both are here", {
  parent <- file.path(creator_root, "..")
  skip_if_not(file.exists(file.path(parent, "R", "psarc.R")), "RockShiny is not next to creator/ (the bundled copy is the one in use)")
  man <- jsonlite::fromJSON(file.path(creator_root, "rockshiny", "MANIFEST.json"))$files
  for (f in names(man)) {
    expect_true(file.exists(file.path(parent, f)), info = f)
    expect_identical(unname(tools::md5sum(file.path(creator_root, "rockshiny", f))), unname(tools::md5sum(file.path(parent, f))),
                     info = paste(f, "differs: run python3 creator/tools/vendor_rockshiny.py"))
  }
  here <- list.files(file.path(parent, "R"), pattern = "[.]R$")
  expect_setequal(paste0("R/", here), grep("^R/", names(man), value = TRUE))
})

# The Shiny modules, server side (shiny::testServer): the studio is replaced by a fake
# handle that records the commands sent to the browser and plays its answers back.
fake_studio <- function(state = list(open = TRUE, title = "T", artist = "A", key = "AT", platform = "mac", stems = list())) {
  sent <- list()
  up <- tempfile("rsc-up-"); dir.create(up)
  rv <- shiny::reactiveValues(state = state, saved = NULL, lyrics = NULL, stems = NULL, errors = NULL)
  list(
    sent = function() sent,
    rv = rv, up = up,
    send = function(cmd, ...) sent[[length(sent) + 1L]] <<- c(list(cmd = cmd), list(...)),
    open = function(path, name = basename(path)) sent[[length(sent) + 1L]] <<- list(cmd = "open", path = path, name = name),
    new_song = function(spec) sent[[length(sent) + 1L]] <<- c(list(cmd = "new"), spec),
    save = function(platform, action = "library") { sent[[length(sent) + 1L]] <<- list(cmd = "save", platform = platform, action = action); "tok1" },
    state = shiny::reactive(rv$state), saved = shiny::reactive(rv$saved), errors = shiny::reactive(rv$errors),
    lyrics_request = shiny::reactive(rv$lyrics), stems_saved = shiny::reactive(rv$stems),
    uploaded = function(token, kind, part = NULL) file.path(up, paste0(token, "-", kind, if (!is.null(part)) paste0("-", part))),
    current = shiny::reactiveVal(NULL)
  )
}

test_that("Save: the package the browser uploads goes into the library, unique name, checked", {
  f <- song_or_demo("Daft-Punk_Derezzed_v1_m.psarc")
  lib_dir <- tempfile("lib-"); dir.create(lib_dir)
  file.copy(f, file.path(lib_dir, basename(f)))
  st <- fake_studio()
  lib <- shiny::reactiveVal(list(dir = lib_dir))
  withr::local_options(rockshiny.library_dir = lib_dir)
  shiny::testServer(mod_export_server, args = list(studio = st, lib = lib), {
    session$setInputs(platform = "mac", save = 1)
    expect_identical(st$sent()[[1]]$cmd, "save")
    file.copy(f, st$uploaded("tok1", "psarc"))              # what the browser would POST
    st$rv$saved <- list(token = "tok1", name = basename(f), size = file.size(f), platform = "mac")
    session$flushReact()
    out <- file.path(lib_dir, sub("_m[.]psarc$", "-2_m.psarc", basename(f)))       # never over the existing file
    expect_true(file.exists(out))
    expect_identical(saved(), normalizePath(out, winslash = "/"))
    expect_match(paste(output$report$html), "Saved and checked")
  })
})

test_that("Lyrics: a .lrc next to the song wins; then LRCLIB (faked); offline is reported", {
  d <- tempfile("song-"); dir.create(d)
  song <- file.path(d, "My_Song_p.psarc"); writeBin(raw(10), song)
  writeLines(c("[00:01.00] first line", "[00:03.00] second line"), file.path(d, "My_Song_p.lrc"))
  r <- creator_lyrics_lookup(list(artist = "A", title = "T"), song, online = FALSE)
  expect_identical(r$source, "file")
  expect_match(r$lrc, "second line")
  fake <- function(url) list(list(id = 7, trackName = "Title", artistName = "Artist", duration = 200,
                                  syncedLyrics = "[00:10.00] hello", plainLyrics = "hello"))
  r <- creator_lyrics_lookup(list(artist = "Artist", title = "Title", duration = 200), NULL, online = TRUE, fetch = fake)
  expect_identical(r$source, "lrclib"); expect_identical(r$synced, "line")
  r <- creator_lyrics_lookup(list(artist = "A", title = "T"), NULL, online = TRUE, fetch = function(url) stop("no network"))
  expect_true(isTRUE(r$offline))
  expect_null(creator_lyrics_lookup(list(artist = "A", title = "T"), NULL, online = FALSE))

  st <- fake_studio()
  shiny::testServer(mod_lyrics_server, args = list(studio = st, fetch = fake), {
    session$setInputs(online = TRUE)
    st$rv$lyrics <- list(requestId = 3, artist = "Artist", title = "Title", duration = 200)
    session$flushReact()
    m <- Filter(function(x) x$cmd == "lyrics", st$sent())[[1]]
    expect_equal(m$requestId, 3)
    expect_match(m$result$lrc, "hello")
  })
})

test_that("Song: a dropped .psarc opens, dropped audio asks for the new-song details", {
  f <- song_or_demo("Daft-Punk_Derezzed_v1_m.psarc")
  withr::local_options(rockshiny.uploads_dir = tempfile("up-"))
  st <- fake_studio()
  lib <- shiny::reactiveVal(library_open(dirname(f), FALSE, budget = Inf))
  shiny::testServer(mod_project_server, args = list(studio = st, lib = lib), {
    session$setInputs(file = list(name = basename(f), datapath = f, size = file.size(f), type = ""))
    expect_identical(st$sent()[[1]]$cmd, "open")
    expect_identical(st$sent()[[1]]$name, basename(f))
    wav <- tempfile(fileext = ".wav"); writeBin(raw(100), wav)
    session$setInputs(file = list(name = "Some Artist - Some Song.wav", datapath = wav, size = 100, type = ""))
    session$setInputs(title = "Some Song", artist = "Some Artist", album = "", year = "2025", charts = c("lead", "bass"),
                      tuning = "Drop D", bpm = NA, platform = "pc", create = 1)
    m <- st$sent()[[length(st$sent())]]
    expect_identical(m$cmd, "new")
    expect_identical(m$title, "Some Song"); expect_identical(m$tuning, "Drop D")
    expect_identical(m$arrangements, c("lead", "bass"))
  })
  expect_identical(creator_guess_name("Dire Straits - Sultans of Swing.mp3"), list(artist = "Dire Straits", title = "Sultans of Swing"))
})

test_that("New song: the form's choices (the chart drafts included) reach the studio; the demo button names it", {
  withr::local_options(rockshiny.uploads_dir = tempfile("up-"))
  st <- fake_studio()
  shiny::testServer(mod_project_server, args = list(studio = st, lib = shiny::reactiveVal(NULL)), {
    wav <- tempfile(fileext = ".wav"); writeBin(raw(100), wav)
    session$setInputs(file = list(name = "Neon Harbor - Night Drive.wav", datapath = wav, size = 100, type = ""))
    session$setInputs(title = "Night Drive", artist = "Neon Harbor", album = "", year = "2025", charts = c("rhythm", "bass"),
                      tuning = "E standard", bpm = NA, platform = "mac", draft = TRUE, create = 1)
    m <- st$sent()[[length(st$sent())]]
    expect_identical(m$cmd, "new")
    expect_true(m$draft)
    expect_identical(m$platform, "mac")
    expect_identical(m$arrangements, c("rhythm", "bass"))
  })
  ui <- htmltools::renderTags(mod_creator_ui("zz"))$html
  expect_match(ui, 'data-rsc-help="zz-studio-studio" data-rsc-what="demo"', fixed = TRUE)
  expect_match(paste(format(creator_new_song_modal(shiny::NS("p"), "x.wav")), collapse = ""), "Draft the rhythm and bass charts", fixed = TRUE)
})

test_that("Stems: files the browser uploads are kept next to the song", {
  lib_dir <- tempfile("lib-"); dir.create(lib_dir)
  st <- fake_studio(list(open = TRUE, stems = list("vocals", "drums")))
  shiny::testServer(mod_stems_server, args = list(studio = st, lib = shiny::reactiveVal(list(dir = lib_dir))), {
    for (p in c("vocals", "drums")) writeBin(as.raw(1:50), st$uploaded("s1", "stem", p))
    st$rv$stems <- list(token = "s1", ids = list("vocals", "drums"), title = "Song", artist = "Band")
    session$flushReact()
    d <- file.path(lib_dir, "Band - Song (stems)")
    expect_true(file.exists(file.path(d, "vocals.wav")))
    expect_true(file.exists(file.path(d, "drums.wav")))
  })
})

test_that("the upload endpoint only takes POSTs with sane names, and stores the body", {
  d <- tempfile("up-"); dir.create(d)
  body <- as.raw(sample(0:255, 300000, replace = TRUE))
  pos <- 0
  req <- list(REQUEST_METHOD = "POST", QUERY_STRING = "token=abc1&kind=psarc",
              rook.input = list(read = function(n) { if (pos >= length(body)) return(raw(0)); r <- body[(pos + 1):min(length(body), pos + n)]; pos <<- pos + length(r); r }))
  res <- creator_upload_filter(d, req)
  expect_equal(res$status, 200L)
  expect_identical(readBin(file.path(d, "abc1-psarc"), "raw", 1e6), body)
  expect_equal(creator_upload_filter(d, modifyList(req, list(QUERY_STRING = "token=../x&kind=psarc")))$status, 400L)
  expect_equal(creator_upload_filter(d, modifyList(req, list(REQUEST_METHOD = "GET")))$status, 405L)
})

test_that("the module is isolated: every input id is namespaced, classes are the Creator's", {
  ui <- htmltools::renderTags(mod_creator_ui("zz"))$html
  ids <- regmatches(ui, gregexpr('\\bid="[^"]+"', ui))[[1]]
  ids <- sub('^id="', "", sub('"$', "", ids))
  expect_true(length(ids) > 10)
  expect_true(all(startsWith(ids, "zz-") | grepl("^(bslib|tab|sidebar|accordion)", ids)),
              info = paste(ids[!startsWith(ids, "zz-")], collapse = ", "))
  deps <- vapply(htmltools::findDependencies(mod_creator_ui("zz")), function(d) d$name, "")
  expect_true(all(c("rockshiny-creator-engine", "rockshiny-creator-studio", "rockshiny-karaoke-sync") %in% deps))
  css <- readLines(file.path(creator_dir(), "inst", "studio", "creator.css"))
  sel <- sub("\\{.*$", "", grep("^[^ /*@}].*\\{", css, value = TRUE))          # selectors (not inside @media)
  parts <- trimws(unlist(strsplit(sel, ",")))
  parts <- parts[nzchar(parts) & !grepl("^(from|to|[0-9]+%)", parts)]         # keyframe steps
  expect_true(all(grepl("\\.rsc-", parts)), info = paste(parts[!grepl("\\.rsc-", parts)], collapse = " / "))
})

test_that("creator_build_html() writes one offline page with the whole studio inside", {
  out <- tempfile(fileext = ".html")
  creator_build_html(out)
  html <- paste(readLines(out, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  for (f in c(CREATOR_ENGINE_JS, CREATOR_STUDIO_JS, "karaoke-sync.js", "rsc-page.js")) expect_match(html, f, fixed = TRUE, info = f)
  expect_false(grepl('<script[^>]+src=|<link[^>]+href="http', html))    # nothing loaded from elsewhere
  expect_lt(file.size(out), 2e6)
})

test_that("Help: the sidebar's Help and tour buttons name the module's studio; the studio ships the help", {
  ui <- htmltools::renderTags(mod_creator_ui("zz"))$html
  expect_equal(lengths(regmatches(ui, gregexpr('data-rsc-help="zz-studio-studio"', ui, fixed = TRUE))), 3L)   # Help, the tour, the demo song
  expect_match(ui, 'data-rsc-what="tour"', fixed = TRUE)
  expect_match(ui, 'id="zz-studio-studio"', fixed = TRUE)
  expect_true("rsc-help.js" %in% CREATOR_STUDIO_JS)
  js <- paste(readLines(file.path(creator_dir(), "inst", "studio", "rsc-help.js"), warn = FALSE), collapse = "\n")
  for (s in c("What it can do", "What it can\\u2019t do", "Difficulty levels", "does not transcribe a song for you", "Not tested in the game"))
    expect_match(js, s, fixed = TRUE, info = s)
})

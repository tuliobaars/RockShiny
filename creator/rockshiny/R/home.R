# -----------------------------------------------------------------------------
# home.R -- the data behind the home screen (mod_home.R, inst/home/): the song
# catalog (library + uploads + examples, by artist / album / genre), playlists,
# recently played songs and genres. No Shiny code in here.
#
#   lib <- library_current()
#   cat <- home_catalog(lib)                       # data.frame: id, path, title, artist, album, genre, ...
#   p   <- playlist_create("Road trip", cat$path[1:3])
#   playlists_read()                               # list of playlists
#   history_add(cat$path[1], "karaoke")
#   genre_set_artist("Dire Straits", "Classic Rock")
#
# Everything the user makes is kept in the data folder (getOption("rockshiny.data_dir"),
# default tools::R_user_dir("RockShiny", "data"); the same folder as scores.csv):
#   playlists.json   playlists: name + songs (path, and artist / title in case the file moves)
#   history.json     the last 100 songs opened (path, mode, time)
#   genres.json      genres set by hand, per artist and per song
# Genres found online (MusicBrainz artist tags, see genre_lookup_artist()) are
# cached in <cache>/genres/artists.json, like the lyrics.
# -----------------------------------------------------------------------------

HOME_FORMAT <- "rockshiny-home/1"
PLAYLISTS_FORMAT <- "rockshiny-playlists/1"
HISTORY_MAX <- 100L

.home_state <- new.env(parent = emptyenv())

home_file <- function(name) file.path(score_dir(), name)

home_json_read <- function(f, default) {
  if (!file.exists(f)) return(default)
  tryCatch(jsonlite::fromJSON(paste(readLines(f, warn = FALSE, encoding = "UTF-8"), collapse = "\n"), simplifyVector = FALSE),
           error = function(e) default)
}

home_json_write <- function(x, f) {
  dir.create(dirname(f), showWarnings = FALSE, recursive = TRUE)
  tmp <- paste0(f, ".tmp", Sys.getpid())
  con <- file(tmp, "w", encoding = "UTF-8")
  writeLines(jsonlite::toJSON(x, auto_unbox = TRUE, null = "null", na = "null", pretty = TRUE, digits = NA), con)
  close(con)
  if (!file.rename(tmp, f)) { file.copy(tmp, f, overwrite = TRUE); unlink(tmp) }
  invisible(f)
}

#' Short stable id of a song for the browser: the first 12 hex digits of the md5 of its path.
#' @noRd
song_id <- function(path) substr(as.character(openssl::md5(as.character(path))), 1L, 12L)

# ---- catalog -----------------------------------------------------------------------------

#' The home screen's song catalog: every song the app offers (library folder,
#' uploads, examples) with its genre.
#' @param lib a library from `library_open()`.
#' @return data.frame(id, path, title, artist, album, year, length, lyrics ("archive":
#'   in the file; "web": to look up; "": no karaoke, e.g. MIDI), kind, source, genre, added).
#' @export
home_catalog <- function(lib) {
  s <- library_all_songs(lib)
  if (!nrow(s)) {
    return(data.frame(id = character(), path = character(), title = character(), artist = character(), album = character(),
                      year = character(), length = numeric(), lyrics = character(), kind = character(), source = character(),
                      genre = character(), added = numeric(), stringsAsFactors = FALSE))
  }
  title <- ifelse(is.na(s$title) | !nzchar(s$title), basename(s$path), s$title)
  lyr <- ifelse(s$kind != "psarc", "", ifelse(s$lyrics %in% TRUE, "archive", "web"))
  side <- s$kind == "psarc" & file.exists(sub("\\.psarc$", ".lrc", s$path, ignore.case = TRUE))
  lyr[side & lyr == "web"] <- "archive"                  # a sidecar .lrc: lyrics at hand
  data.frame(id = song_id(s$path), path = s$path, title = title, artist = s$artist, album = s$album, year = s$year,
             length = s$length, lyrics = lyr, kind = s$kind, source = s$source,
             genre = genre_of(s$artist, s$path), added = s$mtime, stringsAsFactors = FALSE)
}

#' The catalog as columns for the browser (home.js).
#' @noRd
home_catalog_json <- function(cat) {
  na <- function(x) { x <- as.character(x); x[is.na(x)] <- ""; x }
  list(id = cat$id, title = na(cat$title), artist = na(cat$artist), album = na(cat$album), year = na(cat$year),
       length = round(ifelse(is.na(cat$length), 0, cat$length), 1), lyrics = na(cat$lyrics), kind = na(cat$kind),
       source = na(cat$source), genre = na(cat$genre), added = ifelse(is.na(cat$added), 0, cat$added))
}

# ---- playlists ---------------------------------------------------------------------------

#' Playlists: a list of list(id, name, created, songs = list(list(path, title, artist))).
#' @export
playlists_read <- function() {
  x <- home_json_read(home_file("playlists.json"), list())
  p <- x$playlists %||% list()
  lapply(p, function(q) list(id = as.character(q$id), name = as.character(q$name %||% "Playlist"),
                             created = as.character(q$created %||% ""), songs = q$songs %||% list()))
}

playlists_write <- function(p) {
  home_json_write(list(format = PLAYLISTS_FORMAT, playlists = p), home_file("playlists.json"))
  .home_state$version <- (.home_state$version %||% 0) + 1
  invisible(p)
}

#' What is stored for a song in a playlist: its path, and artist / title to find it again.
#' @noRd
playlist_entry <- function(path) {
  m <- tryCatch(library_meta(path), error = function(e) list(artist = NA, song = basename(path)))
  list(path = path, title = m$song %||% basename(path), artist = if (is.null(m$artist) || is.na(m$artist)) "" else m$artist)
}

#' Create a playlist.
#' @param name its name.
#' @param paths songs to put in it.
#' @return the new playlist's id.
#' @export
playlist_create <- function(name, paths = character()) {
  p <- playlists_read()
  name <- trimws(name %||% "")
  if (!nzchar(name)) name <- sprintf("My playlist #%d", length(p) + 1L)
  id <- paste0("pl", substr(as.character(openssl::md5(paste(name, Sys.time(), stats::runif(1)))), 1L, 8L))
  p[[length(p) + 1L]] <- list(id = id, name = substr(name, 1L, 100L), created = format(Sys.time(), "%Y-%m-%dT%H:%M:%S"),
                              songs = lapply(paths, playlist_entry))
  playlists_write(p)
  id
}

playlist_modify <- function(pid, fn) {
  p <- playlists_read()
  i <- which(vapply(p, function(q) identical(q$id, pid), logical(1)))
  if (!length(i)) stop("no playlist ", pid, call. = FALSE)
  q <- fn(p[[i[1]]])
  if (is.null(q)) p[[i[1]]] <- NULL else p[[i[1]]] <- q
  playlists_write(p)
  invisible(TRUE)
}

#' Change a playlist: rename it, delete it, add, remove or move songs.
#' @param pid playlist id.
#' @param name new name.
#' @param paths songs to add.
#' @param index position (1-based) of the song to remove.
#' @param from,to move a song.
#' @export
playlist_rename <- function(pid, name) playlist_modify(pid, function(q) { if (nzchar(trimws(name))) q$name <- substr(trimws(name), 1L, 100L); q })
#' @rdname playlist_rename
#' @export
playlist_delete <- function(pid) playlist_modify(pid, function(q) NULL)
#' @rdname playlist_rename
#' @export
playlist_add <- function(pid, paths) playlist_modify(pid, function(q) { q$songs <- c(q$songs, lapply(paths, playlist_entry)); q })
#' @rdname playlist_rename
#' @export
playlist_remove <- function(pid, index) playlist_modify(pid, function(q) {
  index <- as.integer(index)
  if (length(index) && index >= 1L && index <= length(q$songs)) q$songs[[index]] <- NULL
  q
})
#' @rdname playlist_rename
#' @export
playlist_move <- function(pid, from, to) playlist_modify(pid, function(q) {
  n <- length(q$songs); from <- as.integer(from); to <- as.integer(to)
  if (n < 2L || from < 1L || from > n || to < 1L || to > n || from == to) return(q)
  s <- q$songs[[from]]
  q$songs <- append(q$songs[-from], list(s), after = to - 1L)
  q
})

#' Songs of a playlist found in the catalog: by path, else by artist + title
#' (a file that was moved or renamed). NA for songs not found.
#' @noRd
playlist_resolve <- function(q, cat) {
  vapply(q$songs, function(e) {
    i <- match(e$path %||% "", cat$path)
    if (is.na(i) && nzchar(e$title %||% "")) {
      i <- which(tolower(cat$title) == tolower(e$title) & tolower(ifelse(is.na(cat$artist), "", cat$artist)) == tolower(e$artist %||% ""))[1]
    }
    if (is.na(i)) NA_character_ else cat$path[i]
  }, character(1))
}

# ---- recently played ------------------------------------------------------------------------

#' Remember that a song was opened (in "instrument" or "karaoke" mode).
#' @param path the song.
#' @param mode "instrument" or "karaoke".
#' @export
history_add <- function(path, mode) {
  h <- home_json_read(home_file("history.json"), list())$plays %||% list()
  h <- c(list(list(path = path, mode = mode, time = format(Sys.time(), "%Y-%m-%dT%H:%M:%S"))),
         Filter(function(e) !identical(e$path, path), h))
  h <- utils::head(h, HISTORY_MAX)
  home_json_write(list(plays = h), home_file("history.json"))
  .home_state$version <- (.home_state$version %||% 0) + 1
  invisible(h)
}

#' The songs opened lately, newest first: list of list(path, mode, time).
#' @export
history_read <- function() home_json_read(home_file("history.json"), list())$plays %||% list()

# ---- genres -----------------------------------------------------------------------------

#' Genres in the home screen, first hit wins: set by hand for the song, set by
#' hand for the artist, found online for the artist (genre_lookup_artist()).
#' Rocksmith archives carry no genre.
#' @noRd
genre_of <- function(artist, path) {
  u <- genres_user()
  o <- genres_online_cache()
  key <- artist_key(artist)
  g <- rep(NA_character_, length(path))
  if (length(u$songs)) g <- unlist(u$songs)[path]
  by_artist <- c(unlist(u$artists), unlist(lapply(o, function(e) e$genre %||% NA_character_)))   # hand-set first: it wins
  a <- unname(by_artist[key])
  a <- if (length(a)) a else rep(NA_character_, length(path))
  g <- unname(ifelse(is.na(g), a, g))
  g[!is.na(g) & !nzchar(g)] <- NA_character_
  g
}

artist_key <- function(artist) {
  a <- tolower(trimws(ifelse(is.na(artist), "", artist)))
  a <- sub("\\s*[([].*$", "", a)                        # "Carlos Santana (ft Chad Kroeger)" -> "carlos santana"
  gsub("\\s+", " ", a)
}

genres_user <- function() {
  x <- home_json_read(home_file("genres.json"), list())
  list(artists = x$artists %||% list(), songs = x$songs %||% list())
}

#' Set a genre by hand: for all songs of an artist, or for one song ("" removes it).
#' @param artist the artist's name.
#' @param path the song.
#' @param genre the genre.
#' @export
genre_set_artist <- function(artist, genre) {
  u <- genres_user()
  u$artists[[artist_key(artist)]] <- if (nzchar(genre %||% "")) genre_clean(genre) else NULL
  home_json_write(u, home_file("genres.json"))
  .home_state$version <- (.home_state$version %||% 0) + 1
  invisible(u)
}
#' @rdname genre_set_artist
#' @export
genre_set_song <- function(path, genre) {
  u <- genres_user()
  u$songs[[path]] <- if (nzchar(genre %||% "")) genre_clean(genre) else NULL
  home_json_write(u, home_file("genres.json"))
  .home_state$version <- (.home_state$version %||% 0) + 1
  invisible(u)
}

genre_clean <- function(g) {
  g <- trimws(gsub("\\s+", " ", g))
  substr(g, 1L, 40L)
}

# Online genres: MusicBrainz artist tags, mapped to a short list of display genres
# (the first of an artist's tags, by votes, that is a genre).
GENRE_TAGS <- list(
  "Classic Rock" = c("classic rock", "album rock", "arena rock", "southern rock"),
  "Hard Rock" = c("hard rock", "glam rock", "glam metal", "stoner rock"),
  "Blues Rock" = c("blues rock", "electric blues rock"),
  "Blues" = c("blues", "electric blues", "chicago blues", "delta blues", "texas blues", "modern blues"),
  "Metal" = c("heavy metal", "metal", "thrash metal", "nu metal", "alternative metal", "progressive metal", "death metal",
              "power metal", "metalcore", "black metal", "doom metal", "speed metal", "groove metal"),
  "Punk" = c("punk", "punk rock", "pop punk", "hardcore punk", "skate punk"),
  "Grunge" = c("grunge", "post-grunge"),
  "Alternative" = c("alternative rock", "alternative", "indie rock", "indie", "britpop", "post-punk", "new wave", "emo"),
  "Progressive Rock" = c("progressive rock", "art rock", "psychedelic rock", "space rock"),
  "Pop" = c("pop", "pop rock", "synth-pop", "dance-pop", "power pop", "soft rock"),
  "Rock" = c("rock", "rock and roll", "rock & roll", "rockabilly", "garage rock", "surf rock", "blues-rock"),
  "Funk & Soul" = c("funk", "soul", "r&b", "rhythm and blues", "motown", "disco"),
  "Jazz" = c("jazz", "jazz fusion", "smooth jazz", "swing"),
  "Country" = c("country", "country rock", "americana", "bluegrass", "outlaw country"),
  "Folk" = c("folk", "folk rock", "singer-songwriter", "acoustic"),
  "Latin" = c("latin", "latin rock", "latin pop", "salsa", "bossa nova"),
  "Reggae" = c("reggae", "ska", "dub"),
  "Hip Hop" = c("hip hop", "rap", "rap rock", "rap metal"),
  "Electronic" = c("electronic", "electronica", "house", "techno", "industrial", "edm")
)

#' The display genre of a set of tags (names, most votes first), or NA.
#' @noRd
genre_from_tags <- function(tags) {
  tags <- tolower(trimws(tags))
  for (t in tags) for (g in names(GENRE_TAGS)) if (t %in% GENRE_TAGS[[g]]) return(g)
  NA_character_
}

genres_online_file <- function() file.path(cache_root(), "genres", "artists.json")
genres_online_cache <- function() {
  f <- genres_online_file()
  stamp <- if (file.exists(f)) paste(file.info(f)$mtime, file.info(f)$size) else ""
  if (!identical(.home_state$genre_stamp, stamp) || !identical(.home_state$genre_file, f)) {
    .home_state$genre_cache <- home_json_read(f, list())
    .home_state$genre_stamp <- stamp
    .home_state$genre_file <- f
  }
  .home_state$genre_cache
}

MUSICBRAINZ_API <- "https://musicbrainz.org/ws/2"

#' GET a MusicBrainz endpoint (JSON). MusicBrainz asks for a descriptive
#' User-Agent and at most one request per second (genres_background() waits).
#' @noRd
musicbrainz_fetch <- function(url) {
  old <- options(timeout = getOption("rockshiny.lyrics_timeout", 10))
  on.exit(options(old), add = TRUE)
  con <- url(url, headers = c(`User-Agent` = "RockShiny/0.1 (karaoke and note-highway player; R)", Accept = "application/json"))
  on.exit(close(con), add = TRUE)
  res <- readLines(con, warn = FALSE, encoding = "UTF-8")
  jsonlite::fromJSON(paste(res, collapse = "\n"), simplifyVector = FALSE)
}

#' Look an artist's genre up on MusicBrainz (artist search; its tags) and cache
#' the answer (also "none found"; network errors are not cached).
#' @param artist the artist's name.
#' @param fetch HTTP function (tests pass a fake).
#' @return the display genre, or NA.
#' @export
genre_lookup_artist <- function(artist, fetch = musicbrainz_fetch) {
  key <- artist_key(artist)
  if (!nzchar(key)) return(NA_character_)
  name <- sub("\\s*[([].*$", "", trimws(artist))
  name <- strsplit(name, "\\s+(?:&|and|feat\\.?|ft\\.?|with)\\s+", perl = TRUE)[[1]][1]
  q <- utils::URLencode(sprintf('artist:"%s"', gsub('"', "", name)), reserved = TRUE)
  res <- fetch(sprintf("%s/artist/?query=%s&fmt=json&limit=5", MUSICBRAINZ_API, q))
  genre <- NA_character_
  tags <- character()
  norm <- function(x) gsub("[^a-z0-9]+", "", tolower(ascii_fold(x %||% "")))
  for (a in res$artists %||% list()) {
    score <- as.numeric(a$score %||% 0)
    if (score < 80 || !identical(norm(a$name), norm(name))) next
    t <- a$tags %||% list()
    if (!length(t)) next
    cnt <- vapply(t, function(x) as.numeric(x$count %||% 0), numeric(1))
    tags <- vapply(t, function(x) as.character(x$name %||% ""), character(1))[order(-cnt)]
    genre <- genre_from_tags(tags)
    if (!is.na(genre)) break
  }
  cache <- genres_online_cache()
  cache[[key]] <- list(genre = genre, tags = utils::head(tags, 8), source = "musicbrainz",
                       time = format(Sys.time(), "%Y-%m-%dT%H:%M:%S"))
  home_json_write(cache, genres_online_file())
  .home_state$version <- (.home_state$version %||% 0) + 1
  genre
}

#' Artists whose genre is not known yet (not set by hand, not looked up lately).
#' @noRd
genres_missing <- function(artists, retry_days = 30) {
  key <- unique(artist_key(artists[!is.na(artists) & nzchar(artists)]))
  u <- genres_user()$artists
  o <- genres_online_cache()
  fresh <- vapply(key, function(k) {
    e <- o[[k]]
    if (is.null(e)) return(FALSE)
    if (!is.null(e$genre) && !is.na(e$genre)) return(TRUE)
    age <- tryCatch(as.numeric(difftime(Sys.time(), as.POSIXct(e$time, format = "%Y-%m-%dT%H:%M:%S"), units = "days")),
                    error = function(e) Inf)
    isTRUE(age < retry_days)
  }, logical(1))
  key[!fresh & !key %in% names(u)]
}

#' Look up the genres of the library's artists in the background, one request
#' per ~1.1 s (MusicBrainz's rate limit), between Shiny's work. Stops at the first
#' network error (offline). Off with options(rockshiny.genres_online = FALSE).
#' @noRd
genres_background <- function(artists, fetch = musicbrainz_fetch) {
  if (!isTRUE(getOption("rockshiny.genres_online", TRUE)) || isTRUE(.home_state$genre_running)) return(invisible(FALSE))
  todo <- genres_missing(artists)
  if (!length(todo)) return(invisible(FALSE))
  # the display names of those artists
  names_by_key <- tapply(artists, artist_key(artists), function(x) x[1])
  .home_state$genre_running <- TRUE
  step <- function(i) {
    if (i > length(todo)) { .home_state$genre_running <- FALSE; return(invisible()) }
    ok <- tryCatch({ genre_lookup_artist(names_by_key[[todo[i]]] %||% todo[i], fetch); TRUE },
                   error = function(e) { message("RockShiny: genre lookup stopped (", conditionMessage(e), ")"); FALSE })
    if (!ok) { .home_state$genre_running <- FALSE; return(invisible()) }
    later::later(function() step(i + 1L), 1.1)
  }
  later::later(function() step(1L), 2)
  invisible(TRUE)
}

#' Version counter of the user's home data (playlists, history, genres).
#' @noRd
home_version <- function() .home_state$version %||% 0

# ---- shuffle ---------------------------------------------------------------------------

#' A song picked at random: each app start (and each Shuffle) opens another one,
#' not one of the last few picked (remembered in the data folder).
#' @param lib a library from `library_open()`.
#' @param need "lyrics": a song with lyrics in the file (it can be sung), if there
#'   is one; "any": any Rocksmith song.
#' @return a path, or NULL for an empty library.
#' @export
random_song <- function(lib, need = c("lyrics", "any")) {
  need <- match.arg(need)
  s <- library_all_songs(lib)
  s <- s[s$kind == "psarc" & s$source != "examples", , drop = FALSE]
  if (!nrow(s)) return(NULL)
  paths <- s$path
  if (need == "lyrics" && any(s$lyrics %in% TRUE)) paths <- s$path[s$lyrics %in% TRUE]
  f <- home_file("random.json")
  recent <- unlist(home_json_read(f, list())$recent %||% list())
  pool <- setdiff(paths, recent)
  if (!length(pool)) pool <- paths
  pick <- pool[sample.int(length(pool), 1L)]
  keep <- min(10L, max(1L, length(paths) %/% 2L))
  tryCatch(home_json_write(list(recent = as.list(utils::head(c(pick, setdiff(recent, pick)), keep))), f), error = function(e) NULL)
  pick
}

# Library stress test (run in webR or R):
#   RS_WEBR_MOUNTS=/tmp/biglib=/biglib node tests/webr/run_webr.mjs tests/perf/library_bench.R
#   R: devtools::load_all(); options(rs.bench_dir = "~/path/to/library"); source("tests/perf/library_bench.R")
# The library can be generated with tests/reference/make_big_library.py. It runs on a
# temporary cache (your library index and audio cache are not touched).
dir <- getOption("rs.bench_dir", if (dir.exists("/biglib")) "/biglib" else "songs")
now <- function() proc.time()[[3]]
old <- options(rockshiny.cache_dir = file.path(tempdir(), "rs-bench-cache"))
unlink(library_index_file())
t <- now(); files <- library_files(dir, recursive = TRUE); t_list <- now() - t
sz <- sum(file.info(files)$size)
cat(sprintf("library: %s, %d files, %.2f GB; listing %.2f s\n", dir, length(files), sz / 1e9, t_list))

t <- now(); lib <- library_open(dir, recursive = TRUE, budget = 1); t_open <- now() - t
cat(sprintf("first open (no index, 1 s scan budget): %.2f s (mapping %.2f s), lazy = %s, scanned %d, pending %d\n",
            t_open, lib$map_seconds, lib$lazy, sum(lib$songs$scanned), lib$pending))
g <- karaoke_groups(lib)
cat(sprintf("  karaoke lists right away: %d with lyrics, %d to look up online, %d not checked yet\n",
            length(g$with), length(g$online), length(g$unknown)))
t <- now(); n0 <- sum(lib$songs$scanned); slices <- 0
while (lib$pending) { lib <- library_scan_more(lib, 0.25); slices <- slices + 1 }
t_scan <- now() - t
cat(sprintf("background scan of the rest: %.1f s in %d slices of 0.25 s (%.1f ms per file, index write included)\n",
            t_scan, slices, 1000 * t_scan / (nrow(lib$songs) - n0)))
t <- now(); lib2 <- library_open(dir, recursive = TRUE); t_re <- now() - t
cat(sprintf("reopen (index): %.2f s, scanned %d/%d, pending %d\n", t_re, sum(lib2$songs$scanned), nrow(lib2$songs), lib2$pending))
t <- now(); g <- karaoke_groups(lib2); ch <- library_choices_of(lib2); t_g <- now() - t
cat(sprintf("karaoke groups + instrument choices: %.2f s -> %d with lyrics, %d online, %d unknown; %d choices\n",
            t_g, length(g$with), length(g$online), length(g$unknown), length(ch)))
s <- lib2$songs
cat(sprintf("scan errors: %d; with lyrics (archive): %d; without: %d\n", sum(!is.na(s$error)), sum(s$lyrics %in% TRUE), sum(s$lyrics %in% FALSE)))
# one song opened like the app does when it is selected (md5 + lyrics + metadata)
p <- g$with[[1]]
t <- now(); k <- load_karaoke_song(p, online = FALSE); library_note_key(p, k$key); t_sel <- now() - t
cat(sprintf("select one song (md5 %.1f MB + lyrics): %.2f s\n", file.info(p)$size / 1e6, t_sel))
cat(sprintf("index file: %.0f KB\n", file.info(library_index_file())$size / 1024))
options(old)

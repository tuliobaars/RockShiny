# Run the project's testthat files in webR (see run_webr.mjs):
#   node tests/webr/run_webr.mjs tests/webr/run_tests.R
# Only the files whose dependencies the shims provide (openssl AES, xml2 flat
# element lists, jsonlite); the rest need the real packages or external tools.
source("tests/webr/testthat-shim.R")
files <- file.path("tests/testthat", c("test-karaoke.R", "test-lyrics-online.R", "test-library.R", "test-home.R", "test-crypto.R", "test-psarc.R", "test-vocals-practice.R"))
res <- run_tests(files)
if (length(list.files("songs", "\\.psarc$")) < 18L) {
  message("(test-vocals-practice.R expects the full 18-song library: 13 songs with lyrics)")
}

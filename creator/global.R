# -----------------------------------------------------------------------------
# global.R -- RockShiny Creator: load everything the app and the module need.
#
# Standalone:        shiny::runApp("creator")     (Shiny sources this file first)
# Inside RockShiny:  source("creator/global.R", local = TRUE) in RockShiny's
#                    app.R, then mod_creator_ui("creator") in the UI and
#                    mod_creator_server("creator", lib = lib) in the server.
#
# The Creator builds on RockShiny's R code (PSARC reading, chart parsing,
# lyrics lookup, audio conversion, the library): from the RockShiny project
# above this folder, or -- the creator/ folder on its own -- from the copy in
# creator/rockshiny/. When it runs inside RockShiny, that code is already
# loaded and is not loaded twice.
# Shiny's own autoloading of R/ is off (R/_disable_autoload.R): this file
# loads R/ itself, so that it can also be sourced from the RockShiny app.
# -----------------------------------------------------------------------------
.rsc_env <- environment()                      # where this file is sourced (the app's environment)
local({
  here <- if (file.exists("R/mod_creator.R")) "." else if (file.exists("creator/R/mod_creator.R")) "creator" else
    getOption("rockshiny.creator.root", stop("global.R: cannot find the Creator folder (run from RockShiny or creator/)."))
  here <- normalizePath(here, winslash = "/")
  # RockShiny's code: the project above this folder, else the copy bundled in creator/rockshiny/
  # (the creator/ folder on its own; refreshed by tools/vendor_rockshiny.py)
  rockshiny <- getOption("rockshiny.root")
  if (is.null(rockshiny)) {
    parent <- normalizePath(file.path(here, ".."), winslash = "/")
    rockshiny <- if (file.exists(file.path(parent, "R", "psarc.R")) && dir.exists(file.path(parent, "inst", "app"))) parent
                 else normalizePath(file.path(here, "rockshiny"), winslash = "/")
  }
  if (!file.exists(file.path(rockshiny, "R", "psarc.R"))) stop("global.R: RockShiny's R/ folder is not in ", rockshiny)
  standalone <- identical(normalizePath(rockshiny, winslash = "/"), normalizePath(file.path(here, "rockshiny"), winslash = "/"))
  env <- .rsc_env
  if (!exists("psarc_open", envir = env, mode = "function")) {
    for (f in list.files(file.path(rockshiny, "R"), pattern = "[.]R$", full.names = TRUE)) sys.source(f, envir = env)
  }
  for (f in list.files(file.path(here, "R"), pattern = "^[^_].*[.]R$", full.names = TRUE)) sys.source(f, envir = env)
  if (is.null(getOption("rockshiny.root"))) options(rockshiny.root = rockshiny)   # RockShiny's assets (inst/)
  # RockShiny's default library ("songs", relative) is relative to RockShiny's folder, not to creator/
  lib <- get("library_dir", envir = env)()
  if (is.null(getOption("rockshiny.library_dir")) && !grepl("^(/|~|[A-Za-z]:)", lib) && !dir.exists(lib)) {
    if (!standalone && dir.exists(file.path(rockshiny, lib))) {
      options(rockshiny.library_dir = normalizePath(file.path(rockshiny, lib), winslash = "/"))
    } else if (standalone) {
      # on its own: the library is creator/songs/ (made when first needed: saves go there)
      songs <- file.path(here, "songs")
      if (!dir.exists(songs)) dir.create(songs, showWarnings = FALSE)
      options(rockshiny.library_dir = normalizePath(songs, winslash = "/"))
    }
  }
  options(rockshiny.creator.root = here)
  # a .psarc is 2-70 MB; the studio also saves packages back to the server
  if ((getOption("shiny.maxRequestSize") %||% 0) < 512 * 1024^2) options(shiny.maxRequestSize = 512 * 1024^2)
})
rm(.rsc_env)

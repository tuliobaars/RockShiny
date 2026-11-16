# -----------------------------------------------------------------------------
# creator_assets.R -- the Creator's front end: one list of files, used by the
# Shiny dependency (mod_studio_ui()) and by the offline page
# (creator_build_html()), so both run exactly the same code.
#
#   creator/inst/engine/  the codec (PSARC, SNG, XML, Wwise audio, DDS, manifests)
#                         and the signal processing (beats, stems)
#   creator/inst/studio/  the studio (timeline editor, inspector, audio, tools)
#   creator/inst/page/    the offline page host
#   inst/karaoke/karaoke-sync.js  (RockShiny) LRC parsing, syllables, LRCLIB, lyrics sync
# -----------------------------------------------------------------------------

CREATOR_VERSION <- "0.1.0"

CREATOR_ENGINE_JS <- c("rsc-core.js", "rsc-aes.js", "rsc-psarc.js", "rsc-xml.js", "rsc-sng.js", "rsc-arrangement.js",
                       "rsc-compile.js", "rsc-vocals.js", "rsc-manifest.js", "rsc-codebooks.js", "rsc-wem.js", "rsc-dds.js",
                       "rsc-project.js", "rsc-difficulty.js", "rsc-demo.js", "rsc-dsp.js", "rsc-beats.js", "rsc-sync.js", "rsc-voice.js", "rsc-transcribe.js", "rsc-stems.js")
CREATOR_STUDIO_JS <- c("rsc-audio.js", "rsc-studio.js", "rsc-timeline.js", "rsc-inspector.js", "rsc-tools.js", "rsc-fill.js", "rsc-help.js")

#' The Creator's folder (the one with app.R, global.R and R/).
#' @noRd
creator_dir <- function() {
  d <- getOption("rockshiny.creator.root")
  if (!is.null(d) && dir.exists(d)) return(normalizePath(d, winslash = "/"))
  for (cand in c(".", "creator", file.path(getOption("rockshiny.root", "."), "creator"))) {
    if (file.exists(file.path(cand, "R", "mod_creator.R"))) return(normalizePath(cand, winslash = "/"))
  }
  stop("Cannot find the RockShiny Creator folder (set options(rockshiny.creator.root = ...)).", call. = FALSE)
}

#' A folder of the Creator's front end: "engine", "studio" or "page".
#' @noRd
creator_asset_dir <- function(sub) {
  d <- file.path(creator_dir(), "inst", sub)
  if (!dir.exists(d)) stop("Missing Creator assets: ", d, call. = FALSE)
  normalizePath(d, winslash = "/")
}

#' RockShiny's lyrics tools (karaoke-sync.js): LRC parser, syllables, LRCLIB, aligner.
#' @noRd
creator_karaoke_sync_file <- function() {
  f <- file.path(asset_dir("karaoke"), "karaoke-sync.js")
  if (!file.exists(f)) stop("RockShiny's inst/karaoke/karaoke-sync.js is missing.", call. = FALSE)
  f
}

#' htmlDependencies of the studio (engine, RockShiny's lyrics tools, studio, Shiny bridge).
#' @noRd
creator_dependencies <- function() {
  list(
    htmltools::htmlDependency("rockshiny-creator-engine", CREATOR_VERSION, src = c(file = creator_asset_dir("engine")),
                              script = CREATOR_ENGINE_JS),
    htmltools::htmlDependency("rockshiny-karaoke-sync", CREATOR_VERSION, src = c(file = dirname(creator_karaoke_sync_file())),
                              script = "karaoke-sync.js"),
    htmltools::htmlDependency("rockshiny-creator-studio", CREATOR_VERSION, src = c(file = creator_asset_dir("studio")),
                              script = c(CREATOR_STUDIO_JS, "rsc-shiny.js"), stylesheet = c("creator.css", "creator-shiny.css"))
  )
}

# -----------------------------------------------------------------------------
# RockShiny Creator -- the admin and song-making studio for RockShiny.
#
#   shiny::runApp("creator")      this app on its own (global.R loads everything)
#   creator_build_html()          the same studio as one offline HTML file
#
# Open a Rocksmith 2014 .psarc (the library, or a dropped file) or start a new
# song from an audio file; edit beats, sections, charts and lyrics on the
# timeline; pull out stems; fetch and sync lyrics; save a .psarc for PC or Mac
# into the library (checked with RockShiny's readers) or as a download.
#
# The same module runs inside the RockShiny app (its "Creator" page): see
# R/mod_creator.R. Assets: inst/engine (codec), inst/studio, inst/page.
# -----------------------------------------------------------------------------
library(shiny)
if (!exists("mod_creator_ui", mode = "function")) source("global.R", local = TRUE)   # runApp() has sourced it already

ui <- function(req) creator_page("creator", library_ui = mod_library_bar_ui("library", "creator"))

server <- function(input, output, session) {
  lib <- mod_library_server("library")
  mod_creator_server("creator", lib = lib)
}

shinyApp(ui, server)

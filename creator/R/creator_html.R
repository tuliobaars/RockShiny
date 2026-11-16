# -----------------------------------------------------------------------------
# creator_html.R -- RockShiny Creator as one standalone HTML file: the studio,
# its engine and RockShiny's lyrics tools inlined, no server and no network
# needed (the online lyrics lookup is the only thing that uses the network,
# and only when asked). Open it from disk in Chrome, Edge or Firefox.
#
#   creator_build_html("RockShinyCreator.html")
# -----------------------------------------------------------------------------

#' Write the offline Creator (one self-contained .html file).
#' @param file output path.
#' @param title page title.
#' @return `file`, invisibly.
#' @export
creator_build_html <- function(file = file.path(creator_dir(), "RockShinyCreator.html"), title = "RockShiny Creator") {
  read <- function(f) paste(readLines(f, encoding = "UTF-8", warn = FALSE), collapse = "\n")
  script <- function(code, name) paste0("<script>/* ", name, " */\n", gsub("</(script)", "<\\\\/\\1", code, ignore.case = TRUE, perl = TRUE), "\n</script>")
  eng <- creator_asset_dir("engine"); stu <- creator_asset_dir("studio"); pg <- creator_asset_dir("page")
  js <- c(
    vapply(CREATOR_ENGINE_JS, function(f) script(read(file.path(eng, f)), f), ""),
    script(read(creator_karaoke_sync_file()), "karaoke-sync.js (RockShiny)"),
    vapply(CREATOR_STUDIO_JS, function(f) script(read(file.path(stu, f)), f), ""),
    script(read(file.path(pg, "rsc-page.js")), "rsc-page.js")
  )
  css <- paste0("<style>\n", read(file.path(stu, "creator.css")), "\n", read(file.path(pg, "page.css")), "\n</style>")
  html <- read(file.path(pg, "page.html"))
  fill <- function(h, key, value) { parts <- strsplit(h, key, fixed = TRUE)[[1]]; paste(parts, collapse = value) }
  html <- fill(html, "{{TITLE}}", htmltools::htmlEscape(title))
  html <- fill(html, "{{VERSION}}", CREATOR_VERSION)
  html <- fill(html, "{{STYLE}}", css)
  html <- fill(html, "{{SCRIPTS}}", paste(js, collapse = "\n"))
  dir.create(dirname(normalizePath(file, mustWork = FALSE)), showWarnings = FALSE, recursive = TRUE)
  con <- file(file, open = "wb")
  on.exit(close(con), add = TRUE)
  writeBin(charToRaw(enc2utf8(html)), con)
  invisible(file)
}

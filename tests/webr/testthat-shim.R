# Minimal testthat/withr stand-in for webR (dev tooling): enough of the API to
# run the project's tests/testthat files unchanged and report pass/fail/skip.
.tt <- new.env()
.tt$results <- data.frame(file = character(), test = character(), status = character(), msg = character())
.tt$cleanup <- list()
.tt$file <- ""

.tt_fail <- function(msg, info = NULL) stop(structure(class = c("tt_failure", "error", "condition"),
  list(message = paste0(msg, if (!is.null(info)) paste0(" [", paste(info, collapse = " "), "]")), call = NULL)))
.tt_lab <- function(x) paste(utils::head(deparse(x), 1), collapse = "")

test_that <- function(desc, code) {
  .tt$cleanup <- list()
  status <- "pass"; msg <- ""
  tryCatch(eval(substitute(code), new.env(parent = parent.frame())),
    tt_skip = function(e) { status <<- "skip"; msg <<- conditionMessage(e) },
    error = function(e) { status <<- if (inherits(e, "tt_failure")) "FAIL" else "ERROR"; msg <<- conditionMessage(e) })
  for (f in rev(.tt$cleanup)) try(f(), silent = TRUE)
  .tt$results[nrow(.tt$results) + 1L, ] <- list(.tt$file, desc, status, msg)
  cat(sprintf("  %-5s %s%s\n", status, desc, if (nzchar(msg)) paste0("\n        ", gsub("\n", "\n        ", msg)) else ""))
  invisible(status == "pass")
}
skip <- function(message = "skipped") stop(structure(class = c("tt_skip", "condition"), list(message = message, call = NULL)))
skip_if <- function(condition, message = "condition is TRUE") if (isTRUE(condition)) skip(message)
skip_if_not <- function(condition, message = "condition is FALSE") if (!isTRUE(condition)) skip(message)
skip_on_os <- function(os, ...) invisible(NULL)
skip_on_cran <- function() invisible(NULL)
skip_if_not_installed <- function(pkg, ...) if (!requireNamespace(pkg, quietly = TRUE)) skip(paste(pkg, "not installed"))
test_path <- function(...) file.path("tests", "testthat", ...)

expect_true <- function(object, info = NULL, ...) if (!isTRUE(object)) .tt_fail(paste(.tt_lab(substitute(object)), "is not TRUE"), info)
expect_false <- function(object, info = NULL, ...) if (!isFALSE(object)) .tt_fail(paste(.tt_lab(substitute(object)), "is not FALSE"), info)
expect_null <- function(object, info = NULL, ...) if (!is.null(object)) .tt_fail(paste(.tt_lab(substitute(object)), "is not NULL"), info)
expect_identical <- function(object, expected, info = NULL, ...) {
  if (!identical(object, expected)) .tt_fail(paste0(.tt_lab(substitute(object)), " not identical to ", .tt_lab(substitute(expected)),
    ": ", paste(utils::head(format(object), 6), collapse = " "), " vs ", paste(utils::head(format(expected), 6), collapse = " ")), info)
}
expect_equal <- function(object, expected, tolerance = 1.5e-8, info = NULL, ...) {
  r <- all.equal(expected, object, tolerance = tolerance, check.attributes = FALSE)
  if (!isTRUE(r)) .tt_fail(paste0(.tt_lab(substitute(object)), " != ", .tt_lab(substitute(expected)), ": ", paste(r, collapse = "; ")), info)
}
expect_length <- function(object, n, info = NULL) if (length(object) != n) .tt_fail(sprintf("%s has length %d, not %d", .tt_lab(substitute(object)), length(object), n), info)
expect_gt <- function(object, expected, info = NULL) if (!isTRUE(all(object > expected))) .tt_fail(sprintf("%s (%s) not > %s", .tt_lab(substitute(object)), format(object), format(expected)), info)
expect_gte <- function(object, expected, info = NULL) if (!isTRUE(all(object >= expected))) .tt_fail(sprintf("%s (%s) not >= %s", .tt_lab(substitute(object)), format(object), format(expected)), info)
expect_lt <- function(object, expected, info = NULL) if (!isTRUE(all(object < expected))) .tt_fail(sprintf("%s (%s) not < %s", .tt_lab(substitute(object)), format(object), format(expected)), info)
expect_lte <- function(object, expected, info = NULL) if (!isTRUE(all(object <= expected))) .tt_fail(sprintf("%s (%s) not <= %s", .tt_lab(substitute(object)), format(object), format(expected)), info)
expect_match <- function(object, regexp, fixed = FALSE, all = TRUE, info = NULL, ...) {
  ok <- grepl(regexp, object, fixed = fixed)
  if (!length(ok) || !(if (all) all(ok) else any(ok))) .tt_fail(sprintf("'%s' does not match '%s'", paste(object, collapse = "', '"), regexp), info)
}
expect_type <- function(object, type) if (!identical(typeof(object), type)) .tt_fail(sprintf("type %s, not %s", typeof(object), type))
expect_s3_class <- function(object, class) if (!inherits(object, class)) .tt_fail(sprintf("not of class %s", class))
expect_error <- function(object, regexp = NULL, ...) {
  err <- tryCatch({ object; NULL }, error = function(e) e)
  if (is.null(err)) .tt_fail(paste(.tt_lab(substitute(object)), "did not throw an error"))
  if (!is.null(regexp) && !grepl(regexp, conditionMessage(err))) .tt_fail(sprintf("error '%s' does not match '%s'", conditionMessage(err), regexp))
}
expect_warning <- function(object, regexp = NULL, ...) {
  w <- NULL
  withCallingHandlers(object, warning = function(x) { w <<- x; invokeRestart("muffleWarning") })
  if (is.null(w)) .tt_fail(paste(.tt_lab(substitute(object)), "did not warn"))
  if (!is.null(regexp) && !grepl(regexp, conditionMessage(w))) .tt_fail(sprintf("warning '%s' does not match '%s'", conditionMessage(w), regexp))
}
expect_no_error <- function(object, ...) { object; invisible(TRUE) }

shim_namespace("withr", list(
  local_tempdir = function(...) { d <- tempfile("tt"); dir.create(d); .tt$cleanup[[length(.tt$cleanup) + 1L]] <- function() unlink(d, TRUE); d },
  local_options = function(.new = list(), ...) {
    new <- c(.new, list(...)); old <- options(new)
    .tt$cleanup[[length(.tt$cleanup) + 1L]] <- function() options(old)
    invisible(old)
  },
  local_envvar = function(.new = list(), ...) {
    new <- unlist(c(.new, list(...))); old <- Sys.getenv(names(new), unset = NA, names = TRUE)
    do.call(Sys.setenv, as.list(new))
    .tt$cleanup[[length(.tt$cleanup) + 1L]] <- function() { for (k in names(old)) if (is.na(old[[k]])) Sys.unsetenv(k) else do.call(Sys.setenv, stats::setNames(list(old[[k]]), k)) }
  }
))

#' Run testthat files (helpers first), print a summary, return the results.
run_tests <- function(files, helpers = list.files("tests/testthat", "^helper.*[.]R$", full.names = TRUE)) {
  env <- new.env(parent = globalenv())
  for (h in helpers) sys.source(h, envir = env)
  for (f in files) {
    .tt$file <- basename(f)
    cat("\n==", basename(f), "\n")
    tryCatch(sys.source(f, envir = new.env(parent = env)), error = function(e) cat("  ERROR loading file:", conditionMessage(e), "\n"))
  }
  r <- .tt$results
  cat(sprintf("\n[ pass %d | fail %d | error %d | skip %d ]\n", sum(r$status == "pass"), sum(r$status == "FAIL"),
              sum(r$status == "ERROR"), sum(r$status == "skip")))
  invisible(r)
}

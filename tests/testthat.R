# Run by R CMD check (working directory: <pkg>.Rcheck/tests). Interactively:
# devtools::test(), or testthat::test_dir("tests/testthat") from the project root.
# Tests that need a particular song skip when it is not in songs/ (which is not
# part of the built package, so under R CMD check they all skip).
library(testthat)
library(RockShiny)
test_check("RockShiny")

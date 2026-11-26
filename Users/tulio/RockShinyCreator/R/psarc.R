# -----------------------------------------------------------------------------
# psarc.R -- PlayStation ARChive reader (Rocksmith 2014 flavour).
#
# Layout (all big-endian):
#   0  char[4]  magic            "PSAR"
#   4  u16/u16  version          1.4
#   8  char[4]  compression      "zlib"
#  12  u32      toc_length       header + TOC size in bytes (TOC ends here)
#  16  u32      toc_entry_size   30
#  20  u32      toc_entries      number of entries (entry 0 = file-name manifest)
#  24  u32      block_size       65536
#  28  u32      archive_flags    4 => TOC is AES-256-CFB encrypted
#  32  TOC      entries[n] then the block-length table (u16 per block)
#
# TOC entry (30 bytes): md5[16] | zindex u32 | length uint40 | offset uint40
#
# Each file is stored as consecutive blocks starting at `offset`; block k of
# the file has compressed length zlengths[zindex + k]. A zlength of 0 means a
# full, *uncompressed* block of block_size bytes. Otherwise the block is zlib
# data -- unless inflation fails, in which case it was stored raw.
# -----------------------------------------------------------------------------

PSARC_HEADER_SIZE <- 32L

#' Read the 32-byte PSARC header.
#' @param filepath path of a .psarc file.
#' @export
read_psarc_header <- function(filepath) {
  if (!file.exists(filepath)) stop("File not found: ", filepath)
  con <- file(filepath, "rb")
  on.exit(close(con))
  parse_psarc_header(readBin(con, "raw", PSARC_HEADER_SIZE))
}

parse_psarc_header <- function(hdr) {
  if (length(hdr) < PSARC_HEADER_SIZE || rawToChar(hdr[1:4]) != "PSAR") {
    stop("Invalid file format: magic bytes 'PSAR' not found.")
  }
  be32 <- function(i) be_uint_cols(matrix(hdr[i:(i + 3L)], nrow = 4L))
  list(
    version        = paste(be_uint_cols(matrix(hdr[5:6], 2L)), be_uint_cols(matrix(hdr[7:8], 2L)), sep = "."),
    compression    = rawToChar(hdr[9:12]),
    toc_length     = be32(13L),
    toc_entry_size = be32(17L),
    num_entries    = be32(21L),
    block_size     = be32(25L),
    archive_flags  = be32(29L)
  )
}

#' Open a PSARC: decrypt + decode the TOC and resolve file names.
#'
#' @param filepath path of a .psarc file.
#' @return An object of class "psarc": list(path, header, entries, zlengths).
#'   `entries` is a data.frame with one row per file (the name manifest entry
#'   is removed) and columns name, md5, zindex, length, offset.
#' @export
psarc_open <- function(filepath) {
  filepath <- normalizePath(filepath, mustWork = TRUE)
  con <- file(filepath, "rb")
  on.exit(close(con))

  header <- parse_psarc_header(readBin(con, "raw", PSARC_HEADER_SIZE))
  if (header$compression != "zlib") stop("Unsupported PSARC compression: ", header$compression)

  toc <- readBin(con, "raw", header$toc_length - PSARC_HEADER_SIZE)
  if (has_bit(header$archive_flags, 4)) {
    toc <- aes_cfb128_decrypt(toc, hex_to_raw(RS_KEYS$psarc_toc_key), hex_to_raw(RS_KEYS$psarc_toc_iv))
  }

  # --- fixed-size entries, decoded column-wise (one matrix column per entry)
  n   <- header$num_entries
  esz <- header$toc_entry_size
  m   <- matrix(toc[seq_len(n * esz)], nrow = esz)
  entries <- data.frame(
    md5    = apply(m[1:16, , drop = FALSE], 2L, paste, collapse = ""),
    zindex = be_uint_cols(m[17:20, , drop = FALSE]),
    length = be_uint_cols(m[21:25, , drop = FALSE]),
    offset = be_uint_cols(m[26:30, , drop = FALSE]),
    stringsAsFactors = FALSE
  )

  # --- block-length table: the rest of the TOC. Width = bytes needed to
  # express block_size - 1 (2 for the standard 64 KiB blocks).
  zwidth <- if (header$block_size <= 65536) 2L else if (header$block_size <= 16777216) 3L else 4L
  zraw   <- toc[-seq_len(n * esz)]
  nz     <- length(zraw) %/% zwidth
  zlengths <- be_uint_cols(matrix(zraw[seq_len(nz * zwidth)], nrow = zwidth))

  arc <- structure(
    list(path = filepath, header = header, entries = entries, zlengths = zlengths),
    class = "psarc"
  )

  # --- entry 0 is a newline-separated manifest naming entries 1..n-1
  manifest <- rawToChar(psarc_read(arc, 1L))
  file_names <- strsplit(gsub("\r", "", manifest, fixed = TRUE), "\n", fixed = TRUE)[[1]]
  length(file_names) <- n - 1L
  arc$entries$name <- c("<manifest>", file_names)
  arc$entries <- arc$entries[-1L, c("name", "md5", "zindex", "length", "offset")]
  rownames(arc$entries) <- NULL
  arc
}

#' Print an archive: its entries.
#' @param x the object.
#' @param ... ignored.
#' @export
print.psarc <- function(x, ...) {
  cat("<psarc>", basename(x$path), "-", nrow(x$entries), "files, version", x$header$version, "\n")
  invisible(x)
}

#' Read one archive entry.
#'
#' @param arc   A "psarc" object.
#' @param entry Entry row index (into the *full* TOC for internal use when
#'   numeric and `raw_index = TRUE`) or a file name inside the archive.
#' @param out   Optional file path: stream blocks to disk instead of memory
#'   (use for the multi-megabyte .wem audio).
#' @return raw vector (or, with `out`, the output path invisibly).
#' @export
psarc_read <- function(arc, entry, out = NULL) {
  e <- psarc_entry(arc, entry)
  con <- file(arc$path, "rb")
  on.exit(close(con), add = TRUE)

  sink_con <- NULL
  if (!is.null(out)) {
    dir.create(dirname(out), showWarnings = FALSE, recursive = TRUE)
    sink_con <- file(out, "wb")
    on.exit(close(sink_con), add = TRUE)
  }

  seek(con, e$offset)
  remaining <- e$length
  z <- e$zindex + 1                      # zlengths is 1-based in R
  chunks <- vector("list", 0L)
  bsize  <- arc$header$block_size

  while (remaining > 0) {
    zlen <- arc$zlengths[z]
    z <- z + 1
    if (is.na(zlen)) stop("Corrupt PSARC: block table exhausted for ", e$name)
    block <- if (zlen == 0) {
      readBin(con, "raw", bsize)
    } else {
      packed <- readBin(con, "raw", zlen)
      inflate_or_raw(packed)
    }
    if (length(block) > remaining) block <- block[seq_len(remaining)]
    remaining <- remaining - length(block)
    if (is.null(sink_con)) chunks[[length(chunks) + 1L]] <- block else writeBin(block, sink_con)
    if (length(block) == 0L) stop("Corrupt PSARC: empty block while reading ", e$name)
  }

  if (is.null(sink_con)) unlist(chunks, use.names = FALSE) %||% raw(0) else invisible(out)
}

#' Blocks are zlib streams unless compression did not pay off, in which case
#' the block is stored verbatim. Only try inflating when the zlib header
#' checks out (CMF=0x78 and (CMF*256+FLG) %% 31 == 0) to avoid needless errors.
#' @noRd
inflate_or_raw <- function(packed) {
  if (length(packed) >= 2L && packed[1] == as.raw(0x78) &&
      ((0x78 * 256 + as.integer(packed[2])) %% 31) == 0) {
    out <- tryCatch(memDecompress(packed, type = "gzip"), error = function(e) NULL)
    if (!is.null(out)) return(out)
  }
  packed
}

psarc_entry <- function(arc, entry) {
  if (is.character(entry)) {
    i <- match(entry, arc$entries$name)
    if (is.na(i)) stop("File not found in archive: ", entry)
    return(as.list(arc$entries[i, ]))
  }
  # numeric: index into the full TOC (1 = name manifest); used by psarc_open()
  if (is.null(arc$entries$name)) {
    return(c(list(name = "<manifest>"), as.list(arc$entries[entry, ])))
  }
  as.list(arc$entries[entry, ])
}

#' Find entries whose name matches a regular expression.
#' @param arc an opened archive (`psarc_open()`).
#' @param pattern regular expression matched against the entry names.
#' @export
psarc_find <- function(arc, pattern) {
  arc$entries$name[grepl(pattern, arc$entries$name, perl = TRUE)]
}

#' List contents of a PSARC file (compatibility wrapper).
#' @param filepath path of a .psarc file.
#' @export
list_psarc_contents <- function(filepath) {
  psarc_open(filepath)$entries
}

#' Extract a specific file from a PSARC archive to `out_dir`.
#' @param filepath path of a .psarc file.
#' @param target_file name of the entry inside the archive.
#' @param out_dir folder to write it to.
#' @export
extract_psarc_file <- function(filepath, target_file, out_dir = ".") {
  arc <- if (inherits(filepath, "psarc")) filepath else psarc_open(filepath)
  psarc_read(arc, target_file, out = file.path(out_dir, target_file))
}

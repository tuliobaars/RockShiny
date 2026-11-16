# -----------------------------------------------------------------------------
# utils.R -- small, dependency-free helpers shared by the binary parsers.
#
# All binary parsing in this app works on in-memory raw vectors with *0-based*
# byte offsets (mirroring the on-disk specs), and is vectorised over offsets so
# that arrays of fixed-size structs can be decoded without R-level loops.
# -----------------------------------------------------------------------------

`%||%` <- function(a, b) if (is.null(a) || length(a) == 0L) b else a

#' Convert a hex string ("0A1B...") to a raw vector.
#' @noRd
hex_to_raw <- function(hex) {
  hex <- gsub("[^0-9A-Fa-f]", "", hex)
  as.raw(strtoi(substring(hex, seq(1L, nchar(hex), 2L), seq(2L, nchar(hex), 2L)), 16L))
}

#' Gather `size` consecutive bytes starting at each 0-based offset.
#' Returns one flat raw vector (bytes of offset 1, then offset 2, ...), which is
#' exactly the layout readBin() expects for `n = length(offsets)` values.
#' @noRd
raw_gather <- function(buf, offsets, size) {
  if (length(offsets) == 0L) return(raw(0))
  buf[as.vector(outer(seq_len(size) - 1, offsets, "+")) + 1]
}

# Little-endian readers, vectorised over 0-based offsets ----------------------
le_f32 <- function(buf, off) readBin(raw_gather(buf, off, 4L), "double",  n = length(off), size = 4L, endian = "little")
le_f64 <- function(buf, off) readBin(raw_gather(buf, off, 8L), "double",  n = length(off), size = 8L, endian = "little")
le_i32 <- function(buf, off) readBin(raw_gather(buf, off, 4L), "integer", n = length(off), size = 4L, endian = "little")
le_i16 <- function(buf, off) readBin(raw_gather(buf, off, 2L), "integer", n = length(off), size = 2L, endian = "little", signed = TRUE)
le_u16 <- function(buf, off) readBin(raw_gather(buf, off, 2L), "integer", n = length(off), size = 2L, endian = "little", signed = FALSE)
u8     <- function(buf, off) as.integer(buf[off + 1])
i8     <- function(buf, off) { v <- as.integer(buf[off + 1]); v - 256L * (v > 127L) }

#' Unsigned 32-bit little-endian as double (R integers are signed 32-bit and
#' 0x80000000 would otherwise read as NA).
#' @noRd
le_u32 <- function(buf, off) le_u16(buf, off) + 65536 * le_u16(buf, off + 2)

#' Unsigned big-endian integer of arbitrary width (e.g. PSARC's 40-bit fields).
#' `bytes` is a raw matrix with one column per value (most significant row first).
#' @noRd
be_uint_cols <- function(bytes) {
  m <- matrix(as.numeric(bytes), nrow = nrow(bytes))
  colSums(m * 256^((nrow(m) - 1):0))
}

#' Look up template frets for (template id, string) pairs; NA when the id is
#' out of range (matrix indexing would otherwise throw "subscript out of bounds").
#' @noRd
template_frets <- function(frets, template_id, string) {
  ok <- !is.na(template_id) & template_id >= 0L & template_id < nrow(frets)
  out <- rep(NA_integer_, length(template_id))
  if (any(ok)) out[ok] <- frets[cbind(template_id[ok] + 1L, string[ok] + 1L)]
  out
}

#' Test a single flag bit on double-encoded bitmasks (safe for bit 31).
#' @noRd
has_bit <- function(mask, bit) (mask %/% bit) %% 2 == 1

#' Zero-terminated fixed-width C string -> character (vectorised over offsets).
#' @noRd
c_string <- function(buf, off, width) {
  vapply(off, function(o) {
    b <- buf[(o + 1):(o + width)]
    nul <- which(b == as.raw(0))[1]
    if (!is.na(nul)) b <- b[seq_len(nul - 1L)]
    out <- rawToChar(b)
    Encoding(out) <- "UTF-8"
    out
  }, character(1))
}

# ASCII folding for file names (karaoke_slug()): accented letters become their base letter,
# ligatures and fractions their letters and digits -- the same on every platform (iconv's
# //TRANSLIT is not: glibc turns "\u00f3" into "o", macOS into "'o") and the same as Python's
# NFKD + ascii("ignore") in tools/karaoke_export_html.py, for Latin-1, Latin Extended-A/B and
# Additional, punctuation, letterlike symbols, ligatures and full-width forms (anything else
# is dropped, as there). Generated from Python's unicodedata; not alphanumeric -> "-".
#' @noRd
ASCII_FOLD <- local({
  cp <- as.integer(c(0xA0, 0xA8, 0xAA, 0xAF, 0xB2:0xB4, 0xB8:0xBA, 0xC0:0xC5, 0xC7:0xCF, 0xD1:0xD6,
                 0xD9:0xDD, 0xE0:0xE5, 0xE7:0xEF, 0xF1:0xF6, 0xF9:0xFD, 0xFF:0x10F, 0x112:0x125,
                 0x128:0x130, 0x134:0x137, 0x139:0x140, 0x143:0x149, 0x14C:0x151, 0x154:0x165,
                 0x168:0x17F, 0x1A0:0x1A1, 0x1AF:0x1B0, 0x1CD:0x1DC, 0x1DE:0x1E1, 0x1E6:0x1ED, 0x1F0,
                 0x1F4:0x1F5, 0x1F8:0x1FB, 0x200:0x21B, 0x21E:0x21F, 0x226:0x233, 0x1E00:0x1E9B,
                 0x1EA0:0x1EF9, 0x2000:0x200A, 0x2017, 0x2024, 0x202F, 0x203E, 0x205F, 0x2102:0x2103,
                 0x2109:0x210E, 0x2110:0x2113, 0x2115, 0x2119:0x211D, 0x2124, 0x2128, 0x212A:0x212D,
                 0x212F:0x2131, 0x2133:0x2134, 0x2139, 0x2145:0x2149, 0x215F:0x2160, 0x2164, 0x2169,
                 0x216C:0x2170, 0x2174, 0x2179, 0x217C:0x217F, 0xFF01:0xFF5E))
  to <- strsplit(paste0("--a-23--1oAAAAAACEEEEIIIINOOOOOUUUUYaaaaaaceeeeiiiinooooouuuuyyAaAaAaCcCcCcCcDdEeEeEeEeEeG",
                        "gGgGgGgHhIiIiIiIiIJjKkLlLlLlLlNnNnNnnOoOoOoRrRrRrSsSsSsSsTtTtUuUuUuUuUuUuWwYyYZzZzZzsOoUuA",
                        "aIiOoUuUuUuUuUuAaAaGgKkOoOojGgNnAaAaAaEeEeIiIiOoOoRrRrUuUuSsTtHhAaEeOoOoOoOoYyAaBbBbBbCcDd",
                        "DdDdDdDdEeEeEeEeEeFfGgHhHhHhHhHhIiIiKkKkKkLlLlLlLlMmMmMmNnNnNnNnOoOoOoOoPpPpRrRrRrRrSsSsSs",
                        "SsSsTtTtTtTtUuUuUuUuUuVvVvWwWwWwWwWwXxXxYyZzZzZzhtwyasAaAaAaAaAaAaAaAaAaAaAaAaEeEeEeEeEeEe",
                        "EeEeIiIiOoOoOoOoOoOoOoOoOoOoOoOoUuUuUuUuUuUuUuYyYyYyYy----------------CCFgHHHhIILlNPQRRRZZ",
                        "KABCeEFMoiDdeij1IVXLCDMivxlcdm---------------0123456789-------ABCDEFGHIJKLMNOPQRSTUVWXYZ--",
                        "----abcdefghijklmnopqrstuvwxyz----"), "")[[1]]
  mcp <- as.integer(c(0xBC, 0xBD, 0xBE, 0x132, 0x133, 0x1C4, 0x1C5, 0x1C6, 0x1C7, 0x1C8, 0x1C9, 0x1CA,
                  0x1CB, 0x1CC, 0x1F1, 0x1F2, 0x1F3, 0x2025, 0x2026, 0x203C, 0x2047, 0x2048, 0x2049,
                  0x2100, 0x2101, 0x2105, 0x2106, 0x2116, 0x2120, 0x2121, 0x2122, 0x213B, 0x2150,
                  0x2151, 0x2152, 0x2153, 0x2154, 0x2155, 0x2156, 0x2157, 0x2158, 0x2159, 0x215A,
                  0x215B, 0x215C, 0x215D, 0x215E, 0x2161, 0x2162, 0x2163, 0x2165, 0x2166, 0x2167,
                  0x2168, 0x216A, 0x216B, 0x2171, 0x2172, 0x2173, 0x2175, 0x2176, 0x2177, 0x2178,
                  0x217A, 0x217B, 0x2189, 0xFB00, 0xFB01, 0xFB02, 0xFB03, 0xFB04, 0xFB05, 0xFB06))
  mto <- c("14", "12", "34", "IJ", "ij", "DZ", "Dz", "dz", "LJ", "Lj", "lj", "NJ", "Nj", "nj", "DZ",
             "Dz", "dz", "--", "---", "--", "--", "--", "--", "a-c", "a-s", "c-o", "c-u", "No", "SM",
             "TEL", "TM", "FAX", "17", "19", "110", "13", "23", "15", "25", "35", "45", "16", "56",
             "18", "38", "58", "78", "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII", "ii",
             "iii", "iv", "vi", "vii", "viii", "ix", "xi", "xii", "03", "ff", "fi", "fl", "ffi",
             "ffl", "st", "st")
  stats::setNames(c(to, mto), c(cp, mcp))
})

#' @noRd
ascii_fold <- function(x) {
  vapply(enc2utf8(as.character(x)), function(s) {
    if (is.na(s)) return(NA_character_)
    cp <- utf8ToInt(s)
    if (anyNA(cp)) return(iconv(s, "UTF-8", "ASCII", sub = ""))
    if (all(cp < 128L)) return(s)
    out <- ifelse(cp < 128L, vapply(cp, intToUtf8, ""), unname(ASCII_FOLD[as.character(cp)]))
    paste(out[!is.na(out)], collapse = "")
  }, character(1), USE.NAMES = FALSE)
}

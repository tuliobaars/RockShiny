# -----------------------------------------------------------------------------
# shims.R -- minimal stand-ins for the compiled packages the R code imports
# (openssl, xml2, jsonlite), so the project's own R files can be *executed* in
# webR (R compiled to WebAssembly, base R only) where no CRAN binaries are
# available. Dev tooling only: never loaded by the app.
#
#   openssl : pure-R AES-256 block cipher -> aes_cbc_encrypt / aes_ctr_decrypt
#   xml2    : read_xml / xml_find_all / xml_attr for flat element lists
#             (enough for the vocals XML: /vocals/vocal[@time, @lyric, ...])
#   jsonlite: fromJSON(simplifyVector = FALSE), toJSON (auto_unbox = FALSE
#             semantics, unbox() scalars, na = "null"), base64_enc/_dec
# Each shim is registered as a real namespace, so `pkg::fun` calls resolve.
# -----------------------------------------------------------------------------

shim_namespace <- function(name, funs) {
  impenv <- new.env(parent = .BaseNamespaceEnv, hash = TRUE)
  attr(impenv, "name") <- paste0("imports:", name)
  env <- new.env(parent = impenv, hash = TRUE)
  info <- new.env(hash = TRUE, parent = baseenv())
  env$.__NAMESPACE__. <- info
  info$spec <- c(name = name, version = "0.0.0-shim")
  setNamespaceInfo(env, "exports", new.env(hash = TRUE, parent = baseenv()))
  setNamespaceInfo(env, "lazydata", new.env(parent = baseenv(), hash = TRUE))
  setNamespaceInfo(env, "imports", list(base = TRUE))
  setNamespaceInfo(env, "path", file.path(tempdir(), name))
  setNamespaceInfo(env, "dynlibs", NULL)
  setNamespaceInfo(env, "S3methods", matrix(NA_character_, 0L, 4L))
  env$.__S3MethodsTable__. <- new.env(hash = TRUE, parent = baseenv())
  for (f in names(funs)) {
    fn <- funs[[f]]
    environment(fn) <- env
    assign(f, fn, envir = env)
  }
  .Internal(registerNamespace(name, env))
  namespaceExport(env, names(funs))
  invisible(env)
}

# ---- openssl: AES-256 -------------------------------------------------------------
.aes <- new.env()
.aes$sbox <- c(
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16)
.aes$xt <- vapply(0:255, function(b) bitwAnd(bitwXor(bitwShiftL(b, 1L), if (b >= 128L) 0x1bL else 0L), 0xffL), integer(1))
.aes$keys <- list()

aes_expand <- function(key) {
  id <- paste(as.character(key), collapse = "")
  if (!is.null(.aes$keys[[id]])) return(.aes$keys[[id]])
  stopifnot(length(key) == 32L)
  sb <- .aes$sbox
  w <- matrix(0L, 4L, 60L)
  w[, 1:8] <- matrix(as.integer(key), 4L)
  rcon <- c(0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40)
  for (i in 9:60) {
    j <- i - 1L; tmp <- w[, i - 1L]
    if (j %% 8L == 0L) { tmp <- sb[c(tmp[2:4], tmp[1]) + 1L]; tmp[1] <- bitwXor(tmp[1], rcon[j %/% 8L]) }
    else if (j %% 8L == 4L) tmp <- sb[tmp + 1L]
    w[, i] <- bitwXor(w[, i - 8L], tmp)
  }
  rk <- lapply(0:14, function(r) as.vector(w[, (4L * r + 1L):(4L * r + 4L)]))
  .aes$keys[[id]] <- rk
  rk
}

# One AES-256 block. SubBytes + ShiftRows + MixColumns of a round are folded
# into four table lookups per byte (M2 = 2*S[x], M3 = 3*S[x]): output byte r of
# column c = M2[a_r] ^ M3[a_r+1] ^ S[a_r+2] ^ S[a_r+3], a = the shifted state.
.aes$shift <- c(1L, 6L, 11L, 16L, 5L, 10L, 15L, 4L, 9L, 14L, 3L, 8L, 13L, 2L, 7L, 12L)
.aes$P <- lapply(0:3, function(k) .aes$shift[as.vector(outer((0:3 + k) %% 4L, 4L * (0:3), "+")) + 1L])
.aes$M2 <- .aes$xt[.aes$sbox + 1L]
.aes$M3 <- bitwXor(.aes$M2, .aes$sbox)
aes_block <- function(block, rk) {           # block: 16 ints (column-major state)
  sb <- .aes$sbox; M2 <- .aes$M2; M3 <- .aes$M3; P <- .aes$P
  P0 <- P[[1]]; P1 <- P[[2]]; P2 <- P[[3]]; P3 <- P[[4]]
  s <- bitwXor(block, rk[[1]]) + 1L
  for (r in 1:13) {
    s <- bitwXor(bitwXor(M2[s[P0]], M3[s[P1]]), bitwXor(bitwXor(sb[s[P2]], sb[s[P3]]), rk[[r + 1L]])) + 1L
  }
  bitwXor(sb[s[.aes$shift]], rk[[15L]])
}

shim_namespace("openssl", list(
  aes_cbc_encrypt = function(data, key, iv = raw(16)) {
    rk <- aes_expand(key)
    pad <- 16L - length(data) %% 16L
    x <- as.integer(c(data, as.raw(rep(pad, pad))))
    prev <- as.integer(iv); out <- integer(length(x))
    for (b in seq(1L, length(x), 16L)) {
      prev <- aes_block(bitwXor(x[b:(b + 15L)], prev), rk)
      out[b:(b + 15L)] <- prev
    }
    as.raw(out)
  },
  md5 = function(x) {
    vapply(x, function(s) { f <- tempfile(); writeBin(charToRaw(enc2utf8(s)), f); on.exit(unlink(f)); unname(tools::md5sum(f)) }, "", USE.NAMES = FALSE)
  },
  aes_ctr_decrypt = function(data, key, iv) {
    rk <- aes_expand(key)
    n <- length(data); ctr <- as.integer(iv); ks <- integer(ceiling(n / 16) * 16)
    for (b in seq(1L, length(ks), 16L)) {
      ks[b:(b + 15L)] <- aes_block(ctr, rk)
      k <- 16L                                   # 128-bit big-endian increment
      repeat { ctr[k] <- (ctr[k] + 1L) %% 256L; if (ctr[k] != 0L || k == 1L) break; k <- k - 1L }
    }
    xor(data, as.raw(ks[seq_len(n)]))
  }
))

# ---- xml2: flat element lists -------------------------------------------------------
xml_unescape <- function(x) {
  x <- gsub("&lt;", "<", x, fixed = TRUE); x <- gsub("&gt;", ">", x, fixed = TRUE)
  x <- gsub("&quot;", "\"", x, fixed = TRUE); x <- gsub("&apos;", "'", x, fixed = TRUE)
  m <- gregexpr("&#(x?)([0-9A-Fa-f]+);", x)
  regmatches(x, m) <- lapply(regmatches(x, m), function(e) {
    if (!length(e)) return(e)
    hex <- grepl("^&#x", e)
    num <- ifelse(hex, strtoi(sub("^&#x([0-9A-Fa-f]+);$", "\\1", e), 16L), strtoi(sub("^&#([0-9]+);$", "\\1", e), 10L))
    vapply(num, function(u) intToUtf8(u), character(1))
  })
  gsub("&amp;", "&", x, fixed = TRUE)
}
shim_namespace("xml2", list(
  read_xml = function(x, ...) {
    txt <- if (is.raw(x)) rawToChar(x[x != as.raw(0)]) else paste(x, collapse = "\n")
    Encoding(txt) <- "UTF-8"
    txt <- sub("^\ufeff", "", txt)
    txt <- gsub("<!--.*?-->", "", txt, perl = TRUE)
    structure(list(text = txt), class = "shim_xml")
  },
  xml_find_all = function(x, xpath, ...) {
    el <- sub(".*/", "", xpath)
    tags <- regmatches(x$text, gregexpr(sprintf("<%s\\b[^>]*>", el), x$text, perl = TRUE))[[1]]
    structure(tags, class = "shim_nodes")
  },
  xml_attr = function(x, attr, ...) {
    x <- unclass(x)
    re <- sprintf("\\s%s\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", attr)
    m <- regmatches(x, regexec(re, x, perl = TRUE))
    out <- vapply(m, function(v) if (length(v)) paste0(v[3], v[4]) else NA_character_, character(1))
    out[!is.na(out)] <- xml_unescape(out[!is.na(out)])
    Encoding(out) <- "UTF-8"
    out
  }
))

# ---- jsonlite ------------------------------------------------------------------------
json_parse <- function(txt) {
  re <- "\"(?:[^\"\\\\]|\\\\.)*\"|-?[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[][{}:,]"
  tok <- regmatches(txt, gregexpr(re, txt, perl = TRUE))[[1]]
  i <- 0L
  nxt <- function() { i <<- i + 1L; tok[i] }
  unq <- function(s) {
    s <- substr(s, 2L, nchar(s) - 1L)
    if (!grepl("\\", s, fixed = TRUE)) return(s)
    m <- gregexpr("\\\\u[0-9A-Fa-f]{4}", s)
    regmatches(s, m) <- lapply(regmatches(s, m), function(e) vapply(strtoi(substring(e, 3), 16L), intToUtf8, ""))
    s <- gsub("\\\\n", "\n", s); s <- gsub("\\\\t", "\t", s); s <- gsub("\\\\r", "\r", s)
    s <- gsub("\\\\/", "/", s); s <- gsub("\\\\\"", "\"", s); gsub("\\\\\\\\", "\\\\", s)
  }
  val <- function() {
    t <- nxt()
    if (t == "{") {
      out <- list()
      if (tok[i + 1L] == "}") { nxt(); return(structure(list(), names = character(0))) }
      repeat { k <- unq(nxt()); nxt(); out[k] <- list(val()); if (nxt() == "}") break }
      return(out)
    }
    if (t == "[") {
      out <- list()
      if (tok[i + 1L] == "]") { nxt(); return(out) }
      repeat { out[[length(out) + 1L]] <- val(); if (nxt() == "]") break }
      return(out)
    }
    if (t == "true") return(TRUE); if (t == "false") return(FALSE); if (t == "null") return(NULL)
    if (substr(t, 1L, 1L) == "\"") { s <- unq(t); Encoding(s) <- "UTF-8"; return(s) }
    as.numeric(t)
  }
  val()
}
json_str <- function(s) {
  s <- enc2utf8(s)
  s <- gsub("\\", "\\\\", s, fixed = TRUE); s <- gsub("\"", "\\\"", s, fixed = TRUE)
  s <- gsub("\n", "\\n", s, fixed = TRUE); s <- gsub("\r", "\\r", s, fixed = TRUE); s <- gsub("\t", "\\t", s, fixed = TRUE)
  paste0("\"", s, "\"")
}
json_atom <- function(v) {
  if (is.factor(v)) v <- as.character(v)
  out <- if (is.logical(v)) ifelse(v, "true", "false")
    else if (is.character(v)) json_str(v)
    else if (is.numeric(v)) { x <- formatC(v, digits = 15, format = "fg", flag = "-"); trimws(x) }
    else stop("json shim: unsupported type ", typeof(v))
  out[is.na(v)] <- "null"
  out
}
json_write <- function(x, auto_unbox, null) {
  if (is.null(x)) return(if (identical(null, "null")) "null" else "{}")
  if (inherits(x, "scalar")) return(json_atom(unclass(x)))
  if (is.data.frame(x)) {
    rows <- lapply(seq_len(nrow(x)), function(r) lapply(x[r, , drop = FALSE], function(col) structure(col, class = "scalar")))
    return(paste0("[", paste(vapply(rows, json_write, "", auto_unbox, null), collapse = ","), "]"))
  }
  if (is.list(x)) {
    parts <- vapply(x, json_write, "", auto_unbox, null)
    if (!is.null(names(x))) return(paste0("{", paste0(json_str(names(x)), ":", parts, collapse = ","), "}"))
    return(paste0("[", paste(parts, collapse = ","), "]"))
  }
  if (!length(x)) return("[]")
  if (auto_unbox && length(x) == 1L) return(json_atom(x))
  paste0("[", paste(json_atom(x), collapse = ","), "]")
}
b64 <- c(LETTERS, letters, 0:9, "+", "/")
shim_namespace("jsonlite", list(
  fromJSON = function(txt, simplifyVector = TRUE, ...) json_parse(paste(txt, collapse = "\n")),
  toJSON = function(x, auto_unbox = FALSE, digits = 4, na = "null", null = "list", ...)
    structure(json_write(x, auto_unbox, null), class = "json"),
  unbox = function(x) structure(x, class = c("scalar", class(x))),
  base64_enc = function(input) {
    b <- as.integer(if (is.character(input)) charToRaw(input) else input); n <- length(b)
    pad <- (3L - n %% 3L) %% 3L; b <- c(b, integer(pad))
    m <- matrix(b, 3L)
    v <- m[1, ] * 65536L + m[2, ] * 256L + m[3, ]
    ch <- rbind(b64[v %/% 262144L + 1L], b64[(v %/% 4096L) %% 64L + 1L], b64[(v %/% 64L) %% 64L + 1L], b64[v %% 64L + 1L])
    s <- paste(ch, collapse = "")
    if (pad) substr(s, nchar(s) - pad + 1L, nchar(s)) <- strrep("=", pad)
    s
  },
  base64_dec = function(input) {
    s <- gsub("[^A-Za-z0-9+/]", "", input); v <- match(strsplit(s, "")[[1]], b64) - 1L
    v <- c(v, integer((4L - length(v) %% 4L) %% 4L)); m <- matrix(v, 4L)
    x <- m[1, ] * 262144L + m[2, ] * 4096L + m[3, ] * 64L + m[4, ]
    out <- as.vector(rbind(x %/% 65536L, (x %/% 256L) %% 256L, x %% 256L))
    as.raw(out[seq_len(floor(nchar(s) * 3 / 4))])
  }
))
print.json <- function(x, ...) cat(x, "\n")

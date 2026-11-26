# -----------------------------------------------------------------------------
# crypto.R -- the two AES modes Rocksmith 2014 uses.
#
#   * PSARC table of contents: AES-256-CFB128 with a fixed, public key/IV.
#   * SNG note charts:         AES-256-CTR, platform key, IV stored in the file.
#
# The `openssl` R package exposes CBC/CTR/GCM but not CFB, so CFB decryption is
# built from single-block AES encryptions (CFB decryption only ever needs the
# *forward* cipher: P_i = C_i XOR E_k(C_{i-1}), C_0 = IV). The TOC is a few KB,
# so ~100-200 block calls is negligible.
# -----------------------------------------------------------------------------

RS_KEYS <- list(
  psarc_toc_key = "C53DB23870A1A2F71CAE64061FDD0E1157309DC85204D4C5BFDF25090DF2572C",
  psarc_toc_iv  = "E915AA018FEF71FC508132E4BB4CEB42",
  sng_mac       = "9821330E34B91F70D0A48CBD625993126970CEA09192C0E6CDA676CC9838289D",
  sng_pc        = "CB648DF3D12A16BF71701414E69619EC171CCA5D2A142E3E59DE7ADDA18A3A30"
)

#' One raw AES block encryption E_k(block) (ECB semantics): the first CTR
#' keystream block for counter `block` (decrypting 16 zero bytes) is exactly
#' E_k(block) -- one block of work (CBC would also encrypt a padding block).
#' @noRd
aes_encrypt_block <- function(block16, key) {
  openssl::aes_ctr_decrypt(raw(16), key = key, iv = block16)
}

#' AES-CFB128 decryption (arbitrary length; the final partial block is fine).
#' @noRd
aes_cfb128_decrypt <- function(data, key, iv) {
  n <- length(data)
  if (n == 0L) return(raw(0))
  out  <- raw(n)
  prev <- iv
  for (start in seq(1L, n, by = 16L)) {
    idx <- start:min(start + 15L, n)
    keystream <- aes_encrypt_block(prev, key)
    out[idx] <- xor(data[idx], keystream[seq_along(idx)])
    if (length(idx) == 16L) prev <- data[idx]
  }
  out
}

#' AES-CTR decryption with a 128-bit big-endian counter (OpenSSL semantics).
#' @noRd
aes_ctr_decrypt_raw <- function(data, key, iv) {
  openssl::aes_ctr_decrypt(data, key = key, iv = iv)
}

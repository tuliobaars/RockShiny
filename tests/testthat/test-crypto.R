test_that("AES-256-CFB128 matches NIST SP 800-38A F.3.17 (incl. partial block)", {
  key <- hex_to_raw("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4")
  iv  <- hex_to_raw("000102030405060708090a0b0c0d0e0f")
  ct  <- hex_to_raw(paste0("dc7e84bfda79164b7ecd8486985d3860", "39ffed143b28b1c832113c6331e5407b",
                           "df10132415e54b92a13ed0a8267ae2f9", "75a385741ab9cef82031623d55b1e471"))
  pt  <- hex_to_raw(paste0("6bc1bee22e409f96e93d7e117393172a", "ae2d8a571e03ac9c9eb76fac45af8e51",
                           "30c81c46a35ce411e5fbc1191a0a52ef", "f69f2445df4f9b17ad2b417be66c3710"))
  expect_identical(aes_cfb128_decrypt(ct, key, iv), pt)
  expect_identical(aes_cfb128_decrypt(ct[1:37], key, iv), pt[1:37])
})

test_that("byte helpers decode little/big endian correctly", {
  b <- as.raw(c(0x00, 0x00, 0x80, 0x3f, 0xff, 0xff, 0xff, 0xff, 0x01, 0x02, 0x03, 0x04, 0x05))
  expect_equal(le_f32(b, 0), 1)
  expect_equal(le_u32(b, 4), 4294967295)
  expect_equal(le_i32(b, 4), -1L)
  expect_equal(i8(b, 4), -1L)
  expect_equal(be_uint_cols(matrix(b[9:13], ncol = 1)), 4328719365)   # 40-bit
  expect_true(has_bit(2^31 + 2, 2^31))
})

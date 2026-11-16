/* ---------------------------------------------------------------------------
 * rsc-aes.js -- the two AES modes of Rocksmith 2014, in plain JS (synchronous,
 * no WebCrypto: works the same from file://, in workers and under Node).
 *
 *   PSARC table of contents : AES-256-CFB128, fixed public key + IV
 *   SNG note charts         : AES-256-CTR, platform key, IV stored in the file
 *
 * Both modes only ever use the forward cipher E_k, so only encryption is built.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const E = root.RSCreator.engine;

  E.KEYS = {
    psarcKey: "C53DB23870A1A2F71CAE64061FDD0E1157309DC85204D4C5BFDF25090DF2572C",
    psarcIV: "E915AA018FEF71FC508132E4BB4CEB42",
    sngMac: "9821330E34B91F70D0A48CBD625993126970CEA09192C0E6CDA676CC9838289D",
    sngPC: "CB648DF3D12A16BF71701414E69619EC171CCA5D2A142E3E59DE7ADDA18A3A30"
  };

  // ---- tables ------------------------------------------------------------------------------
  const SBOX = new Uint8Array(256), T0 = new Uint32Array(256), T1 = new Uint32Array(256),
    T2 = new Uint32Array(256), T3 = new Uint32Array(256);
  (function build() {
    // generator walk as in SJCL: x runs over GF(2^8) by x *= 3, xi = x^-1 (th: 3x -> x)
    const d = new Uint8Array(256), th = new Uint8Array(256);
    for (let i = 0; i < 256; i++) { d[i] = (i << 1) ^ ((i >> 7) * 0x11b); th[d[i] ^ i] = i; }
    let x = 0, xi = 0;
    for (let k = 0; k < 256; k++) {
      let s = xi ^ (xi << 1) ^ (xi << 2) ^ (xi << 3) ^ (xi << 4);
      s = (s >> 8) ^ (s & 255) ^ 0x63;
      SBOX[x] = s;
      const x2 = d[x];
      const t = (d[s] * 0x101) ^ (s * 0x1010100);
      T0[x] = ((t << 24) | (t >>> 8)) >>> 0;
      T1[x] = ((t << 16) | (t >>> 16)) >>> 0;
      T2[x] = ((t << 8) | (t >>> 24)) >>> 0;
      T3[x] = t >>> 0;
      x ^= x2 || 1;
      xi = th[xi] || 1;
    }
  })();

  /** Expanded key (Uint32 words) of a 16/24/32-byte key. */
  function expandKey(key) {
    const nk = key.length / 4, rounds = nk + 6, w = new Uint32Array(4 * (rounds + 1));
    for (let i = 0; i < nk; i++) w[i] = (key[4 * i] << 24 | key[4 * i + 1] << 16 | key[4 * i + 2] << 8 | key[4 * i + 3]) >>> 0;
    let rcon = 1;
    for (let i = nk; i < w.length; i++) {
      let t = w[i - 1];
      if (i % nk === 0) {
        t = (SBOX[(t >>> 16) & 255] << 24 | SBOX[(t >>> 8) & 255] << 16 | SBOX[t & 255] << 8 | SBOX[t >>> 24]) ^ (rcon << 24);
        rcon = (rcon << 1) ^ ((rcon >> 7) * 0x11b);
      } else if (nk > 6 && i % nk === 4) {
        t = SBOX[t >>> 24] << 24 | SBOX[(t >>> 16) & 255] << 16 | SBOX[(t >>> 8) & 255] << 8 | SBOX[t & 255];
      }
      w[i] = (w[i - nk] ^ t) >>> 0;
    }
    return { w, rounds };
  }

  /** E_k(in[inOff..+16]) -> out[outOff..+16] */
  function encryptBlock(ks, inp, inOff, out, outOff) {
    const w = ks.w;
    let s0 = ((inp[inOff] << 24) | (inp[inOff + 1] << 16) | (inp[inOff + 2] << 8) | inp[inOff + 3]) ^ w[0];
    let s1 = ((inp[inOff + 4] << 24) | (inp[inOff + 5] << 16) | (inp[inOff + 6] << 8) | inp[inOff + 7]) ^ w[1];
    let s2 = ((inp[inOff + 8] << 24) | (inp[inOff + 9] << 16) | (inp[inOff + 10] << 8) | inp[inOff + 11]) ^ w[2];
    let s3 = ((inp[inOff + 12] << 24) | (inp[inOff + 13] << 16) | (inp[inOff + 14] << 8) | inp[inOff + 15]) ^ w[3];
    let k = 4;
    for (let r = 1; r < ks.rounds; r++) {
      const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 255] ^ T2[(s2 >>> 8) & 255] ^ T3[s3 & 255] ^ w[k];
      const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 255] ^ T2[(s3 >>> 8) & 255] ^ T3[s0 & 255] ^ w[k + 1];
      const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 255] ^ T2[(s0 >>> 8) & 255] ^ T3[s1 & 255] ^ w[k + 2];
      const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 255] ^ T2[(s1 >>> 8) & 255] ^ T3[s2 & 255] ^ w[k + 3];
      s0 = t0; s1 = t1; s2 = t2; s3 = t3; k += 4;
    }
    const o = [
      (SBOX[s0 >>> 24] << 24 | SBOX[(s1 >>> 16) & 255] << 16 | SBOX[(s2 >>> 8) & 255] << 8 | SBOX[s3 & 255]) ^ w[k],
      (SBOX[s1 >>> 24] << 24 | SBOX[(s2 >>> 16) & 255] << 16 | SBOX[(s3 >>> 8) & 255] << 8 | SBOX[s0 & 255]) ^ w[k + 1],
      (SBOX[s2 >>> 24] << 24 | SBOX[(s3 >>> 16) & 255] << 16 | SBOX[(s0 >>> 8) & 255] << 8 | SBOX[s1 & 255]) ^ w[k + 2],
      (SBOX[s3 >>> 24] << 24 | SBOX[(s0 >>> 16) & 255] << 16 | SBOX[(s1 >>> 8) & 255] << 8 | SBOX[s2 & 255]) ^ w[k + 3]
    ];
    for (let i = 0; i < 4; i++) {
      out[outOff + 4 * i] = o[i] >>> 24; out[outOff + 4 * i + 1] = (o[i] >>> 16) & 255;
      out[outOff + 4 * i + 2] = (o[i] >>> 8) & 255; out[outOff + 4 * i + 3] = o[i] & 255;
    }
  }

  const keyOf = (k) => (typeof k === "string" ? E.fromHex(k) : k);
  E.aesEncryptBlock = function (key, block) {
    const out = new Uint8Array(16);
    encryptBlock(expandKey(keyOf(key)), block, 0, out, 0);
    return out;
  };

  /** AES-CFB128: P_i = C_i ^ E(C_{i-1}) (decrypt), C_i = P_i ^ E(C_{i-1}) (encrypt). */
  function cfb(data, key, iv, decrypt) {
    const ks = expandKey(keyOf(key)), out = new Uint8Array(data.length), ksb = new Uint8Array(16);
    let prev = Uint8Array.from(keyOf(iv));
    for (let o = 0; o < data.length; o += 16) {
      encryptBlock(ks, prev, 0, ksb, 0);
      const n = Math.min(16, data.length - o);
      for (let i = 0; i < n; i++) out[o + i] = data[o + i] ^ ksb[i];
      if (n === 16) prev = (decrypt ? data : out).slice(o, o + 16);
    }
    return out;
  }
  E.aesCfbDecrypt = (data, key, iv) => cfb(data, key, iv, true);
  E.aesCfbEncrypt = (data, key, iv) => cfb(data, key, iv, false);

  /** AES-CTR with a 128-bit big-endian counter (OpenSSL semantics); its own inverse. */
  E.aesCtr = function (data, key, iv) {
    const ks = expandKey(keyOf(key)), out = new Uint8Array(data.length), ksb = new Uint8Array(16);
    const ctr = Uint8Array.from(keyOf(iv));
    for (let o = 0; o < data.length; o += 16) {
      encryptBlock(ks, ctr, 0, ksb, 0);
      const n = Math.min(16, data.length - o);
      for (let i = 0; i < n; i++) out[o + i] = data[o + i] ^ ksb[i];
      for (let i = 15; i >= 0; i--) { ctr[i] = (ctr[i] + 1) & 255; if (ctr[i] !== 0) break; }
    }
    return out;
  };
})(typeof window !== "undefined" ? window : globalThis);

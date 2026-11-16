/* ---------------------------------------------------------------------------
 * rsc-core.js -- RockShiny Creator engine: shared helpers.
 *
 * The engine (rsc-*.js in this folder) is the one codec of the Creator: the
 * Shiny app and the standalone HTML page both run it in the browser, and the
 * tests run it under Node. It has no dependencies and touches no DOM.
 *
 *   RSCreator.engine.Reader / Writer   little/big-endian binary cursor
 *   RSCreator.engine.md5(bytes)         -> Uint8Array(16)
 *   RSCreator.engine.crc32ogg(bytes)    Ogg page checksum
 *   RSCreator.engine.fnv1_32(text)      Wwise object ids (lower-cased FNV-1)
 *   RSCreator.engine.inflate / deflate  zlib streams (async)
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const RSC = (root.RSCreator = root.RSCreator || {});
  const E = (RSC.engine = RSC.engine || {});

  // ---- text ---------------------------------------------------------------------------
  const te = new TextEncoder(), td = new TextDecoder("utf-8");
  E.utf8 = (s) => te.encode(String(s));
  E.fromUtf8 = (u8) => td.decode(u8);
  E.latin1 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; };

  E.concat = function (parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  E.equalBytes = function (a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  E.hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
  E.fromHex = function (h) {
    h = String(h).replace(/[^0-9a-f]/gi, "");
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(2 * i, 2), 16);
    return out;
  };

  // ---- base64 (chunked: large buffers) -------------------------------------------------------
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64R = new Int16Array(256).fill(-1);
  for (let i = 0; i < 64; i++) B64R[B64.charCodeAt(i)] = i;
  E.toBase64 = function (u8) {
    const parts = [];
    for (let i = 0; i < u8.length; i += 3 * 16384) {
      const end = Math.min(u8.length, i + 3 * 16384);
      let s = "";
      for (let j = i; j < end; j += 3) {
        const a = u8[j], b = j + 1 < end ? u8[j + 1] : 0, c = j + 2 < end ? u8[j + 2] : 0;
        s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] +
             (j + 1 < end ? B64[((b & 15) << 2) | (c >> 6)] : "=") + (j + 2 < end ? B64[c & 63] : "=");
      }
      parts.push(s);
    }
    return parts.join("");
  };
  E.fromBase64 = function (s) {
    s = String(s).replace(/[^A-Za-z0-9+/]/g, "");
    const n = Math.floor(s.length * 3 / 4);
    const out = new Uint8Array(n);
    let o = 0;
    for (let i = 0; i < s.length; i += 4) {
      const a = B64R[s.charCodeAt(i)], b = B64R[s.charCodeAt(i + 1)];
      const c = i + 2 < s.length ? B64R[s.charCodeAt(i + 2)] : -1, d = i + 3 < s.length ? B64R[s.charCodeAt(i + 3)] : -1;
      out[o++] = (a << 2) | (b >> 4);
      if (c >= 0 && o < n) out[o++] = ((b & 15) << 4) | (c >> 2);
      if (d >= 0 && o < n) out[o++] = ((c & 3) << 6) | d;
    }
    return out.subarray(0, o);
  };

  // ---- binary cursor ---------------------------------------------------------------------
  class Reader {
    constructor(u8, pos = 0, little = true) {
      this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      this.pos = pos; this.le = little;
    }
    get left() { return this.u8.length - this.pos; }
    u8v() { return this.u8[this.pos++]; }
    i8() { const v = this.dv.getInt8(this.pos); this.pos += 1; return v; }
    u16() { const v = this.dv.getUint16(this.pos, this.le); this.pos += 2; return v; }
    i16() { const v = this.dv.getInt16(this.pos, this.le); this.pos += 2; return v; }
    u32() { const v = this.dv.getUint32(this.pos, this.le); this.pos += 4; return v; }
    i32() { const v = this.dv.getInt32(this.pos, this.le); this.pos += 4; return v; }
    f32() { const v = this.dv.getFloat32(this.pos, this.le); this.pos += 4; return v; }
    f64() { const v = this.dv.getFloat64(this.pos, this.le); this.pos += 8; return v; }
    bytes(n) { const v = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return v; }
    /** Zero-terminated string in a fixed-width field (UTF-8). */
    cstr(width) {
      const b = this.bytes(width);
      let n = b.indexOf(0);
      if (n < 0) n = b.length;
      return td.decode(b.subarray(0, n));
    }
    skip(n) { this.pos += n; return this; }
  }
  E.Reader = Reader;

  class Writer {
    constructor(size = 1 << 16, little = true) {
      this.buf = new Uint8Array(size); this.dv = new DataView(this.buf.buffer); this.pos = 0; this.le = little;
    }
    ensure(n) {
      if (this.pos + n <= this.buf.length) return;
      let size = this.buf.length * 2;
      while (size < this.pos + n) size *= 2;
      const b = new Uint8Array(size);
      b.set(this.buf.subarray(0, this.pos));
      this.buf = b; this.dv = new DataView(b.buffer);
    }
    u8(v) { this.ensure(1); this.buf[this.pos++] = v & 255; return this; }
    i8(v) { this.ensure(1); this.dv.setInt8(this.pos, v); this.pos += 1; return this; }
    u16(v) { this.ensure(2); this.dv.setUint16(this.pos, v, this.le); this.pos += 2; return this; }
    i16(v) { this.ensure(2); this.dv.setInt16(this.pos, v, this.le); this.pos += 2; return this; }
    u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, this.le); this.pos += 4; return this; }
    i32(v) { this.ensure(4); this.dv.setInt32(this.pos, v, this.le); this.pos += 4; return this; }
    f32(v) { this.ensure(4); this.dv.setFloat32(this.pos, v, this.le); this.pos += 4; return this; }
    f64(v) { this.ensure(8); this.dv.setFloat64(this.pos, v, this.le); this.pos += 8; return this; }
    bytes(u8) { this.ensure(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; return this; }
    zeros(n) { this.ensure(n); this.buf.fill(0, this.pos, this.pos + n); this.pos += n; return this; }
    /** Fixed-width zero-padded string field (UTF-8, truncated to width - 1 bytes). */
    cstr(s, width) {
      let b = te.encode(String(s == null ? "" : s));
      if (b.length > width - 1) {
        let n = width - 1;
        while (n > 0 && (b[n] & 0xc0) === 0x80) n--;          // do not cut a UTF-8 sequence
        b = b.subarray(0, n);
      }
      this.bytes(b); this.zeros(width - b.length);
      return this;
    }
    /** Big-endian unsigned integer of `n` bytes (PSARC's 40-bit fields). */
    uintBE(v, n) { this.ensure(n); for (let i = n - 1; i >= 0; i--) { this.buf[this.pos + i] = v % 256; v = Math.floor(v / 256); } this.pos += n; return this; }
    result() { return this.buf.slice(0, this.pos); }
  }
  E.Writer = Writer;

  E.readUintBE = function (u8, off, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u8[off + i]; return v; };

  // ---- MD5 (RFC 1321) -----------------------------------------------------------------------
  const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const MD5_K = new Int32Array(64);
  for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  E.md5 = function (input) {
    const msg = typeof input === "string" ? te.encode(input) : input;
    const n = msg.length, total = ((n + 8) >>> 6) + 1, words = new Int32Array(total * 16);
    for (let i = 0; i < n; i++) words[i >> 2] |= msg[i] << ((i % 4) * 8);
    words[n >> 2] |= 0x80 << ((n % 4) * 8);
    words[total * 16 - 2] = (n * 8) | 0;
    words[total * 16 - 1] = Math.floor(n / 536870912) | 0;
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (let blk = 0; blk < total * 16; blk += 16) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        const tmp = D; D = C; C = B;
        const x = (A + F + MD5_K[i] + words[blk + g]) | 0;
        B = (B + ((x << MD5_S[i]) | (x >>> (32 - MD5_S[i])))) | 0;
        A = tmp;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16), dv = new DataView(out.buffer);
    dv.setInt32(0, a0, true); dv.setInt32(4, b0, true); dv.setInt32(8, c0, true); dv.setInt32(12, d0, true);
    return out;
  };

  // ---- CRC-32 of Ogg pages (polynomial 0x04c11db7, not reflected, init 0) --------------------
  const OGG_CRC = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    OGG_CRC[i] = r >>> 0;
  }
  E.crc32ogg = function (u8, from = 0, to = u8.length) {
    let c = 0;
    for (let i = from; i < to; i++) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ u8[i]) & 255]) >>> 0;
    return c >>> 0;
  };

  // ---- Wwise ids: FNV-1 32-bit of the lower-cased name -------------------------------------------
  E.fnv1_32 = function (name) {
    const b = te.encode(String(name).toLowerCase());
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h = Math.imul(h, 0x01000193) >>> 0; h = (h ^ b[i]) >>> 0; }
    return h >>> 0;
  };

  // ---- zlib (RFC 1950) -------------------------------------------------------------------------
  // Browsers: (De)CompressionStream("deflate") (= zlib format). Node and tests may
  // install synchronous implementations as RSCreator.engine.zlibImpl = {inflate, deflate}.
  async function streamThrough(u8, stream) {
    const blob = new Blob([u8]);
    const out = await new Response(blob.stream().pipeThrough(stream)).arrayBuffer();
    return new Uint8Array(out);
  }
  E.inflate = async function (u8) {
    if (E.zlibImpl) return E.zlibImpl.inflate(u8);
    return streamThrough(u8, new DecompressionStream("deflate"));
  };
  /**
   * Inflate a zlib stream that may be followed by other bytes (SNG files carry a
   * signature and padding after it, which the browser's strict DecompressionStream
   * rejects): the input goes in in small pieces and the output produced before the
   * complaint about the trailing bytes is kept. -> Uint8Array
   */
  E.inflateLenient = async function (u8) {
    if (E.zlibImpl) return E.zlibImpl.inflate(u8);
    const ds = new DecompressionStream("deflate"), w = ds.writable.getWriter(), r = ds.readable.getReader();
    const chunks = [];
    let n = 0;
    const reading = (async () => {
      try { for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); n += value.length; } } catch (e) { /* trailing bytes */ }
    })();
    try { for (let i = 0; i < u8.length; i += 4096) await w.write(u8.subarray(i, Math.min(u8.length, i + 4096))); await w.close(); } catch (e) { /* trailing bytes */ }
    await reading;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  };
  E.deflate = async function (u8) {
    if (E.zlibImpl) return E.zlibImpl.deflate(u8);
    return streamThrough(u8, new CompressionStream("deflate"));
  };
  /** A zlib stream header? (CMF 0x78 and a valid FCHECK) */
  E.looksZlib = (u8) => u8.length >= 2 && u8[0] === 0x78 && ((0x78 * 256 + u8[1]) % 31) === 0;

  /** Yield to the event loop (long jobs keep the page responsive). */
  E.tick = () => new Promise((res) => setTimeout(res, 0));
})(typeof window !== "undefined" ? window : globalThis);

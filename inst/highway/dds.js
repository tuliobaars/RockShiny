/* ---------------------------------------------------------------------------
 * dds.js -- minimal DirectDraw Surface decoder for Rocksmith album art.
 * Supports DXT1 (BC1, used by all sample songs), DXT3 (BC2), DXT5 (BC3) and
 * uncompressed 32-bit BGRA. Returns ImageData for the top mip level.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const NS = (root.RSHighway = root.RSHighway || {});

  function rgb565(c, out, o) {
    const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
    out[o] = (r << 3) | (r >> 2); out[o + 1] = (g << 2) | (g >> 4); out[o + 2] = (b << 3) | (b >> 2); out[o + 3] = 255;
  }

  /** @param bytes Uint8Array of a .dds file. */
  function decodeDDS(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0x20534444) throw new Error("not a DDS file");   // "DDS "
    const h = dv.getUint32(12, true), w = dv.getUint32(16, true);
    const pfFlags = dv.getUint32(80, true);
    const fourCC = String.fromCharCode(bytes[84], bytes[85], bytes[86], bytes[87]);
    const px = new Uint8ClampedArray(w * h * 4);
    let off = 128;

    if (!(pfFlags & 4)) {                                   // uncompressed (assume 32-bit BGRA)
      for (let i = 0; i < w * h; i++, off += 4) {
        px[i * 4] = bytes[off + 2]; px[i * 4 + 1] = bytes[off + 1]; px[i * 4 + 2] = bytes[off]; px[i * 4 + 3] = bytes[off + 3];
      }
      return new ImageData(px, w, h);
    }
    if (!/^DXT[135]$/.test(fourCC)) throw new Error("unsupported DDS format " + fourCC);

    const pal = new Uint8Array(16), alpha = new Uint8Array(16);
    for (let by = 0; by < h; by += 4) {
      for (let bx = 0; bx < w; bx += 4) {
        alpha.fill(255);
        if (fourCC === "DXT3") {                            // explicit 4-bit alpha
          for (let i = 0; i < 16; i++) alpha[i] = ((bytes[off + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
          off += 8;
        } else if (fourCC === "DXT5") {                     // interpolated alpha
          const a0 = bytes[off], a1 = bytes[off + 1], av = [a0, a1];
          for (let i = 1; i < (a0 > a1 ? 7 : 5); i++) av.push(a0 > a1 ? ((7 - i) * a0 + i * a1) / 7 : ((5 - i) * a0 + i * a1) / 5);
          if (a0 <= a1) av.push(0, 255);
          let bits = 0, nb = 0, p = off + 2;
          for (let i = 0; i < 16; i++) {
            while (nb < 3) { bits |= bytes[p++] << nb; nb += 8; }
            alpha[i] = av[bits & 7]; bits >>= 3; nb -= 3;
          }
          off += 8;
        }
        const c0 = dv.getUint16(off, true), c1 = dv.getUint16(off + 2, true), idx = dv.getUint32(off + 4, true);
        off += 8;
        rgb565(c0, pal, 0); rgb565(c1, pal, 4);
        const four = c0 > c1 || fourCC !== "DXT1";
        for (let k = 0; k < 3; k++) {
          pal[8 + k] = four ? (2 * pal[k] + pal[4 + k]) / 3 : (pal[k] + pal[4 + k]) / 2;
          pal[12 + k] = four ? (pal[k] + 2 * pal[4 + k]) / 3 : 0;
        }
        pal[11] = 255; pal[15] = four ? 255 : 0;
        for (let i = 0; i < 16; i++) {
          const x = bx + (i & 3), y = by + (i >> 2);
          if (x >= w || y >= h) continue;
          const c = ((idx >> (2 * i)) & 3) * 4, o = (y * w + x) * 4;
          px[o] = pal[c]; px[o + 1] = pal[c + 1]; px[o + 2] = pal[c + 2];
          px[o + 3] = Math.min(pal[c + 3], alpha[i]);
        }
      }
    }
    return new ImageData(px, w, h);
  }

  /** base64 .dds -> data: URL (PNG) usable as <img src>. */
  NS.ddsToDataURL = function (b64) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const img = decodeDDS(bytes), c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    c.getContext("2d").putImageData(img, 0, 0);
    return c.toDataURL("image/png");
  };
  NS.decodeDDS = decodeDDS;
})(window);

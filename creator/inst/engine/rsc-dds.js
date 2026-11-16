/* ---------------------------------------------------------------------------
 * rsc-dds.js -- album art as Rocksmith stores it: DirectDraw Surface, DXT1
 * (BC1), no mipmaps, 256 / 128 / 64 px squares (gfxassets/album_art/).
 *
 *   E.ddsDecode(u8)                 -> {width, height, rgba: Uint8ClampedArray}
 *   E.ddsEncodeDXT1(rgba, w, h)     -> .dds bytes
 *   E.resizeRGBA(rgba, w, h, W, H)  box / bilinear resampling
 *   E.albumArtSet(rgba, w, h)       -> {256: bytes, 128: bytes, 64: bytes}
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const E = root.RSCreator.engine;

  const unpack565 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
  const pack565 = (r, g, b) => ((Math.round(r * 31 / 255) & 31) << 11) | ((Math.round(g * 63 / 255) & 63) << 5) | (Math.round(b * 31 / 255) & 31);

  E.ddsDecode = function (u8) {
    const r = new E.Reader(u8);
    if (E.latin1(u8.subarray(0, 4)) !== "DDS ") throw new Error("Not a DDS image.");
    r.pos = 12; const height = r.u32(), width = r.u32();
    r.pos = 80; const pfFlags = r.u32(), fourCC = E.latin1(u8.subarray(84, 88));
    r.pos = 88; const bpp = r.u32();
    const rgba = new Uint8ClampedArray(width * height * 4);
    let o = 128;
    if (fourCC === "DXT1" || fourCC === "DXT5" || fourCC === "DXT3") {
      const bs = fourCC === "DXT1" ? 8 : 16;
      for (let by = 0; by < height; by += 4) {
        for (let bx = 0; bx < width; bx += 4, o += bs) {
          const alpha = new Uint8Array(16).fill(255);
          let co = o;
          if (fourCC === "DXT5") {
            const a0 = u8[o], a1 = u8[o + 1], pal = [a0, a1];
            if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
            else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5); pal.push(0, 255); }
            let bits = 0n;
            for (let i = 5; i >= 0; i--) bits = (bits << 8n) | BigInt(u8[o + 2 + i]);
            for (let i = 0; i < 16; i++) alpha[i] = pal[Number((bits >> BigInt(3 * i)) & 7n)];
            co = o + 8;
          } else if (fourCC === "DXT3") {
            for (let i = 0; i < 16; i++) alpha[i] = ((u8[o + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
            co = o + 8;
          }
          const c0 = u8[co] | (u8[co + 1] << 8), c1 = u8[co + 2] | (u8[co + 3] << 8);
          const p0 = unpack565(c0), p1 = unpack565(c1), pal = [p0, p1];
          if (c0 > c1 || fourCC !== "DXT1") { pal.push(p0.map((v, k) => (2 * v + p1[k]) / 3), p0.map((v, k) => (v + 2 * p1[k]) / 3)); }
          else { pal.push(p0.map((v, k) => (v + p1[k]) / 2), [0, 0, 0, 0]); }
          const idx = u8[co + 4] | (u8[co + 5] << 8) | (u8[co + 6] << 16) | (u8[co + 7] << 24);
          for (let i = 0; i < 16; i++) {
            const x = bx + (i & 3), y = by + (i >> 2);
            if (x >= width || y >= height) continue;
            const p = pal[(idx >>> (2 * i)) & 3], d = (y * width + x) * 4;
            rgba[d] = p[0]; rgba[d + 1] = p[1]; rgba[d + 2] = p[2];
            rgba[d + 3] = p.length === 4 ? 0 : alpha[i];
          }
        }
      }
    } else if (pfFlags & 0x40) {                     // uncompressed RGB(A)
      const step = bpp / 8;
      for (let i = 0; i < width * height; i++, o += step) {
        rgba[i * 4] = u8[o + 2]; rgba[i * 4 + 1] = u8[o + 1]; rgba[i * 4 + 2] = u8[o]; rgba[i * 4 + 3] = step === 4 ? u8[o + 3] : 255;
      }
    } else throw new Error("Unsupported DDS format " + fourCC + ".");
    return { width, height, rgba };
  };

  /** DXT1 encode: per 4x4 block, endpoints along the block's principal colour axis. */
  E.ddsEncodeDXT1 = function (rgba, width, height) {
    const w = new E.Writer(128 + Math.ceil(width / 4) * Math.ceil(height / 4) * 8);
    w.bytes(E.utf8("DDS ")).u32(124).u32(0x1 | 0x2 | 0x4 | 0x1000 | 0x80000).u32(height).u32(width)
      .u32(Math.ceil(width / 4) * Math.ceil(height / 4) * 8).u32(0).u32(0).zeros(44)
      .u32(32).u32(0x4).bytes(E.utf8("DXT1")).zeros(20).u32(0x1000).zeros(16);
    const px = new Float64Array(48);
    for (let by = 0; by < height; by += 4) {
      for (let bx = 0; bx < width; bx += 4) {
        let mr = 0, mg = 0, mb = 0;
        for (let i = 0; i < 16; i++) {
          const x = Math.min(width - 1, bx + (i & 3)), y = Math.min(height - 1, by + (i >> 2)), d = (y * width + x) * 4;
          px[3 * i] = rgba[d]; px[3 * i + 1] = rgba[d + 1]; px[3 * i + 2] = rgba[d + 2];
          mr += rgba[d]; mg += rgba[d + 1]; mb += rgba[d + 2];
        }
        mr /= 16; mg /= 16; mb /= 16;
        // principal axis by power iteration on the covariance
        let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
        for (let i = 0; i < 16; i++) {
          const r = px[3 * i] - mr, g = px[3 * i + 1] - mg, b = px[3 * i + 2] - mb;
          cxx += r * r; cxy += r * g; cxz += r * b; cyy += g * g; cyz += g * b; czz += b * b;
        }
        let ax = 1, ay = 1, az = 1;
        for (let k = 0; k < 8; k++) {
          const nx = cxx * ax + cxy * ay + cxz * az, ny = cxy * ax + cyy * ay + cyz * az, nz = cxz * ax + cyz * ay + czz * az;
          const n = Math.hypot(nx, ny, nz) || 1; ax = nx / n; ay = ny / n; az = nz / n;
        }
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < 16; i++) {
          const t = (px[3 * i] - mr) * ax + (px[3 * i + 1] - mg) * ay + (px[3 * i + 2] - mb) * az;
          if (t < lo) lo = t; if (t > hi) hi = t;
        }
        const clamp = (v) => Math.max(0, Math.min(255, v));
        let c0 = pack565(clamp(mr + ax * hi), clamp(mg + ay * hi), clamp(mb + az * hi));
        let c1 = pack565(clamp(mr + ax * lo), clamp(mg + ay * lo), clamp(mb + az * lo));
        if (c0 < c1) { const t = c0; c0 = c1; c1 = t; }
        let idx = 0;
        if (c0 !== c1) {
          const p0 = unpack565(c0), p1 = unpack565(c1);
          const pal = [p0, p1, p0.map((v, k) => (2 * v + p1[k]) / 3), p0.map((v, k) => (v + 2 * p1[k]) / 3)];
          for (let i = 0; i < 16; i++) {
            let best = 0, bd = Infinity;
            for (let k = 0; k < 4; k++) {
              const dr = px[3 * i] - pal[k][0], dg = px[3 * i + 1] - pal[k][1], db = px[3 * i + 2] - pal[k][2];
              const d = dr * dr + dg * dg + db * db;
              if (d < bd) { bd = d; best = k; }
            }
            idx |= best << (2 * i);
          }
        }
        w.u16(c0).u16(c1).u32(idx >>> 0);
      }
    }
    return w.result();
  };

  /** Resample RGBA: area average when shrinking, bilinear when growing. */
  E.resizeRGBA = function (src, sw, sh, dw, dh) {
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const x0 = x * sw / dw, x1 = (x + 1) * sw / dw, y0 = y * sh / dh, y1 = (y + 1) * sh / dh;
        const acc = [0, 0, 0, 0];
        let wsum = 0;
        if (x1 - x0 >= 1 || y1 - y0 >= 1) {
          for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
            const wx = Math.min(x1, xx + 1) - Math.max(x0, xx), wy = Math.min(y1, yy + 1) - Math.max(y0, yy), wgt = wx * wy;
            if (wgt <= 0) continue;
            const d = (Math.min(sh - 1, yy) * sw + Math.min(sw - 1, xx)) * 4;
            for (let k = 0; k < 4; k++) acc[k] += src[d + k] * wgt;
            wsum += wgt;
          }
        } else {
          const fx = Math.max(0, (x + 0.5) * sw / dw - 0.5), fy = Math.max(0, (y + 0.5) * sh / dh - 0.5);
          const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
          for (const [xx, yy, wgt] of [[ix, iy, (1 - tx) * (1 - ty)], [ix + 1, iy, tx * (1 - ty)], [ix, iy + 1, (1 - tx) * ty], [ix + 1, iy + 1, tx * ty]]) {
            const d = (Math.min(sh - 1, yy) * sw + Math.min(sw - 1, xx)) * 4;
            for (let k = 0; k < 4; k++) acc[k] += src[d + k] * wgt;
            wsum += wgt;
          }
        }
        const d = (y * dw + x) * 4;
        for (let k = 0; k < 4; k++) out[d + k] = acc[k] / (wsum || 1);
      }
    }
    return out;
  };

  /** The three album-art sizes of a package, from any RGBA image (centre-cropped to a square). */
  E.albumArtSet = function (rgba, w, h) {
    const s = Math.min(w, h), ox = Math.floor((w - s) / 2), oy = Math.floor((h - s) / 2);
    const sq = new Uint8ClampedArray(s * s * 4);
    for (let y = 0; y < s; y++) sq.set(rgba.subarray(((y + oy) * w + ox) * 4, ((y + oy) * w + ox + s) * 4), y * s * 4);
    const out = {};
    for (const n of [256, 128, 64]) out[n] = E.ddsEncodeDXT1(E.resizeRGBA(sq, s, s, n, n), n, n);
    return out;
  };
})(typeof window !== "undefined" ? window : globalThis);

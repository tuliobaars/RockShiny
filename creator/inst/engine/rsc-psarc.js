/* ---------------------------------------------------------------------------
 * rsc-psarc.js -- PlayStation ARChive (Rocksmith 2014 flavour): read + write.
 *
 * Layout (big-endian), as in RockShiny's R/psarc.R:
 *   0 "PSAR" | 4 u16 1, u16 4 | 8 "zlib" | 12 u32 toc_length | 16 u32 30
 *   20 u32 entries (entry 0 = the file-name manifest) | 24 u32 65536 block size
 *   28 u32 flags (4 = TOC encrypted with AES-256-CFB)
 *   32 TOC: entries[n] (md5[16] | zindex u32 | length u40 | offset u40), then a
 *      u16 compressed length per 64 KiB block (0 = a full uncompressed block)
 * Files are stored as consecutive blocks from `offset`: zlib, or raw when
 * compression does not pay off.
 *
 *   const arc = await RSCreator.engine.psarcOpen(bytes)   // {header, entries, read(name)}
 *   const out = await RSCreator.engine.psarcWrite([{name, data}, ...])
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const E = root.RSCreator.engine;
  const HEADER = 32, ENTRY = 30, BLOCK = 65536;

  function parseHeader(u8) {
    if (u8.length < HEADER || E.latin1(u8.subarray(0, 4)) !== "PSAR") throw new Error("Not a PSARC archive (no 'PSAR' magic).");
    const r = new E.Reader(u8, 4, false);
    return {
      version: r.u16() + "." + r.u16(), compression: E.latin1(r.bytes(4)), tocLength: r.u32(), entrySize: r.u32(),
      entries: r.u32(), blockSize: r.u32(), flags: r.u32()
    };
  }

  /**
   * Open an archive held in memory. -> {header, entries: [{name, md5, zindex, length,
   * offset}] (without the manifest entry), read(name) -> Promise<Uint8Array>, has(name)}
   */
  E.psarcOpen = async function (u8) {
    const h = parseHeader(u8);
    if (h.compression !== "zlib") throw new Error("Unsupported PSARC compression: " + h.compression);
    let toc = u8.subarray(HEADER, h.tocLength);
    if (h.flags & 4) toc = E.aesCfbDecrypt(toc, E.KEYS.psarcKey, E.KEYS.psarcIV);
    const entries = [];
    for (let i = 0; i < h.entries; i++) {
      const o = i * h.entrySize;
      entries.push({
        md5: E.hex(toc.subarray(o, o + 16)), zindex: E.readUintBE(toc, o + 16, 4),
        length: E.readUintBE(toc, o + 20, 5), offset: E.readUintBE(toc, o + 25, 5)
      });
    }
    const zw = h.blockSize <= 65536 ? 2 : h.blockSize <= 16777216 ? 3 : 4;
    const zraw = toc.subarray(h.entries * h.entrySize);
    const zlengths = new Array(Math.floor(zraw.length / zw));
    for (let i = 0; i < zlengths.length; i++) zlengths[i] = E.readUintBE(zraw, i * zw, zw);

    async function readEntry(e) {
      const parts = [];
      let remaining = e.length, pos = e.offset, z = e.zindex;
      while (remaining > 0) {
        const zlen = zlengths[z++];
        if (zlen === undefined) throw new Error("Corrupt PSARC: block table exhausted");
        let block;
        if (zlen === 0) { block = u8.subarray(pos, pos + h.blockSize); pos += h.blockSize; }
        else {
          const packed = u8.subarray(pos, pos + zlen); pos += zlen;
          block = packed;
          if (E.looksZlib(packed)) { try { block = await E.inflate(packed); } catch (err) { block = packed; } }
        }
        if (!block.length) throw new Error("Corrupt PSARC: empty block");
        if (block.length > remaining) block = block.subarray(0, remaining);
        parts.push(block);
        remaining -= block.length;
      }
      return parts.length === 1 ? parts[0].slice() : E.concat(parts);
    }

    const names = E.fromUtf8(await readEntry(entries[0])).replace(/\r/g, "").split("\n");
    const files = entries.slice(1).map((e, i) => Object.assign({ name: names[i] }, e));
    const byName = new Map(files.map((f) => [f.name, f]));
    return {
      header: h, entries: files, zlengths,
      names: () => files.map((f) => f.name),
      has: (name) => byName.has(name),
      find: (re) => files.map((f) => f.name).filter((n) => re.test(n)),
      read: (name) => {
        const e = byName.get(name);
        if (!e) return Promise.reject(new Error("File not found in archive: " + name));
        return readEntry(e);
      }
    };
  };

  /**
   * Build an archive. files: [{name, data: Uint8Array, compress?: boolean}] in the
   * order they are stored; compress defaults to true except for .wem audio (stored
   * raw, like the toolkit: Vorbis does not deflate). opts.encrypt (default true).
   * -> Promise<Uint8Array>
   */
  E.psarcWrite = async function (files, opts) {
    opts = opts || {};
    const all = [{ name: null, data: E.utf8(files.map((f) => f.name).join("\n")), compress: true }].concat(files);
    const zlengths = [], blobs = [], meta = [];
    for (const f of all) {
      const data = f.data, compress = f.compress != null ? f.compress : !/\.wem$/i.test(f.name || "");
      const zindex = zlengths.length;
      let size = 0;
      for (let o = 0; o < data.length; o += BLOCK) {
        const chunk = data.subarray(o, Math.min(data.length, o + BLOCK));
        let stored = chunk;
        if (compress) {
          const z = await E.deflate(chunk);
          if (z.length < chunk.length) stored = z;
        }
        zlengths.push(stored.length === BLOCK ? 0 : stored.length);
        blobs.push(stored);
        size += stored.length;
      }
      meta.push({ zindex, length: data.length, stored: size, md5: f.name == null ? new Uint8Array(16) : E.md5(f.name) });
    }
    const tocLength = HEADER + all.length * ENTRY + zlengths.length * 2;
    const toc = new E.Writer(tocLength, false);
    let offset = tocLength;
    for (const m of meta) {
      toc.bytes(m.md5).u32(m.zindex).uintBE(m.length, 5).uintBE(offset, 5);
      offset += m.stored;
    }
    for (const z of zlengths) toc.u16(z);
    let tocBytes = toc.result();
    const encrypt = opts.encrypt !== false;
    if (encrypt) tocBytes = E.aesCfbEncrypt(tocBytes, E.KEYS.psarcKey, E.KEYS.psarcIV);
    const head = new E.Writer(HEADER, false);
    head.bytes(E.utf8("PSAR")).u16(1).u16(4).bytes(E.utf8("zlib")).u32(tocLength).u32(ENTRY).u32(all.length).u32(BLOCK).u32(encrypt ? 4 : 0);
    return E.concat([head.result(), tocBytes].concat(blobs));
  };
})(typeof window !== "undefined" ? window : globalThis);

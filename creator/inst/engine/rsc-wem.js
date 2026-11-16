/* ---------------------------------------------------------------------------
 * rsc-wem.js -- Wwise audio (.wem) and sound banks (.bnk).
 *
 *   E.wemInfo(u8)            -> {codec: "vorbis"|"pcm", channels, sampleRate, samples, ...}
 *   E.wemToOgg(u8)           Wwise Vorbis -> a standard Ogg Vorbis file that browsers
 *                            decode (a port of ww2ogg + revorb: the stripped setup
 *                            header is rebuilt from the packed codebook library, the
 *                            packet type / window bits are restored, and the granule
 *                            positions are computed exactly, so no revorb pass is needed)
 *   E.wemToPlayable(u8)      -> {bytes, mime}: Ogg for Vorbis, the RIFF itself for PCM
 *   E.pcmToWem(channels, sr) 16-bit PCM .wem (RIFF WAVE) for songs made from scratch
 *   E.bankBuild(opts)        a Rocksmith song / preview sound bank for a .wem
 *
 * ww2ogg: (c) 2002 Xiph.org Foundation, 2009-2016 Adam Gashlin (BSD-3-Clause,
 * LICENSE-ww2ogg). The bank layout follows the banks of the sample songs.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const E = root.RSCreator.engine;

  // ---- RIFF --------------------------------------------------------------------------------
  function riffChunks(u8) {
    const r = new E.Reader(u8);
    const magic = E.latin1(u8.subarray(0, 4));
    if (magic !== "RIFF" && magic !== "RIFX") throw new Error("Not a RIFF/Wwise audio file.");
    r.le = magic === "RIFF";
    r.pos = 4;
    const riffSize = r.u32() + 8;
    if (E.latin1(u8.subarray(8, 12)) !== "WAVE") throw new Error("Not a WAVE file.");
    const chunks = {};
    let o = 12;
    while (o + 8 <= Math.min(riffSize, u8.length)) {
      const type = E.latin1(u8.subarray(o, o + 4));
      r.pos = o + 4;
      const size = r.u32();
      if (!chunks[type]) chunks[type] = { offset: o + 8, size };
      o += 8 + size + (size & 1 && type !== "data" ? 0 : 0);
    }
    return { chunks, le: r.le };
  }

  E.wemInfo = function (u8) {
    const { chunks, le } = riffChunks(u8);
    const fmt = chunks["fmt "];
    if (!fmt) throw new Error("Wwise audio without a fmt chunk.");
    const r = new E.Reader(u8, fmt.offset, le);
    const tag = r.u16(), channels = r.u16(), sampleRate = r.u32(), avgBytes = r.u32(), blockAlign = r.u16(), bits = r.u16();
    const info = { tag, channels, sampleRate, avgBytes, blockAlign, bits, fmtSize: fmt.size, chunks, le };
    if (tag === 0xffff) {
      info.codec = "vorbis";
      const vorbOff = chunks.vorb ? chunks.vorb.offset : fmt.offset + 0x18;
      info.samples = new E.Reader(u8, vorbOff, le).u32();
    } else if (tag === 0x0001 || tag === 0xfffe) {
      info.codec = "pcm";
      info.samples = chunks.data ? Math.floor(chunks.data.size / (blockAlign || channels * 2)) : 0;
    } else info.codec = "unknown";
    info.duration = info.samples / sampleRate;
    return info;
  };

  // ---- bit streams (LSB first, as Vorbis) ----------------------------------------------------
  class BitReader {
    constructor(u8, offset) { this.u8 = u8; this.pos = offset; this.bit = 0; this.total = 0; }
    read(n) {
      let v = 0;
      for (let i = 0; i < n; i++) {
        if (this.pos >= this.u8.length) throw new Error("Wwise audio: out of bits");
        if ((this.u8[this.pos] >> this.bit) & 1) v |= 1 << i;
        if (++this.bit === 8) { this.bit = 0; this.pos++; }
        this.total++;
      }
      return v >>> 0;
    }
  }
  class BitWriter {
    constructor() { this.bytes = []; this.cur = 0; this.nbits = 0; }
    write(v, n) {
      for (let i = 0; i < n; i++) {
        if ((v >>> i) & 1) this.cur |= 1 << this.nbits;
        if (++this.nbits === 8) { this.bytes.push(this.cur); this.cur = 0; this.nbits = 0; }
      }
    }
    writeBytes(u8, from, to) {
      if (this.nbits === 0) { for (let i = from; i < to; i++) this.bytes.push(u8[i]); return; }
      for (let i = from; i < to; i++) this.write(u8[i], 8);
    }
    finish() { if (this.nbits) { this.bytes.push(this.cur); this.cur = 0; this.nbits = 0; } return Uint8Array.from(this.bytes); }
  }
  const ilog = (v) => { let r = 0; while (v) { r++; v >>>= 1; } return r; };
  function quantvals(entries, dims) {
    const bits = ilog(entries);
    let vals = entries >> Math.floor((bits - 1) * (dims - 1) / dims);
    for (;;) {
      let acc = 1, acc1 = 1;
      for (let i = 0; i < dims; i++) { acc *= vals; acc1 *= vals + 1; }
      if (acc <= entries && acc1 > entries) return vals;
      if (acc > entries) vals--; else vals++;
    }
  }

  // ---- codebooks ----------------------------------------------------------------------------------
  let CB = null;
  function codebooks() {
    if (CB) return CB;
    const data = E.fromBase64(E.CODEBOOKS_AOTUV_B64);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tableAt = dv.getUint32(data.length - 4, true);
    const count = (data.length - tableAt) / 4;
    const offs = [];
    for (let i = 0; i < count; i++) offs.push(dv.getUint32(tableAt + 4 * i, true));
    CB = { data, offs, count };
    return CB;
  }
  /** Rebuild a packed (Wwise) codebook as a full Vorbis codebook. */
  function rebuildCodebook(bis, out, checkSize) {
    const dims = bis.read(4), entries = bis.read(14);
    out.write(0x564342, 24); out.write(dims, 16); out.write(entries, 24);
    const ordered = bis.read(1);
    out.write(ordered, 1);
    if (ordered) {
      out.write(bis.read(5), 5);
      let cur = 0;
      while (cur < entries) { const n = ilog(entries - cur), num = bis.read(n); out.write(num, n); cur += num; }
      if (cur > entries) throw new Error("Wwise codebook: entry count overflow");
    } else {
      const lenBits = bis.read(3), sparse = bis.read(1);
      if (lenBits === 0 || lenBits > 5) throw new Error("Wwise codebook: bad codeword length size");
      out.write(sparse, 1);
      for (let i = 0; i < entries; i++) {
        let present = 1;
        if (sparse) { present = bis.read(1); out.write(present, 1); }
        if (present) out.write(bis.read(lenBits), 5);
      }
    }
    const lookup = bis.read(1);
    out.write(lookup, 4);
    if (lookup === 1) {
      out.write(bis.read(32), 32); out.write(bis.read(32), 32);
      const vlen = bis.read(4), seq = bis.read(1);
      out.write(vlen, 4); out.write(seq, 1);
      const q = quantvals(entries, dims);
      for (let i = 0; i < q; i++) out.write(bis.read(vlen + 1), vlen + 1);
    }
    if (checkSize && Math.floor(bis.total / 8) + 1 !== checkSize) throw new Error("Wwise codebook: size mismatch");
  }

  // ---- Ogg pages --------------------------------------------------------------------------------------
  function oggPage(packet, granule, seq, flags) {
    const segs = Math.floor(packet.length / 255) + 1;
    if (segs > 255) throw new Error("Ogg packet too large for one page");
    const page = new Uint8Array(27 + segs + packet.length);
    const dv = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53, 0, flags], 0);
    const lo = granule % 4294967296, hi = Math.floor(granule / 4294967296);
    dv.setUint32(6, lo, true); dv.setUint32(10, hi, true);
    dv.setUint32(14, 1, true); dv.setUint32(18, seq, true); dv.setUint32(22, 0, true);
    page[26] = segs;
    let left = packet.length;
    for (let i = 0; i < segs; i++) { page[27 + i] = left >= 255 ? 255 : left; left -= 255; }
    page.set(packet, 27 + segs);
    dv.setUint32(22, E.crc32ogg(page), true);
    return page;
  }

  /** Wwise Vorbis (.wem) -> Ogg Vorbis bytes. */
  E.wemToOgg = function (u8) {
    const info = E.wemInfo(u8);
    if (info.codec !== "vorbis") throw new Error("Not Wwise Vorbis audio (format 0x" + info.tag.toString(16) + ").");
    const le = info.le, rd = (o, n) => { const r = new E.Reader(u8, o, le); return n === 2 ? r.u16() : r.u32(); };
    const ch = info.chunks, fmtOff = ch["fmt "].offset;
    const vorbSize = ch.vorb ? ch.vorb.size : -1;
    if (vorbSize === -1 && info.fmtSize !== 0x42) throw new Error("Wwise audio: expected a 0x42 fmt chunk");
    const vorbOff = ch.vorb ? ch.vorb.offset : fmtOff + 0x18;
    let noGranule = false, modPackets = false, setupOff, audioOff, bs0, bs1;
    if (vorbSize === -1 || vorbSize === 0x2a) {
      noGranule = true;
      const modSignal = rd(vorbOff + 4, 4);
      if (![0x4a, 0x4b, 0x69, 0x70].includes(modSignal)) modPackets = true;
      setupOff = rd(vorbOff + 0x10, 4); audioOff = rd(vorbOff + 0x14, 4);
      bs0 = u8[vorbOff + 0x28]; bs1 = u8[vorbOff + 0x29];
    } else if (vorbSize === 0x32 || vorbSize === 0x34) {
      setupOff = rd(vorbOff + 0x18, 4); audioOff = rd(vorbOff + 0x1c, 4);
      bs0 = u8[vorbOff + 0x30]; bs1 = u8[vorbOff + 0x31];
    } else throw new Error("Wwise audio: unsupported vorb layout (0x" + vorbSize.toString(16) + ")");
    const dataOff = ch.data.offset, dataEnd = dataOff + ch.data.size;
    const hdr = noGranule ? 2 : 6;
    const pages = [];
    let seq = 0;

    // identification
    {
      const w = new BitWriter();
      w.write(1, 8); for (const c of "vorbis") w.write(c.charCodeAt(0), 8);
      w.write(0, 32); w.write(info.channels, 8); w.write(info.sampleRate, 32); w.write(0, 32);
      w.write((info.avgBytes * 8) >>> 0, 32); w.write(0, 32); w.write(bs0, 4); w.write(bs1, 4); w.write(1, 1);
      pages.push(oggPage(w.finish(), 0, seq++, 2));
    }
    // comment
    {
      const w = new BitWriter(), vendor = "converted from Audiokinetic Wwise by RockShiny Creator (ww2ogg)";
      w.write(3, 8); for (const c of "vorbis") w.write(c.charCodeAt(0), 8);
      w.write(vendor.length, 32); for (const c of vendor) w.write(c.charCodeAt(0), 8);
      w.write(0, 32); w.write(1, 1);
      pages.push(oggPage(w.finish(), 0, seq++, 0));
    }
    // setup
    let modeBlockflag, modeBits;
    {
      const pOff = dataOff + setupOff, pSize = rd(pOff, 2);
      const bis = new BitReader(u8, pOff + hdr), w = new BitWriter();
      w.write(5, 8); for (const c of "vorbis") w.write(c.charCodeAt(0), 8);
      const cbCountLess1 = bis.read(8), cbCount = cbCountLess1 + 1;
      w.write(cbCountLess1, 8);
      const lib = codebooks();
      for (let i = 0; i < cbCount; i++) {
        const id = bis.read(10);
        if (id >= lib.count - 1) throw new Error("Wwise audio: unknown codebook " + id);
        const start = lib.offs[id], end = lib.offs[id + 1];
        rebuildCodebook(new BitReader(lib.data.subarray(0, end), start), w, 0);
      }
      w.write(0, 6); w.write(0, 16);                     // time domain transforms (placeholder)
      const floorCountLess1 = bis.read(6), floorCount = floorCountLess1 + 1;
      w.write(floorCountLess1, 6);
      for (let i = 0; i < floorCount; i++) {
        w.write(1, 16);                                 // floor type 1
        const parts = bis.read(5); w.write(parts, 5);
        const classList = []; let maxClass = 0;
        for (let j = 0; j < parts; j++) { const c = bis.read(4); w.write(c, 4); classList.push(c); if (c > maxClass) maxClass = c; }
        const dimsList = [];
        for (let j = 0; j <= maxClass; j++) {
          const d = bis.read(3); w.write(d, 3); dimsList.push(d + 1);
          const sub = bis.read(2); w.write(sub, 2);
          if (sub) { const mb = bis.read(8); w.write(mb, 8); if (mb >= cbCount) throw new Error("Wwise audio: bad floor masterbook"); }
          for (let k = 0; k < (1 << sub); k++) { const b = bis.read(8); w.write(b, 8); if (b - 1 >= cbCount) throw new Error("Wwise audio: bad floor subclass book"); }
        }
        w.write(bis.read(2), 2);
        const rangebits = bis.read(4); w.write(rangebits, 4);
        for (let j = 0; j < parts; j++) for (let k = 0; k < dimsList[classList[j]]; k++) w.write(bis.read(rangebits), rangebits);
      }
      const resCountLess1 = bis.read(6), resCount = resCountLess1 + 1;
      w.write(resCountLess1, 6);
      for (let i = 0; i < resCount; i++) {
        const type = bis.read(2); w.write(type, 16);
        if (type > 2) throw new Error("Wwise audio: bad residue type");
        w.write(bis.read(24), 24); w.write(bis.read(24), 24); w.write(bis.read(24), 24);
        const clsLess1 = bis.read(6), cls = clsLess1 + 1; w.write(clsLess1, 6);
        const classbook = bis.read(8); w.write(classbook, 8);
        const cascade = [];
        for (let j = 0; j < cls; j++) {
          const low = bis.read(3); w.write(low, 3);
          const flag = bis.read(1); w.write(flag, 1);
          let high = 0;
          if (flag) { high = bis.read(5); w.write(high, 5); }
          cascade.push(high * 8 + low);
        }
        for (let j = 0; j < cls; j++) for (let k = 0; k < 8; k++) if (cascade[j] & (1 << k)) w.write(bis.read(8), 8);
      }
      const mapCountLess1 = bis.read(6), mapCount = mapCountLess1 + 1;
      w.write(mapCountLess1, 6);
      for (let i = 0; i < mapCount; i++) {
        w.write(0, 16);
        const subFlag = bis.read(1); w.write(subFlag, 1);
        let submaps = 1;
        if (subFlag) { const s = bis.read(4); w.write(s, 4); submaps = s + 1; }
        const sq = bis.read(1); w.write(sq, 1);
        if (sq) {
          const stepsLess1 = bis.read(8); w.write(stepsLess1, 8);
          const nb = ilog(info.channels - 1);
          for (let j = 0; j <= stepsLess1; j++) { w.write(bis.read(nb), nb); w.write(bis.read(nb), nb); }
        }
        const reserved = bis.read(2); w.write(reserved, 2);
        if (reserved) throw new Error("Wwise audio: mapping reserved field nonzero");
        if (submaps > 1) for (let j = 0; j < info.channels; j++) w.write(bis.read(4), 4);
        for (let j = 0; j < submaps; j++) { w.write(bis.read(8), 8); w.write(bis.read(8), 8); w.write(bis.read(8), 8); }
      }
      const modeCountLess1 = bis.read(6), modeCount = modeCountLess1 + 1;
      w.write(modeCountLess1, 6);
      modeBlockflag = []; modeBits = ilog(modeCount - 1);
      for (let i = 0; i < modeCount; i++) {
        const bf = bis.read(1); w.write(bf, 1); modeBlockflag.push(!!bf);
        w.write(0, 16); w.write(0, 16); w.write(bis.read(8), 8);
      }
      w.write(1, 1);
      if (Math.ceil(bis.total / 8) !== pSize) throw new Error("Wwise audio: setup packet size mismatch");
      pages.push(oggPage(w.finish(), 0, seq++, 0));
    }
    // audio packets: type/window bits restored, exact granule positions (what revorb does)
    const size0 = 1 << bs0, size1 = 1 << bs1;
    let off = dataOff + audioOff, prevBlockflag = false, prevSize = 0, granule = 0;
    while (off < dataEnd) {
      const size = rd(off, 2);
      const payload = off + hdr, next = payload + size;
      if (next > dataEnd) throw new Error("Wwise audio: packet truncated");
      const w = new BitWriter();
      let mode;
      if (modPackets) {
        w.write(0, 1);
        const br = new BitReader(u8, payload);
        mode = br.read(modeBits);
        w.write(mode, modeBits);
        const rem = br.read(8 - modeBits);
        if (modeBlockflag[mode]) {
          let nextFlag = false;
          if (next + hdr <= dataEnd) {
            const nsize = rd(next, 2);
            if (nsize > 0) nextFlag = modeBlockflag[new BitReader(u8, next + hdr).read(modeBits)];
          }
          w.write(prevBlockflag ? 1 : 0, 1); w.write(nextFlag ? 1 : 0, 1);
        }
        prevBlockflag = modeBlockflag[mode];
        w.write(rem, 8 - modeBits);
        w.writeBytes(u8, payload + 1, next);
      } else {
        mode = (u8[payload] >> 1) & ((1 << modeBits) - 1);
        w.writeBytes(u8, payload, next);
      }
      const bsz = modeBlockflag[mode] ? size1 : size0;
      if (prevSize) granule += (prevSize + bsz) / 4;
      prevSize = bsz;
      off = next;
      const last = off >= dataEnd;
      const g = last && info.samples ? Math.min(granule, info.samples) : granule;
      pages.push(oggPage(w.finish(), g, seq++, last ? 4 : 0));
    }
    return E.concat(pages);
  };

  /** A browser-playable file of a .wem: Ogg Vorbis (converted) or the PCM RIFF itself. */
  E.wemToPlayable = function (u8) {
    const info = E.wemInfo(u8);
    if (info.codec === "vorbis") return { bytes: E.wemToOgg(u8), mime: "audio/ogg", info };
    if (info.codec === "pcm") {
      if (info.tag === 0x0001) return { bytes: u8, mime: "audio/wav", info };
      return { bytes: E.pcmToWem(E.wemPcmChannels(u8), info.sampleRate), mime: "audio/wav", info };
    }
    throw new Error("Unsupported Wwise codec 0x" + info.tag.toString(16) + ".");
  };

  /** Float channels of a 16-bit PCM .wem/.wav. */
  E.wemPcmChannels = function (u8) {
    const info = E.wemInfo(u8);
    if (info.codec !== "pcm" || info.bits !== 16) throw new Error("Not 16-bit PCM audio.");
    const d = info.chunks.data, n = info.samples, ch = info.channels;
    const dv = new DataView(u8.buffer, u8.byteOffset + d.offset, n * ch * 2);
    const out = [];
    for (let c = 0; c < ch; c++) out.push(new Float32Array(n));
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[c][i] = dv.getInt16((i * ch + c) * 2, true) / 32768;
    return out;
  };

  /** 16-bit PCM RIFF (a .wem Wwise and vgmstream read as PCM; also a plain .wav). */
  E.pcmToWem = function (channels, sampleRate) {
    const ch = channels.length, n = channels[0].length, dataBytes = n * ch * 2;
    const w = new E.Writer(44 + dataBytes);
    w.bytes(E.utf8("RIFF")).u32(36 + dataBytes).bytes(E.utf8("WAVE"));
    w.bytes(E.utf8("fmt ")).u32(16).u16(1).u16(ch).u32(sampleRate).u32(sampleRate * ch * 2).u16(ch * 2).u16(16);
    w.bytes(E.utf8("data")).u32(dataBytes);
    const out = w.buf, dv = new DataView(out.buffer);
    let o = w.pos;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const v = Math.max(-1, Math.min(1, channels[c][i]));
        dv.setInt16(o, v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), true); o += 2;
      }
    }
    return out.subarray(0, o);
  };

  // ---- sound banks -------------------------------------------------------------------------------------
  const PREFETCH = 51200;
  /** Deterministic 32-bit id from a text (stable output for the same song). */
  const idOf = (s) => (E.fnv1_32("rsc:" + s) | 1) >>> 0;
  // The HIRC objects of the sample songs' banks (Custom Song Toolkit templates); only the ids
  // (and the codec plugin) change from song to song. Sound objects of song and preview banks
  // differ in a few property bytes, hence two templates.
  const SOUND_SONG = "00000000010004000200000000000000000000000000000328000100000100000000004474c72600000003002e2f0000b0c0010000000300000000000000000000000000000000000000000000000000000000";
  const SOUND_PREVIEW = "0000000001000400020000000000000000000000000000f95b9476000001009ac208f94474c72600000003002e2f0000b0c0010000000300000000000000000001010001000000010000000000000000000000";
  const VOLUME_AT = 46;                          // offset of the volume (f32 dB) in both Sound templates
  const MIXER = "4474c726000029fcf09b0000000000000000000101000000000000000000000000000000000000000000000000000100000000000000";
  const ACTION = "000000000304000000000000000400000000";

  /**
   * A Rocksmith song (or preview) sound bank: BKHD | DIDX + DATA (the first 51 200 bytes of
   * the .wem, prefetched) | HIRC (sound, actor-mixer, play action, event "Play_<name>") | STID.
   * opts: {name: "DireStraitsSultansPlum" (or "..._Preview"), wemId, wem (bytes), codec, volume (dB),
   * preview, ids: {bank, sound, action, media}} (ids default to values derived from the name).
   */
  E.bankBuild = function (opts) {
    const name = opts.name, wemId = opts.wemId >>> 0, ids = opts.ids || {};
    const preview = opts.preview != null ? opts.preview : /_Preview$/.test(name);
    const bankId = ids.bank != null ? ids.bank >>> 0 : idOf("bank:" + name);
    const soundId = ids.sound != null ? ids.sound >>> 0 : idOf("sound:" + name);
    const actionId = ids.action != null ? ids.action >>> 0 : idOf("action:" + name);
    const eventId = E.fnv1_32("Play_" + name);
    const prefetch = opts.wem.subarray(0, Math.min(PREFETCH, opts.wem.length));
    const put = (u8, off, v) => new DataView(u8.buffer, u8.byteOffset).setUint32(off, v >>> 0, true);

    const sound = E.fromHex(preview ? SOUND_PREVIEW : SOUND_SONG);
    put(sound, 0, soundId); put(sound, 4, opts.codec === "pcm" ? 0x00010001 : 0x00040001); put(sound, 12, wemId); put(sound, 16, wemId);
    put(sound, 23, ids.media != null ? ids.media >>> 0 : idOf("media:" + name));   // a per-bank value (random in the samples)
    new DataView(sound.buffer).setFloat32(VOLUME_AT, opts.volume != null ? opts.volume : -7, true);   // SongVolume / PreviewVolume (dB)
    const mixer = E.fromHex(MIXER); put(mixer, 50, soundId);
    const action = E.fromHex(ACTION); put(action, 0, actionId); put(action, 6, soundId); put(action, 14, bankId);
    const event = new Uint8Array(12); put(event, 0, eventId); put(event, 4, 1); put(event, 8, actionId);

    const w = new E.Writer(prefetch.length + 512);
    const chunk = (tag, body) => { w.bytes(E.utf8(tag)).u32(body.length).bytes(body); };
    const hd = new E.Writer(28); hd.u32(91).u32(bankId).u32(0).u32(0).zeros(12);
    chunk("BKHD", hd.result());
    const di = new E.Writer(12); di.u32(wemId).u32(0).u32(prefetch.length);
    chunk("DIDX", di.result());
    chunk("DATA", prefetch);
    const hi = new E.Writer(256);
    const objs = [[2, sound], [7, mixer], [3, action], [4, event]];
    hi.u32(objs.length);
    for (const [type, body] of objs) hi.u8(type).u32(body.length).bytes(body);
    chunk("HIRC", hi.result());
    const bankName = "Song_" + name;
    const st = new E.Writer(64); st.u32(1).u32(1).u32(bankId).u8(bankName.length).bytes(E.utf8(bankName));
    chunk("STID", st.result());
    return { bytes: w.result(), bankId, eventId, soundId, actionId };
  };

  /** Ids of an existing bank (to rebuild it for a new .wem, e.g. after replacing the audio). */
  E.bankIds = function (u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = {};
    let o = 0;
    while (o + 8 <= u8.length) {
      const tag = E.latin1(u8.subarray(o, o + 4)), n = dv.getUint32(o + 4, true), b = o + 8;
      if (tag === "BKHD") out.bank = dv.getUint32(b + 4, true);
      if (tag === "HIRC") {
        let p = b + 4;
        for (let i = 0, cnt = dv.getUint32(b, true); i < cnt; i++) {
          const t = u8[p], sz = dv.getUint32(p + 1, true), id = dv.getUint32(p + 5, true);
          if (t === 2) { out.sound = id; out.media = dv.getUint32(p + 5 + 23, true); out.volume = dv.getFloat32(p + 5 + VOLUME_AT, true); }
          if (t === 3) out.action = id; if (t === 4) out.event = id;
          p += 5 + sz;
        }
      }
      o += 8 + n;
    }
    return out;
  };

  /** The .wem ids a bank references (DIDX), e.g. to find the full song's audio. */
  E.bankWemIds = function (u8) {
    const ids = [];
    let o = 0;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    while (o + 8 <= u8.length) {
      const tag = E.latin1(u8.subarray(o, o + 4)), n = dv.getUint32(o + 4, true);
      if (tag === "DIDX") for (let i = 0; i + 12 <= n; i += 12) ids.push(dv.getUint32(o + 8 + i, true));
      o += 8 + n;
    }
    return ids;
  };
})(typeof window !== "undefined" ? window : globalThis);

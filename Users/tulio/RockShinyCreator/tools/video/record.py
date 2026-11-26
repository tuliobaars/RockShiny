"""
Recording RockShiny in headless Chromium for the videos (tools/video/make_videos.py).

Frames come from the DevTools screencast (JPEG, device pixels: a 1440 x 810 page at
4/3 gives 1920 x 1080), each with its time stamp; a clip is any stretch of time
between two marks, turned into a constant 30 fps H.264 file by ffmpeg. The page gets
a caption bar (lower third, RockShiny's look), a visible mouse pointer with click
ripples, and a 'spotlight' helper -- all drawn by the page itself, so they are in
the frames.
"""
import asyncio, base64, os, shutil, subprocess, time

FPS = 30
W, H, DPR = 1440, 810, 4 / 3

OVERLAY_JS = r"""
(() => {
  if (window.__rsv) return;
  const css = `
  #__rsv_cap { position: fixed; left: 50%; bottom: var(--rsv-bottom, 96px); transform: translate(-50%, 14px); z-index: 2147483000; opacity: 0;
    transition: opacity .35s ease, transform .35s ease; pointer-events: none; max-width: 78vw;
    font-family: Inter, "Poppins", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  #__rsv_cap.on { opacity: 1; transform: translate(-50%, 0); }
  #__rsv_cap .box { display: flex; align-items: stretch; gap: 14px; padding: 12px 22px 13px 14px; border-radius: 14px;
    background: rgba(12, 15, 23, .86); backdrop-filter: blur(12px) saturate(140%); -webkit-backdrop-filter: blur(12px) saturate(140%);
    box-shadow: 0 14px 50px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.09); }
  #__rsv_cap .bar { width: 4px; border-radius: 3px; background: linear-gradient(180deg, #ffc46b, #f08a00); box-shadow: 0 0 14px rgba(245,165,36,.6); }
  #__rsv_cap b { display: block; color: #fff; font-size: 22px; font-weight: 800; letter-spacing: -.01em; line-height: 1.25; white-space: nowrap; }
  #__rsv_cap span { display: block; color: rgba(232,234,241,.72); font-size: 14.5px; font-weight: 500; margin-top: 2px; line-height: 1.35; }
  #__rsv_cap.top { top: var(--rsv-top, 84px); bottom: auto; }
  #__rsv_ptr { position: fixed; left: 0; top: 0; z-index: 2147483001; width: 22px; height: 22px; pointer-events: none; transition: opacity .3s; opacity: 0;
    background: no-repeat center / contain url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M4 2l15 10.5-6.3 1.3 3.8 7.4-2.7 1.3-3.8-7.5L5 20z' fill='white' stroke='black' stroke-width='1.3' stroke-linejoin='round'/></svg>");
    filter: drop-shadow(0 2px 4px rgba(0,0,0,.6)); }
  #__rsv_ptr.on { opacity: 1; }
  .__rsv_rip { position: fixed; z-index: 2147483000; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; pointer-events: none;
    border: 2.5px solid rgba(245,165,36,.95); box-shadow: 0 0 16px rgba(245,165,36,.6); animation: __rsvrip .55s ease-out forwards; }
  @keyframes __rsvrip { from { transform: scale(.35); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
  #__rsv_key { position: fixed; right: 28px; top: 92px; z-index: 2147483000; pointer-events: none; opacity: 0; transition: opacity .25s;
    font: 800 18px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #1a1206; background: #f5a524; padding: 9px 14px; border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0,0,0,.5), 0 0 18px rgba(245,165,36,.5); }
  #__rsv_key.on { opacity: 1; }
  `;
  const boot = () => {
    if (document.getElementById("__rsv_style")) return;
    const st = document.createElement("style"); st.id = "__rsv_style"; st.textContent = css; document.head.appendChild(st);
    const cap = document.createElement("div"); cap.id = "__rsv_cap"; cap.innerHTML = '<div class="box"><div class="bar"></div><div><b></b><span></span></div></div>';
    const ptr = document.createElement("div"); ptr.id = "__rsv_ptr";
    const key = document.createElement("div"); key.id = "__rsv_key";
    document.body.append(cap, ptr, key);
    addEventListener("mousemove", (e) => { ptr.style.transform = "translate(" + (e.clientX - 3) + "px," + (e.clientY - 2) + "px)"; ptr.classList.add("on"); }, true);
    addEventListener("mousedown", (e) => { const r = document.createElement("div"); r.className = "__rsv_rip"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
      document.body.appendChild(r); setTimeout(() => r.remove(), 700); }, true);
  };
  window.__rsv = {
    caption(title, sub, opts) {
      boot(); opts = opts || {};
      const c = document.getElementById("__rsv_cap");
      if (!title) { c.classList.remove("on"); return; }
      c.querySelector("b").textContent = title; c.querySelector("span").textContent = sub || "";
      c.querySelector("span").style.display = sub ? "block" : "none";
      c.classList.toggle("top", opts.pos === "top");
      if (opts.bottom != null) c.style.setProperty("--rsv-bottom", opts.bottom + "px");
      if (opts.top != null) c.style.setProperty("--rsv-top", opts.top + "px");
      c.classList.remove("on"); void c.offsetWidth; c.classList.add("on");
    },
    key(text) { boot(); const k = document.getElementById("__rsv_key"); k.textContent = text; k.classList.add("on"); clearTimeout(k._t); k._t = setTimeout(() => k.classList.remove("on"), 900); },
    hidePointer() { boot(); document.getElementById("__rsv_ptr").classList.remove("on"); },
    boot
  };
  if (document.readyState !== "loading") boot(); else addEventListener("DOMContentLoaded", boot);
})();
"""


class Recorder:
    """Screencast frames of one page, with time marks to cut clips from."""

    def __init__(self, page, workdir):
        self.page, self.dir = page, workdir
        os.makedirs(workdir, exist_ok=True)
        self.frames = []          # (path, t)
        self.marks = {}
        self.cdp = None
        self.n = 0

    async def start(self):
        self.cdp = await self.page.context.new_cdp_session(self.page)
        self.cdp.on("Page.screencastFrame", lambda p: asyncio.ensure_future(self._frame(p)))
        await self.cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 90, "everyNthFrame": 1,
                                                     "maxWidth": int(W * DPR), "maxHeight": int(H * DPR)})
        await asyncio.sleep(0.3)

    async def _frame(self, p):
        try:
            await self.cdp.send("Page.screencastFrameAck", {"sessionId": p["sessionId"]})
        except Exception:
            return
        path = os.path.join(self.dir, "f%06d.jpg" % self.n)
        self.n += 1
        with open(path, "wb") as f:
            f.write(base64.b64decode(p["data"]))
        self.frames.append((path, time.time()))

    def mark(self, name):
        self.marks[name] = time.time()
        return self.marks[name]

    async def stop(self):
        try:
            await self.cdp.send("Page.stopScreencast")
        except Exception:
            pass
        await asyncio.sleep(0.2)

    def clip_ranges(self, out, ranges):
        """Several stretches of time (pairs of marks or times) played one after the other -> out.mp4."""
        parts = []
        for i, (a, b) in enumerate(ranges):
            parts.append(self.clip(out + ".part%d.mp4" % i, a, b))
        if len(parts) == 1:
            os.replace(out + ".part0.mp4", out); return duration(out)
        lst = out + ".txt"
        with open(lst, "w") as f:
            for i in range(len(parts)): f.write("file '%s'\n" % (out + ".part%d.mp4" % i))
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out])
        for i in range(len(parts)): os.remove(out + ".part%d.mp4" % i)
        os.remove(lst)
        return duration(out)

    def clip(self, out, a, b, speed=1.0):
        """Frames between marks (or times) a and b -> out.mp4 (30 fps, 1920x1080). speed > 1 plays faster."""
        ta = self.marks.get(a, a) if isinstance(a, str) else a
        tb = self.marks.get(b, b) if isinstance(b, str) else b
        fr = [f for f in self.frames if f[1] <= tb]
        if not fr:
            raise RuntimeError("no frames before " + str(b))
        first = max([i for i, f in enumerate(fr) if f[1] <= ta] or [0])
        sel = fr[first:]
        lst = out + ".txt"
        with open(lst, "w") as f:
            for i, (p, t) in enumerate(sel):
                t0 = max(t, ta)
                t1 = sel[i + 1][1] if i + 1 < len(sel) else tb
                d = max(0.0, (min(t1, tb) - t0) / speed)
                if d <= 0 and i + 1 < len(sel):
                    continue
                f.write("file '%s'\nduration %.4f\n" % (p, max(d, 0.001)))
            f.write("file '%s'\n" % sel[-1][0])
        run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
             "-vf", "scale=1920:1080:flags=lanczos,fps=%d,format=yuv420p" % FPS, "-c:v", "libx264", "-preset", "medium", "-crf", "18", out])
        os.remove(lst)
        return duration(out)


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(" ".join(cmd[:6]) + "...\n" + r.stderr[-2000:])
    return r


def duration(path):
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path])
    return float(r.stdout.strip())


def concat(clips, out, music=None, fade=0.5, music_gain_db=0.0, tail=0.0):
    """Clips joined by cross-fades, with a music bed (faded out at the end) -> out.mp4."""
    durs = [duration(c) for c in clips]
    args = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    for c in clips:
        args += ["-i", c]
    fc, last, off = [], "[0:v]", 0.0
    for i in range(1, len(clips)):
        off += durs[i - 1] - fade
        fc.append("%s[%d:v]xfade=transition=fade:duration=%.2f:offset=%.3f[v%d]" % (last, i, fade, off, i))
        last = "[v%d]" % i
    total = sum(durs) - fade * (len(clips) - 1)
    if not fc:
        fc.append("[0:v]null[v0]"); last = "[v0]"
    maps = ["-map", last]
    if music:
        args += ["-i", music]
        fc.append("[%d:a]atrim=0:%.3f,afade=t=out:st=%.3f:d=2.5,volume=%.1fdB[a]" % (len(clips), total, max(0, total - 2.5), music_gain_db))
        maps += ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    args += ["-filter_complex", ";".join(fc)] + maps + ["-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
                                                         "-movflags", "+faststart", "-t", "%.3f" % total, out]
    run(args)
    return total


def hold(image, out, seconds):
    """A still image as a clip."""
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-i", image, "-t", "%.2f" % seconds,
         "-vf", "scale=1920:1080,fps=%d,format=yuv420p" % FPS, "-c:v", "libx264", "-crf", "18", out])
    return duration(out)

"""Page x renderer benchmark (see bench.html). Needs Python + Playwright.
   python3 tests/perf/run_bench.py [reps] [--gpu]     (serve repo root on :8765 first)
   --gpu: run Chromium's GPU pipeline on SwiftShader (accelerated 2D canvas, GPU
   raster + compositing, like a real machine). Without it, headless Chromium
   software-rasters canvas on the main thread, which unfairly penalises canvas."""
import asyncio, statistics, sys
from playwright.async_api import async_playwright
BASE = "http://localhost:8765/tests/perf/bench.html"
CHARTS = {"sultans_lead": 200.0, "numb_rhythm": 150.0}
async def run(b, page, renderer, chart, throttle, secs=6):
    ctx = await b.new_context(viewport={"width": 1280, "height": 720})
    pg = await ctx.new_page(); cdp = await ctx.new_cdp_session(pg)
    await pg.goto(f"{BASE}?page={page}&renderer={renderer}")
    await pg.evaluate(f"bench.setup('{chart}', {CHARTS[chart]})")
    await cdp.send("Performance.enable")
    await cdp.send("Emulation.setCPUThrottlingRate", {"rate": throttle})
    await pg.wait_for_timeout(1000)
    m0 = {m["name"]: m["value"] for m in (await cdp.send("Performance.getMetrics"))["metrics"]}
    iv = await pg.evaluate(f"bench.frames({secs * 1000})")
    m1 = {m["name"]: m["value"] for m in (await cdp.send("Performance.getMetrics"))["metrics"]}
    await ctx.close()
    n = len(iv); d = lambda k: (m1[k] - m0[k]) * 1000 / n
    return dict(fps=n / (sum(iv) / 1000), jank=100 * sum(x > 25 for x in iv) / n,
                main=d("TaskDuration"), script=d("ScriptDuration"), layout=d("LayoutDuration") + d("RecalcStyleDuration"))
async def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    reps = int(args[0]) if args else 2
    flags = ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--use-angle=swiftshader",
             "--enable-gpu-rasterization", "--enable-accelerated-2d-canvas"] if "--gpu" in sys.argv else []
    async with async_playwright() as p:
        b = await p.chromium.launch(args=flags)
        print(f"{'chart':13s} {'cpu':4s} {'page':6s} {'renderer':8s} {'fps':>5s} {'jank%':>6s} {'main ms/frame':>14s} {'script':>7s} {'style+layout':>13s}")
        for chart in CHARTS:
            for throttle in (1, 4):
                for page in ("plain", "shiny"):
                    for renderer in ("canvas", "dom"):
                        rs = [await run(b, page, renderer, chart, throttle) for _ in range(reps)]
                        a = {k: statistics.mean(r[k] for r in rs) for k in rs[0]}
                        print(f"{chart:13s} {str(throttle)+'x':4s} {page:6s} {renderer:8s} {a['fps']:5.1f} {a['jank']:6.1f} {a['main']:14.2f} {a['script']:7.2f} {a['layout']:13.2f}", flush=True)
        await b.close()
asyncio.run(main())

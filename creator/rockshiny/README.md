# creator/rockshiny/ — RockShiny's code, for the Creator on its own

The Creator uses RockShiny's R code: PSARC reading, chart parsing, lyrics lookup,
audio conversion and the library. It also uses a few RockShiny assets: the app's
CSS, the drop zone, and the karaoke lyrics tools.

- **Inside the RockShiny project** (`creator/` next to RockShiny's `R/`), it
  uses those files from the folder above.
- **On its own** (only the `creator/` folder), it uses this copy, so
  `shiny::runApp("creator")` works anywhere.

Do not edit the files here: change them in RockShiny, then refresh the copy.

```bash
python3 creator/tools/vendor_rockshiny.py           # refresh
python3 creator/tools/vendor_rockshiny.py --check   # is it current? (the tests check this)
```

`MANIFEST.json` lists the files with their MD5s. RockShiny is MIT-licensed
(`LICENSE`, `LICENSE.md`).

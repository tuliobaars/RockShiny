#!/bin/sh
# -----------------------------------------------------------------------------
# rs-convert.sh -- background Wwise (.wem) -> browser audio conversion.
#
# usage: rs-convert.sh VGMSTREAM FFMPEG WEM OUTDIR HEAD_SECONDS FULL SPEC [SPEC...]
#   HEAD_SECONDS  length of the quick-start clip (0 = none)
#   FULL          1 = also encode the whole song, 0 = head only
#   SPEC          "ext:ffmpeg,codec,args" (comma-separated ffmpeg args); tried in
#                 order until one encodes (e.g. ffmpeg without libvorbis)
# Output (each written to *.partial.<pid>.* and renamed, so readers never see a
# half-written file, and two concurrent jobs never share a temp file):
#   OUTDIR/head.<ext>, OUTDIR/audio.<ext>
# Progress: OUTDIR/job.status = decoding | head <ext> | done <ext> | error <msg>
# -----------------------------------------------------------------------------
VGM=$1; FF=$2; WEM=$3; OUT=$4; HEAD=$5; FULL=$6
shift 6
LOG="$OUT/job.log"
status() { printf '%s\n' "$*" > "$OUT/job.status.$$.tmp" && mv -f "$OUT/job.status.$$.tmp" "$OUT/job.status"; }

status decoding
WAV="$OUT/decoded.$$.wav"
if ! "$VGM" -o "$WAV" "$WEM" > "$LOG" 2>&1; then
  rm -f "$WAV"; status "error vgmstream could not decode the .wem (see job.log)"; exit 1
fi

for SPEC in "$@"; do
  EXT=${SPEC%%:*}
  ARGS=$(printf '%s' "${SPEC#*:}" | tr ',' ' ')
  # quick-start clip: the first HEAD_SECONDS
  if [ "$HEAD" != "0" ] && [ ! -s "$OUT/head.$EXT" ]; then
    # shellcheck disable=SC2086  (ARGS is intentionally word-split)
    if "$FF" -y -hide_banner -loglevel error -i "$WAV" -t "$HEAD" -vn $ARGS "$OUT/head.partial.$$.$EXT" >> "$LOG" 2>&1; then
      mv -f "$OUT/head.partial.$$.$EXT" "$OUT/head.$EXT"
    else
      rm -f "$OUT/head.partial.$$.$EXT"; continue         # encoder missing: next format
    fi
  fi
  if [ "$FULL" != "1" ]; then
    rm -f "$WAV"; status "head $EXT"; exit 0
  fi
  status "head $EXT"
  # shellcheck disable=SC2086
  if "$FF" -y -hide_banner -loglevel error -i "$WAV" -vn $ARGS "$OUT/audio.partial.$$.$EXT" >> "$LOG" 2>&1; then
    mv -f "$OUT/audio.partial.$$.$EXT" "$OUT/audio.$EXT"
    rm -f "$WAV"; status "done $EXT"; exit 0
  fi
  rm -f "$OUT/audio.partial.$$.$EXT"
done
rm -f "$WAV"
status "error no browser-playable format could be encoded (see job.log)"
exit 1

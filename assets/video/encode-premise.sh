#!/usr/bin/env bash
#
# Prepare a stock clip for the premise card on the homepage.
#
#   ./encode-premise.sh ~/Downloads/whatever-you-downloaded.mp4
#
# Produces, in this folder:
#   premise.mp4          720x900 (4:5), silent, ~10s, H.264 — what the page loads
#   premise-poster.jpg   first frame, shown until the video is ready
#
# The card is portrait, so a landscape source is centre-cropped. If the subject
# of your clip sits off-centre, nudge CROP_X below (0.5 = centre, 0 = left edge).
#
set -euo pipefail

SRC="${1:-}"
if [ -z "$SRC" ] || [ ! -f "$SRC" ]; then
  echo "usage: $0 <source-video>" >&2
  exit 1
fi

OUT_DIR="$(cd "$(dirname "$0")" && pwd)"
W=720           # card is 4:5; 720x900 matches what the page already ships
H=900
SECONDS_LONG=10 # keep it short — it loops, and every byte is on the critical path
START=0         # seconds into the source to begin
CROP_X=0.5      # horizontal centre of the crop, 0..1

# Scale so the shorter side covers the frame, then crop to 4:5.
ffmpeg -hide_banner -loglevel error -y \
  -ss "$START" -i "$SRC" -t "$SECONDS_LONG" \
  -vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-${W})*${CROP_X}:(ih-${H})/2,fps=25" \
  -an \
  -c:v libx264 -profile:v main -pix_fmt yuv420p \
  -crf 30 -preset slow \
  -movflags +faststart \
  "${OUT_DIR}/premise.mp4"

ffmpeg -hide_banner -loglevel error -y \
  -i "${OUT_DIR}/premise.mp4" -frames:v 1 -q:v 6 \
  "${OUT_DIR}/premise-poster.jpg"

echo "wrote:"
ls -lh "${OUT_DIR}/premise.mp4" "${OUT_DIR}/premise-poster.jpg" | awk '{print "  " $9 "  " $5}'
echo
echo "Aim for under ~1MB. If it is larger, raise -crf (32, 34) or cut SECONDS_LONG."

#!/bin/sh
# Renders every _render_*.html to a transparent PNG at 2x (and the horizontal logos to PDF).
E="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
D="$(cd "$(dirname "$0")" && pwd -W)"
for f in "$D"/_render_*.html; do
  n=$(basename "$f" .html); n=${n#_render_}
  w=$(grep -o 'viewBox="0 0 [0-9]* [0-9]*"' "$f" | head -1 | awk '{print $3}')
  h=$(grep -o 'viewBox="0 0 [0-9]* [0-9]*"' "$f" | head -1 | awk '{print $4}' | tr -d '"')
  "$E" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --force-device-scale-factor=2 --window-size=$w,$h --virtual-time-budget=8000 \
    --screenshot="$D/$n.png" "file:///$f" 2>/dev/null
  case "$n" in *horizontal*|*stacked*) "$E" --headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=8000 --print-to-pdf="$D/$n.pdf" "file:///$f" 2>/dev/null;; esac
done

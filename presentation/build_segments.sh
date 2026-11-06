#!/bin/bash
set -e
U=/root/.claude/uploads/d640cd64-7f79-5ecd-a1bc-3fa71f150d1b
O=/tmp/claude-0/-home-user-varuna-gcs/d640cd64-7f79-5ecd-a1bc-3fa71f150d1b/scratchpad/seg
SF=/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf
SN=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
txt() { # title subtitle dur
  local T="$1" ST="$2" D="$3"
  local A="if(lt(t,0.6),0,if(lt(t,1.2),(t-0.6)/0.6,if(gt(t,$D-0.6),max(0,($D-0.2-t)/0.4),1)))"
  echo "drawbox=x=0:y=ih*0.68:w=iw:h=ih*0.32:color=black@0.38:t=fill,drawtext=fontfile=$SF:text='$T':fontsize=130:fontcolor=0xF5C860:borderw=4:bordercolor=0x5a3a00@0.6:shadowx=6:shadowy=6:shadowcolor=black@0.7:x=(w-text_w)/2:y=h*0.76:alpha='$A',drawtext=fontfile=$SN:text='$ST':fontsize=64:fontcolor=white:shadowx=4:shadowy=4:shadowcolor=black@0.8:x=(w-text_w)/2:y=h*0.76+170:alpha='$A'"
}
seg() { # out file ss dur lowres title sub
  local OUT=$1 F=$2 SS=$3 D=$4 LR=$5
  local PRE="fps=30"; [ "$LR" = 1 ] && PRE="fps=30,hqdn3d=3:2:4:4"
  ffmpeg -v error -y -ss $SS -t $D -i $U/$F -an -vf "$PRE,scale=4032:2268:flags=lanczos,setsar=1,crop=3840:2160:x='192*t/$D':y='108*t/$D',unsharp=7:7:0.8,eq=contrast=1.07:saturation=1.22:brightness=0.01,vignette=PI/5,$(txt "$6" "$7" $D),fade=in:st=0:d=0.4,fade=out:st=$(echo "$D-0.4"|bc):d=0.4,format=yuv420p" -c:v libx264 -preset fast -crf 17 $O/$OUT.mp4
}
card() { # out file ss dur title sub
  local OUT=$1 D=$4
  local A="if(lt(t,0.5),0,if(lt(t,1.3),(t-0.5)/0.8,if(gt(t,$D-0.7),max(0,($D-0.2-t)/0.5),1)))"
  ffmpeg -v error -y -ss $3 -t $D -i $U/$2 -an -vf "fps=30,scale=1280:720,gblur=sigma=18,scale=3840:2160,setsar=1,eq=brightness=-0.18:saturation=1.2,vignette=PI/4,drawtext=fontfile=$SF:text='$5':fontsize=260:fontcolor=0xF5C860:borderw=6:bordercolor=0x5a3a00@0.6:shadowx=8:shadowy=8:shadowcolor=black@0.7:x=(w-text_w)/2:y=(h-text_h)/2-120:alpha='$A',drawtext=fontfile=$SN:text='$6':fontsize=80:fontcolor=white:shadowx=4:shadowy=4:shadowcolor=black@0.8:x=(w-text_w)/2:y=h/2+140:alpha='$A',fade=in:st=0:d=0.6,fade=out:st=$(echo "$D-0.6"|bc):d=0.6,format=yuv420p" -c:v libx264 -preset fast -crf 17 $O/$OUT.mp4
}
card s00 ac7383d3-VID-20261105-WA0018.mp4 0 4 "VARUNA AI" "AI Drone + Autonomous Boat for Cleaner Water"
seg s01 ac7383d3-VID-20261105-WA0018.mp4 0 5 1 "STEP 1 - DRONE LAUNCH" "The drone takes off to survey the water body"
seg s02 b61b87ae-VID-20261105-WA0001.mp4 1 4.5 1 "AERIAL SURVEILLANCE" "Drone scans the area from the sky"
seg s03 6d92cac0-VID-20261105-WA0016.mp4 21 4 1 "WASTE DETECTED" "AI identifies floating waste from above"
seg s04 3117396d-VID-20261105-WA0017.mp4 13 6 1 "LIVE ON GROUND STATION" "Detections stream to the Varuna GCS in real time"
seg s05 b61b87ae-VID-20261105-WA0001.mp4 28 5 1 "TARGET LOCATED" "Location shared with the clean-up boat"
seg s06 407ff779-video_20261106_141036.mp4 0 6 0 "STEP 2 - AUTONOMOUS BOAT" "The boat is deployed to the detected spot"
seg s07 d2f09032-video_20261106_140836.mp4 0 5.5 0 "COLLECTING WASTE" "Front collector gathers floating debris"
seg s08 92ae555e-video_20261106_141106.mp4 0 5 0 "SOLAR POWERED" "Clean energy for continuous operation"
seg s09 f32054de-video_20261106_141132.mp4 0 6 0 "MISSION COMPLETE" "Detect - Navigate - Clean"
card s10 f32054de-video_20261106_141132.mp4 2 4.5 "VARUNA AI" "Cleaner Water - Smarter Future"

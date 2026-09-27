#!/bin/sh
# 临时探针：验证取景循环帧率（6 秒）
rm -f /tmp/ds_feed.stop /tmp/ds_feed.done /tmp/ds_feed_0.jpg /tmp/ds_feed_1.jpg /tmp/ds_tmp.jpg
start_gst() {
  gst-launch-1.0 v4l2src device=/dev/video29 ! video/x-raw,width=640,height=360 ! videorate ! video/x-raw,framerate=12/1 ! videoconvert ! jpegenc ! multifilesink location=/tmp/ds_feed.jpg >/dev/null 2>&1 &
  echo $! > /tmp/ds_feed.pid
}
start_gst
n=0; i=0; start=$(date +%s)
while [ ! -f /tmp/ds_feed.stop ]; do
    now=$(date +%s)
    if [ $((now - start)) -ge 6 ]; then break; fi
    read pid < /tmp/ds_feed.pid 2>/dev/null
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        sleep 0.3; start_gst
    fi
    if [ -s /tmp/ds_feed.jpg ]; then
        cp -f /tmp/ds_feed.jpg /tmp/ds_tmp.jpg 2>/dev/null
        t=$(tail -c 2 /tmp/ds_tmp.jpg 2>/dev/null | od -An -tx1 | tr -d ' \n')
        if [ "$t" = "ffd9" ]; then
            mv -f /tmp/ds_tmp.jpg /tmp/ds_feed_$i.jpg
            n=$((n+1))
            printf '%d %d\n' "$n" "$i" > /tmp/ds_feed.done.n
            mv -f /tmp/ds_feed.done.n /tmp/ds_feed.done
            i=$((1 - i))
        fi
    fi
    sleep 0.08
done
echo "frames=$n in 6s" > /tmp/ds_feed_test_result
kill -9 $(cat /tmp/ds_feed.pid) 2>/dev/null
pkill -9 -f "gst-launch.*video29" 2>/dev/null

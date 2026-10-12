#!/bin/bash
# one video at a time, low priority, waits for RAM
cd "$(dirname "$0")"
while read -r id start end; do
  [ -z "$id" ] && continue
  [ -f raw/$id${start:+_$start}.npz ] && continue
  while [ $(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo) -lt 1500 ]; do sleep 15; done
  name=$id${start:+_$start}
  echo "$(date +%T) start $name" >> queue.log
  nice -n 15 timeout 2400 ${PY:-$HOME/moves-venv/bin/python} extract.py "$name" "https://www.youtube.com/watch?v=$id" "${start:--}" "${end:--}" heavy 2>/dev/null | grep '^{' >> queue.log || echo "$(date +%T) FAIL $name" >> queue.log
  rm -f tmp/$name*
done < "$1"
echo "$(date +%T) queue done $1" >> queue.log

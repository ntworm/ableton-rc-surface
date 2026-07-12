#!/bin/bash
# Spawns N parallel fake-phone clients, each with light modulator load.
# usage: ./launch-clients.sh N
N=${1:-8}
HOST=192.168.100.2
PORT=59065
DURATION_MS=15000

for i in $(seq 1 $N); do
  node scripts/stress/fake-phone-multi.mjs \
    --host $HOST --port $PORT \
    --n-lfos 2 --n-stutters 0 \
    --lfo-rate 4 --lfo-depth 0.6 \
    --duration-ms $DURATION_MS \
    > /tmp/stress-client-$i.log 2>&1 &
done

echo "spawned $N clients, waiting ${DURATION_MS}ms"
wait
echo "all clients finished"
for i in $(seq 1 $N); do
  echo "--- client $i ---"
  tail -3 /tmp/stress-client-$i.log
done

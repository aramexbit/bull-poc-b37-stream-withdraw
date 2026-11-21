#!/bin/bash
# Run the B-37 PoC end to end: fresh Anvil (chain-id 4663) on 127.0.0.1:8547, then node run.mjs.
# Exits 0 when the bug reproduces, 1 when it does not.
set -u
cd "$(dirname "$0")"
ANVIL="${ANVIL:-$HOME/.foundry/bin/anvil}"
LOG="/tmp/anvil-b37-poc.log"
rm -f "$LOG" poc-result.json
"$ANVIL" --port 8547 --chain-id 4663 --silent > "$LOG" 2>&1 &
APID=$!
trap 'kill $APID 2>/dev/null; wait $APID 2>/dev/null' EXIT
for i in $(seq 1 30); do
  curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://127.0.0.1:8547 >/dev/null 2>&1 && break
  sleep 0.5
done
node run.mjs
RC=$?
echo "run.mjs rc=$RC (0 = bug reproduced)"
exit $RC

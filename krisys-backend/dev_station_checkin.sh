#!/usr/bin/env bash
set -e
# USAGE: bash ./dev_station_checkin.sh <WALLET ADDRESS> (no quotes around the string)
# After seeding stations, and after then provisioning stations with dev_seed_stations.sh and dev_provision_foodtruck.sh, use this script to check-in by passing a WALLET_ID as parameter to this script call.
if [ $# -ne 1 ]; then
	echo "Usage: $0 <WALLET_ADDRESS>"
	exit 1
fi

WALLET_ADDRESS="$1"
HQ_URL="http://localhost:5000"
STATION_URL="http://localhost:6001"
FOODTRUCK_PASSPHRASE="foodtruck"

echo "Fetching crisisId from HQ"
CRISIS_JSON="$(curl -sS "$HQ_URL/crisis")"
CRISIS_ID="$(echo "$CRISIS_JSON" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

if [ -z "$CRISIS_ID" ]; then
	echo "Failed to extract crisisId from /crisis"
	echo "$CRISIS_JSON"
	exit 1
fi

echo "Running station check-in test"
echo "	Crisis: $CRISIS_ID"
echo "	Wallet: $WALLET_ADDRESS"
echo

echo "→ Submitting station check-in"
curl -sS -X POST "$STATION_URL/station/checkin" \
	-H "Content-Type: application/json" \
	-d "{
		\"crisisId\": \"$CRISIS_ID\",
		\"address\": \"$WALLET_ADDRESS\"
	}"
echo
echo

echo "→ Flushing station queue"
curl -sS -X POST "$STATION_URL/station/flush" \
	-H "Content-Type: application/json"
echo
echo "Done."
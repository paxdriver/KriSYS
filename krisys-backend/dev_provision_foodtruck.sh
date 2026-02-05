#!/usr/bin/env bash
set -e

STATION_URL="http://localhost:6001"
PASSPHRASE="foodtruck"

echo "Provisioning FOODTRUCK_001"
curl -X POST "$STATION_URL/station/provision" \
	-H "Content-Type: application/json" \
	-d "{\"passphrase\":\"$PASSPHRASE\"}"

echo
echo "If this is a fresh provision, restart docker-compose before check-ins."
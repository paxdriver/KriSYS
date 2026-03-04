#!/usr/bin/env bash
set -e

FOODTRUCK_STATION_URL="http://localhost:6001"
FOODTRUCK_PASSPHRASE="foodtruck"

echo "Provisioning FOODTRUCK_001"
curl -X POST "$FOODTRUCK_STATION_URL/station/provision" \
	-H "Content-Type: application/json" \
	-d "{\"passphrase\":\"$FOODTRUCK_PASSPHRASE\"}"

CAMP_STATION_URL="http://localhost:6003"
CAMP_PASSPHRASE="camp"

echo "Provisioning CAMP_CENTRAL station"
curl -X POST "$CAMP_STATION_URL/station/provision" \
	-H "Content-Type: application/json" \
	-d "{\"passphrase\":\"$CAMP_PASSPHRASE\"}"

echo
echo "Provisioning 2 statiosn complete"
echo "REMINDER: If this is a fresh provision, restart docker-compose before check-ins."
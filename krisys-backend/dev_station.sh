#!/usr/bin/env bash
set -e

HQ_URL="http://localhost:5000"
STATION_URL="http://localhost:6001"
ADMIN_TOKEN_FILE="blockchain/admin_token.txt"

if [ ! -f "$ADMIN_TOKEN_FILE" ]; then
	echo "Admin token not found: $ADMIN_TOKEN_FILE"
	exit 1
fi

ADMIN_TOKEN="$(cat "$ADMIN_TOKEN_FILE")"

echo "Using admin token from $ADMIN_TOKEN_FILE"
echo

create_station () {
	echo "Creating station: $1"
	curl -X POST "$HQ_URL/admin/station/create" \
		-H "Content-Type: application/json" \
		-H "X-Admin-Token: $ADMIN_TOKEN" \
		-d "{
			\"station_id\": \"$1\",
			\"name\": \"$2\",
			\"stype\": \"$3\",
			\"location\": \"$4\",
			\"passphrase\": \"$5\"
		}"
	echo
	echo
}

create_station "FOODTRUCK_001" "Food Truck 001" "foodtruck" "Sector TBD" "foodtruck"
create_station "CAMP_CENTRAL" "Camp Central" "camp" "Central" "camp"
create_station "BORDER_CROSSING_NE" "Border Crossing NE" "border" "NE" "border"

echo "Activating FOODTRUCK_001 via station"
curl -X POST "$STATION_URL/station/provision" \
	-H "Content-Type: application/json" \
	-d '{"passphrase":"foodtruck"}'

echo
echo "Done."
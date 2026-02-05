# DEV NOTE: Hard coding the provisioning of 3 stations for ease of testing - maybe consider for wizard later
# to help simplify setup if KriSys provider knows some of the permanent stations like hospitals at time of init
# * Seed 3 pending stations for Phase 5 testing.
# 	- passphrases are intentionally simple for development only
# 	- in production these must be long, printed, and distributed out-of-band

# STATION PASSPHRASES: "foodtruck", "camp", "border"
curl -X POST http://localhost:5000/admin/station/create \
	-H "Content-Type: application/json" \
	-d '{"station_id":"FOODTRUCK_001","name":"Food Truck 001","stype":"foodtruck","location":"Sector TBD","passphrase":"foodtruck"}'

curl -X POST http://localhost:5000/admin/station/create \
	-H "Content-Type: application/json" \
	-d '{"station_id":"CAMP_CENTRAL","name":"Camp Central","stype":"camp","location":"Central","passphrase":"camp"}'

curl -X POST http://localhost:5000/admin/station/create \
	-H "Content-Type: application/json" \
	-d '{"station_id":"BORDER_CROSSING_NE","name":"Border Crossing NE","stype":"border","location":"NE","passphrase":"border"}'

##############################
# THEN ACTIVATE ONE
# curl -sS -X POST http://localhost:6001/station/provision -H "Content-Type: application/json" -d '{"passphrase":"foodtruck"}'
#   RESPONSE: {"crisisId":"CRISIS ID DERIVED FROM PASSPHRASE + STATION_ID","device_id":"DEVICE ID PROVISIONED","station_id":"FOODTRUCK_001","status":"active"}
##############################
# TEST A CHECK-IN WITH THE NEWLY ACTIVATED STATION
# curl -sS -X POST http://localhost:6001/station/checkin \
#         -H "Content-Type: application/json" \
#         -d '{
#                 "crisisId": "CRISIS ID",
#                 "address": "WALLET ADDRESS TO CHECK-IN"
#         }'
#   RESPONSE: {"inserted":true,"relay_hash":"2d1de8a9-7428-47fa-8bec-9c4ed77324d1","status":"queued"}
##############################
# FINALLY, FLUSH THE STATION QUEUE AND MINE A BLOCK IN THE DEVTOOLS UI
# curl -sS -X POST http://localhost:6001/station/flush
#   RESPONSE: {"central_url":"http://backend:5000","checkins":{"attempted":1,"errors":[],"failed":0,"station_id":"FOODTRUCK_001","success":1},"messages":{"attempted":0,"errors":[],"failed":0,"success":0},"pull_error":null,"pulled_blocks_stored":0,"status":"ok"}
##############################
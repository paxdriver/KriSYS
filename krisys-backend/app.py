# krisys-backend/app.py
import hashlib
import uuid
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from blockchain import Blockchain, Transaction, PolicySystem
import time
import json
import fcntl
import glob
import os
import base64
from functools import wraps
from database import db_connection
import pgpy
import hmac
import secrets
import qrcode
from io import BytesIO

# DEV NOTE: logging for development only
import logging
# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# DEV - helper function to print size of blockchain database in kb
def get_db_size_kb():
	db_path = os.getenv('BLOCKCHAIN_DB_PATH', 'app/blockchain.db')
	if not os.path.exists(db_path):
		return 0.0
	# Get size in bytes
	size_bytes = os.path.getsize(db_path)
	# Convert to Kilobytes (KB)
	return size_bytes / 1024.0

# -----------------------
# TELEMETRY CONFIGURATION
# -----------------------

TIME_TIL_STATION_DEEMED_STALE = 120 	# Stations ping hq with status update every 60s, so 120s without a ping the station is stale

# Retention policy:
# Keep only the newest N events.
# This prevents unbounded DB growth.
ADMIN_EVENT_RETENTION_LIMIT = 20000  # keep last 20k events max
def emit_telemetry_event(
	source: str,
	severity: str,
	event_type: str,
	context: dict | None = None,
	node_id: str | None = None,
):
	"""
	Emit a structured operational event into admin_events table.

	This function:
	- Inserts structured telemetry into SQLite.
	- Enforces retention cap.
	- Does NOT affect blockchain logic.
	- Never raises fatal errors (telemetry must not break consensus).
	"""
		# Basic validation
	if severity not in ("info", "warning", "error", "critical"):
		severity = "info"

	try:
		with db_connection() as conn:
			conn.execute(
				'''
				INSERT INTO admin_events
				(source, node_id, severity, event_type, context_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?)
				''',
				(
					source,
					node_id,
					severity,
					event_type,
					json.dumps(context, separators=(",", ":"), ensure_ascii=False)
					if context else None,
					int(time.time()),
				)
			)

			# RETENTION ENFORCEMENT
			# Keep only the newest ADMIN_EVENT_RETENTION_LIMIT rows.
			conn.execute(
				# This approach might be more efficient that O(1)?
				# f'''
				# DELETE FROM admin_events
				# WHERE id < (
				# 	SELECT id FROM admin_events
				# 	ORDER BY created_at DESC
				# 	LIMIT 1 ADMIN_EVENT_RETENTION_LIMIT ?
				# )
				# '''
				f'''
				DELETE FROM admin_events
				WHERE id NOT IN (
					SELECT id FROM admin_events
					ORDER BY created_at DESC
					LIMIT {ADMIN_EVENT_RETENTION_LIMIT}
				)
				'''
			)

			conn.commit()

	except Exception as e:
		# Telemetry must never break application flow
		logger.error(f"Telemetry insert failed: {str(e)}")


MAX_MEMBERS = 20     # DEV NOTE: THIS SHOULD BE DEFINED IN THE BLOCKCHAIN ISNTANTIATION POLICY BY ADMIN
MIN_PASSPHRASE_LENGTH = 1   # set small limit, just for obfuscation not security

def _hq_state_dir() -> str:
	# Where dev_remote stores persistent artifacts (DB + keys + policy_id)
	return os.environ.get("KRISYS_HQ_STATE_DIR", "/app/data")

app = Flask(__name__, static_folder='static')

# docker-compose setup that spins up relay, station, app and blockchain
is_dev = os.environ.get("FLASK_ENV") == "development"
# Individual containers intended to simulate real network, using webserver, linode, and separate devices
dev_remote = os.environ.get("FLASK_ENV") == "dev_remote"



def _admin_token_state_dir() -> str:
	# In dev_remote, persist under the HQ state dir; otherwise under ./blockchain
	if dev_remote:
		return _hq_state_dir()
	return "blockchain"

def load_or_create_admin_token() -> str:
	"""
	File-backed admin token for guarding admin endpoints.
	Created once, persisted, and reused across restarts.
	"""
	state_dir = _admin_token_state_dir()
	os.makedirs(state_dir, exist_ok=True)

	path = os.path.join(state_dir, "admin_token.txt")
	lock_path = os.path.join(state_dir, ".admin_token.lock")

	with open(lock_path, "w", encoding="utf-8") as lf:
		fcntl.flock(lf.fileno(), fcntl.LOCK_EX)

		if os.path.exists(path):
			with open(path, "r", encoding="utf-8") as f:
				token = f.read().strip()
			if token:
				return token

		token = secrets.token_urlsafe(32)
		with open(path, "w", encoding="utf-8") as f:
			f.write(token)

		emit_telemetry_event(
			source="HQ",
			severity="critical",
			event_type="PGP",
			context={"path": private_key_file}
		)
		logger.warning("Created admin_token.txt at %s", path)
		return token

# DEV NOTE: ADMIN TOKEN FOR STATION CREATION/PROVISIONING, SEGREGATED FROM DEVTOOLS ADMIN BYPASS FOR NOW
# 	- In production, proper auth and secrets will be incorporated into this access so only HQ can hit ADMIN endpoints
ADMIN_STATION_TOKEN = load_or_create_admin_token()

def station_admin_required(fn):
	@wraps(fn)
	def wrapper(*args, **kwargs):
		token = request.headers.get("X-Admin-Token")
		if not isinstance(token, str) or not token.strip():
			return jsonify({"error": "UNAUTHORIZED: MISSING ADMIN TOKEN"}), 401
		if not hmac.compare_digest(token.strip(), ADMIN_STATION_TOKEN):
			return jsonify({"error": "UNAUTHORIZED: INVALID ADMIN TOKEN"}), 401
		return fn(*args, **kwargs)
	return wrapper
#####################################
# Station activation passphrase hashing (Phase 5)
# -------------------------------
# DEV NOTE:
# In production, this must be a long random secret set via environment variable and protected like a password.
# It prevents offline guessing if the stations table is ever leaked.
STATION_ACTIVATION_PEPPER = os.environ.get(	"STATION_ACTIVATION_PEPPER","DEV_ONLY_CHANGE_ME",)

def hash_station_activation_passphrase(passphrase: str) -> str:
	"""
	Hash a station activation passphrase for safe storage and lookup.

	- Deterministic (same passphrase -> same hash)
	- Non-reversible
	- Uses HMAC-SHA256 with a server-side pepper

	This hash is stored only while the station is in 'pending' state.
	It is deleted immediately after successful activation.
	"""
	if not isinstance(passphrase, str):
		raise ValueError("Activation passphrase must be a string")

	p = passphrase.strip()
	if not p:
		raise ValueError("Activation passphrase cannot be empty")

	return hmac.new(
		STATION_ACTIVATION_PEPPER.encode("utf-8"),
		p.encode("utf-8"),
		hashlib.sha256,
	).hexdigest()
# -------------------------------
####################################


# ----------------------------
# CORS configuration (browser access only)
# ----------------------------
################ DEV NOTE: CHANGE ADMIN SECRETS!!!!!!!
# CORS(app, origins=['http://localhost:3000', 'http://localhost:5000', 'http://localhost:5000/crisis'])
# app.secret_key = os.environ.get('SECRET_KEY', 'dev_secret_key_please_change_in_prod')  # PRODUCTION: Use secure random key
################
if is_dev or dev_remote:
	FRONTEND_ORIGINS = ["http://localhost:3000",]
else:
	# Production (locked down later via setup wizard)
	FRONTEND_ORIGINS = []

CORS(app, origins=FRONTEND_ORIGINS)


# DEV ONLY - with docker-compose
def dev_local_bootstrap_policy_id_and_cleanup() -> str | None:
	"""
	DEV LOCAL ONLY (docker-compose)

	If dev_policy_id.txt is missing:
	- generate new policy_id
	- wipe blockchain DB
	- wipe station DB
	- wipe station keys
	- wipe relay DB

	Returns policy_id or None.
	"""
	if not is_dev:
		return None

	policy_file = os.path.join("blockchain", "dev_policy_id.txt")
	os.makedirs(os.path.dirname(policy_file), exist_ok=True)

	policy_id = None
	if os.path.exists(policy_file):
		with open(policy_file, "r", encoding="utf-8") as f:
			policy_id = f.read().strip() or None

	if policy_id:
		emit_telemetry_event(
			source="HQ",
			severity="info",
			event_type="policy",
			context={"policy_id": policy_id}
		)
		logger.info(f"DEV: reusing persisted policy_id={policy_id}")
		return policy_id

	policy_id = uuid.uuid4().hex
	with open(policy_file, "w", encoding="utf-8") as f:
		f.write(policy_id)

	emit_telemetry_event(
		source="HQ",
		severity="warning",
		event_type="policy",
		context={"policy_id": policy_id}
	)
	logger.warning("DEV: dev_policy_id.txt missing; resetting ALL local state")

	# Delete old blockchain's api keys and databases to start fresh
	db_path = os.getenv("BLOCKCHAIN_DB_PATH", "blockchain.db")
	stale_paths = [
		db_path,
		"blockchain/master_public_key.asc",
		"blockchain/master_private_key.asc",
		os.path.join("device-offline-server", "station-data", "station.db"),
		os.path.join("device-offline-server", "station-data", "krisys_station_identity.json"),
		os.path.join("relay-offline-server", "relay-data", "relay.db"),
		os.path.join("camp_central", "station-data", "station.db"),
		os.path.join("camp_central", "station-data", "krisys_station_identity.json"),
	]

	for path in stale_paths:
		try:
			if os.path.exists(path):
				os.remove(path)
				logger.info(f"DEV: deleted {path}")
		except Exception as e:
			logger.warning(f"DEV: failed to delete {path}: {e}")

	return policy_id
def dev_remote_bootstrap_policy_id_and_cleanup() -> str | None:
	"""
	DEV-REMOTE ONLY (HQ on Linode).

	Rule:
	- If dev_policy_id.txt exists: reuse it.
	- If dev_policy_id.txt is missing/empty: treat as operator reset:
		- wipe HQ DB + master keys
		- generate and persist a new policy_id
	- Uses a file lock so only one gunicorn worker performs reset.

	Returns:
		policy_id (str) in dev_remote, else None
	"""
	if not dev_remote:
		return None

	state_dir = _hq_state_dir()
	os.makedirs(state_dir, exist_ok=True)

	policy_file = os.path.join(state_dir, "dev_policy_id.txt")
	lock_file = os.path.join(state_dir, ".reset.lock")

	# IMPORTANT: DB + key paths must match where Blockchain writes them.
	# If your Blockchain still writes keys under /app/blockchain, align that first.
	db_path = os.environ.get(
		"BLOCKCHAIN_DB_PATH",
		os.path.join(state_dir, "blockchain.db"),
	)
	pub_path = os.path.join(state_dir, "master_public_key.asc")
	priv_path = os.path.join(state_dir, "master_private_key.asc")

	with open(lock_file, "w", encoding="utf-8") as lf:
		fcntl.flock(lf.fileno(), fcntl.LOCK_EX)

		# If policy exists and is non-empty, reuse it
		if os.path.exists(policy_file):
			try:
				with open(policy_file, "r", encoding="utf-8") as f:
					existing = f.read().strip() or None
				if existing:
					logger.info("DEV-REMOTE: reusing persisted policy_id=%s", existing)
					return existing
			except Exception as e:
				logger.warning("DEV-REMOTE: failed reading policy file: %s", e)

		# Missing/empty policy file => operator reset
		logger.warning("DEV-REMOTE: dev_policy_id.txt missing/empty; performing HQ reset")

		for path in [db_path, pub_path, priv_path]:
			try:
				if os.path.exists(path):
					os.remove(path)
					logger.info("DEV-REMOTE: deleted %s", path)
			except Exception as e:
				logger.warning("DEV-REMOTE: failed deleting %s: %s", path, e)

		# Generate and persist new policy id after cleanup
		policy_id = uuid.uuid4().hex
		try:
			with open(policy_file, "w", encoding="utf-8") as f:
				f.write(policy_id)
		except Exception as e:
			logger.error("DEV-REMOTE: failed writing policy file: %s", e)
			raise

		logger.warning("DEV-REMOTE: created new policy_id=%s", policy_id)
		return policy_id

# GENERATING CRISIS BLOCKCHAIN - (an event and aftermath all tied to the same chain)
# persists policy across reloads until the policy_id textfile is deleted. When that happens we'll delete old databases (station.db and blockchain.db) and asc pgp key files belonging to the old blockchain (master_public_key.asc/master_private_key.asc) so that we're starting fresh.

if is_dev:
	persisted_policy_id = dev_local_bootstrap_policy_id_and_cleanup()
elif dev_remote:
	persisted_policy_id = dev_remote_bootstrap_policy_id_and_cleanup()
else:
	persisted_policy_id = None

# Policy is the settings and details of the crisis for which we need a KriSys blockchain 
policy_system = PolicySystem()
hurricane_policy_id = policy_system.create_crisis_policy(
	name="Hurricane Response 2024",
	organization="Orange Cross",
	contact="hurricane-response@orangecross.org",
	description="Emergency response protocol for 2025 Atlantic hurricane season",
	policy_settings={
		'block_interval': 180,  # 3 minutes
		'size_limit': 10240,    # 10KB for more detailed reports
		'rate_limit': 600,      # 10 minute between messages
		'priority_levels': {
			'evacuation': 1,
			'medical': 2,
			'shelter': 3,
			'supplies': 4,
			'personal': 5
		},
		'types': ['check_in', 'message', 'alert', 'damage_report']
	},
	# No policy_id provided -> generates UUID during the policy creation process
	policy_id=persisted_policy_id      # TODO: When building the crisis generation wizard for aid organizations to create an event, they can assign an id for that event to be the same as an id used in another system if they should choose, or as part of a relational database to help integrate different systems into one another easily.
)

# Activate the hurricane policy
policy_system.current_policy = hurricane_policy_id

# Create the blockchain
blockchain = Blockchain(policy_system)

########### TESTING IN DEV MODE ###############
def DEV_POLICY_CHECK():
	# Get current policy information
	current_policy = blockchain.policy_system.get_policy()
	emit_telemetry_event(
		source="HQ",
		severity="info",
		event_type="policy",
		context={
			"Crisis_Name": current_policy['name'],
			"policy_id": hurricane_policy_id,
			"Organization": current_policy['organization'],
			"Contact": current_policy['contact'],
			"Description": current_policy['description'],
			}
	)
	logger.info(f"Crisis Name: {current_policy['name']}")
	logger.info(f"policy_id: {hurricane_policy_id}")
	logger.info(f"Organization: {current_policy['organization']}")
	logger.info(f"Contact: {current_policy['contact']}")
	logger.info(f"Description: {current_policy['description']}")

	# Get specific policy setting
	block_interval = current_policy['policy']['block_interval']
	emit_telemetry_event(
		source="HQ",
		severity="info",
		event_type="blockchain",
		context={"Block_Interval": current_policy['policy']['block_interval']}
	)
	logger.info(f"block_interval: {block_interval}")
	
# Call policy check after the blockchain and policy are instatiated
DEV_POLICY_CHECK()

# Ensure only verified check-in stations count (plain text and public) for hospitals, camps, food trucks, etc. sanctioned by server
def ensure_station(crisis_id: str, station_id: str, name: str, stype: str, location: str | None = None):
	"""
	Ensure a station record exists for this crisis.
	If it already exists, do nothing.

	NOTE: This only creates the metadata row. Authentication
	(api_key_hash, status) is handled separately.
	"""
	with db_connection() as conn:
		row = conn.execute(
			"SELECT 1 FROM stations WHERE crisis_id = ? AND station_id = ?",
			(crisis_id, station_id),
		).fetchone()

		if row:
			emit_telemetry_event(
				source="HQ",
				severity="info",
				event_type="DB",
				context={"station_exists": station_id}
			)
			logger.info(f"Station {station_id} already exists for crisis {crisis_id}")
			return

		conn.execute(
			'''
			INSERT INTO stations (crisis_id, station_id, name, type, location)
			VALUES (?, ?, ?, ?, ?)
			''',
			(crisis_id, station_id, name, stype, location),
		)
		conn.commit()
		emit_telemetry_event(
			source="HQ",
			severity="info",
			event_type="DB",
			context={"station_created": station_id}
		)
		logger.info(f"Created station {station_id} ({name}) for crisis {crisis_id}")


# Auth for registered stations, rather than passphrase to unlock one-time set-up stores an api key registered remotely by the sys admin
def _dev_station_identity_file_path(station_id: str) -> str:
	base = os.path.join( os.path.dirname(__file__),
		"device-offline-server",
		"station-data",)
	os.makedirs(base, exist_ok=True)

	safe = "".join(c for c in station_id if c.isalnum() or c in ("_", "-"))
	return os.path.join(base, f"station_identity_{safe}.json")


def provision_dev_station_api_key(crisis_id: str, station_id: str) -> None:
	"""
	DEV ONLY: provision a station API key ONCE.

	Behavior:
	- If station already has api_key_hash and is active:
		- Do NOT rotate key on reload.
		- If identity file is missing, warn (cannot recover plaintext).
	- If station has no api_key_hash (or not active):
		- Generate a new key, store hash, set active.
		- Write plaintext key to station identity file for the station container.
	"""
	identity_path = _dev_station_identity_file_path(station_id)

	with db_connection() as conn:
		row = conn.execute(
			"""
			SELECT api_key_hash, status
			FROM stations
			WHERE crisis_id = ? AND station_id = ?
			""",
			(crisis_id, station_id),
		).fetchone()

	if not row:
		logger.error(f"DEV station provisioning failed: station {station_id} not found for crisis {crisis_id}")
		return

	has_hash = bool(row["api_key_hash"])
	is_active = row["status"] == "active"

	if has_hash and is_active:
		if os.path.exists(identity_path):
			return

		raise RuntimeError( f"Station {station_id} is provisioned in DB but identity file is missing "
			f"({identity_path}). Plain API key cannot be recovered. "
			"Dev recovery: delete blockchain/dev_policy_id.txt to reset and regenerate "
			"DB + keys + identity files together.")

	# Generate a new key only when needed (or forced)
	api_key = secrets.token_urlsafe(32)
	api_key_hash = hashlib.sha256(api_key.encode("utf-8")).hexdigest()

	with db_connection() as conn:
		conn.execute(
	  		"""
			UPDATE stations
			SET api_key_hash = ?, status = 'active'
			WHERE crisis_id = ? AND station_id = ?
			""",
			(api_key_hash, crisis_id, station_id),)
		conn.commit()

	identity = {
		"station_id": station_id,
		"crisis_id": crisis_id,
		"api_key": api_key,
		"createdAt": int(time.time()),
	}

	try:
		with open(identity_path, "w", encoding="utf-8") as f:
			f.write(json.dumps(identity, indent=2))
		logger.warning("DEV ONLY: wrote station identity file for %s at %s",
			station_id,
			identity_path,)
	except Exception as e:
		logger.error(f"DEV: failed writing station identity file: {e}")
		return

# DEV NOTE: SIMULATED VERIFIED STATION FOR DEMO (not when testing remotely, only docker-compose)
crisis_id = blockchain.crisis_metadata['id']
if is_dev:
	ensure_station(
		crisis_id=crisis_id,
		station_id="HOSPITAL_SE_001",
		name="Southeast Field Hospital",
		stype="hospital",
		location="Sector SE"
	)
	provision_dev_station_api_key(crisis_id, "HOSPITAL_SE_001")
if is_dev:
	# DEV NOTE: SECOND SIMULATED VERIFIED STATION FOR DEMO (not when testing remotely, only docker-compose)
	ensure_station(
		crisis_id=crisis_id,
		station_id="STATION_001",
		name="Default Check-in Station",
		stype="generic",
		location=None
	)
	provision_dev_station_api_key(crisis_id, "STATION_001")





	# DEV NOTE: This is simulating the station NOT used by devtools like the STATION_001 or HOSPITAL_SE_001, this is the station that acts like a real provisioned station which is already tested working with passphrase activation so this bootstrap automates this for quicker iteration while under development.
	# Set activation passphrase for dev bootstrap
# if is_dev and not dev_remote:
	# RUN BASH SCRIPTS TO AUTOMATICALLY PERFORM FOODTRUCK'S PROVISIONING AND OVERWRITE STALE CRISIS_ID'S (station container will need to be rebooted for new blockchain to take effect)




########### TESTING IN DEV MODE ###############


#####################
# Admin token setup : this is for the organization hosting the entire KriSYS system for a given disaster
ADMIN_TOKEN = ""

private_key_file = os.path.join('blockchain', 'master_private_key.asc')
if not os.path.exists(private_key_file):
	emit_telemetry_event(
		source="HQ",
		severity="critical",
		event_type="PGP",
		context={"message": "Master private key file not found! Shutting down."}
	)
	logger.critical("MASTER PRIVATE KEY FILE NOT FOUND. SHUTTING DOWN.")
	import sys
	sys.exit(1)
with open(private_key_file, 'r') as f:
	ADMIN_TOKEN = f.read()

# Admin authentication decorator
def admin_required(f):
	@wraps(f)
	def decorated_function(*args, **kwargs):
		auth_token = request.headers.get('X-Admin-Token')
		
		if not auth_token:
			return jsonify({"error": "UNAUTHORIZED: MISSING ADMIN TOKEN"}), 401        
		
		try:
			# Decode the base64-encoded token
			decoded_token = base64.b64decode(auth_token).decode('utf8')
			if decoded_token != ADMIN_TOKEN:
				return jsonify({"error": "UNAUTHORIZED: INVALID ADMIN TOKEN"}), 401
		except Exception as e:
			emit_telemetry_event(
				source="HQ",
				severity="critical",
				event_type="PGP",
				context={"error": str(e)}
			)
			logger.error(f"Token decoding error: {str(e)}")
			return jsonify({"error": "UNAUTHORIZED: INVALID TOKEN FORMAT"}), 401    
		return f(*args, **kwargs)
	return decorated_function

# # DEV NOTE: Create admin key file
# admin_key_file = os.path.join('blockchain', 'admin_keys.txt')
# try:
#     with open(admin_key_file, 'w') as f:
#         f.write(f"Blockchain ID: {blockchain.crisis_metadata['id']}\n")
#         f.write(f"Master Public Key: {str(blockchain.master_keypair.pubkey)}\n")
#         f.write(f"ADMIN_TOKEN: {os.environ['ADMIN_TOKEN']}\n")
#         f.write("WARNING: This token decrypts all wallet keys - PROTECT IT!\n")
#     logger.info(f"Admin key file created at {admin_key_file}")
# except Exception as e:
#     logger.error(f"Failed to create admin key file: {str(e)}")

# logger.info(f"Created crisis policy: {hurricane_policy_id}")
# logger.info(f"Current policy: {policy_system.current_policy}")
# logger.info(f"Policy details: {json.dumps(policy_system.get_policy(), indent=4)}")

#####################

# Test route
@app.route('/health', methods=['GET'])
def health():
	return jsonify({"role": "backend", "status": "ok"}), 200

# Crisis metadata
@app.route('/crisis', methods=['GET'])
def get_crisis_info():
	"""Get metadata about the current crisis"""
	return jsonify({
		"id": blockchain.crisis_metadata["id"],
		"name": blockchain.crisis_metadata['name'],
		"organization": blockchain.crisis_metadata['organization'],
		"contact": blockchain.crisis_metadata['contact'],
		"description": blockchain.crisis_metadata['description'],
		"created_at": blockchain.crisis_metadata['created_at'],
		"block_public_key": blockchain.crisis_metadata['public_key'],
	})

# Wallet info - NO KEYS INCLUDED
@app.route('/wallet/<family_id>', methods=['GET'])
def get_wallet(family_id):
	wallet = blockchain.wallets.get_wallet(family_id)
	if wallet:
		crisis_meta = blockchain.policy_system.get_policy()
		response = wallet.to_dict()
		response['crisis'] = {
			"id": crisis_meta['id'],
			"name": crisis_meta['name']
		}
		return jsonify(response)
	
	return jsonify({"error": "Wallet not found"}), 404

@app.route('/wallet/<family_id>/transactions')
def get_wallet_transactions(family_id):
	wallet = blockchain.wallets.get_wallet(family_id)
	if not wallet:
		return jsonify({"error": "Wallet not found"}), 404
	
	# Get all member addresses
	addresses = [member['address'] for member in wallet.members]
	
	# Find transactions related to any member - NO DECRYPTION ON SERVER
	transactions = []
	for block in blockchain.chain:
		for tx in block.transactions:
			if any(addr in tx.related_addresses for addr in addresses):
				transactions.append(tx.to_dict())
	
	return jsonify(transactions)

# Message submission with encryption
@app.route('/transaction', methods=['POST'])
def add_transaction():
	data = request.json or {}

	# Dev rate limit override
	rate_limit_override = request.headers.get('X-Dev-Rate-Override') == 'true'

	if not data:
		return jsonify({"error": "No data provided"}), 400

	if data.get('type_field') != 'message':
		return jsonify({"error": "THIS TYPE OF TRANSACTION IS NOT YET DEFINED"}), 500

	relay_hash = data.get('relay_hash', '')
	if relay_hash is None:
		relay_hash = ''

	if not isinstance(relay_hash, str) or not relay_hash.strip():
		return jsonify({"error": "relay_hash is required for offline-safe messaging"}), 400

	if len(relay_hash) > 128:
		return jsonify({"error": "relay_hash too long"}), 400

	relay_hash = relay_hash.strip()

	# 1) If already mined (exists in DB), treat as success (idempotent)
	with db_connection() as conn:
		row = conn.execute(
			"SELECT transaction_id FROM transactions WHERE relay_hash = ? LIMIT 1",
			(relay_hash,),
		).fetchone()

	if row:
		return jsonify(
			{
				"status": "deduped",
				"transaction_id": row["transaction_id"],
				"relay_hash": relay_hash,
			}
		), 200

	# 2) If already pending in memory, treat as success (idempotent)
	for tx in blockchain.pending_transactions:
		if (tx.relay_hash or "") == relay_hash:
			return jsonify(
				{
					"status": "deduped_pending",
					"transaction_id": tx.transaction_id,
					"relay_hash": relay_hash,
				}
			), 200

	# 3) Normal create path (encrypt if recipient_id provided)
	message_data = data.get('message_data', '')
	if not isinstance(message_data, str):
		return jsonify({"error": "message_data must be a string"}), 400

	if 'recipient_id' in data:
		public_key_str = blockchain.wallets.get_wallet_public_key(data['recipient_id'])
		if public_key_str:
			pub_key = pgpy.PGPKey()
			pub_key.parse(public_key_str)
			encrypted_msg = pub_key.encrypt(pgpy.PGPMessage.new(message_data))
			message_data = str(encrypted_msg)

	try:
		tx = Transaction(
			timestamp_created=int(data['timestamp_created']),
			station_address=data['station_address'],
			message_data=message_data,
			related_addresses=data['related_addresses'],
			type_field=data['type_field'],
			priority_level=int(data['priority_level']),
			relay_hash=relay_hash,
			posted_id=data.get('posted_id', ''),
		)

		blockchain.add_transaction(tx, rate_limit_override=rate_limit_override)
		return jsonify({"status": "success", "transaction_id": tx.transaction_id}), 201

	except ValueError as e:
		return jsonify({"error": str(e)}), 400
	except KeyError as e:
		return jsonify({"error": f"Missing field: {str(e)}"}), 400
	except Exception as e:
		emit_telemetry_event(
			source="HQ",
			severity="critical",
			event_type="blockchain",
			context={ "transaction_error": {str(e)} }
		)
		logger.error(f"Transaction error: {str(e)}")
		return jsonify({"error": "Internal server error"}), 500
	
@app.route('/blockchain', methods=['GET'])
def get_chain():
	chain_data = [block.to_dict() for block in blockchain.chain]
	return jsonify(chain_data), 200

@app.route('/address/<string:address>', methods=['GET'])
def get_address_transactions(address):
	txs = []
	for block in blockchain.chain:
		for tx in block.transactions:
			if address in tx.related_addresses:
				txs.append(tx.to_dict())
	return jsonify(txs), 200

# Wallet management endpoints - with passphrase encryption
@app.route('/wallet', methods=['POST'])
def create_wallet():
	"""Create a new family wallet with keys stored separately"""
	try: 
		data = request.json
		num_members = int(data.get('num_members', 1))
		passphrase = data.get('passphrase', '')  # Get passphrase from request
		
		if not passphrase or len(passphrase) < MIN_PASSPHRASE_LENGTH:
			return jsonify({"error": f"Passphrase must be at least {MIN_PASSPHRASE_LENGTH} characters"}), 400

		if num_members < 1 or num_members > MAX_MEMBERS:
			return jsonify({"error": "Number of members must be between 1-20"}), 400

		members = [{"name": f"Member {i+1}"} for i in range(num_members)]
		
		wallet = blockchain.wallets.create_wallet(
			family_id=hashlib.sha256(secrets.token_bytes(32)).hexdigest()[:24],
			members=members,
			crisis_id=blockchain.crisis_metadata['id'],
			passphrase=passphrase   # Passphrase deciphers private_key stored by blockchain host in wallet_keys, which is encrypted value by blockchain host's public/private keys to never store user's private key, but to allow simple passphrase for user to retrieve their private_key by memory
		)
		
		return jsonify(wallet.to_dict()), 201

	except Exception as e:
		emit_telemetry_event(
			source="HQ",
			severity="critical",
			event_type="DB",
			context={"wallet_creation_error": str(e)}
		)
		logger.error(f"Wallet creation error: {str(e)}")
		return jsonify({"error": "Wallet creation failed"}), 500


# DEV NOTE: MUST COMPLETELY CHANGE THIS FOR PROPER ADMIN AUTH, NEVER PASS ADMIN_TOKEN TO BROWSER
# TODO: create proper frontend panel with proper auth using JWT
@app.route("/admin", methods=["GET"])
def admin_panel():
    return render_template("admin.html",
        admin_token_b64=base64.b64encode(
			ADMIN_TOKEN.encode("utf-8")
		).decode("utf-8")
    )

@app.route("/debug/stations")
def debug_stations():
    with db_connection() as conn:
        rows = conn.execute("SELECT * FROM stations").fetchall()
        return jsonify([dict(r) for r in rows])

# HQ Telemetry ingestion endpoint
@app.route("/admin/telemetry", methods=["POST"])
def admin_receive_telemetry():
	"""
	Receive structured telemetry events from stations/relays.
	Authenticated via X-Station-API-Key.
	"""

	api_key = request.headers.get("X-Station-API-Key")
	if not api_key:
		return jsonify({"error": "Missing station API key"}), 401

	provided_hash = hashlib.sha256(api_key.encode("utf-8")).hexdigest()

	with db_connection() as conn:
		row = conn.execute(
			"""
			SELECT station_id, crisis_id
			FROM stations
			WHERE api_key_hash = ? AND status = 'active'
			""",
			(provided_hash,),
		).fetchone()

	if not row:
		return jsonify({"error": "Invalid station API key"}), 401

	data = request.get_json(force=True, silent=True) or {}

	source = data.get("source")
	severity = data.get("severity")
	event_type = data.get("event_type")
	context = data.get("context")
	node_id = data.get("node_id")

	if not isinstance(source, str) or not isinstance(event_type, str):
		return jsonify({"error": "Invalid telemetry payload"}), 400
	
	# HEARTBEAT: update last_seen only, do NOT persist
	if event_type == "lifecycle" and isinstance(context, dict):
		if context.get("event_name") == "heartbeat":
			with db_connection() as conn:
				conn.execute(
					"""
					UPDATE stations
					SET last_seen_at = ?
					WHERE station_id = ?
					""",
					(int(time.time()), node_id),
				)
				conn.commit()

			return jsonify({"status": "ok"}), 201

	# NON-HEARTBEAT events still persist
	emit_telemetry_event(
		source=source,
		severity=severity or "info",
		event_type=event_type,
		context=context if isinstance(context, dict) else {},
		node_id=node_id if isinstance(node_id, str) else row["station_id"],
	)

	# Also update last_seen for real lifecycle events
	with db_connection() as conn:
		# DEV NOTE: TODO - perform these updates in batches on HQ so that many stations update at same time
		conn.execute(
			"""
			UPDATE stations
			SET last_seen_at = ?
			WHERE station_id = ?
			""",
			(int(time.time()), node_id),
		)
		conn.commit()

	return jsonify({"status": "ok"}), 201

def _safe_parse_context_json(raw: str | None) -> dict | None:
	# Safely parse context_json without throwing.
	if not isinstance(raw, str) or not raw.strip():
		# Reject non-string or empty inputs.
		return None
	try:
		# Attempt JSON parsing.
		obj = json.loads(raw)
	except Exception:
		# Reject malformed JSON.
		return None
	return obj if isinstance(obj, dict) else None  # Only accept dict payloads.


@app.route("/admin/stations/status", methods=["GET"])
@admin_required
def admin_station_status():
	"""
	Aggregate station operational state for the HQ panel.

	Output:
	{
	  "stations": [ ... ],
	  "count": <number>
	}

	Combines:
	- authoritative station rows from `stations` table (includes pending/active metadata)
	- recent lifecycle/summary telemetry from `admin_events` (no new data collection)
	"""
	limit = request.args.get("limit", 1000)
	try:
		limit = int(limit)
	except Exception:
		limit = 1000  # fallback if limit query param is invalid
	limit = max(1, min(limit, 5000))  # clamp to a safe maximum

	crisis_id = blockchain.crisis_metadata["id"]

	with db_connection() as conn:
		# Fetch all configured stations for the current crisis (active, pending, etc.)
		station_rows = conn.execute(
			"""
			SELECT station_id, name, type, location, status, last_seen_at
			FROM stations
			WHERE crisis_id = ?
			ORDER BY station_id ASC
			""",
			(crisis_id,),
		).fetchall()

		# Fetch recent station-scoped telemetry events (lifecycle + summaries).
		event_rows = conn.execute(
			"""
			SELECT node_id, event_type, context_json, created_at
			FROM admin_events
			WHERE source = ? AND node_id IS NOT NULL AND node_id != ''
			ORDER BY created_at DESC
			LIMIT ?
			""",
			("station", limit),
		).fetchall()

	stations: dict[str, dict] = {}

	# Seed output with canonical station metadata.
	for row in station_rows:
		stations[row["station_id"]] = {
			"station_id": row["station_id"],
			"name": row["name"],
			"type": row["type"],
			"location": row["location"],
			"status": row["status"],
			"last_seen_at": row["last_seen_at"],
			"last_event_at": None,
			"lifecycle": {
				"connectivity": None,
				"mode": None,
				"last_lifecycle_event": None,
				"last_lifecycle_at": None,
			},
			"identity": {
				"verified_at": None,
				"rejected_at": None,
				"state": "unknown"
			},
			"summary": None,
		}

	# Merge telemetry context into the canonical list.
	for event in event_rows:
		station_id = event["node_id"]
		if not station_id:
			continue  # defensive guard

		entry = stations.get(station_id)
		if not entry:
			# Include stations known only from telemetry (defensive path).
			entry = {
				"station_id": station_id,
				"name": None,
				"type": None,
				"location": None,
				"status": "unknown",
				"last_seen_at": None,
				"last_event_at": None,
				"lifecycle": {
					"connectivity": None,
					"mode": None,
					"last_lifecycle_event": None,
					"last_lifecycle_at": None,
				},
				"identity": {
					"verified_at": None,
					"rejected_at": None,
					"state": "unknown"
				},
				"summary": None,
			}
		if entry["last_seen_at"] is None:
			entry["last_seen_at"] = event["created_at"]

		stations[station_id] = entry

		ctx = _safe_parse_context_json(event["context_json"])
		if not ctx:
			logger.warning('_safe_parse_context_json function call failed in HQ!!!!')
			continue

		event_type = event["event_type"]  # ← from DB column
		event_name = ctx.get("event_name")
		event_context = ctx.get("context") if isinstance(ctx.get("context"), dict) else {}
		event_timestamp = ctx.get("created_at") or event["created_at"]
		
		# Lifecycle aggregation
		if event_type == "lifecycle":
			if entry["lifecycle"]["last_lifecycle_event"] is None:
				entry["lifecycle"]["last_lifecycle_event"] = event_name
				entry["lifecycle"]["last_lifecycle_at"] = event_timestamp

			if event_name in ("online", "offline"):
				entry["lifecycle"]["connectivity"] = event_name

			if event_name == "mode_changed":
				to_mode = event_context.get("to")
				entry["lifecycle"]["mode"] = to_mode if isinstance(to_mode, str) else None

		
		if event_type == "summary" and event_name == "flush_summary" and entry["summary"] is None:
			entry["summary"] = {
				"messages_sent": event_context.get("messages_sent"),
				"checkins_sent": event_context.get("checkins_sent"),
				"blocks_pulled": event_context.get("blocks_pulled"),
				"summary_at": event_timestamp,
			}
		# Identity state inference for telemetric observability (active status check)
		if event_type == "lifecycle":
			if event_name == "online" and entry["identity"]["state"] == "unknown":
				entry["identity"]["state"] = "verified"
				entry["identity"]["verified_at"] = event_timestamp
			if event_name == "identity_rejected":
				entry["identity"]["state"] = "rejected"
				entry["identity"]["rejected_at"] = event_timestamp
	
	# STALE DETECTION INFERENCE
	NOW = int(time.time())
	OFFLINE_TIMEOUT = TIME_TIL_STATION_DEEMED_STALE   # Seconds til stale, set at top of script
	for entry in stations.values():
		last_seen = entry["last_seen_at"]
		station_id = entry["station_id"]
		previous_connectivity = entry["lifecycle"]["connectivity"]

		# --- HQ STALE DETECTION ---
		if last_seen and (NOW - last_seen) > OFFLINE_TIMEOUT:
			if previous_connectivity != "offline":
				entry["lifecycle"]["connectivity"] = "offline"

				# Persist HQ-derived offline transition
				emit_telemetry_event(
					source="HQ",  		# Derived by HQ
					severity="info",
					event_type="network",
					context={
						"event": "station_stale_timeout",
						"station_id": station_id,
						"last_seen_at": last_seen,
					},
					node_id=station_id,
				)

				logger.info(f"lost track of station: {station_id}")
		
		# --- HQ RECONNECT DETECTION ---
		elif last_seen and previous_connectivity == "offline":
			entry["lifecycle"]["connectivity"] = "online"

			# Persist HQ-derived reconnect transition
			emit_telemetry_event(
				source="HQ",		# Derived by HQ
				severity="info",
				event_type="network",
				context={
					"event": "station_reconnected",
					"station_id": station_id,
					"last_seen_at": last_seen,
				},
				node_id=station_id,
			)

			logger.info(f"station reconnected: {station_id}")


	out = sorted(stations.values(), key=lambda item: item["station_id"])
	return jsonify({"stations": out, "count": len(out)}), 200
# -------------------

# ADMIN EVENTS QUERY ENDPOINT
@app.route("/admin/events", methods=["GET"])
@admin_required
def get_admin_events():
	"""
	Query structured telemetry events.

	Query params:
	- severity (optional: critical, info, warning)
	- event_type (optional: PGP, DB, network, policy, blockchain)
	- limit (default 100)
	"""

	severity = request.args.get("severity")
	event_type = request.args.get("event_type")
	limit = request.args.get("limit", 100)

	try:
		limit = int(limit)
	except Exception:
		limit = 100

	query = "SELECT * FROM admin_events WHERE 1=1"
	params = []

	if severity:
		query += " AND severity = ?"
		params.append(severity)

	if event_type:
		query += " AND event_type = ?"
		params.append(event_type)

	query += " ORDER BY created_at DESC LIMIT ?"
	params.append(limit)

	with db_connection() as conn:
		rows = conn.execute(query, tuple(params)).fetchall()

	results = []
	for r in rows:
		results.append({
			"id": r["id"],
			"source": r["source"],
			"node_id": r["node_id"],
			"severity": r["severity"],
			"event_type": r["event_type"],
			"context": r["context_json"],
			"created_at": r["created_at"],
		})

	return jsonify(results), 200


# Admin endpoint for manual mining
@app.route('/admin/mine', methods=['POST'])
def mine_block():
	try: 
		if not blockchain.pending_transactions:
			return jsonify({"error": "No transactions to mine"}), 400
		block = blockchain.mine_block()
		blockchain.save_block(block)
		emit_telemetry_event(
			source="HQ",
			severity="info",
			event_type="DB",
			context={"DB_size": f"{get_db_size_kb()}kb" }
		)
		logger.info(f'DB SIZE: {get_db_size_kb()}kb')

		return jsonify({
			"message": f"Block #{block.block_index} mined",
			"hash": block.hash
		}), 200
	except Exception as e:
		emit_telemetry_event(
			source="HQ",
			severity="critical",
			event_type="blockchain",
			context={"mining_error": str(e)}
		)
		logger.error(f"Mining error: {str(e)}")
		return jsonify({"error": "Mining failed"}), 500


@app.route('/admin/alert', methods=['POST'])
@admin_required
def admin_alert():
	data = request.json
	try: 
		# Alerts are provider-only emergency interrupts.
		# Priority is always 1 by definition.
		tx = Transaction(
			timestamp_created=int(time.time()),
			station_address="ADMIN_ALERT",
			message_data=data['message'],
			related_addresses=[],
			type_field="alert",
			priority_level=1,
		)
		# Provider alerts should not be rate-limited like stations/users.
		blockchain.add_transaction(tx, rate_limit_override = True)
		return jsonify({"status": "success", "transaction_id": tx.transaction_id}), 201
	
	except KeyError as e:
		return jsonify({"error": f"Missing field: {str(e)}"}), 400
	
	except Exception as e:
		emit_telemetry_event(
			source="HQ",
			severity="critical",
			event_type="DB",
			context={"admin_alert_error": str(e)}
		)
		logger.error(f"Admin alert error: {str(e)}")
		return jsonify({"error": "Internal server error"}), 500


@app.route('/wallet/<family_id>/qr/<address>')
def get_address_qr(family_id: str, address: str):
	"""Generate QR code for a specific address"""
	try:
		# Generate QR code
		img = qrcode.make(address)
		buffered = BytesIO()
		img.save(buffered, "PNG")
		img_str = base64.b64encode(buffered.getvalue()).decode('utf-8')
		return jsonify({
			"qr_code": f"data:image/png;base64,{img_str}"
		})
		
	except Exception as e:
		emit_telemetry_event(
			source="HQ",
			severity="critical",
			event_type="network",
			context={"qr_code_generation_error": str(e)}
		)
		logger.error(f"QR generation error: {str(e)}")
		return jsonify({"error": "QR generation failed"}), 500


@app.route('/policy', methods=['GET'])
def get_current_policy():
	policy = blockchain.policy_system.get_policy()
	return jsonify(policy)


@app.route('/admin/policy', methods=['POST'])
@admin_required
def set_policy():
	data = request.json
	policy_id = data.get('policy_id')
	if policy_id in blockchain.policy_system.policies:
		blockchain.policy_system.current_policy = policy_id
		return jsonify({"status": "success", "policy": policy_id})
	return jsonify({"error": "Invalid Policy ID provided"}), 400


# HQ → Station Peer List Endpoint
@app.route("/crisis/stations", methods=["GET"])
def get_crisis_stations():
	"""
	Return list of active stations for this crisis.
	Authenticated via X-Station-API-Key.
	- Only active stations with api keys can call this endpoint for info about other active stations
	- This way stations can sync with one another and limit network attempts on LAN to known stations
	- Does NOT include pending or revoked stations
	"""

	api_key = request.headers.get("X-Station-API-Key")
	if not api_key:
		return jsonify({"error": "Missing station API key"}), 401

	provided_hash = hashlib.sha256(api_key.encode("utf-8")).hexdigest()

	with db_connection() as conn:
		# Validate calling station
		row = conn.execute(
			"""
			SELECT station_id, crisis_id
			FROM stations
			WHERE api_key_hash = ? AND status = 'active'
			""",
			(provided_hash,),
		).fetchone()

		if not row:
			return jsonify({"error": "Invalid station API key"}), 401

		crisis_id = row["crisis_id"]

		# Return all active stations for this crisis
		station_rows = conn.execute(
			"""
			SELECT station_id, name, type, location
			FROM stations
			WHERE crisis_id = ? AND status = 'active'
			ORDER BY station_id ASC
			""",
			(crisis_id,),
		).fetchall()

	stations = []
	for s in station_rows:
		stations.append({
			"station_id": s["station_id"],
			"name": s["name"],
			"type": s["type"],
			"location": s["location"],
		})

	return jsonify({
		"crisis_id": crisis_id,
		"stations": stations,
		"generated_at": int(time.time()),
	}), 200


# Verified check-in stations like camp office, food truck, hospital, etc.
# DEV NOTE:
#   -If X-Station-API-Key is missing → 401.
#   -If station_id isn’t in stations for this crisis_id → 400.
#   -If status != 'active' or api_key_hash missing → 403.
#   -If SHA-256(api_key) does not match api_key_hash (with hmac.compare_digest) → 401.
#   -Only then do we accept and add the check_in transaction.
#   -Checkins from offline generate relay_hash to help cull tx's pushed to blockchain and purge from queues
@app.route('/checkin', methods=['POST'])
def check_in():
	"""Process QR code scan and create check-in transaction"""
	try:
		data: dict = request.json or {}
		address = data.get('address')
		station_id = data.get('station_id', 'STATION_001')
		api_key = request.headers.get('X-Station-API-Key')  # Registered station api key, established by admin remotely before distributing station scanners
		
		relay_hash = data.get('relay_hash', '')
		
		if relay_hash is None:
			relay_hash = ''
		
		if not isinstance(relay_hash, str):
			return jsonify({"error": "relay_hash must be a string"}), 400
		
		if len(relay_hash) > 128:
			return jsonify({"error": "relay_hash too long"}), 400

		now_s = int(time.time())
		timestamp_created = data.get('timestamp_created', None)
		if timestamp_created is None:
			timestamp_created = now_s
		
		try:
			timestamp_created = int(timestamp_created)
		
		except Exception:
			return jsonify({"error": "timestamp_created must be an integer seconds"}), 400      
	 
		# Allow old timestamps (offline check-ins), but reject far-future values
		if timestamp_created < 0 or timestamp_created > now_s + 24 * 60 * 60:
			return jsonify({"error": "timestamp_created out of bounds"}), 400

		if not address:
			return jsonify({"error": "Missing address"}), 400

		if not api_key:
			return jsonify({"error": "Missing station API key"}), 401

		crisis_id = blockchain.crisis_metadata['id']

		# Look up station auth info
		with db_connection() as conn:
			row = conn.execute(
				'''
				SELECT api_key_hash, status
				FROM stations
				WHERE crisis_id = ? AND station_id = ?
				''',
				(crisis_id, station_id),
			).fetchone()

		if not row:
			emit_telemetry_event(
				source="HQ",
				severity="warning",
				event_type="network",
				context={"station_error": f"Check-in attempt from unknown station_id: {station_id} for crisis_id: {crisis_id}"}
			)
			logger.warning(f"Check-in attempt from unknown station_id={station_id} for crisis={crisis_id}")
			return jsonify({"error": "Unknown station_id"}), 400

		if row['status'] != 'active' or not row['api_key_hash']:
			emit_telemetry_event(
				source="HQ",
				severity="warning",
				event_type="network",
				context={"station_error": f"Check-in attempt from inactive station_id: {station_id} for crisis_id: {crisis_id}"}
			)
			logger.warning(f"Check-in attempt from inactive station_id={station_id} for crisis={crisis_id}, status={row['status']}")
			return jsonify({"error": "Station not active"}), 403

		# Verify API key
		provided_hash = hashlib.sha256(api_key.encode('utf-8')).hexdigest()
		if not hmac.compare_digest(provided_hash, row['api_key_hash']):
			emit_telemetry_event(
				source="HQ",
				severity="warning",
				event_type="network",
				context={"api_key_error": f"Invalid API key attempted from station_id: {station_id} for crisis_id: {crisis_id}"}
			)
			logger.warning(f"Invalid API key for station_id={station_id} crisis={crisis_id}")
			return jsonify({"error": "Invalid station API key"}), 401
		
		# If Station A products check-in while offline, share with peer station and peer can post it for Station A if that peer is online. Simply emit event for this, maybe be useful to tracing station functionality.
		posting_station_id = station_id  # from request body
		auth_station_id = row["station_id"]  # from API key lookup
		
		# log forwarding if id of station submitting the check-in differs from station_id on the transaction just for record-keeping purposes.
		if posting_station_id != auth_station_id: 
			emit_telemetry_event(
				source="HQ",
				severity="info",
				event_type="checkin_forwarded",
				context={
					"original_station_id": posting_station_id,
					"submitting_station_id": auth_station_id,
				},
				node_id=auth_station_id,
			)
		
		# Create check-in transaction
		tx = Transaction(
			timestamp_created = timestamp_created,
			station_address = station_id,
			message_data = "Check-in",
			related_addresses = [address],
			type_field = "check_in",
			priority_level = 2,		# default operational priority level and check-ins
			relay_hash = relay_hash
		)

		# Check-ins are high through-put, only stations are allowed to do check-ins and stations will cull repeated transactions on behalf of the server in the case of spamming abuse (like a bored unattended child repeated scanning just to play with the device while bored, for eg.)
		blockchain.add_transaction(tx, rate_limit_override=True) 
		return jsonify(
			{
				"status": "success",
				"transaction_id": tx.transaction_id,
				"relay_hash": relay_hash,
				"message": f"Checked in {address} at station {station_id}",
			}
		), 201

	except Exception as e:
		emit_telemetry_event(
			source="HQ",
			severity="critical",
			event_type="network",
			context={"check-in_error": str(e)}
		)
		logger.error(f"Check-in error: {str(e)}")
		return jsonify({"error": str(e)}), 400
	
	# TEST LIKE THIS OR use the devtools and the api key in the docker server logs with the DevTools button "Check-in":
	# curl -X POST http://localhost:5000/checkin \
	#     -H "Content-Type: application/json" \
	#     -H "X-Station-API-Key: <STATION_API_KEY>" \
	#     -d '{
	#          "address": "some-wallet-or-member-address",
	#          "station_id": "HOSPITAL_SE_001",
	#          "timestamp_created": 1730000000,
	#          "relay_hash": "uuid-optional-but-recommended-for-offline-dedupe"
	#     }'
	#
	# ---------------------------------------------------------------------------
	# CHECK-IN ENDPOINT (station-authenticated)
	# ---------------------------------------------------------------------------
	#
	# Purpose
	# -------
	# This endpoint is used by *verified stations* (e.g. hospitals, camp offices,
	# food trucks) to submit "check-in" events for victim/family wallet addresses.
	#
	# Design goals:
	# - Only pre-approved stations may create check-in transactions.
	# - Each station has a human-readable ID (station_id) that appears on-chain.
	# - Each station is *authenticated* by a secret API key that never appears
	#   on-chain or in the UI.
	# - The crisis master key still signs blocks; station keys authenticate
	#   *origin*, not consensus.
	#
	# IMPORTANT (lifecycle / security model)
	# -------------------------------------
	# - A station MUST be online to become a station (register/activate), because
	#   activation happens against central HQ and returns:
	#     - api_key (plaintext, returned ONCE)
	#     - crisis metadata + block_public_key (+ genesis block)
	# - The station activation passphrase is delivered out-of-band (separately
	#   from the station device) to reduce interception/misuse risk.
	#   Rationale: stations can submit operational check-ins at higher priority
	#   than normal messages, so station credentials must be treated as sensitive.
	# - Stations store the issued api_key locally (one key per physical station
	#   device) in `krisys_station_identity.json` and use it only in the HTTP
	#   header `X-Station-API-Key` when calling this endpoint.
	# - The passphrase is NOT used here. Passphrase is for one-time activation
	#   only (see /admin/station/create + /station/activate).
	#
	# Data model (stations table)
	# ---------------------------
	# stations (
	#   id                    INTEGER PRIMARY KEY,
	#   crisis_id             TEXT NOT NULL,   -- which crisis/blockchain
	#   station_id            TEXT NOT NULL,   -- e.g. "HOSPITAL_SE_001"
	#   name                  TEXT,            -- human readable name
	#   type                  TEXT,            -- "hospital", "shelter", etc.
	#   location              TEXT,            -- optional free text
	#
	#   -- One-time activation (pending state)
	#   registration_code_hash TEXT,           -- hash of activation passphrase
	#
	#   -- Long-term identity (active state)
	#   api_key_hash          TEXT,            -- SHA-256 of long-term API key
	#
	#   -- Lifecycle
	#   status                TEXT DEFAULT 'pending',  -- pending | active | revoked (future)
	#   activated_device_id   TEXT,            -- device UUID that activated (audit)
	#   activated_at          INTEGER,         -- unix seconds (audit)
	#   created_at            INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
	#
	#   UNIQUE(crisis_id, station_id),
	#   UNIQUE(registration_code_hash)         -- prevents passphrase reuse collisions
	# )
	#
	# Station provisioning / activation (current implementation)
	# ---------------------------------------------------------
	# There are two dev paths right now:
	#
	# 1) docker-compose DEV (legacy convenience for UI/devtools)
	#    - stations are created by ensure_station(...)
	#    - API keys are provisioned by provision_dev_station_api_key(...):
	#        - generates a random token_urlsafe(32) key,
	#        - stores SHA-256(key) in api_key_hash,
	#        - sets status = "active",
	#        - writes plaintext key to station_identity_<STATION_ID>.json
	#          (used by docker-compose station container + DevTools).
	#
	# 2) Phase 5 DEV-REMOTE / more realistic station lifecycle
	#    - Admin creates a pending station and one-time activation passphrase:
	#        POST /admin/station/create
	#        Header: X-Admin-Token: <ADMIN_STATION_TOKEN from admin_token.txt>
	#        Body: { station_id, name, stype, location, passphrase }
	#      Notes:
	#        - This endpoint is guarded by a temporary file-backed admin token
	#          (admin_token.txt). This is separate from the blockchain master key.
	#        - It stores only registration_code_hash (not plaintext passphrase).
	#
	#    - Station activates by passphrase (must be online):
	#        POST /station/activate
	#        Body: { passphrase, device_id }
	#      HQ returns api_key ONCE + crisis info + block_public_key (+ genesis block).
	#      Station stores api_key locally into krisys_station_identity.json.
	#
	# Request requirements (this /checkin endpoint)
	# --------------------------------------------
	# - JSON body must include:
	#     { "address": "<wallet address>", ... }
	# - JSON body may include:
	#     { "station_id": "<station id>" }
	#   If missing, station_id defaults to "STATION_001".
	# - JSON body may include (recommended for offline-safe dedupe):
	#     { "relay_hash": "<uuid>" }
	# - JSON body may include:
	#     { "timestamp_created": <int seconds> }  # allow old timestamps (offline)
	#
	# - HTTP headers must include:
	#     X-Station-API-Key: <station's long random API key>
	#
	# Authorization logic
	# -------------------
	# 1) address must be present → otherwise 400 "Missing address".
	# 2) X-Station-API-Key must be present → otherwise 401 "Missing station API key".
	# 3) Look up station row by (crisis_id, station_id):
	#       SELECT api_key_hash, status FROM stations
	#       WHERE crisis_id = ? AND station_id = ?
	#
	#    - If no row → 400 "Unknown station_id".
	# 4) Station must be active and have an api_key_hash:
	#    - If status != "active" or api_key_hash is NULL/empty →
	#         403 "Station not active".
	# 5) Verify API key:
	#    - Compute provided_hash = SHA-256(api_key_from_header).
	#    - Compare with stored api_key_hash using hmac.compare_digest to avoid
	#      timing leaks.
	#    - If mismatch → 401 "Invalid station API key".
	#
	# Only after all of the above passes do we:
	# - Construct a Transaction(...) with:
	#     type_field       = "check_in"
	#     station_address  = station_id        (appears on-chain)
	#     related_addresses = [address]        (the wallet being checked in)
	#     message_data     = "Check-in"        (currently fixed string)
	#     priority_level   = 2                 (operational priority; alerts are priority 1 only)
	# - Add the transaction to blockchain.pending_transactions.
	#
	# Mining and verification
	# -----------------------
	# - The background miner picks up pending transactions and builds a new Block,
	#   which is then hashed and signed by the crisis master key (sign_block).
	# - Clients verify blocks offline using pinned block_public_key.
	#
	# A check-in is therefore:
	# - station-authenticated at the transaction intake level (API key),
	# - and chain-authorized at the block level (crisis master key signature).
	#
	# Future integration notes
	# ------------------------
	# - We can change station registration/activation UX (passphrases, one-time
	#   codes, provider workflows) without changing this endpoint.
	# - This endpoint should remain: address + station_id + API key => check_in tx.
	# ---------------------------------------------------------------------------

# Stations are registered at central HQ, one-time passphrase required for activation.
# Once a station is activated, it stores its api key locally and uses that to unlock.
# DEV NOTE: THIS RETURNS SECRETS AND IS USED BY HQ ADMIN AND STATION REQUESTING API KEY
@app.route("/station/activate", methods=["POST"])
def station_activate():
	"""
	One-time station activation by passphrase (passphrase-only).

	Request JSON:
	{
		"passphrase": "foodtruck",
		"device_id": "optional-device-uuid"
	}

	Response (200):
	{
		"crisis": {
			"id": "...",
			"name": "...",
			"block_public_key": "...",
			"genesis_block": { ... }
		},
		"station": {
			"station_id": "...",
			"name": "...",
			"stype": "...",
			"location": "..."
		},
		"api_key": "..."
	}
	"""
	data = request.get_json(force=True, silent=True) or {}

	passphrase = data.get("passphrase")
	device_id = data.get("device_id")

	if not isinstance(passphrase, str) or not passphrase.strip():
		return jsonify({"error": "Missing passphrase"}), 400

	try:
		code_hash = hash_station_activation_passphrase(passphrase)
	except Exception as e:
		return jsonify({"error": str(e)}), 400

	# Find the pending station by passphrase hash (one-time)
	with db_connection() as conn:
		row = conn.execute(
			"""
			SELECT crisis_id, station_id, name, type, location, status, api_key_hash
			FROM stations
			WHERE registration_code_hash = ?
			LIMIT 1
			""",
			(code_hash,),
		).fetchone()

	if not row:
		return jsonify({"error": "Invalid passphrase"}), 404

	# If somehow already active, do not re-issue keys
	if row["status"] == "active" and row["api_key_hash"]:
		return jsonify({"error": "Station already active"}), 409

	# Issue API key ONCE (never stored plaintext)
	api_key = secrets.token_urlsafe(32)
	api_key_hash = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
	now_s = int(time.time())

	with db_connection() as conn:
		conn.execute(
			"""
			UPDATE stations
			SET
				api_key_hash = ?,
				status = 'active',
				registration_code_hash = NULL,
				activated_device_id = ?,
				activated_at = ?
			WHERE crisis_id = ? AND station_id = ?
			""",
			(
				api_key_hash,
				device_id.strip() if isinstance(device_id, str) else None,
				now_s,
				row["crisis_id"],
				row["station_id"],
			),
		)
		conn.commit()

	genesis = blockchain.chain[0].to_dict() if blockchain.chain else None

	return jsonify(
		{
			"crisis": {
				"id": blockchain.crisis_metadata["id"],
				"name": blockchain.crisis_metadata["name"],
				"block_public_key": blockchain.crisis_metadata["public_key"],
				"genesis_block": genesis,
			},
			"station": {
				"station_id": row["station_id"],
				"name": row["name"],
				"stype": row["type"],
				"location": row["location"],
			},
			"api_key": api_key,
		}
	), 200

# Authentication endpoint that returns private key for client-side decryption
@app.route('/auth/unlock', methods=['POST'])
def unlock_wallet_endpoint():
	"""
	Authenticate user and return private key for client-side decryption
	This is the ONLY server-side decryption - just for key delivery
	"""
	try:
		data = request.json
		family_id = data.get('family_id')
		passphrase = data.get('passphrase', "")  # Empty for development
		
		if not family_id:
			return jsonify({"error": "Missing family_id"}), 400
		
		# Check if wallet exists
		wallet = blockchain.wallets.get_wallet(family_id)
		if not wallet:
			return jsonify({"error": "Wallet not found"}), 404
		
		# Authenticate and get private key
		private_key_str = blockchain.wallets.authenticate_and_get_private_key(family_id, passphrase)
		
		if private_key_str:
			return jsonify({
				"status": "unlocked",
				"private_key": private_key_str,  # Send key to React frontend
				"message": "Wallet unlocked - private key delivered for client-side decryption"
			})
		else:
			return jsonify({"error": "Invalid passphrase"}), 401
			
	except Exception as e:
		emit_telemetry_event(
			source="HQ",
			severity="warning",
			event_type="network",
			context={"wallet_unlock_error": f"Wallet unlock failed: {str(e)}"}
		)
		logger.error(f"Unlock error: {str(e)}")
		return jsonify({"error": "Internal server error"}), 500

# DEV NOTE: move to admin UI in production, requiring admin key to access internally, not exposed by default
@app.route("/admin/station/create", methods=["POST"])
@station_admin_required
def admin_station_create():
	"""
	DEV / DEV-REMOTE ONLY CAN ACCESS WITHOUT AUTH

	Create or update a *pending* station that is waiting for activation
	via a one-time passphrase.

	Request JSON:
	{
		"station_id": "FOODTRUCK_001",
		"name": "Food Truck 001",
		"stype": "foodtruck",
		"location": "Sector A",
		"passphrase": "foodtruck"
	}

	Response (201):
	{
		"status": "pending",
		"crisis_id": "...",
		"station_id": "FOODTRUCK_001"
	}
	"""

	data = request.get_json(force=True, silent=True) or {}

	station_id = data.get("station_id")
	name = data.get("name")
	stype = data.get("stype") or data.get("type")
	location = data.get("location")
	passphrase = data.get("passphrase")

	if station_id and isinstance(station_id, str): station_id = station_id.strip()

	if not isinstance(station_id, str) or not station_id:
		return jsonify({"error": "Missing station_id"}), 400
	if not isinstance(name, str) or not name.strip():
		return jsonify({"error": "Missing name"}), 400
	if not isinstance(stype, str) or not stype.strip():
		return jsonify({"error": "Missing stype"}), 400
	if not isinstance(passphrase, str) or not passphrase.strip():
		return jsonify({"error": "Missing passphrase"}), 400

	try:
		code_hash = hash_station_activation_passphrase(passphrase)
	except Exception as e:
		return jsonify({"error": str(e)}), 400

	crisis_id = blockchain.crisis_metadata["id"]

	# Ensure the station exists (metadata only)
	ensure_station(
		crisis_id=crisis_id,
		station_id=station_id,
		name=name.strip(),
		stype=stype.strip(),
		location=location.strip() if isinstance(location, str) else None,
	)

	with db_connection() as conn:
		# Do not overwrite active stations
		row = conn.execute(
			"""
			SELECT status, api_key_hash
			FROM stations
			WHERE crisis_id = ? AND station_id = ?
			""",
			(crisis_id, station_id),
		).fetchone()

		if row and row["status"] == "active" and row["api_key_hash"]:
			return jsonify({
				"error": "Station already active"
			}), 409

		# Store pending activation hash
		conn.execute(
			"""
			UPDATE stations
			SET
				name = ?,
				type = ?,
				location = ?,
				status = 'pending',
				registration_code_hash = ?,
				api_key_hash = NULL
			WHERE crisis_id = ? AND station_id = ?
			""",
			(
				name.strip(),
				stype.strip(),
				location.strip() if isinstance(location, str) else None,
				code_hash,
				crisis_id,
				station_id,
			),
		)
		conn.commit()

	return jsonify({
		"status": "pending",
		"crisis_id": crisis_id,
		"station_id": station_id,
	}), 201

# Debug endpoints
@app.route('/debug/wallet/<family_id>')
def debug_wallet(family_id):
	wallet = blockchain.wallets.get_wallet(family_id)
	if not wallet:
		return jsonify({"error": "Wallet not found"}), 404
	return jsonify(wallet.to_dict())

@app.route('/debug/transactions')
def debug_transactions():
	all_transactions = []
	for block in blockchain.chain:
		for tx in block.transactions:
			all_transactions.append(tx.to_dict())
	return jsonify(all_transactions)

@app.route('/debug/blockchain')
def debug_blockchain():
	return jsonify([block.to_dict() for block in blockchain.chain])

@app.route('/wallet/<family_id>/public-key')
def get_wallet_public_key(family_id):
	"""Get public key for a wallet (for encryption)"""
	try:
		public_key_str = blockchain.wallets.get_wallet_public_key(family_id)
		if public_key_str:
			return jsonify({
				"family_id": family_id,
				"public_key": public_key_str
			})
		else:
			return jsonify({"error": "Public key not found"}), 404
	except Exception as e:
		emit_telemetry_event(
			source="HQ",
			severity="critical",
			event_type="DB",
			context={"wallet_pub_key_error": f"get_wallet_public_key failed: {str(e)}"}
		)
		logger.error(f"Error getting public key: {str(e)}")
		return jsonify({"error": "Internal server error"}), 500


if __name__ == '__main__':
	app.run(host='0.0.0.0', port=5000)
# krisys-backend/app.py
import hashlib
import uuid
from flask import Flask, request, jsonify
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

MAX_MEMBERS = 20     # DEV NOTE: THIS SHOULD BE DEFINED IN THE BLOCKCHAIN ISNTANTIATION POLICY BY ADMIN
MIN_PASSPHRASE_LENGTH = 1   # set small limit, just for obfuscation not security

def _hq_state_dir() -> str:
	# Where dev_remote stores persistent artifacts (DB + keys + policy_id)
	return os.environ.get("KRISYS_HQ_STATE_DIR", "/app/data")

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

app = Flask(__name__, static_folder='static')

# docker-compose setup that spins up relay, station, app and blockchain
is_dev = os.environ.get("FLASK_ENV") == "development"
# Individual containers intended to simulate real network, using webserver, linode, and separate devices
dev_remote = os.environ.get("FLASK_ENV") == "dev_remote"

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
	- wipe relay DB
	- wipe keys

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
		logger.info(f"DEV: reusing persisted policy_id={policy_id}")
		return policy_id

	policy_id = uuid.uuid4().hex
	with open(policy_file, "w", encoding="utf-8") as f:
		f.write(policy_id)

	logger.warning(
		"DEV: dev_policy_id.txt missing; resetting ALL local state"
	)

	db_path = os.getenv("BLOCKCHAIN_DB_PATH", "blockchain.db")

	stale_paths = [
		db_path,
		"blockchain/master_public_key.asc",
		"blockchain/master_private_key.asc",
		os.path.join("device-offline-server", "station-data", "station.db"),
		os.path.join("relay-offline-server", "relay-data", "relay.db"),
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
		logger.warning(
			"DEV-REMOTE: dev_policy_id.txt missing/empty; performing HQ reset"
		)

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
	logger.info(f"Crisis Name: {current_policy['name']}")
	logger.info(f"policy_id: {hurricane_policy_id}")
	logger.info(f"Organization: {current_policy['organization']}")
	logger.info(f"Contact: {current_policy['contact']}")
	logger.info(f"Description: {current_policy['description']}")

	# Get specific policy setting
	block_interval = current_policy['policy']['block_interval']
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
# DEV NOTE: SECOND SIMULATED VERIFIED STATION FOR DEMO (not when testing remotely, only docker-compose)
if is_dev:
	ensure_station(
		crisis_id=crisis_id,
		station_id="STATION_001",
		name="Default Check-in Station",
		stype="generic",
		location=None
	)
	provision_dev_station_api_key(crisis_id, "STATION_001")

########### TESTING IN DEV MODE ###############


#####################
# Admin token setup : this is for the organization hosting the entire KriSYS system for a given disaster
ADMIN_TOKEN = ""

private_key_file = os.path.join('blockchain', 'master_private_key.asc')
if not os.path.exists(private_key_file):
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
			logger.error(f"Token decoding error: {str(e)}")
			return jsonify({"error": "UNAUTHORIZED: INVALID TOKEN FORMAT"}), 401    
		return f(*args, **kwargs)
	return decorated_function
#####################

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

# Admin endpoint for manual mining
@app.route('/admin/mine', methods=['POST'])
def mine_block():
	try: 
		if not blockchain.pending_transactions:
			return jsonify({"error": "No transactions to mine"}), 400
		block = blockchain.mine_block()
		blockchain.save_block(block)
		return jsonify({
			"message": f"Block #{block.block_index} mined",
			"hash": block.hash
		}), 200
	except Exception as e:
		logger.error(f"Mining error: {str(e)}")
		return jsonify({"error": "Mining failed"}), 500

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
		logger.error(f"Wallet creation error: {str(e)}")
		return jsonify({"error": "Wallet creation failed"}), 500


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
			logger.warning(
				f"Check-in attempt from unknown station_id={station_id} "
				f"for crisis={crisis_id}"
			)
			return jsonify({"error": "Unknown station_id"}), 400

		if row['status'] != 'active' or not row['api_key_hash']:
			logger.warning(
				f"Check-in attempt from inactive station_id={station_id} "
				f"for crisis={crisis_id}, status={row['status']}"
			)
			return jsonify({"error": "Station not active"}), 403

		# Verify API key
		provided_hash = hashlib.sha256(api_key.encode('utf-8')).hexdigest()
		if not hmac.compare_digest(provided_hash, row['api_key_hash']):
			logger.warning(f"Invalid API key for station_id={station_id} crisis={crisis_id}")
			return jsonify({"error": "Invalid station API key"}), 401

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
		logger.error(f"Check-in error: {str(e)}")
		return jsonify({"error": str(e)}), 400
	
	# TEST LIKE THIS OR use the devtools and the api key in the docker server logs with the DevTools button "Check-in":
	# curl -X POST http://localhost:5000/checkin \
	#     -H "Content-Type: application/json" \
	#     -H "X-Station-API-Key: <PASTE_HOSPITAL_SE_001_KEY_HERE>" \
	#     -d '{"address": "some-wallet-address", "station_id": "HOSPITAL_SE_001"}'
	
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
	# Data model (stations table)
	# ---------------------------
	# stations (
	#   id                    INTEGER PRIMARY KEY,
	#   crisis_id             TEXT NOT NULL,   -- which crisis/blockchain
	#   station_id            TEXT NOT NULL,   -- e.g. "HOSPITAL_SE_001"
	#   name                  TEXT,            -- human readable name
	#   type                  TEXT,            -- "hospital", "shelter", etc.
	#   location              TEXT,            -- optional free text
	#   registration_code_hash TEXT,           -- FUTURE: one-time activation code
	#   api_key_hash          TEXT,            -- SHA-256 of long-term API key
	#   status                TEXT DEFAULT 'pending',  -- "pending", "active", "revoked"
	#   created_at            REAL DEFAULT (strftime('%s', 'now')),
	#   UNIQUE(crisis_id, station_id)
	# )
	#
	# In development:
	# - stations are created by ensure_station(...)
	# - API keys are provisioned by provision_dev_station_api_key(...):
	#     - generates a random token_urlsafe(32) key,
	#     - stores SHA-256(key) in api_key_hash,
	#     - sets status = "active",
	#     - logs the *plain* key once for manual testing.
	#
	# In production (FUTURE work):
	# - stations will be created in "pending" with a registration_code_hash.
	# - on first boot, a station device will send:
	#       { station_id, registration_code }
	#   to a dedicated registration endpoint.
	# - server verifies the registration code, then:
	#     - generates the API key,
	#     - stores api_key_hash,
	#     - sets status = "active",
	#     - clears registration_code_hash,
	#     - returns the plain API key once to the device.
	# - device stores the key locally; operators never type passwords.
	#
	# Request requirements (current endpoint)
	# --------------------------------------
	# - JSON body must include:
	#     { "address": "<wallet address>", ... }
	# - JSON body may include:
	#     { "station_id": "<station id>" }
	#   If missing, station_id defaults to "STATION_001".
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
	#     type_field      = "check_in"
	#     station_address = station_id        (appears on-chain)
	#     related_addresses = [address]       (the wallet being checked in)
	#     message_data    = "Check-in"
	#     priority_level  = 1                 (high priority for mining)
	# - Add the transaction to blockchain.pending_transactions.
	#
	# Mining and verification
	# -----------------------
	# - The background miner (or /admin/mine) picks up pending transactions and
	#   builds a new Block, which is then:
	#     - hashed,
	#     - signed by the crisis master key (sign_block),
	#     - saved to the DB.
	#
	# - Clients (frontend) fetch blocks via /blockchain and /crisis, reconstruct the
	#   signed header (block_index, hash, previous_hash) and verify block.signature
	#   with block_public_key. Only verified blocks are treated as canonical.
	#
	# - A check-in is therefore:
	#   - station-authenticated at the transaction level (API key),
	#   - and chain-authorized at the block level (crisis master key signature).
	#
	# Future integration notes
	# ------------------------
	# - The ONLY part that will change when we add the full registration flow is
	#   *how* api_key_hash and status are set:
	#     - today: via provision_dev_station_api_key(...) in app startup (dev only).
	#     - future: via a dedicated registration endpoint using registration_code.
	#
	# - The logic inside /checkin (address + station_id + API key → transaction)
	#   should stay the same, so any changes to registration do NOT require
	#   rewriting this endpoint.
	#
	# ---------------------------------------------------------------------------

# Stations are registered at central HQ, one-time passphrase required for activation.
# Once a station is activated, it stores its api key locally and uses that to unlock.
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
		logger.error(f"Unlock error: {str(e)}")
		return jsonify({"error": "Internal server error"}), 500

# DEV NOTE: move to admin UI in production, requiring admin key to access internally, not exposed by default
@app.route("/admin/station/create", methods=["POST"])
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
		logger.error(f"Error getting public key: {str(e)}")
		return jsonify({"error": "Internal server error"}), 500


if __name__ == '__main__':
	app.run(host='0.0.0.0', port=5000)
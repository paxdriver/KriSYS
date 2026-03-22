# krisys-backend/device-offline-server/app.py
"""
KriSYS Offline Station Server

This service runs on a physical station device (e.g. hospital, shelter,
food distribution point) and acts as an offline mesh relay.

Responsibilities:
	- Accept unconfirmed client messages (relay_hash-based) while offline
	- Persist queued messages and recent blocks to disk (SQLite)
	- Prevent duplicate storage via inventory + dedupe checks
	- Enforce single-crisis operation via crisisId pinning
	- Relay queued messages to central backend when connectivity returns
	- Verify received blocks (hash + signature) before storing
	- Use verified blocks to mark relay_hash confirmed and prune queued

Trust model:
	- Station must be bootstrapped from the trusted central server at least once
	  (same requirement as wallet creation).
	- Station stores the crisis trust anchor (block_public_key) extracted from
	  genesis metadata into SQLite meta.
	- relay_hash (UUID) is the stable ID for offline messages.
	- transaction_id exists after central acceptance (but we do not depend on it
	  for mesh dedupe).

Timestamp conventions:
	- timestamp_created: seconds since epoch (int)
	- queuedAt / generatedAt / confirmedAt: milliseconds since epoch (int)

RULES:
1)	If:
	- has local identity
	- AND was verified by HQ at least once
	- AND pinned crisis exists
Then:
	role = "station"

2) Else if:
	- pinned crisis exists
	- AND has chain
Then:
	role = "relay"

3) Else:
	role = "uninitialized"

4) If HQ reachable:
	online = true
Else:
	online = false


Role			|	Online	|	Behavior
----------------------------------------------------------------------
station			|	yes		|	accept check‑ins, flush immediately
station			|	no		|	accept check‑ins, queue, preserve timestamps
relay			|	yes		|	sync blocks + queued msgs
relay			|	no		|	local relay only
uninitialized	|	any		|	reject station + mesh actions
"""

import os
import time
import sqlite3
import json
import base64
import uuid
import hashlib
from contextlib import contextmanager
import requests
import pgpy
from flask import Flask, jsonify, request
from flask_cors import CORS
import threading
# --- Station device identity (self-signed keypair)
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.backends import default_backend
import base64
# ---
import logging
# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
# ----------------------------
# CORS configuration (browser DevTools access)
# ----------------------------
# docker-compose setup that spins up relay, station, app and blockchain
is_dev = os.environ.get("FLASK_ENV") == "development"
# Individual containers intended to simulate real network, using webserver, linode, and separate devices
dev_remote = os.environ.get("FLASK_ENV") == "dev_remote"

if is_dev or dev_remote:
	FRONTEND_ORIGINS = ["http://localhost:3000","http://localhost:6600"]
else:
	# Production, lock this down later
	FRONTEND_ORIGINS = []
CORS(app, origins=FRONTEND_ORIGINS)
###########################################

# In-memory cache (not source of truth; SQLite is source of truth)
STATION_STATE = {
	"crisisId": None,
	"mode": "unknown",   # "station" | "relay"
	"lastCentralOk": None,
	"lastIdentityVerifiedAt": None,
	"lastIdentityRejectedAt": None, 
}

RUNTIME_STATE_LOCK = threading.Lock()

# Inventory protocol bounds (must match wallet + station-frontend limits)
# DEV NOTE: see also ->
# 	- device-offline-server/rtc-host/server.js (node server on station handles rtc layer)
# 	- krisys-frontend/contexts/P2PContext.js
MAX_QUEUED_PER_PAYLOAD = 100      # relay_hash cap per inventory exchange
MAX_BLOCKS_PER_PAYLOAD = 10       # block suffix cap per payload

# Abuse / safety limits (keep bounded to protect station)
MAX_BLOCKS_STORED = 25
MAX_CONFIRMED_PER_PAYLOAD = 500
MAX_PER_ORIGIN = 50
MAX_MESSAGE_LENGTH = 8192
MAX_ADDRESSES_PER_TX = 16
MAX_ADDRESS_LENGTH = 128
MAX_STATION_ADDRESS_LENGTH = 128
MAX_TYPE_FIELD_LENGTH = 32

# Inventory request cap (relay_hashes only)
RELAY_HASH_CAP = 1000

# Priority bounds (matches your crisis policy convention)
TOP_PRIORITY = 1
BOTTOM_PRIORITY = 5

# Central backend URL from station's perspective (inside docker network)
CENTRAL_URL = os.environ.get("CENTRAL_API_URL")

# Persistent data for offline unconfirmed messages, blockchain, etc.
DATA_DIR = os.environ.get("STATION_DATA_DIR", "/app/data")
STATION_DB_PATH = os.path.join(DATA_DIR, "station.db")
STATION_IDENTITY_FILE = os.path.join(DATA_DIR, "krisys_station_identity.json")

# HEARTBEAT reporting prevents: silent failures, frozen stations appearing healthy, blind spots in monitoring
HEARTBEAT_INTERVAL_MS = 60_000  # 1 minute	DEV NOTE: probably can set this to hourly, choosing short interval for dev

####### THESE VALUES ARE FOR DEVELOPMENT ONLY, WILL BE SET BY POLICY IN PROD
# Storage pruning (DEV-TUNED DEFAULTS)
QUEUED_TTL_MS = 7 * 24 * 60 * 60 * 1000
QUEUED_HIGH_WATER = 500
QUEUED_LOW_WATER = 250
QUEUED_SOFT_WATER = int(QUEUED_HIGH_WATER * 0.6) # heads up before the stop, just for soft warnings
def is_storage_under_pressure(count: int) -> bool:
	return count >= int(QUEUED_SOFT_WATER)

CONFIRMED_TTL_MS = 2 * 24 * 60 * 60 * 1000
CONFIRMED_MAX_ROWS = 20

FLUSH_INTERVAL_SECONDS = 15  	# event loop for station to check every 15s if it is online and has messages to flush to HQ
####### THESE VALUES ARE FOR DEVELOPMENT ONLY, WILL BE SET BY POLICY IN PROD

# --------------------
# POOL LISTING LIMITS
# --------------------
POOL_DEFAULT_TTL_SECONDS = 300      # 5 minutes
POOL_MAX_ENTRIES = 50               # hard cap


#               IMPORTANT                   #
STATION_ID = os.environ.get("STATION_ID")  # can be None
def load_station_identity() -> dict | None:
	try:
		# DEV MODE: explicit station selection (docker-compose)
		if STATION_ID:
			path = os.path.join(
				DATA_DIR,
				f"station_identity_{STATION_ID}.json",
			)
		# REAL DEVICE MODE: single station identity
		else:
			path = STATION_IDENTITY_FILE

		if not os.path.exists(path):
			return None

		with open(path, "r", encoding="utf-8") as f:
			obj = json.loads(f.read())

		if not isinstance(obj.get("station_id"), str):
			return None
		if not isinstance(obj.get("api_key"), str):
			return None
		if not isinstance(obj.get("crisis_id"), str):
			return None

		return obj
	except Exception:
		return None


# Station API key is set up on-site by trusted delegate of the blockchain service provider via one-time password
# DEV NOTE: hard coded for development, this will be saved on device during setup
_station_identity = load_station_identity()

# Optional: used only for docker-compose dev to simulate multiple stations
STATION_ID = _station_identity["station_id"] if _station_identity else None

def get_station_api_key() -> str | None:
	return _station_identity["api_key"] if _station_identity else None

logger.info(f'Station API key (DEV ONLY): {_station_identity} (may not be loaded, race condition on first load)')
# ------------------


def _identity_path_for_write() -> str:
	# Matches load_station_identity() behavior so compose/dev and real device both work.
	env_station_id = os.environ.get("STATION_ID")
	if env_station_id and isinstance(env_station_id, str) and env_station_id.strip():
		safe = env_station_id.strip()
		return os.path.join(DATA_DIR, f"station_identity_{safe}.json")

	return STATION_IDENTITY_FILE


def reload_station_identity_in_memory() -> None:
	global _station_identity
	global STATION_ID

	_station_identity = load_station_identity()
	STATION_ID = _station_identity["station_id"] if _station_identity else None


def get_or_create_station_device_id() -> str:
	"""
	Local device ID for audit only. Not a trust mechanism.
	Stored in station meta so it persists across restarts.
	"""
	init_station_db()

	existing = db_get_meta("deviceId")
	if isinstance(existing, str) and existing.strip():
		return existing.strip()

	new_id = str(uuid.uuid4())
	db_set_meta("deviceId", new_id)
	return new_id

@contextmanager
def station_db():
	"""
	Context manager for station SQLite access.
	Ensures the data directory exists and connections are closed cleanly.
	"""
	os.makedirs(DATA_DIR, exist_ok=True)
	conn = sqlite3.connect(STATION_DB_PATH)
	conn.row_factory = sqlite3.Row
	try:
		yield conn
	finally:
		conn.close()


def init_station_db():
	"""
	Initialize persistent storage tables.
	Safe to call repeatedly.
	"""
	with station_db() as conn:
		# Store genesis block and metadata for the crisis
		conn.execute(
			"""
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
			"""
		)
		# Table for queue messages to be added to a block once connected
		conn.execute(
			"""
			CREATE TABLE IF NOT EXISTS queued (
				relay_hash TEXT PRIMARY KEY,
				json TEXT NOT NULL,
				origin_device TEXT,
				status TEXT,
				queuedAt INTEGER
			)
			"""
		)
		# Efficient lookup of relay_hashes to check if message needs to be queued
		conn.execute(
			"""
			CREATE TABLE IF NOT EXISTS confirmed (
				relay_hash TEXT PRIMARY KEY,
				json TEXT NOT NULL
			)
			"""
		)
		# Table with blockchain persistent to help distribute offline data, verify new msgs, sync to other users, etc.
		conn.execute(
			"""
			CREATE TABLE IF NOT EXISTS blocks (
				block_index INTEGER PRIMARY KEY,
				hash TEXT NOT NULL,
				previous_hash TEXT NOT NULL,
				json TEXT NOT NULL
			)
			"""
		)
		# For offline check-ins at a station
		conn.execute(
			"""
			CREATE TABLE IF NOT EXISTS checkins_queued (
				relay_hash TEXT PRIMARY KEY,
				json TEXT NOT NULL,
				status TEXT NOT NULL,
				queuedAt INTEGER NOT NULL
			)
			"""
		)
		# Known peer stations (from HQ)
		conn.execute(
			"""
			CREATE TABLE IF NOT EXISTS station_peers (
				station_id TEXT PRIMARY KEY,
				name TEXT,
				type TEXT,
				location TEXT,
				last_seen_at INTEGER
			)
			"""
		)
		# STATION POOLS - Bulletin Board for WebRTC Rooms
		conn.execute(
			"""
			CREATE TABLE IF NOT EXISTS station_pools (
				pool_id TEXT PRIMARY KEY,
				host_device_id TEXT NOT NULL,
				label TEXT,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			)
			"""
		)

		# STATION LOCAL EVENT LOG (Lifecycle + Summary Only for volumes, helps distribute resources on the ground more effectively)
		# - Minimal
		# - State-transition only
		# - Wiped after HQ confirms receipt
		conn.execute(
			"""
			CREATE TABLE IF NOT EXISTS station_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				event_type TEXT NOT NULL,        -- lifecycle | summary
				event_name TEXT NOT NULL,        -- online | offline | mode_changed | flush_summary
				context_json TEXT,
				created_at INTEGER NOT NULL
			)
			"""
		)

		conn.commit()

# ---------------------
# STATION DEVICE IDENTITY (SELF-SIGNED KEYPAIR)
# ---------------------
def _compute_fingerprint(public_key_bytes: bytes) -> str:
	"""
	Compute SHA-256 fingerprint of station public key.
	Returned as hex string for human comparison.

	This fingerprint is what users visually compare
	when verifying station identity.
	"""
	digest = hashes.Hash(hashes.SHA256(), backend=default_backend())
	digest.update(public_key_bytes)
	return digest.finalize().hex()


def ensure_station_device_identity():
	"""
	Ensure this station device has a persistent signing keypair.

	If missing:
		- Generate new Ed25519 keypair
		- Store private + public key in SQLite meta table
		- Compute fingerprint
		- Persist fingerprint

	This identity:
		- Is NOT related to API key
		- Is NOT related to HQ
		- Exists purely for user → station identity verification
	"""

	init_station_db()

	private_key_pem = db_get_meta("station_private_key")
	public_key_pem = db_get_meta("station_public_key")

	# If both keys already exist, do nothing
	if private_key_pem and public_key_pem:
		return

	# Generate new Ed25519 keypair (fast, modern, small)
	private_key = Ed25519PrivateKey.generate()
	public_key = private_key.public_key()

	# Serialize private key (PEM, no encryption since device-local only)
	private_bytes = private_key.private_bytes(
		encoding=serialization.Encoding.PEM,
		format=serialization.PrivateFormat.PKCS8,
		encryption_algorithm=serialization.NoEncryption(),
	)

	# Serialize public key (PEM)
	public_bytes = public_key.public_bytes(
		encoding=serialization.Encoding.PEM,
		format=serialization.PublicFormat.SubjectPublicKeyInfo,
	)

	# Compute fingerprint (SHA-256 of raw public key bytes)
	fingerprint = _compute_fingerprint(public_bytes)

	# Store everything in station meta table
	db_set_meta("station_private_key", private_bytes.decode("utf-8"))
	db_set_meta("station_public_key", public_bytes.decode("utf-8"))
	db_set_meta("station_fingerprint", fingerprint)

	logger.warning("Generated new station device identity")
	logger.warning(f"Station fingerprint: {fingerprint}")


# Return current station identity info for profile endpoint
def get_station_device_identity() -> dict | None:
	public_key_pem = db_get_meta("station_public_key")
	fingerprint = db_get_meta("station_fingerprint")
	crisis_id = db_get_meta("crisisId")

	if not public_key_pem or not fingerprint:
		return None

	return {
		"station_id": STATION_ID,
		"crisis_id": crisis_id,
		"station_public_key": public_key_pem,
		"fingerprint": fingerprint,
	}


# DEV NOTE: Sorting messages, consider refactor later to share this with relay-offline-server
def _sort_queued_for_export(queued: list[dict]) -> list[dict]:
	"""
	Sort queued (unconfirmed) transactions for export:
	- priority_level ASC (1 highest)
	- timestamp_created ASC (older first)
	- relay_hash ASC (tie-breaker)
	"""
	def key_fn(msg: dict):
		return (
			int(msg.get("priority_level") or 999),
			int(msg.get("timestamp_created") or 0),
			str(msg.get("relay_hash") or ""),
		)

	return sorted(queued, key=key_fn)


# ----------------------------
# DB helpers (meta)
# ----------------------------

def db_get_meta(key: str) -> str | None:
	with station_db() as conn:
		row = conn.execute(
			"SELECT value FROM meta WHERE key = ?",
			(key,),
		).fetchone()
		return row["value"] if row else None

def db_set_meta(key: str, value: str) -> None:
	with station_db() as conn:
		conn.execute(
			"""
			INSERT INTO meta (key, value)
			VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value=excluded.value
			""",
			(key, value),
		)
		conn.commit()

# META TABLE FLAGS - HARDENING FOR FILLING STORAGE
# DEV NOTE: This will get defaults and more options when the policy/station/relay setup wizards are done
def db_get_intake_paused() -> bool:
	val = db_get_meta("intake_paused")
	return val == "true"
def db_set_intake_paused(paused: bool) -> None:
	db_set_meta("intake_paused", "true" if paused else "false")


def _now_ms() -> int:
	return int(time.time() * 1000)

def _msg_priority_level(msg: dict) -> int:
	try:
		return int(msg.get("priority_level") or 999)
	except Exception:
		return 999


def _msg_created_ms(msg: dict) -> int:
	# We prefer timestamp_created (seconds) if present; otherwise fall back to queuedAt (ms).
	try:
		ts_s = msg.get("timestamp_created")
		if ts_s is not None:
			return int(ts_s) * 1000
	except Exception:
		pass

	try:
		qa = msg.get("queuedAt")
		if qa is not None:
			return int(qa)
	except Exception:
		pass

	return 0


def _meta_get_int(key: str) -> int | None:
	val = db_get_meta(key)
	if not isinstance(val, str) or not val.strip():
		return None
	try:
		return int(val)
	except Exception:
		return None


def _meta_set_int(key: str, value: int) -> None:
	db_set_meta(key, str(int(value)))


def get_identity_verified_at_ms() -> int | None:
	return _meta_get_int("identity_verified_at_ms")


def set_identity_verified_at_ms(ms: int) -> None:
	_meta_set_int("identity_verified_at_ms", ms)


def get_identity_rejected_at_ms() -> int | None:
	return _meta_get_int("identity_rejected_at_ms")


def set_identity_rejected_at_ms(ms: int) -> None:
	_meta_set_int("identity_rejected_at_ms", ms)


def is_identity_rejected_recently(now_ms: int) -> bool:
	rej = get_identity_rejected_at_ms()
	if not isinstance(rej, int):
		return False
	return (now_ms - rej) < int(IDENTITY_REJECT_BACKOFF_MS)

# ----------------------------
# Lifecycle meta persistence
# ----------------------------

def get_last_online_state() -> str | None:
	"""
	Return last persisted online state: "online" | "offline" | None
	"""
	val = db_get_meta("last_online_state")
	if val in ("online", "offline"):
		return val
	return None

def set_last_online_state(state: str) -> None:
	"""
	Persist online state for reboot continuity.
	"""
	if state in ("online", "offline"):
		db_set_meta("last_online_state", state)

def get_last_mode_state() -> str | None:
	"""
	Return last persisted mode: "station" | "relay" | "uninitialized"
	"""
	val = db_get_meta("last_mode_state")
	if val in ("station", "relay", "uninitialized"):
		return val
	return None

def set_last_mode_state(mode: str) -> None:
	"""
	Persist mode state across reboot.
	"""
	if mode in ("station", "relay", "uninitialized"):
		db_set_meta("last_mode_state", mode)

# ----------------------------
# DB helpers (blocks)
# ----------------------------

def db_get_block_hash(block_index: int) -> str | None:
	with station_db() as conn:
		row = conn.execute(
			"SELECT hash FROM blocks WHERE block_index = ?",
			(int(block_index),),
		).fetchone()
		return row["hash"] if row else None


def db_put_block_verified(block: dict) -> None:
	"""
	Store a block that has already passed verification.
	We do not overwrite existing blocks at the same index (no forks supported).
	"""
	with station_db() as conn:
		conn.execute(
			"""
			INSERT OR IGNORE INTO blocks (block_index, hash, previous_hash, json)
			VALUES (?, ?, ?, ?)
			""",
			(
				int(block.get("block_index")),
				str(block.get("hash")),
				str(block.get("previous_hash")),
				json.dumps(block, separators=(",", ":"), ensure_ascii=False),
			),
		)

		# Prune to last MAX_BLOCKS_STORED by index.
		conn.execute(
			"""
			DELETE FROM blocks
			WHERE block_index != 0
			AND block_index NOT IN (
				SELECT block_index
				FROM blocks
				ORDER BY block_index DESC
				LIMIT ?
			)
			""",
			(int(MAX_BLOCKS_STORED),),
		)

		conn.commit()


def db_list_blocks(limit: int) -> list[dict]:
	with station_db() as conn:
		rows = conn.execute(
			"SELECT json FROM blocks ORDER BY block_index DESC LIMIT ?",
			(int(limit),),
		).fetchall()
		blocks = [json.loads(r["json"]) for r in rows]
		blocks.reverse()
		return blocks

	
def db_get_block_public_key() -> str | None:
	return db_get_meta("block_public_key")


# STATION POOL MANAGEMENT
def prune_station_pools():
	"""
	Remove expired pools and enforce max cap.
	Called before returning pool list or after insert.
	"""

	now_s = int(time.time())

	with station_db() as conn:
		# Remove expired entries
		conn.execute(
			"DELETE FROM station_pools WHERE expires_at <= ?",
			(now_s,),
		)

		# Enforce max entries (oldest first eviction)
		rows = conn.execute(
			"SELECT pool_id FROM station_pools ORDER BY created_at ASC"
		).fetchall()

		if len(rows) > POOL_MAX_ENTRIES:
			excess = len(rows) - POOL_MAX_ENTRIES
			to_delete = rows[:excess]
			for r in to_delete:
				conn.execute(
					"DELETE FROM station_pools WHERE pool_id = ?",
					(r["pool_id"],),
				)

		conn.commit()


# ----------------------------
# STATION helpers
# ----------------------------
# def get_peer_base_url(station_id: str) -> str:
# 	"""
# 	Resolve peer station base URL.
# 	For now assume Docker hostname or LAN hostname equals station_id.
# 	This will later be replaced by QR-provided LAN URL.
# 	"""
# 	return f"http://{station_id}:5000"
def get_peer_base_url(station_id: str) -> str:
	"""
	Resolve peer station base URL (Docker dev mapping).
	"""
	if station_id == "FOODTRUCK_001":
		return "http://station:5000"
	if station_id == "CAMP_CENTRAL":
		return "http://station_camp:5000"
	return ""


# Derived from: identity file, SQLite meta, blockchain DB, cached RUNTIME_STATE["central_ok"]
def update_station_mode() -> None:
	global STATION_STATE

	crisis_id = db_get_meta("crisisId")
	pub = db_get_meta("block_public_key")
	has_anchor = isinstance(crisis_id, str) and bool(crisis_id) and isinstance(pub, str) and bool(pub)

	# Minimal: require genesis to claim relay usefulness
	has_genesis = db_get_block_hash(0) is not None

	has_identity = _station_identity is not None
	if not has_identity:
		# reload once in case provisioning just happened
		reload_station_identity_in_memory()
		has_identity = _station_identity is not None

	if has_identity and has_anchor and has_genesis:
		STATION_STATE["mode"] = "station"
	elif has_anchor and has_genesis:
		STATION_STATE["mode"] = "relay"
	else:
		STATION_STATE["mode"] = "uninitialized"

	STATION_STATE["online"] = bool(RUNTIME_STATE.get("central_ok"))
	STATION_STATE["identity_state"] = (
		"rejected"
		if get_identity_rejected_at_ms() is not None
		else "verified"
		if get_identity_verified_at_ms() is not None
		else "unknown"
	)

# ----------------------------
# LOCAL STATION EVENT RECORDING (stores while offline, then dumps after HQ confirms receipt)
# - summary data only, mode changes, online/offline timestamps, volume summary for aid distribution data
# ----------------------------

def record_station_event(event_type: str, event_name: str, context: dict | None = None):
	"""
	Record a minimal station event locally.
	Only lifecycle + summary events are allowed.
	"""

	with station_db() as conn:
		conn.execute(
			"""
			INSERT INTO station_events (event_type, event_name, context_json, created_at)
			VALUES (?, ?, ?, ?)
			""",
			(
				event_type,
				event_name,
				json.dumps(context, separators=(",", ":"), ensure_ascii=False) if context else None,
				int(time.time()),
			),
		)
		conn.commit()
def flush_station_events_to_hq():
	"""
	Send locally recorded lifecycle/summary events to HQ.
	Delete only after successful transmission.
	"""

	api_key = get_station_api_key()
	if not api_key:
		return  # cannot authenticate to HQ

	with station_db() as conn:
		rows = conn.execute(
			"SELECT id, event_type, event_name, context_json, created_at "
			"FROM station_events ORDER BY id ASC"
		).fetchall()

	for r in rows:
		payload = {
			"source": "station",
			"node_id": STATION_ID,
			"severity": "info",
			"event_type": r["event_type"],  # lifecycle | summary
			"context": {
				"event_name": r["event_name"],
				"context": json.loads(r["context_json"]) if r["context_json"] else None,
				"created_at": r["created_at"],
			},
		}

		try:
			resp = requests.post(
				f"{CENTRAL_URL}/admin/telemetry",
				json=payload,
				headers={
					"X-Station-API-Key": api_key
				},
				timeout=5,
			)

			if resp.status_code == 201:
				with station_db() as conn:
					conn.execute(
						"DELETE FROM station_events WHERE id = ?",
						(r["id"],),
					)
					conn.commit()

		except Exception:
			break  # retry later

# -----------------------
# Station vs Relay guards
# ----------------------
# Add guards on station automation to prevent undesired thrashing
def require_station_mode() -> tuple[bool, str]:
	update_station_mode()
	mode = STATION_STATE.get("mode")

	if mode != "station":
		return False, f"Station-only endpoint (mode={mode})"

	return True, ""

def require_relay_or_station_mode() -> tuple[bool, str]:
	update_station_mode()
	mode = STATION_STATE.get('mode')

	if mode not in ("station", "relay"):
		return False, f"Relay endpoint unavailable (mode={mode})"

	return True, ""

def has_usable_chain() -> bool:
	# Minimum requirement: verified genesis block exists
	return db_get_block_hash(0) is not None

def require_usable_relay() -> tuple[bool, str]:
	update_station_mode()
	mode = STATION_STATE.get('mode')

	if mode not in ("station", "relay"):
		return False, f"Relay unavailable (mode={mode})"

	if not has_usable_chain():
		return False, "Relay unavailable (no verified blockchain)"

	return True, ""

# ----------------------------
# DB helpers (queued + confirmed)
# ----------------------------

def db_is_confirmed(relay_hash: str) -> bool:
	with station_db() as conn:
		row = conn.execute(
			"SELECT 1 FROM confirmed WHERE relay_hash = ?",
			(relay_hash,),
		).fetchone()
		return bool(row)


def db_is_queued(relay_hash: str) -> bool:
	with station_db() as conn:
		row = conn.execute(
			"SELECT 1 FROM queued WHERE relay_hash = ?",
			(relay_hash,),
		).fetchone()
		return bool(row)


def db_put_confirmed(relay_hash: str, info: dict) -> None:
	with station_db() as conn:
		conn.execute(
			"""
			INSERT INTO confirmed (relay_hash, json)
			VALUES (?, ?)
			ON CONFLICT(relay_hash) DO UPDATE SET json=excluded.json
			""",
			(
				relay_hash,
				json.dumps(info, separators=(",", ":"), ensure_ascii=False),
			),
		)
		conn.commit()

	try:
		res = db_prune_confirmed()
		if res.get("deleted_ttl") or res.get("deleted_cap"):
			logger.info(f"Station confirmed prune: {res}")
	except Exception as e:
		logger.warning(f"Station confirmed prune failed: {e}")
		

def db_is_checkin_queued(relay_hash: str) -> bool:
	with station_db() as conn:
		row = conn.execute(
			"SELECT 1 FROM checkins_queued WHERE relay_hash = ?",
			(relay_hash,),
		).fetchone()
		return bool(row)


def db_put_checkin_queued(checkin: dict) -> bool:
	relay_hash = checkin.get("relay_hash")
	if not isinstance(relay_hash, str) or not relay_hash:
		return False

	status = checkin.get("status")
	if not isinstance(status, str) or not status:
		status = "pending"

	with station_db() as conn:
		cur = conn.execute(
			"""
			INSERT OR IGNORE INTO checkins_queued (relay_hash, json, status, queuedAt)
			VALUES (?, ?, ?, ?)
			""",
			(
				relay_hash,
				json.dumps(checkin, separators=(",", ":"), ensure_ascii=False),
				status,
				int(checkin.get("queuedAt") or 0),
			),
		)
		conn.commit()
		return cur.rowcount == 1


def db_list_checkins_queued(limit: int) -> list[dict]:
	with station_db() as conn:
		rows = conn.execute(
			"SELECT json FROM checkins_queued ORDER BY queuedAt DESC LIMIT ?",
			(int(limit),),
		).fetchall()
		return [json.loads(r["json"]) for r in rows]


def db_delete_checkin_queued(relay_hash: str) -> None:
	with station_db() as conn:
		conn.execute(
			"DELETE FROM checkins_queued WHERE relay_hash = ?",
			(relay_hash,),
		)
		conn.commit()

def db_get_confirmed_many(relay_hashes: list[str]) -> dict:
	"""
	Return confirmed info for the relay hashes provided.
	Used by /mesh/inventory so clients can prune.
	"""
	if not relay_hashes:
		return {}

	placeholders = ",".join(["?"] * len(relay_hashes))
	query = (
		"SELECT relay_hash, json FROM confirmed "
		f"WHERE relay_hash IN ({placeholders})"
	)

	with station_db() as conn:
		rows = conn.execute(query, tuple(relay_hashes)).fetchall()

	out = {}
	for r in rows:
		out[r["relay_hash"]] = json.loads(r["json"])
	return out


def db_put_queued(msg: dict) -> bool:
	"""
	Insert into queued if not already present.
	Returns True if inserted, False if already existed.

	After insert, run pruning to keep the STATION stable under load.
	"""
	# Hard stop: intake paused
	if db_get_intake_paused():
		logger.warning("STATION intake paused: rejecting queued message")
		return False

	relay_hash = msg.get("relay_hash")
	if not isinstance(relay_hash, str) or not relay_hash:
		return False

	status = msg.get("status")
	if not isinstance(status, str) or not status:
		status = "pending"

	pause_needed = False
	count = 0

	with station_db() as conn:
		cur = conn.execute(
			"""
			INSERT OR IGNORE INTO queued (
				relay_hash, json, origin_device, status, queuedAt
			)
			VALUES (?, ?, ?, ?, ?)
			""",
			(
				relay_hash,
				json.dumps(msg, separators=(",", ":"), ensure_ascii=False),
				msg.get("origin_device"),
				status,
				int(msg.get("queuedAt") or 0),
			),
		)

		row = conn.execute("SELECT COUNT(1) AS c FROM queued").fetchone()
		count = int(row["c"]) if row else 0


		if count > int(QUEUED_HIGH_WATER): # HARD STOP
			pause_needed = True

		# DEV NOTE: Soft pressure warning only; intake still allowed.
		# Used for pre-507 signaling and future UX.
		if is_storage_under_pressure(count) and not db_get_intake_paused(): # SOFT WARNING
			logger.warning("STATION storage nearing capacity (queued=%d, soft=%d, hard=%d)",
				count, 
				QUEUED_SOFT_WATER, 
				QUEUED_HIGH_WATER,
			)

		conn.commit()

	inserted = cur.rowcount == 1

	# Set intake pause OUTSIDE the DB transaction to avoid sqlite lock
	if pause_needed and not db_get_intake_paused():
		logger.error("STATION storage full (queued=%d). Pausing intake.",count,)
		db_set_intake_paused(True)

	# Prune regardless of whether we inserted; TTL cleanup is always safe
	try:
		res = db_prune_queued()
		if res.get("deleted_ttl") or res.get("deleted_evicted"):
			logger.info(f"STATION queued prune: {res}")
	except Exception as e:
		logger.warning(f"STATION queued prune failed: {e}")

	return inserted


def db_update_queued_status(relay_hash: str, status: str) -> None:
	with station_db() as conn:
		row = conn.execute(
			"SELECT json FROM queued WHERE relay_hash = ?",
			(relay_hash,),
		).fetchone()

		if not row:
			return

		try:
			msg = json.loads(row["json"])
		except Exception:
			msg = {"relay_hash": relay_hash}

		msg["status"] = status

		if status == "sent":
			msg["sentAt"] = int(time.time() * 1000)

		conn.execute(
			"""
			UPDATE queued
			SET status = ?, json = ?
			WHERE relay_hash = ?
			""",
			(status, json.dumps(msg, separators=(",", ":"), ensure_ascii=False), relay_hash,),
		)
		conn.commit()


def db_delete_queued(relay_hash: str) -> None:
	with station_db() as conn:
		conn.execute(
			"DELETE FROM queued WHERE relay_hash = ?",
			(relay_hash,),
		)
		conn.commit()


def db_list_queued(limit: int) -> list[dict]:
	with station_db() as conn:
		rows = conn.execute(
			"SELECT json FROM queued ORDER BY queuedAt DESC LIMIT ?",
			(int(limit),),
		).fetchall()
		return [json.loads(r["json"]) for r in rows]


def get_known_relay_hashes() -> set[str]:
	"""
	Return all relay_hash values known to this station (queued or confirmed).
	Used for inventory and for dedupe during sanitize.
	"""
	known = set()

	with station_db() as conn:
		rows = conn.execute("SELECT relay_hash FROM queued").fetchall()
		known.update([r["relay_hash"] for r in rows])

		rows = conn.execute("SELECT relay_hash FROM confirmed").fetchall()
		known.update([r["relay_hash"] for r in rows])

	return known


def db_prune_queued() -> dict:
	"""
	Prune queued (unconfirmed) items:
	1) TTL: delete anything older than QUEUED_TTL_MS based on queuedAt
	2) High/low water: if still above QUEUED_HIGH_WATER, evict down to
	   QUEUED_LOW_WATER using priority-aware eviction:
		- priority_level DESC (5 worst)
		- created time ASC (oldest first)
	"""
	now_ms = _now_ms()
	cutoff = now_ms - int(QUEUED_TTL_MS)

	deleted_ttl = 0
	deleted_evicted = 0
	remaining = 0

	with station_db() as conn:
		# 1) TTL prune by queuedAt
		cur = conn.execute(
			"DELETE FROM queued WHERE queuedAt IS NOT NULL AND queuedAt > 0 AND queuedAt < ?",
			(int(cutoff),),
		)
		deleted_ttl = int(cur.rowcount or 0)

		# Count remaining
		row = conn.execute("SELECT COUNT(1) AS c FROM queued").fetchone()
		remaining = int(row["c"]) if row else 0

		# Even if we don't need eviction, check whether pruning
		# has reduced storage enough to safely resume intake
		if remaining <= int(QUEUED_HIGH_WATER):
			if remaining <= int(QUEUED_LOW_WATER):
				if db_get_intake_paused():
					logger.info("Queued reduced to %d, resuming STATION intake",remaining,)
					db_set_intake_paused(False)

			conn.commit()
			return {
				"deleted_ttl": deleted_ttl,
				"deleted_evicted": deleted_evicted,
				"remaining": remaining,
			}

		# 2) High/low water eviction (priority-aware)
		to_delete = remaining - int(QUEUED_LOW_WATER)
		if to_delete <= 0:
			# Same resume logic applies here — eviction not needed,
			# but intake may have been paused earlier
			if remaining <= int(QUEUED_LOW_WATER):
				if db_get_intake_paused():
					logger.info("Queued reduced to %d, resuming STATION intake",remaining,)
					db_set_intake_paused(False)

			conn.commit()
			return {
				"deleted_ttl": deleted_ttl,
				"deleted_evicted": deleted_evicted,
				"remaining": remaining,
			}

		rows = conn.execute(
			"SELECT relay_hash, json FROM queued"
		).fetchall()

		candidates: list[tuple[tuple[int, int, str], str]] = []
		for r in rows:
			rh = r["relay_hash"]
			try:
				msg = json.loads(r["json"])
			except Exception:
				msg = {}

			# Evict worst first:
			# - higher priority number is worse -> sort DESC
			# - older created time first
			# We invert priority by sorting on (-priority) or just sort reverse later.
			priority = _msg_priority_level(msg)
			created_ms = _msg_created_ms(msg)
			key = (-priority, created_ms, str(rh))
			candidates.append((key, rh))

		candidates.sort(key=lambda x: x[0])

		evict_hashes = [rh for _key, rh in candidates[:to_delete]]
		for rh in evict_hashes:
			conn.execute("DELETE FROM queued WHERE relay_hash = ?", (rh,))

		deleted_evicted = len(evict_hashes)

		row2 = conn.execute("SELECT COUNT(1) AS c FROM queued").fetchone()
		remaining = int(row2["c"]) if row2 else 0

		# Eviction completed — resume intake if we've recovered enough STATION HDD space
		if remaining <= int(QUEUED_LOW_WATER):
			if db_get_intake_paused():
				logger.info("Queued reduced to %d, resuming STATION intake", remaining,)
				db_set_intake_paused(False)

		conn.commit()

	return {
		"deleted_ttl": deleted_ttl,
		"deleted_evicted": deleted_evicted,
		"remaining": remaining,
	}


def db_prune_confirmed() -> dict:
	"""
	Prune confirmed relay map:
	- TTL based on confirmedAt stored inside the JSON blob (ms)
	- Cap total rows to CONFIRMED_MAX_ROWS by removing oldest confirmedAt first
	"""
	now_ms = _now_ms()
	cutoff = now_ms - int(CONFIRMED_TTL_MS)

	deleted_ttl = 0
	deleted_cap = 0
	remaining = 0

	with station_db() as conn:
		rows = conn.execute(
			"SELECT relay_hash, json FROM confirmed"
		).fetchall()

		parsed: list[tuple[str, int]] = []
		for r in rows:
			rh = r["relay_hash"]
			try:
				info = json.loads(r["json"])
			except Exception:
				info = {}

			try:
				ca = int(info.get("confirmedAt") or 0)
			except Exception:
				ca = 0

			parsed.append((rh, ca))

		# TTL: delete entries with confirmedAt older than cutoff (if confirmedAt is present)
		for rh, ca in parsed:
			if ca > 0 and ca < cutoff:
				conn.execute("DELETE FROM confirmed WHERE relay_hash = ?", (rh,))
				deleted_ttl += 1

		# Recount and cap
		row = conn.execute("SELECT COUNT(1) AS c FROM confirmed").fetchone()
		remaining = int(row["c"]) if row else 0

		if remaining > int(CONFIRMED_MAX_ROWS):
			to_delete = remaining - int(CONFIRMED_MAX_ROWS)

			# Reload after TTL prune
			rows2 = conn.execute(
				"SELECT relay_hash, json FROM confirmed"
			).fetchall()

			candidates: list[tuple[int, str]] = []
			for r in rows2:
				rh = r["relay_hash"]
				try:
					info = json.loads(r["json"])
				except Exception:
					info = {}

				try:
					ca = int(info.get("confirmedAt") or 0)
				except Exception:
					ca = 0

				# Oldest first; unknown timestamps treated as oldest (0)
				candidates.append((ca, rh))

			candidates.sort(key=lambda x: (x[0], x[1]))
			evict = [rh for _ca, rh in candidates[:to_delete]]

			for rh in evict:
				conn.execute("DELETE FROM confirmed WHERE relay_hash = ?", (rh,))
			deleted_cap = len(evict)

			row2 = conn.execute("SELECT COUNT(1) AS c FROM confirmed").fetchone()
			remaining = int(row2["c"]) if row2 else 0

		conn.commit()

	return {
		"deleted_ttl": deleted_ttl,
		"deleted_cap": deleted_cap,
		"remaining": remaining,
	}

# ----------------------------
# Bootstrap + crisis pinning
# ----------------------------
	# DEV NOTE:
	# This bootstrap runs at worker startup for dev simplicity.
	# If central is unreachable, Gunicorn may time out the worker.
	# In production this will be moved into the background loop or guarded by a central reachability check.
def bootstrap_station_or_die() -> None:
	"""
	Bootstrap station from the trusted central backend.

	Behavior:
		- Ensure genesis (block_index=0) exists in station DB.
		- Extract crisisId + block_public_key from genesis metadata and persist.
		- Seed station with the last MAX_BLOCKS_STORED verified blocks from
		  central /blockchain so it can relay confirmations immediately.

	Assumption:
		This runs only during station provisioning with trusted connectivity.
	"""

	# If we already have the trust anchor pinned, we are bootstrapped.
	stored_crisis_id = db_get_meta("crisisId")
	stored_pubkey = db_get_meta("block_public_key")
	if stored_crisis_id and stored_pubkey:
		STATION_STATE["crisisId"] = stored_crisis_id
		return
	
	# DEV - Race condition against flask app
	# resp = requests.get(f"{CENTRAL_URL}/blockchain", timeout=15)
	# resp.raise_for_status()
	# Retry fetching blockchain from central (with backoff)
	max_retries = 10
	retry_delay = 1  # seconds

	for attempt in range(1, max_retries + 1):
		try:
			logger.info(f"Bootstrapping from central (attempt {attempt}/{max_retries})...")
			resp = requests.get(f"{CENTRAL_URL}/blockchain", timeout=15)
			resp.raise_for_status()
			break
		except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
			if attempt < max_retries:
				logger.warning(f"Failed to reach central (attempt {attempt}): {e}. Retrying in {retry_delay}s...")
				time.sleep(retry_delay)
				retry_delay = min(retry_delay * 2, 10)  # cap at 10s
			else:
				logger.error(f"Failed to bootstrap after {max_retries} attempts.")
				raise RuntimeError(f"Could not reach central backend after {max_retries} retries: {e}") from e
	
	#############################
	chain = resp.json()

	if not isinstance(chain, list) or not chain:
		raise RuntimeError("Central /blockchain returned empty chain")

	genesis = None
	for b in chain:
		if isinstance(b, dict) and b.get("block_index") == 0:
			genesis = b
			break

	if not genesis:
		raise RuntimeError("Genesis block not found in central /blockchain")

	# Store genesis as provisioning artifact (trusted source).
	db_put_block_verified(genesis)

	# Extract trust anchor from genesis metadata tx.
	pubkey = None
	crisis_id = None

	for tx in genesis.get("transactions", []) or []:
		if not isinstance(tx, dict):
			continue

		msg_data = tx.get("message_data")
		if not isinstance(msg_data, str):
			continue

		try:
			msg = json.loads(msg_data)
		except Exception:
			continue

		if msg.get("type") != "crisis_metadata":
			continue

		pubkey = msg.get("block_public_key")
		crisis_id = msg.get("crisis_id")
		break

	if not isinstance(pubkey, str) or not pubkey:
		raise RuntimeError("block_public_key not found in genesis metadata")

	if not isinstance(crisis_id, str) or not crisis_id:
		raise RuntimeError("crisis_id not found in genesis metadata")

	db_set_meta("block_public_key", pubkey)
	db_set_meta("crisisId", crisis_id)
	STATION_STATE["crisisId"] = crisis_id

	# Seed station with last MAX_BLOCKS_STORED blocks from central.
	# These will be verified before storing.
	suffix = chain[-MAX_BLOCKS_STORED:]
	process_incoming_blocks(suffix)


def ensure_crisis_id(incoming_crisis_id: str | None) -> tuple[bool, str]:
	"""
	Enforce single-crisis operation.
	Station is pinned at bootstrap time and rejects any other crisisId.
	"""
	if not incoming_crisis_id or not isinstance(incoming_crisis_id, str):
		return False, "Missing or invalid crisisId"

	stored = db_get_meta("crisisId")
	if not stored:
		return False, "Station not bootstrapped (missing crisisId)"

	if stored != incoming_crisis_id:
		return False, "Station crisisId mismatch"

	STATION_STATE["crisisId"] = stored
	return True, ""


# ----------------------------
# Auto-sync
# ----------------------------
AUTO_SYNC_DEFAULT = "1" if dev_remote else "0"
# DEV NOTE: set AUTO_SYNC_DEFAULT in blockchain policy setup wizard, and intervals as well
STATION_AUTO_SYNC = os.environ.get("STATION_AUTO_SYNC", AUTO_SYNC_DEFAULT) == "1"
CENTRAL_CHECK_INTERVAL_MS = 20_000
CENTRAL_MAX_BACKOFF_MS = 30_000

# Adaptive sync cadence (for flushing messages to the server, NOT the block mining cadence)
# Default tiers: busy -> casual
# SYNC_TIERS_MS = [ # realistic timings
# 	60_000,		# busy
# 	180_000,	# medium
# 	600_000,	# casual max
# ]
SYNC_TIERS_MS = [5_000, 10_000, 20_000] # DEV NOTE: faster timings are being used for development iteration
NO_WORK_ESCALATE_AFTER = 3

# Sync between HQ
SYNC_STATE = {
	"tier_idx": 0,
	"no_work_streak": 0,
	"next_sync_at_ms": 0,
}
# Sync between peer stations
PEER_SYNC_STATE = {
	"peer_index": 0,
	"next_peer_sync_at_ms": 0,
}

# If HQ rejects our station API key, do not hammer it
IDENTITY_REJECT_BACKOFF_MS = 15 * 60 * 1000

STOP_EVENT = threading.Event()

RUNTIME_STATE = {
	"central_ok": False,
	"central_last_ok_at_ms": None,
	"central_last_err": None,
	"identity_state": "unknown",	# unknown | verified | rejected
	"identity_verified_at_ms": None,
	"identity_rejected_at_ms": None,
	"next_central_check_at_ms": 0,
	"next_pull_at_ms": 0,
	"next_flush_at_ms": 0,
	"next_peer_refresh_at_ms": 0,
}

# ----------------------------
# Block verification + confirmations
# ----------------------------
def compute_block_hash(block: dict) -> str | None:
	"""
	Recompute block hash(body) using the exact canonical JSON rules used by
	your central backend Block.calculate_hash().
	"""
	try:
		body = {
			"block_index": int(block["block_index"]),
			"timestamp": int(block["timestamp"]),
			"transactions": block.get("transactions") or [],
			"previous_hash": str(block["previous_hash"]),
			"nonce": int(block.get("nonce") or 0),
		}

		blob = json.dumps(
			body,
			sort_keys=True,
			separators=(",", ":"),
			ensure_ascii=False,
		).encode("utf-8")

		return hashlib.sha256(blob).hexdigest()
	except Exception:
		return None


def verify_block_signature(block: dict, block_public_key: str) -> bool:
	"""
	Verify detached PGP signature over canonical header:
		{ block_index, previous_hash, hash }
	"""
	try:
		pub = pgpy.PGPKey()
		pub.parse(block_public_key)

		sig = pgpy.PGPSignature.from_blob(block["signature"])

		header = json.dumps(
			{
				"block_index": int(block["block_index"]),
				"previous_hash": str(block["previous_hash"]),
				"hash": str(block["hash"]),
			},
			sort_keys=True,
			separators=(",", ":"),
			ensure_ascii=False,
		)

		res = pub.verify(header.encode("utf-8"), sig)
		return bool(res)
	except Exception:
		return False


def process_incoming_blocks(incoming_blocks: list[dict]) -> int:
	"""
	Verify incoming blocks (hash + signature) before storing.
	On each stored block, derive confirmations:
		if tx.relay_hash exists => mark confirmed + delete from queued.
	Returns: number of newly stored blocks.
	"""
	if not isinstance(incoming_blocks, list) or not incoming_blocks:
		return 0

	block_public_key = db_get_block_public_key()
	if not block_public_key:
		return 0

	stored = 0

	for b in incoming_blocks[:MAX_BLOCKS_PER_PAYLOAD]:
		if not isinstance(b, dict):
			continue

		# Cheap shape checks first (avoid expensive work on junk).
		if not isinstance(b.get("block_index"), int):
			continue
		if not isinstance(b.get("hash"), str):
			continue
		if not isinstance(b.get("previous_hash"), str):
			continue
		if not isinstance(b.get("signature"), str):
			continue

		# Ignore duplicates or conflicts (no forks).
		existing_hash = db_get_block_hash(b["block_index"])
		if existing_hash:
			if existing_hash == b["hash"]:
				continue
			continue

		# Integrity: hash(body)
		expected = compute_block_hash(b)
		if not expected or expected != b["hash"]:
			logger.info("HASH MISMATCH at index %d", b["block_index"])
			continue

		# Authenticity: signature(header)
		if not verify_block_signature(b, block_public_key):
			logger.info("SIGNATURE FAIL at index %d", b["block_index"])
			continue

		# Verified => store
		db_put_block_verified(b)
		stored += 1

		# Confirm any relay_hashes found in transactions
		for tx in b.get("transactions") or []:
			if not isinstance(tx, dict):
				continue

			rh = tx.get("relay_hash")
			if not isinstance(rh, str) or not rh:
				continue

			info = {
				"confirmedAt": int(time.time() * 1000),
				"block_index": int(b["block_index"]),
				"txId": tx.get("transaction_id"),
				"timestampPosted": tx.get("timestamp_posted"),
			}

			db_put_confirmed(rh, info)
			db_delete_queued(rh)
			db_delete_checkin_queued(rh)

	return stored


# ----------------------------
# Mesh payload sanitization + export
# ----------------------------

def sanitize_sync_payload_server(payload: dict) -> tuple[list[dict], dict]:
	"""
	"Smell test" sanitization for incoming queued messages.
	This does NOT mean confirmed; it only means safe enough to store + relay.

	Returns:
		(sanitized_queued, sanitized_confirmed)

	Note:
		We are not trusting client confirmed hints here. Confirmations come
		from verified blocks.
	"""
	if not isinstance(payload, dict):
		return [], {}

	raw_queued = payload.get("queued") or []
	if not isinstance(raw_queued, list):
		raw_queued = []

	sanitized_confirmed: dict = {}

	now_s = int(time.time())
	now_ms = now_s * 1000
	one_day_s = 24 * 60 * 60

	sanitized_queued: list[dict] = []
	per_origin_count: dict[str, int] = {}

	existing_relay_hashes = get_known_relay_hashes()

	def is_string(v):
		return isinstance(v, str)

	def clamp_length(s: str, max_len: int) -> str:
		return s if len(s) <= max_len else s[:max_len]

	for msg in raw_queued:
		if not isinstance(msg, dict):
			continue
		if len(sanitized_queued) >= MAX_QUEUED_PER_PAYLOAD:
			break

		relay_hash = msg.get("relay_hash")
		if not is_string(relay_hash) or not relay_hash.strip():
			continue
		if relay_hash in existing_relay_hashes:
			continue

		origin = msg.get("origin_device")
		if not is_string(origin) or not origin:
			origin = "unknown"
		per_origin_count[origin] = per_origin_count.get(origin, 0) + 1
		if per_origin_count[origin] > MAX_PER_ORIGIN:
			continue

		try:
			ts = int(msg.get("timestamp_created"))
		except (TypeError, ValueError):
			continue
		if ts < 0 or ts > now_s + one_day_s:
			continue

		try:
			priority = int(msg.get("priority_level"))
		except (TypeError, ValueError):
			continue
		if priority < TOP_PRIORITY or priority > BOTTOM_PRIORITY:
			continue

		station_addr = msg.get("station_address")
		if not is_string(station_addr):
			continue
		station_addr = clamp_length(station_addr, MAX_STATION_ADDRESS_LENGTH)

		type_field = msg.get("type_field")
		if not is_string(type_field):
			continue
		type_field = clamp_length(type_field, MAX_TYPE_FIELD_LENGTH)

		message_data = msg.get("message_data")
		if not is_string(message_data):
			continue
		if len(message_data) > MAX_MESSAGE_LENGTH:
			continue

		related = msg.get("related_addresses") or []
		if not isinstance(related, list):
			related = []
		clean_related = []
		for a in related:
			if not is_string(a) or not a:
				continue
			if len(clean_related) >= MAX_ADDRESSES_PER_TX:
				break
			if len(a) > MAX_ADDRESS_LENGTH:
				a = a[:MAX_ADDRESS_LENGTH]
			clean_related.append(a)

		queued_at = msg.get("queuedAt")
		if isinstance(queued_at, (int, float)):
			queued_at_ms = int(queued_at)
		else:
			queued_at_ms = now_ms

		normalized = {
			"relay_hash": relay_hash,
			"timestamp_created": ts,
			"station_address": station_addr,
			"message_data": message_data,
			"related_addresses": clean_related,
			"type_field": type_field,
			"priority_level": priority,
			"origin_device": origin,
			"status": msg.get("status") or "pending",
			"attempts": int(msg.get("attempts") or 0),
			"queuedAt": queued_at_ms,
		}

		sanitized_queued.append(normalized)

	return sanitized_queued, sanitized_confirmed


# DEV TODO: Block‑vs‑queue bandwidth negotiation
def export_station_payload() -> dict:
	"""
	Build a sync payload from the station's persisted state.
	Clients use this to update their local caches.
	"""

	now_ms = int(time.time() * 1000)
	STATION_STATE["crisisId"] = db_get_meta("crisisId")

	blocks = db_list_blocks(10_000) # DEV NOTE: DEBUGGING STATION PULL
	# blocks = db_list_blocks(MAX_BLOCKS_PER_PAYLOAD)
	last_block = blocks[-1] if blocks else None

	chain_tip = None
	if isinstance(last_block, dict):
		chain_tip = {
			"block_index": last_block.get("block_index"),
			"hash": last_block.get("hash"),
			"previous_hash": last_block.get("previous_hash"),
		}

	raw_queued = db_list_queued(limit=MAX_QUEUED_PER_PAYLOAD)
	sorted_queued = _sort_queued_for_export(raw_queued)

	with station_db() as conn:
		row = conn.execute("SELECT COUNT(1) AS c FROM queued").fetchone()
		count = int(row["c"]) if row else 0
	warnings = []
	if is_storage_under_pressure(count):
		warnings.append("storage_pressure")

	return {
		"version": 1,
		"deviceId": "station_local",
		"crisisId": STATION_STATE.get("crisisId"),
		"generatedAt": now_ms,
		"chain_tip": chain_tip,
		"blocks": blocks,
		"queued": sorted_queued,
		# Confirmations are returned via inventory (filtered by relay_hashes).
		"confirmed": {},
		# DEV NOTE: warnings are informational only. Clients should not change behavior yet.
		"warnings": warnings,
	}

# Ensure station device identity exists (independent of crisis bootstrap)
ensure_station_device_identity()

try:
	# Initialize DB and bootstrap trust anchor (genesis + public key + crisisId)
	init_station_db()
	# Ensure crisis trust anchor + genesis exist
	bootstrap_station_or_die()
except Exception as e:
	logger.warning(f"Station bootstrap failed; continuing unbootstrapped (relay or dud): {e}")


@app.route("/health", methods=["GET"])
def health():
	update_station_mode()
	# logger.info(f"HEALTH ENDPOINT PID: {os.getpid()}")

	refresh_peer_stations_from_hq() 
	with station_db() as conn:
		rows = conn.execute("SELECT station_id FROM station_peers").fetchall()
		peer_ids = [r["station_id"] for r in rows]

	return jsonify({
		"role": "station",
		"status": "ok",
		"mode": STATION_STATE.get("mode"),		
		"auto_sync": STATION_AUTO_SYNC,
		"central_ok": RUNTIME_STATE.get("central_ok"),
		"central_last_ok_at_ms": RUNTIME_STATE.get("central_last_ok_at_ms"),
		"identity_verified_at_ms": get_identity_verified_at_ms(),
		"identity_rejected_at_ms": get_identity_rejected_at_ms(),
		"station_id": STATION_ID,
		"crisisId": db_get_meta("crisisId"),
		"peers": peer_ids,	# DEV TESTING PEER LIST
	}), 200


def _safe_station_id(station_id: str | None) -> str | None:
	if not isinstance(station_id, str) or not station_id.strip():
		return None

	s = station_id.strip()
	for c in s:
		if not (c.isalnum() or c in ("_", "-")):
			return None

	return s


# Allows DEVTOOLS to grab api key for the station check-ins when creating alerts (no more need to copy paste from backend logs!)
@app.route("/dev/station-identity", methods=["GET"])
def dev_station_identity():
	"""
	DEV ONLY: return station API key so DevTools can run /checkin tests without
	manual copy/paste.

	Query:
		/dev/station-identity?station_id=STATION_001

	Reads:
		/app/data/station_identity_<station_id>.json
	"""
	if os.environ.get("FLASK_ENV") != "development":
		return jsonify({"error": "not found"}), 404

	station_id = request.args.get("station_id") or STATION_ID
	station_id = _safe_station_id(station_id)
	if not station_id:
		return jsonify({"error": "Invalid station_id"}), 400

	path = os.path.join(DATA_DIR, f"station_identity_{station_id}.json")
	if not os.path.exists(path):
		return jsonify({"error": "Identity file not found"}), 404

	try:
		with open(path, "r", encoding="utf-8") as f:
			obj = json.loads(f.read())
	except Exception as e:
		return jsonify({"error": f"Failed to read identity file: {e}"}), 500

	api_key = obj.get("api_key")
	if not isinstance(api_key, str) or not api_key:
		return jsonify({"error": "api_key missing in identity file"}), 500

	return jsonify({"station_id": station_id, "api_key": api_key}), 200


@app.route("/station/profile", methods=["GET"])
def station_profile():
	"""
	Public station identity endpoint.

	Used by:
		- Wallet app after QR scan
		- Identity verification handshake
		- Fingerprint comparison

	IMPORTANT:
		This endpoint exposes ONLY public information.
		No secrets.
	"""

	update_station_mode()

	identity = get_station_device_identity()
	if not identity:
		return jsonify({"error": "Station identity unavailable"}), 500

	return jsonify({
		"station_id": identity["station_id"],
		"crisis_id": identity["crisis_id"],
		"station_public_key": identity["station_public_key"],
		"fingerprint": identity["fingerprint"],
		"mode": STATION_STATE.get("mode"),
	}), 200


# Station signed endpoint, so users can verify fingerprint of approved station before P2P connections
@app.route("/station/handshake", methods=["POST"])
def station_handshake():
	"""
	Signed challenge-response handshake to prove that this station possesses the private key corresponding to the public key previously scanned by the user (via QR code)

	Flow:
		1. Client sends a random client_nonce
		2. Station generates its own station_nonce
		3. Station signs: station_id || crisis_id || client_nonce || station_nonce
		4. Client verifies signature using stored public key

	Security Properties:
		- Prevents imposters from spoofing stations (client_nonce required)
		- Does NOT expose private key
	"""

	update_station_mode()

	# --- Parse incoming payload ---
	data = request.get_json(force=True, silent=True) or {}
	client_nonce = data.get("client_nonce")

	if not isinstance(client_nonce, str) or not client_nonce.strip():
		return jsonify({"error": "Missing client_nonce"}), 400

	# --- Load station identity ---
	private_key_pem = db_get_meta("station_private_key")
	public_key_pem = db_get_meta("station_public_key")
	fingerprint = db_get_meta("station_fingerprint")
	crisis_id = db_get_meta("crisisId")

	if not private_key_pem or not public_key_pem:
		return jsonify({"error": "Station identity unavailable"}), 500

	# --- Load private key object ---
	try:
		private_key = serialization.load_pem_private_key(
			private_key_pem.encode("utf-8"),
			password=None,
		)
	except Exception as e:
		logger.error(f"Failed to load station private key: {e}")
		return jsonify({"error": "Invalid station private key"}), 500

	# --- Generate fresh station nonce (prevents replay) ---
	station_nonce_bytes = os.urandom(32)
	station_nonce = base64.b64encode(station_nonce_bytes).decode("utf-8")

	# --- Build message to sign ---
	# Important: exact ordering must be consistent for verification
	message = (f"{STATION_ID}|{crisis_id}|{client_nonce}|{station_nonce}").encode("utf-8")

	# --- Sign message ---
	try:
		signature_bytes = private_key.sign(message)
		signature = base64.b64encode(signature_bytes).decode("utf-8")
	except Exception as e:
		logger.error(f"Failed to sign handshake message: {e}")
		return jsonify({"error": "Signing failed"}), 500

	# --- Return handshake response ---
	return jsonify({
		"station_id": STATION_ID,
		"crisis_id": crisis_id,
		"station_public_key": public_key_pem,
		"fingerprint": fingerprint,
		"client_nonce": client_nonce,
		"station_nonce": station_nonce,
		"signature": signature,
	}), 200


# Check-ins by scanner, not gossip from mesh network but station-direct scans
@app.route("/station/checkin", methods=["POST"])
def station_checkin_offline():
	"""
	Offline check-in intake (station-local).

	Client sends:
		{
			"crisisId": "...",
			"address": "familyId-memberId",
			"timestamp_created": 1234567890,   # optional seconds
			"relay_hash": "uuid",              # optional (station will generate)
			"origin_device": "device_..."      # optional
		}

	Station stores it durably for later flush to central /checkin.
	"""
	
	# Since stations will fallback to relay nodes, this guard prevents a station from behaving like a station if it has not been activated or if api credentials are remotely revoked. It can still operate without changes as a relay but it won't be allowed to flush its queue to be posted to the blockchain anymore.
	ok, err = require_station_mode()
	if not ok:
		return jsonify({"error": err}), 403
	
	incoming = request.get_json(force=True, silent=True) or {}

	ok, err = ensure_crisis_id(incoming.get("crisisId"))
	if not ok:
		return jsonify({"error": err}), 400
	
	# Hard stop: refuse new check-ins when storage is full
	if db_get_intake_paused():
		logger.error("STATION storage full: rejecting /station/checkin")
		return (
			jsonify({
				"error": "storage_full",
				"message": "Station storage full; not accepting new check-ins",
			}),
			507,
		)

	address = incoming.get("address")
	if not isinstance(address, str) or not address.strip():
		return jsonify({"error": "Missing or invalid address"}), 400

	now_s = int(time.time())
	now_ms = now_s * 1000

	ts = incoming.get("timestamp_created")
	if ts is None:
		ts = now_s
	try:
		ts = int(ts)
	except Exception:
		return jsonify({"error": "timestamp_created must be integer seconds"}), 400

	if ts < 0 or ts > now_s + 24 * 60 * 60:
		return jsonify({"error": "timestamp_created out of bounds"}), 400

	relay_hash = incoming.get("relay_hash")
	if relay_hash is None or relay_hash == "":
		relay_hash = str(uuid.uuid4())
	if not isinstance(relay_hash, str) or not relay_hash.strip():
		return jsonify({"error": "relay_hash must be a non-empty string"}), 400
	if len(relay_hash) > 128:
		return jsonify({"error": "relay_hash too long"}), 400

	# Dedupe: if we already confirmed mined in a block, reject as already known
	if db_is_confirmed(relay_hash):
		# If already confirmed in canonical chain, ignore
		return jsonify({"status": "ok", "relay_hash": relay_hash, "deduped": True}), 200

	# Dedupe: if already queued, return ok
	if db_is_checkin_queued(relay_hash):
		# If already queued locally, ignore
		return jsonify({"status": "ok", "relay_hash": relay_hash, "deduped": True}), 200

	checkin = {
		"relay_hash": relay_hash,
		"timestamp_created": ts,  # seconds
		"address": address.strip(),
		"status": "pending",
		"queuedAt": now_ms,  # ms
		"origin_device": incoming.get("origin_device") or "unknown",
	}

	inserted = db_put_checkin_queued(checkin)

	return (
		jsonify(
			{
				"status": "queued",
				"relay_hash": relay_hash,
				"inserted": bool(inserted),
			}
		),
		201,
	)

# DEV NOTE: /station/provision does NOT return secrets, it safely stores api key returned from server
@app.route("/station/provision", methods=["POST"])
def station_provision():
	"""
	Provision this station by exchanging a one-time passphrase for an API key.
	Request JSON: { "passphrase": "foodtruck" }
	Response (200):
	{
		"status": "active",
		"station_id": "...",
		"crisisId": "...",
		"device_id": "..."
	}
	"""
	init_station_db()

	incoming = request.get_json(force=True, silent=True) or {}
	passphrase = incoming.get("passphrase")

	if not isinstance(passphrase, str) or not passphrase.strip():
		return jsonify({"error": "Missing passphrase"}), 400

	device_id = get_or_create_station_device_id()

	# Call HQ to activate
	try:
		resp = requests.post(
			f"{CENTRAL_URL}/station/activate",
			json={
				"passphrase": passphrase.strip(),
				"device_id": device_id,
			},
			timeout=20,
		)
	except Exception as e:
		return jsonify({"error": f"Failed to reach central: {e}"}), 502

	if resp.status_code != 200:
		try:
			return jsonify(resp.json()), resp.status_code
		except Exception:
			return jsonify({"error": resp.text}), resp.status_code

	obj = resp.json() or {}

	api_key = obj.get("api_key")
	crisis = obj.get("crisis") or {}
	station = obj.get("station") or {}

	crisis_id = crisis.get("id")
	block_public_key = crisis.get("block_public_key")
	station_id = station.get("station_id")

	if not isinstance(api_key, str) or not api_key:
		return jsonify({"error": "Central response missing api_key"}), 500
	if not isinstance(crisis_id, str) or not crisis_id:
		return jsonify({"error": "Central response missing crisis.id"}), 500
	if not isinstance(block_public_key, str) or not block_public_key:
		return jsonify({"error": "Central response missing crisis.block_public_key"}), 500
	if not isinstance(station_id, str) or not station_id:
		return jsonify({"error": "Central response missing station.station_id"}), 500

	# Persist identity to disk
	identity_path = _identity_path_for_write()
	identity = {
		"station_id": station_id,
		"crisis_id": crisis_id,
		"api_key": api_key,
		"createdAt": int(time.time()),
	}

	try:
		os.makedirs(DATA_DIR, exist_ok=True)
		with open(identity_path, "w", encoding="utf-8") as f:
			f.write(json.dumps(identity, indent=2))
	except Exception as e:
		return jsonify({"error": f"Failed to write identity file: {e}"}), 500

	# Pin trust anchor + crisisId locally
	db_set_meta("crisisId", crisis_id)
	db_set_meta("block_public_key", block_public_key)
	STATION_STATE["crisisId"] = crisis_id

	# Store genesis (verified) and pull suffix blocks (best effort)
	genesis = crisis.get("genesis_block")
	if isinstance(genesis, dict):
		try:
			process_incoming_blocks([genesis])
		except Exception as e:
			logger.warning(f"Provision: failed to store genesis: {e}")

	try:
		chain_resp = requests.get(f"{CENTRAL_URL}/blockchain", timeout=20)
		if chain_resp.ok:
			chain = chain_resp.json()
			if isinstance(chain, list) and chain:
				process_incoming_blocks(chain[-MAX_BLOCKS_STORED:])
	except Exception as e:
		logger.warning(f"Provision: failed to pull chain suffix: {e}")

	# Refresh in-memory identity (so /station/flush can use it immediately)
	reload_station_identity_in_memory()

	# Update most recent verification marker
	now_ms = _now_ms()
	set_identity_verified_at_ms(now_ms)
	# Clear any previous rejection marker
	set_identity_rejected_at_ms(0)

	return jsonify(
		{
			"status": "active",
			"station_id": station_id,
			"crisisId": crisis_id,
			"device_id": device_id,
		}
	), 200


@app.route("/mesh/inventory", methods=["POST"])
def mesh_inventory():
	"""
	Inventory handshake:
		Client sends relay_hashes only.
		Station replies:
			- missing_relay_hashes: which relay hashes the station does NOT know
			- confirmed: confirmations for hashes the station knows as confirmed
	"""
	incoming = request.get_json(force=True, silent=True) or {}

	# First check if it has min requirements to serve as a relay (crisisID, local genesis block)
	ok, err = require_usable_relay()
	if not ok:
		return jsonify({"error": err}), 403

	# Since stations will fallback to relay nodes, we still want mesh to work even if station api key is missing or revoked
	ok, err = require_relay_or_station_mode()
	if not ok:
		return jsonify({"error": err}), 403

	ok, err = ensure_crisis_id(incoming.get("crisisId"))
	if not ok:
		return jsonify({"error": err}), 400

	relay_hashes = incoming.get("relay_hashes") or []
	if not isinstance(relay_hashes, list):
		return jsonify({"error": "relay_hashes must be a list"}), 400

	relay_hashes = relay_hashes[:RELAY_HASH_CAP]
	relay_hashes = [rh for rh in relay_hashes if isinstance(rh, str) and rh.strip()]

	known = get_known_relay_hashes()
	missing_relay_hashes = [rh for rh in relay_hashes if rh not in known]

	confirmed = db_get_confirmed_many(relay_hashes)

	# Include check-in relay inventory as well as unconfirmed gossip
	with station_db() as conn:
		rows = conn.execute("SELECT relay_hash FROM checkins_queued").fetchall()

	local_checkin_hashes = [r["relay_hash"] for r in rows]

	incoming_checkin_hashes = incoming.get("checkin_hashes") or []
	if not isinstance(incoming_checkin_hashes, list):
		incoming_checkin_hashes = []

	missing_checkin_hashes = [
		rh for rh in incoming_checkin_hashes
		if rh not in local_checkin_hashes
	]
	
	blocks = db_list_blocks(limit=1)
	_chain_tip = blocks[-1] if blocks else None
	chain_tip = None
	if _chain_tip: 
		chain_tip =  {
			"block_index": _chain_tip["block_index"],
			"hash": _chain_tip["hash"],
		}

	return jsonify(
		{
			"crisisId": STATION_STATE.get("crisisId"),
			"missing_relay_hashes": missing_relay_hashes,
			"missing_checking_hashes": missing_checkin_hashes,
			"confirmed": confirmed,
			"chain_tip": chain_tip,
		}
	), 200


@app.route("/mesh/sync", methods=["POST"])
def mesh_sync():
	"""
	Sync endpoint:
		- accepts queued message bodies (unconfirmed) and recent blocks
		- stores queued after smell test (dedupe by relay_hash)
		- verifies blocks before storing
		- uses verified blocks to confirm relay_hash and prune queued
	"""
	incoming = request.get_json(force=True, silent=True) or {}

	# First check if it has min requirements to serve as a relay (crisisID, local genesis block)
	ok, err = require_usable_relay()
	if not ok:
		return jsonify({"error": err}), 403

	# Since stations will fallback to relay nodes, we still want mesh to work even if station api key is missing or revoked
	ok, err = require_relay_or_station_mode()
	if not ok:
		return jsonify({"error": err}), 403

	ok, err = ensure_crisis_id(incoming.get("crisisId"))
	if not ok:
		return jsonify({"error": err}), 400
	
	# Hard stop: refuse new queued intake when storage is full
	if db_get_intake_paused():
		logger.error("STATION storage full: rejecting /mesh/sync intake")
		return (
			jsonify({
				"error": "storage_full",
				"message": "STATION storage full; not accepting new queued messages",
			}),
			507,
		)

	incoming_queued, _ignored_confirmed = sanitize_sync_payload_server(incoming)

	# Incoming gossip
	for msg in incoming_queued:
		rh = msg.get("relay_hash")
		if not rh:
			continue
		if db_is_confirmed(rh) or db_is_queued(rh):
			continue
		db_put_queued(msg)

	incoming_blocks = incoming.get("blocks") or []
	if isinstance(incoming_blocks, list):
		process_incoming_blocks(incoming_blocks)

	# Incoming check-in replication 
	incoming_checkins = incoming.get("checkins") or []
	for chk in incoming_checkins:
		if not isinstance(chk, dict):
			continue

		relay_hash = chk.get("relay_hash")
		if not isinstance(relay_hash, str) or not relay_hash:
			continue

		if db_is_checkin_queued(relay_hash):
			continue

		db_put_checkin_queued(chk)

	payload = export_station_payload()
	
	return jsonify(payload), 200


def can_reach_central(timeout_sec: int = 3) -> tuple[bool, str | None]:
	try:
		resp = requests.get(f"{CENTRAL_URL}/health", timeout=timeout_sec)
		if resp.status_code == 200:
			return True, None
		return False, f"HTTP {resp.status_code}"
	except Exception as e:
		return False, str(e)

# Function abstraction for /station/flush endpoint below it to make the background loop and endpoint share behaviour
def flush_to_central_internal() -> dict:
	now_ms = _now_ms()
	ok, err = can_reach_central()
	if not ok:
		return {"ok": False, "error": f"central_unreachable: {err}"}

	# ---- Flush queued messages ----
	queued_msgs = db_list_queued(limit=MAX_QUEUED_PER_PAYLOAD)
	pending_msgs = [m for m in queued_msgs if (m.get("status") or "pending") == "pending"]

	msg_success = 0
	msg_failed = 0
	msg_errors: list[str] = []

	for msg in pending_msgs:
		relay_hash = msg.get("relay_hash")
		try:
			url = f"{CENTRAL_URL}/transaction"
			headers = {
				"Content-Type": "application/json",
				"X-Dev-Rate-Override": "true",
			}
			resp = requests.post(url, json=msg, headers=headers, timeout=5)

			if resp.status_code in (200, 201):
				msg_success += 1
				if isinstance(relay_hash, str) and relay_hash:
					db_update_queued_status(relay_hash, "sent")
			else:
				msg_failed += 1
				msg_errors.append(f"{relay_hash}: HTTP {resp.status_code} {resp.text}")
		except Exception as e:
			msg_failed += 1
			msg_errors.append(f"{relay_hash}: {e}")

	# ---- Flush queued check-ins (station-auth) ----
	checkins = db_list_checkins_queued(limit=MAX_QUEUED_PER_PAYLOAD)
	pending_checkins = [
		c for c in checkins if (c.get("status") or "pending") == "pending"
	]

	checkin_success = 0
	checkin_failed = 0
	checkin_errors: list[str] = []

	api_key = get_station_api_key()
	if pending_checkins and not api_key:
		checkin_failed = len(pending_checkins)
		checkin_errors.append("Missing api_key; cannot flush check-ins to central")
	else:
		if pending_checkins and is_identity_rejected_recently(now_ms):
			checkin_failed = len(pending_checkins)
			checkin_errors.append("Identity recently rejected; backoff active")
		else:
			for c in pending_checkins:
				relay_hash = c.get("relay_hash")
				try:
					body = {
						"address": c.get("address"),
						"station_id": STATION_ID,
						"timestamp_created": int(c.get("timestamp_created") or 0),
						"relay_hash": relay_hash,
					}

					url = f"{CENTRAL_URL}/checkin"
					headers = {
						"Content-Type": "application/json",
						"X-Station-API-Key": api_key,
					}

					resp = requests.post(url, json=body, headers=headers, timeout=5)

					if resp.status_code in (200, 201):
						checkin_success += 1

						# Mark identity as verified (persisted)
						set_identity_verified_at_ms(_now_ms())

						# Mark as sent in JSON so db_list_checkins_queued sees it
						c["status"] = "sent"
						c["sentAt"] = _now_ms()

						with station_db() as conn:
							conn.execute(
								"""
								UPDATE checkins_queued
								SET status = ?, json = ?
								WHERE relay_hash = ?
								""",
								(
									"sent",
									json.dumps(
										c,
										separators=(",", ":"),
										ensure_ascii=False,
									),
									relay_hash,
								),
							)
							conn.commit()

					elif resp.status_code in (401, 403):
						# Identity invalid / revoked / inactive => persist rejection
						set_identity_rejected_at_ms(_now_ms())
						checkin_failed += 1
						checkin_errors.append(
							f"{relay_hash}: identity_rejected HTTP {resp.status_code} {resp.text}"
						)
						# Stop trying further check-ins this cycle
						break
					else:
						checkin_failed += 1
						checkin_errors.append(
							f"{relay_hash}: HTTP {resp.status_code} {resp.text}"
						)
				except Exception as e:
					checkin_failed += 1
					checkin_errors.append(f"{relay_hash}: {e}")

	# ---- Pull blocks (always try) ----
	pulled_blocks_stored = 0
	pull_error = None

	try:
		logger.info("=== STATION PULL START ===")

		resp = requests.get(f"{CENTRAL_URL}/blockchain", timeout=15)
		resp.raise_for_status()
		chain = resp.json()

		if isinstance(chain, list) and chain:
			logger.info("Central chain tip: %s", chain[-1]["block_index"])
			logger.info("Station DB tip before pull: %s", db_get_block_hash(len(chain) - 1))

			# Determine local tip
			local_blocks = db_list_blocks(limit=1)
			local_tip = local_blocks[-1] if local_blocks else None

			if local_tip:
				local_index = int(local_tip.get("block_index", -1))
			else:
				local_index = -1

			# Pull ALL blocks newer than local tip
			suffix = [
				b for b in chain
				if isinstance(b, dict)
				and isinstance(b.get("block_index"), int)
				and b["block_index"] > local_index
			]

			if suffix:
				logger.info(f"Pulling {len(suffix)} missing blocks from HQ")
				pulled_blocks_stored = process_incoming_blocks(suffix)
			else:
				pulled_blocks_stored = 0

			logger.info("Central chain tip: %s", chain[-1]["block_index"])

			with station_db() as conn:
				rows = conn.execute(
					"SELECT block_index FROM blocks ORDER BY block_index DESC LIMIT 5"
				).fetchall()
				logger.info("Station DB tip after pull: %s", [r["block_index"] for r in rows])

		else:
			pull_error = "Central /blockchain returned empty or invalid chain"

		logger.info("=== STATION PULL END ===")

	except Exception as e:
		pull_error = str(e)
		logger.error("Pull error: %s", pull_error)

	# Record operational summary and send to HQ for general data to help with aid distribution and station state changes
	record_station_event(
		"summary",
		"flush_summary",
		{
			"messages_sent": msg_success,
			"checkins_sent": checkin_success,
			"blocks_pulled": pulled_blocks_stored,
		},
	)

	return {
		"ok": True,
		"central_url": CENTRAL_URL,
		"messages": {
			"attempted": len(pending_msgs),
			"success": msg_success,
			"failed": msg_failed,
			"errors": msg_errors,
		},
		"checkins": {
			"attempted": len(pending_checkins),
			"success": checkin_success,
			"failed": checkin_failed,
			"errors": checkin_errors,
			"station_id": STATION_ID,
		},
		"pulled_blocks_stored": pulled_blocks_stored,
		"pull_error": pull_error,
	}

# Peer station lists to assist in coordinating station to station syncs
def refresh_peer_stations_from_hq() -> bool:
	"""
	Pull active station list from HQ and update local station_peers table.
	Returns True if successful, False otherwise.
	"""

	api_key = get_station_api_key()
	if not api_key:
		logger.warning("Cannot refresh peers: missing station API key")
		return False

	try:
		resp = requests.get(
			f"{CENTRAL_URL}/crisis/stations",
			headers={"X-Station-API-Key": api_key},
			timeout=10,
		)

		if resp.status_code != 200:
			logger.warning(f"Peer refresh failed: HTTP {resp.status_code}")
			return False

		data = resp.json()
		stations = data.get("stations", [])

		with station_db() as conn:
			# Clear existing peer list
			conn.execute("DELETE FROM station_peers")

			# Insert fresh list
			for s in stations:
				conn.execute(
					"""
					INSERT INTO station_peers
					(station_id, name, type, location, last_seen_at)
					VALUES (?, ?, ?, ?, ?)
					""",
					(
						s.get("station_id"),
						s.get("name"),
						s.get("type"),
						s.get("location"),
						None,
					),
				)

			conn.commit()

		logger.info(f"Refreshed {len(stations)} peer stations from HQ")
		return True

	except Exception as e:
		logger.warning(f"Peer refresh exception: {e}")
		return False

# When accumulating messages, flush pushes them to central HQ to be mined in a block
@app.route("/station/flush", methods=["POST"])
def station_flush():
	# Make sure this feature is only available to a station that has activated api key, if revoked it's in relay mode so it's not allowed to add transactions to blocks
	ok, err = require_station_mode()
	if not ok:
		return jsonify({"error": err}), 403

	result = flush_to_central_internal()
	return jsonify(result), (200 if result.get("ok") else 502)

# BACKGROUND LOOP STARTS vvvvvvvv
# TODO: set up scheduler process for multi-threading, using "workers", "1" in dockerfiles for now to prevent multiple loops and sql write contentions

# Adaptive intervals for 
def _sync_interval_ms() -> int:
	idx = int(SYNC_STATE.get("tier_idx") or 0)
	idx = max(0, min(idx, len(SYNC_TIERS_MS) - 1))
	return int(SYNC_TIERS_MS[idx])
def _sync_note_work(did_work: bool) -> None:
	# did_work = True => speed up (toward busy), did_work = False => after N misses, slow down (toward casual)
	if did_work:
		SYNC_STATE["no_work_streak"] = 0
		SYNC_STATE["tier_idx"] = max(0, int(SYNC_STATE["tier_idx"]) - 1)
		return

	SYNC_STATE["no_work_streak"] = int(SYNC_STATE["no_work_streak"]) + 1
	if int(SYNC_STATE["no_work_streak"]) >= int(NO_WORK_ESCALATE_AFTER):
		SYNC_STATE["no_work_streak"] = 0
		SYNC_STATE["tier_idx"] = min( len(SYNC_TIERS_MS) - 1, int(SYNC_STATE["tier_idx"]) + 1 )

# Perform only one sync attempt, returns True if useful work occurred, False otherwise
# Used for incrementing adaptive sync timings
def perform_sync_attempt() -> bool:
	update_station_mode()
	mode = STATION_STATE.get("mode")
	did_work = False

	try:
		# Station: flush (posts + pulls blocks)
		if mode == "station":
			result = flush_to_central_internal()
			msg_ok = int(result.get("messages", {}).get("success") or 0) > 0
			ci_ok = int(result.get("checkins", {}).get("success") or 0) > 0
			blk_ok = int(result.get("pulled_blocks_stored") or 0) > 0

			did_work = msg_ok or ci_ok or blk_ok

		# Relay: only pull blocks
		elif mode == "relay":
			resp = requests.get(f"{CENTRAL_URL}/blockchain", timeout=15)
			if resp.ok:
				chain = resp.json()
				if isinstance(chain, list) and chain:
					stored = process_incoming_blocks(chain[-MAX_BLOCKS_STORED:])
					did_work = int(stored or 0) > 0

		# Uninitialized: do nothing
		else:
			did_work = False

	except Exception as e:
		logger.warning(f"Sync attempt failed: {e} with station mode=={mode}")
		did_work = False

	return bool(did_work)


# Station QR code generator (krisys:station:v1)
@app.route("/station/qr", methods=["GET"])
def station_qr():
	"""
	Generate station QR payload string.	This does NOT return an image. 
	Format:	krisys:station:v1:<base64url(json)>
	
	DESC: It returns the encoded text string that can be:
		- Embedded into QR image
		- Copied manually
		- Displayed in station's UI (if available or printed and displayed next to check-in scanner)
	"""

	update_station_mode()

	identity = get_station_device_identity()
	if not identity:
		return jsonify({"error": "Station identity unavailable"}), 500

	base_url = request.host_url.rstrip("/")

	payload = {
		"v": 1,
		"type": "station",
		"station_id": identity["station_id"],
		"crisis_id": identity["crisis_id"],
		"base_url": base_url,
		"station_public_key": identity["station_public_key"],
		"fingerprint": identity["fingerprint"],
	}

	json_bytes = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

	# URL-safe base64 (no padding)
	b64 = base64.urlsafe_b64encode(json_bytes).decode("utf-8").rstrip("=")

	qr_string = f"krisys:station:v1:{b64}"

	return jsonify({
		"qr_string": qr_string,
		"payload": payload,  # DEV NOTE: helpful for debugging
	}), 200

# The actual loop to check for stuff to sync and adjust refresh timer based on load
last_heartbeat_at = 0
def background_loop():
	global last_heartbeat_at
	logger.warning("Station auto-sync loop started (enabled=%s)", STATION_AUTO_SYNC)

	# For general logging to send to HQ
	last_online_state = get_last_online_state()		# Persisted metadata
	last_mode_state = get_last_mode_state()			# Persisted metadata

	SYNC_STATE["next_sync_at_ms"] = 0 	# ensures the first iteration runs immediately
	logger.info(STOP_EVENT)
	
	RUNTIME_STATE["next_central_check_at_ms"] = 0
	logger.info(RUNTIME_STATE.get("next_central_check_at_ms"))

	while not STOP_EVENT.is_set():
		now_ms = _now_ms()

		if not STATION_AUTO_SYNC:
			time.sleep(1.0)
			continue

		# ---- Central reachability check ----
		with RUNTIME_STATE_LOCK:
			if now_ms >= int(RUNTIME_STATE["next_central_check_at_ms"] or 0):
				ok, err = can_reach_central()
				RUNTIME_STATE["central_ok"] = bool(ok)
				RUNTIME_STATE["central_last_err"] = err

				if ok:
					# Connection check for mode inference
					RUNTIME_STATE["central_last_ok_at_ms"] = now_ms
					RUNTIME_STATE["next_central_check_at_ms"] = now_ms + CENTRAL_CHECK_INTERVAL_MS
					
					# Peer refresh (only when online)
					if now_ms >= int(RUNTIME_STATE.get("next_peer_refresh_at_ms") or 0):
						refresh_peer_stations_from_hq()
						# refresh every 5 minutes
						RUNTIME_STATE["next_peer_refresh_at_ms"] = now_ms + (5 * 60 * 1000)
				else:
					# Backoff on connectivity failure
					next_delay = min(CENTRAL_CHECK_INTERVAL_MS * 2, CENTRAL_MAX_BACKOFF_MS)
					RUNTIME_STATE["next_central_check_at_ms"] = now_ms + next_delay

		update_station_mode()

		current_online = bool(RUNTIME_STATE.get("central_ok"))
		current_mode = STATION_STATE.get("mode")

		# ONLINE / OFFLINE TRANSITION DETECTION
		if last_online_state is None:
			if current_online:
				record_station_event("lifecycle", "online")
				set_last_online_state("online")
				logger.info("Station booted ONLINE")
			else:
				record_station_event("lifecycle", "offline")
				set_last_online_state("offline")
				logger.warning("Station booted OFFLINE")

			last_online_state = current_online

		elif current_online != last_online_state:
			if current_online:
				record_station_event("lifecycle", "online")
				set_last_online_state("online")
				logger.info("Station transitioned ONLINE")
			else:
				record_station_event("lifecycle", "offline")
				set_last_online_state("offline")
				logger.warning("Station transitioned OFFLINE")

			last_online_state = current_online

		# MODE TRANSITION DETECTION (station ↔ relay)
		if last_mode_state is None and current_mode:
			record_station_event(
				"lifecycle",
				"mode_changed",
				{"from": None, "to": current_mode}
			)
			set_last_mode_state(current_mode)
			last_mode_state = current_mode

		elif current_mode != last_mode_state:
			record_station_event(
				"lifecycle",
				"mode_changed",
				{"from": last_mode_state, "to": current_mode},
			)
			if current_mode: set_last_mode_state(current_mode)

			logger.warning(
				"Station mode changed from %s to %s",
				last_mode_state,
				current_mode,
			)

			last_mode_state = current_mode

		# ---- HEARTBEAT ----
		if current_online and (now_ms - last_heartbeat_at) >= HEARTBEAT_INTERVAL_MS:
			record_station_event(
				"lifecycle",
				"heartbeat",
				{
					"mode": current_mode,
					"central_ok": current_online,
					"queued_count": len(db_list_queued(limit=1000)),
					"blocks_cached": len(db_list_blocks(limit=1000)),
				},
			)
			last_heartbeat_at = now_ms

		# ---- SYNC ----
		# logger.info(
		# 	"SYNC DEBUG: now=%s next=%s online=%s",
		# 	now_ms,
		# 	SYNC_STATE.get("next_sync_at_ms"),
		# 	current_online,
		# )
		with RUNTIME_STATE_LOCK:
			if current_online:
				if now_ms >= int(SYNC_STATE.get("next_sync_at_ms") or 0):
					# Schedule next run FIRST (prevents burst triggers)
					SYNC_STATE["next_sync_at_ms"] = now_ms + _sync_interval_ms()
					
					logger.info("DEBUGGING: ------------ SYNC TRIGGERED")

					did_work = perform_sync_attempt()
					_sync_note_work(did_work)
		
		# ---- Peer Station Cooperation Loop ----
		if current_mode == "station":

			if now_ms >= int(PEER_SYNC_STATE.get("next_peer_sync_at_ms") or 0):

				with station_db() as conn:
					rows = conn.execute("SELECT station_id FROM station_peers ORDER BY station_id ASC").fetchall()
								
				peers = [r["station_id"] for r in rows if r["station_id"] != STATION_ID]

				if peers:
					# Rotate through peers
					idx = PEER_SYNC_STATE["peer_index"] % len(peers)
					target_station_id = peers[idx]

					logger.info(f"Attempting peer inventory sync with: {target_station_id}")
					try:
						base_url = get_peer_base_url(target_station_id)
						if not base_url:
							logger.warning(f"No base URL for {target_station_id}, skipping")
						else:
							payload = {
								"crisisId": db_get_meta("crisisId"),
								"relay_hashes": list(get_known_relay_hashes())[:RELAY_HASH_CAP],
							}

							resp = requests.post(
								f"{base_url}/mesh/inventory",
								json=payload,
								timeout=5,
							)

							if resp.status_code == 200:
								data = resp.json()
								logger.info(f"Peer {target_station_id} responded to inventory")

								# Canonical block catch up
								peer_tip = data.get("chain_tip")
								if peer_tip:
									local_blocks = db_list_blocks(limit=1)
									local_tip = local_blocks[-1] if local_blocks else None

									if local_tip:
										local_index = local_tip.get("block_index")
										peer_index = peer_tip.get("block_index")

										if isinstance(peer_index, int) and peer_index > local_index:
											logger.info(f"Peer {target_station_id} is ahead (local={local_index}, peer={peer_index})")

											# Ask peer for recent blocks
											block_resp = requests.post(
												f"{base_url}/mesh/sync",
												json={
													"crisisId": db_get_meta("crisisId"),
													"queued": [],
													"blocks": [],
												},
												timeout=5,
											)

											if block_resp.status_code == 200:
												block_data = block_resp.json()
												incoming_blocks = block_data.get("blocks", [])
												stored = process_incoming_blocks(incoming_blocks)
												logger.info(f"Stored {stored} blocks from {target_station_id}")

								# Check-in replication
								missing_checkins = data.get("missing_checkin_hashes", [])
								if missing_checkins:
									logger.info(f"Sending {len(missing_checkins)} check-ins to {target_station_id}")

									with station_db() as conn:
										# Only query when missing_checkins is not empty to avoid sql returning invalid type and posting emptiness every loop
										rows = []
										if missing_checkins:
											# Only fetch payloads for relay hashes the peer is missing
											rows = conn.execute(
												"SELECT json FROM checkins_queued WHERE relay_hash IN (%s)" %
												(",".join(["?"] * len(missing_checkins))),
												missing_checkins,
											).fetchall()

									checkin_payloads = [json.loads(r["json"]) for r in rows]

									if checkin_payloads:
										requests.post(
											f"{base_url}/mesh/sync",
											json={
												"crisisId": db_get_meta("crisisId"),
												"queued": [],
												"blocks": [],
												"checkins": checkin_payloads,
											},
											timeout=5,
										)

								# Pull missing relay hashes
								missing = data.get("missing_relay_hashes", [])
								if missing:
									logger.info(f"Requesting {len(missing)} relay payloads from {target_station_id}")

									# Get full queued payloads locally
									local_queue = db_list_queued(limit=RELAY_HASH_CAP)
									payload_map = {m["relay_hash"]: m for m in local_queue if m.get("relay_hash")}

									to_send = [payload_map[rh] for rh in missing if rh in payload_map]

									if to_send:
										requests.post(
											f"{base_url}/mesh/sync",
											json={
												"crisisId": db_get_meta("crisisId"),
												"queued": to_send,
												"blocks": [],
											},
											timeout=5,
										)
										logger.info(f"Sent {len(to_send)} relay payloads to {target_station_id}")
							else:
								logger.warning(f"Peer {target_station_id} inventory failed: HTTP {resp.status_code}")

					except Exception as e:
						logger.warning(f"Peer {target_station_id} unreachable: {e}")

					# Advance rotation
					PEER_SYNC_STATE["peer_index"] += 1

				# Schedule next peer sync attempt (e.g., every 60 seconds)
				PEER_SYNC_STATE["next_peer_sync_at_ms"] = now_ms + 60_000

		time.sleep(0.75)


# -----------------------
# Active pools aka rooms listings (for P2P)
# -----------------------
@app.route("/station/pools", methods=["GET"])
def list_station_pools():
	"""
	Return active pool listings.

	Response:
	{
		"pools": [
			{
				"pool_id": "...",
				"host_device_id": "...",
				"label": "...",
				"created_at": ...,
				"expires_at": ...
			}
		]
	}
	"""

	prune_station_pools()

	with station_db() as conn:
		rows = conn.execute(
			"""
			SELECT pool_id, host_device_id, label, created_at, expires_at
			FROM station_pools
			ORDER BY created_at DESC
			"""
		).fetchall()

	pools = [
		{
			"pool_id": r["pool_id"],
			"host_device_id": r["host_device_id"],
			"label": r["label"],
			"created_at": r["created_at"],
			"expires_at": r["expires_at"],
		}
		for r in rows
	]

	return jsonify({"pools": pools}), 200
# Register or refresh a pool listing
@app.route("/station/pools", methods=["POST"])
def register_station_pool():
	"""
	Register a WebRTC pool listing with this station.

	Request JSON:
	{
		"pool_id": "uuid",
		"host_device_id": "device_x",
		"label": "Family Sync",
		"ttl_seconds": 300   # optional
	}

	Station:
		- Applies TTL
		- Upserts listing
		- Prunes expired / overflow
	"""

	data = request.get_json(force=True, silent=True) or {}

	pool_id = data.get("pool_id")
	host_device_id = data.get("host_device_id")
	label = data.get("label")
	ttl_seconds = data.get("ttl_seconds")

	if not isinstance(pool_id, str) or not pool_id.strip():
		return jsonify({"error": "Missing pool_id"}), 400

	if not isinstance(host_device_id, str) or not host_device_id.strip():
		return jsonify({"error": "Missing host_device_id"}), 400

	now_s = int(time.time())

	try:
		ttl_seconds = int(ttl_seconds)
	except Exception:
		ttl_seconds = POOL_DEFAULT_TTL_SECONDS

	if ttl_seconds <= 0:
		ttl_seconds = POOL_DEFAULT_TTL_SECONDS

	expires_at = now_s + ttl_seconds

	with station_db() as conn:
		conn.execute(
			"""
			INSERT INTO station_pools (
				pool_id,
				host_device_id,
				label,
				created_at,
				expires_at
			)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(pool_id) DO UPDATE SET
				host_device_id=excluded.host_device_id,
				label=excluded.label,
				expires_at=excluded.expires_at
			""",
			(
				pool_id.strip(),
				host_device_id.strip(),
				label.strip() if isinstance(label, str) else None,
				now_s,
				expires_at,
			),
		)
		conn.commit()

	prune_station_pools()

	return jsonify({
		"status": "registered",
		"pool_id": pool_id,
		"expires_at": expires_at,
	}), 200

def event_flush_loop():
	"""
	Separate loop dedicated to flushing lifecycle/summary
	events to HQ at a slower, deterministic cadence.

	This keeps telemetry logic isolated from sync logic and checks less frequently.
	"""
	# logger.info("Station event flush loop started")
	while not STOP_EVENT.is_set():

		# Only flush if station is currently online
		current_online = bool(RUNTIME_STATE.get("central_ok"))

		if current_online:
			flush_station_events_to_hq()

		# Sleep deterministically
		time.sleep(FLUSH_INTERVAL_SECONDS)

_background_started = False

def start_background_loop_once():
	global _background_started
	if _background_started:
		return
	_background_started = True

	t = threading.Thread(target=background_loop, daemon=True)
	t.start()

	flush_thread = threading.Thread(target=event_flush_loop, daemon=True)
	flush_thread.start()

start_background_loop_once()
# BACKGROUND LOOP ^^^^^


if __name__ == "__main__":
	app.run(host="0.0.0.0", port=5000, debug=True)
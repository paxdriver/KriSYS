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
"""

import os
import time
import sqlite3
import json
import uuid
import hashlib
from contextlib import contextmanager
import requests
import pgpy
from flask import Flask, jsonify, request
from flask_cors import CORS

import logging
# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, origins=["http://localhost:3000"])

# In-memory cache (not source of truth; SQLite is source of truth)
station_state = {"crisisId": None,}

# Abuse / safety limits (keep bounded to protect station)
MAX_QUEUED_PER_PAYLOAD = 100
MAX_CONFIRMED_PER_PAYLOAD = 500
MAX_PER_ORIGIN = 50
MAX_MESSAGE_LENGTH = 8192
MAX_ADDRESSES_PER_TX = 16
MAX_ADDRESS_LENGTH = 128
MAX_STATION_ADDRESS_LENGTH = 128
MAX_TYPE_FIELD_LENGTH = 32

MAX_BLOCKS_PER_PAYLOAD = 10
MAX_BLOCKS_STORED = 25

# Inventory request cap (relay_hashes only)
RELAY_HASH_CAP = 1000

# Priority bounds (matches your crisis policy convention)
TOP_PRIORITY = 1
BOTTOM_PRIORITY = 5

# Central backend URL from station's perspective (inside docker network)
CENTRAL_URL = os.environ.get("CENTRAL_API_URL", "http://backend:5000")

# Persistent data for offline unconfirmed messages, blockchain, etc.
DATA_DIR = os.environ.get("STATION_DATA_DIR", "/app/data")
STATION_DB_PATH = os.path.join(DATA_DIR, "station.db")

#               IMPORTANT                   #
#############################################
# Station API key is set up on-site by trusted delegate of the blockchain service provider via one-time password
# DEV NOTE: hard coded for development, this will be saved on device during setup
STATION_ID = os.environ.get("STATION_ID", "STATION_001")

def load_station_api_key_from_file() -> str | None:
	try:
		path = os.path.join(DATA_DIR, f"station_identity_{STATION_ID}.json")
		if not os.path.exists(path):
			return None

		with open(path, "r", encoding="utf-8") as f:
			obj = json.loads(f.read())
		
		key = obj.get("api_key")
		return key if isinstance(key, str) and key else None
	
	except Exception:
		return None
def get_station_api_key() -> str | None:
	return load_station_api_key_from_file()

logger.info(f'Station API key (DEV ONLY): {get_station_api_key()} (may not be loaded, race condition on first load)')
#############################################

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

		conn.commit()


# ----------------------------
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
			WHERE block_index NOT IN (
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
	"""
	relay_hash = msg.get("relay_hash")
	if not isinstance(relay_hash, str) or not relay_hash:
		return False

	status = msg.get("status")
	if not isinstance(status, str) or not status:
		status = "pending"

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
		conn.commit()
		return cur.rowcount == 1

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
			(
				status,
				json.dumps(msg, separators=(",", ":"), ensure_ascii=False),
				relay_hash,
			),
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


# ----------------------------
# Bootstrap + crisis pinning
# ----------------------------
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
	init_station_db()

	# If we already have the trust anchor pinned, we are bootstrapped.
	stored_crisis_id = db_get_meta("crisisId")
	stored_pubkey = db_get_meta("block_public_key")
	if stored_crisis_id and stored_pubkey:
		station_state["crisisId"] = stored_crisis_id
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
				logger.warning(f"Failed to reach central (attempt {attempt}): {e}. " f"Retrying in {retry_delay}s...")
				time.sleep(retry_delay)
				retry_delay = min(retry_delay * 2, 10)  # cap at 10s
			else:
				logger.error(f"Failed to bootstrap after {max_retries} attempts.")
				raise RuntimeError(
					f"Could not reach central backend after {max_retries} retries: {e}"
				) from e
	
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
	station_state["crisisId"] = crisis_id

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

	station_state["crisisId"] = stored
	return True, ""


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

		msg = pgpy.PGPMessage.new(header)

		# PGPy verify result type can vary; `.good` is the typical indicator.
		res = pub.verify(msg, sig)
		return bool(getattr(res, "good", False))
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
			continue

		# Authenticity: signature(header)
		if not verify_block_signature(b, block_public_key):
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
	station_state["crisisId"] = db_get_meta("crisisId")

	blocks = db_list_blocks(MAX_BLOCKS_PER_PAYLOAD)
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

	return {
		"version": 1,
		"deviceId": "station_local",
		"crisisId": station_state.get("crisisId"),
		"generatedAt": now_ms,
		"chain_tip": chain_tip,
		"blocks": blocks,
		"queued": sorted_queued,
		# Confirmations are returned via inventory (filtered by relay_hashes).
		"confirmed": {},
	}


# Initialize DB and bootstrap trust anchor (genesis + public key + crisisId).
init_station_db()
bootstrap_station_or_die()


@app.route("/health", methods=["GET"])
def health():
	return jsonify({"role": "station", "status": "ok"}), 200

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
	incoming = request.get_json(force=True, silent=True) or {}

	ok, err = ensure_crisis_id(incoming.get("crisisId"))
	if not ok:
		return jsonify({"error": err}), 400

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

	# Dedupe: if we already confirmed it via blocks, reject as already known
	if db_is_confirmed(relay_hash):
		return jsonify({"status": "ok", "relay_hash": relay_hash, "deduped": True}), 200

	# Dedupe: if already queued, return ok
	if db_is_checkin_queued(relay_hash):
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

	return jsonify(
		{
			"crisisId": station_state.get("crisisId"),
			"missing_relay_hashes": missing_relay_hashes,
			"confirmed": confirmed,
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

	ok, err = ensure_crisis_id(incoming.get("crisisId"))
	if not ok:
		return jsonify({"error": err}), 400

	incoming_queued, _ignored_confirmed = sanitize_sync_payload_server(incoming)

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

	payload = export_station_payload()
	return jsonify(payload), 200


@app.route("/station/flush", methods=["POST"])
def station_flush():
	"""
	When internet connectivity is available:
	- Flush queued messages to central /transaction
	- Flush queued check-ins to central /checkin (requires station API key)
	- Mark items as 'sent' on success (keep for dedupe until confirmed by blocks)
	- Pull latest blocks from central and process confirmations
	"""
	def pull_blocks_from_central() -> tuple[int, str | None]:
		try:
			resp = requests.get(f"{CENTRAL_URL}/blockchain", timeout=15)
			resp.raise_for_status()
			chain = resp.json()

			if not isinstance(chain, list) or not chain:
				return 0, "Central /blockchain returned empty or invalid chain"

			suffix = chain[-MAX_BLOCKS_STORED:]
			stored_blocks = process_incoming_blocks(suffix)
			return stored_blocks, None
		except Exception as e:
			return 0, str(e)

	# ---- Flush message transactions (existing behavior) ----
	queued_msgs = db_list_queued(limit=MAX_QUEUED_PER_PAYLOAD)
	pending_msgs = [ m for m in queued_msgs if (m.get("status") or "pending") == "pending" ]

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

			if resp.status_code == 201:
				msg_success += 1
				if isinstance(relay_hash, str) and relay_hash:
					db_update_queued_status(relay_hash, "sent")
			else:
				msg_failed += 1
				msg_errors.append(f"{relay_hash}: HTTP {resp.status_code} {resp.text}")
		except Exception as e:
			msg_failed += 1
			msg_errors.append(f"{relay_hash}: {e}")

	checkin_success = 0
	checkin_failed = 0
	checkin_errors: list[str] = []

	checkins = db_list_checkins_queued(limit=MAX_QUEUED_PER_PAYLOAD)
	pending_checkins = [c for c in checkins if (c.get("status") or "pending") == "pending"]
	api_key = get_station_api_key()

	if pending_checkins and not api_key:
		checkin_failed = len(pending_checkins)
		checkin_errors.append("Missing api_key; cannot flush check-ins to central")
	
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

				if resp.status_code == 201:
					checkin_success += 1

					# Mark as sent in JSON so db_list_checkins_queued sees it
					c["status"] = "sent"
					c["sentAt"] = int(time.time() * 1000)

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
				else:
					checkin_failed += 1
					checkin_errors.append(
						f"{relay_hash}: HTTP {resp.status_code} {resp.text}"
					)
			except Exception as e:
				checkin_failed += 1
				checkin_errors.append(f"{relay_hash}: {e}")

	# Always try to pull blocks (even if nothing was pending)
	pulled_blocks, pull_error = pull_blocks_from_central()

	return (
		jsonify(
			{
				"status": "ok",
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
				"pulled_blocks_stored": pulled_blocks,
				"pull_error": pull_error,
			}
		),
		200,
	)


if __name__ == "__main__":
	app.run(host="0.0.0.0", port=5000, debug=True)
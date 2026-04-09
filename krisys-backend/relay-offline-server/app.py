# krisys-backend/relay-offline-server/app.py
"""
KriSYS Offline Relay Server ("dumb" untrusted version of a station)

This service runs on a physical station device (e.g. hospital, shelter,
food distribution point, vehicle, gathering zone) and acts as an offline mesh relay.

The difference between this and a station is that the relay station has no auth
requirements from the service provider. It is simply a dumb room acting as an
access point for users to exchange untrusted messages. Stations also do this,
but stations can check-in users with qr scanners and send those transactions to
the central server to be mined to a block. This relay does not post transactions at all.

Dubbed "the dumb relay" for these reasons. Plug them into power source and users can
connect and share data without needing to host for themselves. Can be run in emergency
vehicles for example, and left on to help propagate unconfirmed messages as the vehicle
travels between regions, gathering messages of passers-by along the way.

Responsibilities:
	- Accept unconfirmed client messages (relay_hash-based) while offline
	- Persist queued messages and recent blocks to disk (SQLite)
	- Prevent duplicate storage via inventory + dedupe checks
	- Enforce single-crisis operation via crisisId pinning
	- Verify received blocks (hash + signature) before storing
	- Use verified blocks to mark relay_hash confirmed and prune queued

Trust model:
	- Relay stores the crisis trust anchor (block_public_key) extracted from
	  genesis metadata into SQLite meta to help it cull malformed messages and limit
	  propagation of corrupted messages
	- relay_hash (UUID) is the stable ID for offline messages.

Timestamp conventions:
	- timestamp_created: seconds since epoch (int)
	- queuedAt / generatedAt / confirmedAt: milliseconds since epoch (int)
"""
# DEV NOTE: Lots of shared functionality with device-offline-station/app.py, consider refactoring modules for shared primitives when working on settings and policy wizard for the blockchain initiliazation

import hashlib
import json
import os
import sqlite3
import requests
import threading
from reconcile_local_chain import validate_local_chain_segment, repair_local_chain_from
from canonical_block import canonical_block_hash
import time
from contextlib import contextmanager
import pgpy
from flask import Flask, jsonify, request
from flask_cors import CORS
import logging
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
	FRONTEND_ORIGINS = ["http://localhost:3000",]
else:
	# Production, lock this down later
	FRONTEND_ORIGINS = []
CORS(app, origins=FRONTEND_ORIGINS)
###########################################

# Hard cap request size (abuse protection). Tune as needed.
# Note: inventory is tiny; sync can be larger due to blocks + queued.
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("RELAY_MAX_CONTENT_LENGTH", str(2 * 1024 * 1024)))

# DEV TODO: "THESE_VALUES_BELOW_IMPORTS" are set by policy in production, hard code more sensible defaults before deployment

# ----------------------------
# Relay auto-pull (defaults on, env to toggle off)
# ----------------------------
RELAY_AUTO_PULL = os.environ.get("RELAY_AUTO_PULL", "1") == "1" # Optional provisioning path for bulk deployment
# DEV NOTE: If CENTRAL_URL is unset, auto‑pull simply won’t run. That’s intentional.
CENTRAL_URL = os.environ.get("CENTRAL_API_URL")  # optional; auto-pull disabled if missing
RELAY_PULL_INTERVAL_MS = int(os.environ.get("RELAY_PULL_INTERVAL_MS", "60000"))
RELAY_RUNTIME = {
	"central_ok": False,
	"last_err": None,
	"next_pull_at_ms": 0,
}
RELAY_STOP_EVENT = threading.Event()
# ----------------------------

# Persistent data for offline relay cache (queued txs + verified blocks)
DATA_DIR = os.environ.get("RELAY_DATA_DIR", "/app/data")
RELAY_DB_PATH = os.path.join(DATA_DIR, "relay.db")

# Abuse / safety limits (bounded to protect a dumb relay)
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

# Priority bounds (matches crisis policy convention)
TOP_PRIORITY = 1
BOTTOM_PRIORITY = 5

# Storage pruning (DEV-TUNED DEFAULTS)
QUEUED_TTL_MS = 7 * 24 * 60 * 60 * 1000
QUEUED_HIGH_WATER = 40
QUEUED_LOW_WATER = 20
QUEUED_SOFT_WATER = int(QUEUED_HIGH_WATER * 0.6) # heads up before the stop, just for soft warnings
def is_storage_under_pressure(count: int) -> bool:
	return count >= int(QUEUED_SOFT_WATER)

CONFIRMED_TTL_MS = 2 * 24 * 60 * 60 * 1000
CONFIRMED_MAX_ROWS = 20

def relay_can_reach_central(timeout_sec: int = 3) -> tuple[bool, str | None]:
	if not CENTRAL_URL:
		return False, "CENTRAL_URL not set"
	try:
		resp = requests.get(f"{CENTRAL_URL}/health", timeout=timeout_sec)
		if resp.status_code == 200:
			return True, None
		return False, f"HTTP {resp.status_code}"
	except Exception as e:
		return False, str(e)
	
def relay_pull_from_central() -> int:
	"""
	Pull blocks from HQ and store verified suffix.
	Returns number of newly stored blocks.
	"""
	# Must be pinned before pulling
	crisis_id = db_get_crisis_id()
	pub = db_get_block_public_key()
	if not crisis_id or not pub:
		return 0

	resp = requests.get(f"{CENTRAL_URL}/blockchain", timeout=15)
	resp.raise_for_status()

	chain = resp.json()
	if not isinstance(chain, list) or not chain:
		return 0

	return process_incoming_blocks(chain[-MAX_BLOCKS_STORED:])

	
@contextmanager
def relay_db():
	"""
	Context manager for relay SQLite access.
	Ensures the data directory exists and connections are closed cleanly.
	"""
	os.makedirs(DATA_DIR, exist_ok=True)
	conn = sqlite3.connect(RELAY_DB_PATH)
	conn.row_factory = sqlite3.Row
	try:
		yield conn
	finally:
		conn.close()


def init_relay_db():
	"""
	Initialize persistent storage tables.
	Safe to call repeatedly.
	"""
	with relay_db() as conn:
		conn.execute(
			"""
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)
			"""
		)

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

		conn.execute(
			"""
			CREATE TABLE IF NOT EXISTS confirmed (
				relay_hash TEXT PRIMARY KEY,
				json TEXT NOT NULL
			)
			"""
		)

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

		conn.commit()


# ----------------------------
# DEV NOTE: Sorting messages, consider refactor later to share this with station-offline-server
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
	with relay_db() as conn:
		row = conn.execute(
			"SELECT value FROM meta WHERE key = ?",
			(key,),
		).fetchone()
		return row["value"] if row else None

def db_set_meta(key: str, value: str) -> None:
	with relay_db() as conn:
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


def db_get_crisis_id() -> str | None:
	return db_get_meta("crisisId")


def db_get_block_public_key() -> str | None:
	return db_get_meta("block_public_key")


def _now_ms() -> int:
	return int(time.time() * 1000)


def _msg_priority_level(msg: dict) -> int:
	try:
		return int(msg.get("priority_level") or 999)
	except Exception:
		return 999


def _msg_created_ms(msg: dict) -> int:
	"""
	We prefer timestamp_created (seconds) if present; otherwise fall back to queuedAt (ms).
	"""
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

# ----------------------------
# DB helpers (queued + confirmed)
# ----------------------------

def db_is_confirmed(relay_hash: str) -> bool:
	with relay_db() as conn:
		row = conn.execute(
			"SELECT 1 FROM confirmed WHERE relay_hash = ?",
			(relay_hash,),
		).fetchone()
		return bool(row)


def db_is_queued(relay_hash: str) -> bool:
	with relay_db() as conn:
		row = conn.execute(
			"SELECT 1 FROM queued WHERE relay_hash = ?",
			(relay_hash,),
		).fetchone()
		return bool(row)


def db_put_confirmed(relay_hash: str, info: dict) -> None:
	with relay_db() as conn:
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
			logger.info(f"Relay confirmed prune: {res}")
	except Exception as e:
		logger.warning(f"Relay confirmed prune failed: {e}")


def db_put_queued(msg: dict) -> bool:
	"""
	Insert into queued if not already present.
	Returns True if inserted, False if already existed.

	After insert, run pruning to keep the RELAY stable under load.
	"""
	# Hard stop: intake paused
	if db_get_intake_paused():
		logger.warning("RELAY intake paused: rejecting queued message")
		return False

	relay_hash = msg.get("relay_hash")
	if not isinstance(relay_hash, str) or not relay_hash:
		return False

	status = msg.get("status")
	if not isinstance(status, str) or not status:
		status = "pending"

	pause_needed = False
	count = 0

	with relay_db() as conn:
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
			logger.warning("RELAY storage nearing capacity (queued=%d, soft=%d, hard=%d)",
				count, 
				QUEUED_SOFT_WATER, 
				QUEUED_HIGH_WATER,
			)

		conn.commit()

	inserted = cur.rowcount == 1

	# Set intake pause OUTSIDE the DB transaction to avoid sqlite lock
	if pause_needed and not db_get_intake_paused():
		logger.error("RELAY storage full (queued=%d). Pausing intake.", count,)
		db_set_intake_paused(True)

	try:
		res = db_prune_queued()
		if res.get("deleted_ttl") or res.get("deleted_evicted"):
			logger.info(f"RELAY queued prune: {res}")
	except Exception as e:
		logger.warning(f"RELAY queued prune failed: {e}")

	return inserted


def db_delete_queued(relay_hash: str) -> None:
	with relay_db() as conn:
		conn.execute(
			"DELETE FROM queued WHERE relay_hash = ?",
			(relay_hash,),
		)
		conn.commit()


def db_list_queued(limit: int) -> list[dict]:
	with relay_db() as conn:
		rows = conn.execute(
			"SELECT json FROM queued ORDER BY queuedAt DESC LIMIT ?",
			(int(limit),),
		).fetchall()
		return [json.loads(r["json"]) for r in rows]


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

	with relay_db() as conn:
		rows = conn.execute(query, tuple(relay_hashes)).fetchall()

	out = {}
	for r in rows:
		out[r["relay_hash"]] = json.loads(r["json"])
	return out

def db_get_queued_by_hashes(relay_hashes: list[str]) -> list[dict]:
	"""
	Return queued payloads for the specified relay_hash values.
	Used to respond to selective relay sync requests.
	"""
	if not relay_hashes:
		return []  # No hashes requested -> return empty list

	# Ensure only non-empty strings are used.
	clean = [rh for rh in relay_hashes if isinstance(rh, str) and rh.strip()]
	if not clean:
		return []  # Nothing valid to fetch

	placeholders = ",".join(["?"] * len(clean))  # Build SQL placeholders

	query = f"SELECT json FROM queued WHERE relay_hash IN ({placeholders})"  # Select queued rows

	with relay_db() as conn:
		rows = conn.execute(query, tuple(clean)).fetchall()  # Execute query

	# Parse JSON rows into dicts.
	return [json.loads(r["json"]) for r in rows]


def get_known_relay_hashes() -> set[str]:
	"""
	Return all relay_hash values known to this relay (queued or confirmed).
	Used for inventory and for dedupe during sanitize.
	"""
	known = set()

	with relay_db() as conn:
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

	with relay_db() as conn:
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
					logger.info(
						"Queued reduced to %d, resuming RELAY intake",
						remaining,
					)
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
					logger.info("Queued reduced to %d, resuming RELAY intake", remaining,)
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
		
		# Eviction completed — resume intake if we've recovered enough RELAY HDD space
		if remaining <= int(QUEUED_LOW_WATER):
			if db_get_intake_paused():
				logger.info(
					"Queued reduced to %d, resuming RELAY intake",
					remaining,
				)
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

	with relay_db() as conn:
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
# Relay State Helpers
# ----------------------------
def relay_is_pinned() -> bool:
	crisis_id = db_get_crisis_id()
	pub = db_get_block_public_key()
	return isinstance(crisis_id, str) and bool(crisis_id) and isinstance(pub, str) and bool(pub)

def require_pinned() -> tuple[bool, str]:
	if not relay_is_pinned():
		return False, f"Relay state: {relay_state()}. Provisioning required."
	return True, ""

def relay_state() -> str:
	# Returns: "UNINITIALIZED" or "PINNED"
	return "PINNED" if relay_is_pinned() else "UNINITIALIZED"

# ----------------------------
# Relay Bootstrap From Known Candidates (DEV)
# ----------------------------

# Purpose: In docker-compose and controlled dev environments, automatically provision the relay from any known peer if CENTRAL_API_URL is not set.

# Behavior:
#	- Only runs if relay is UNINITIALIZED
#	- Only runs if CENTRAL_API_URL is NOT set
#	- Tries a small list of known service names
#	- Retries a few times to survive container race conditions
#	- Stops permanently once pinned

# DEV NOTE: TODO -> Replace `bootstrap_targets` list with dynamic LAN discovery in future production refinement
#	Example future sources:
#		- mDNS discovery
#		- UDP broadcast beacon
#		- Subnet scanning
#		- Saved provisioning file
#	For now we hardcode docker-compose service names.
# ----------------------------

RELAY_BOOTSTRAP_MAX_ATTEMPTS = 3
RELAY_BOOTSTRAP_SLEEP_SECONDS = 3

def relay_bootstrap_from_candidates():
	"""
	Unified bootstrap logic. Tries CENTRAL_API_URL first (if set), known peer targets (docker-compose).
	"""

	if relay_is_pinned():
		return

	bootstrap_targets = []

	# Include CENTRAL_URL if defined
	if CENTRAL_URL:
		bootstrap_targets.append(CENTRAL_URL)

	# DEV NOTE: TODO -> Replace this static list with LAN discovery
	bootstrap_targets.extend([
		"http://backend:5000",
		"http://station:5000",
		"http://station_camp:5000",
	])

	for attempt in range(RELAY_BOOTSTRAP_MAX_ATTEMPTS):

		if relay_is_pinned():
			return

		logger.info(
			"Relay bootstrap attempt %d/%d",
			attempt + 1,
			RELAY_BOOTSTRAP_MAX_ATTEMPTS,
		)

		for target in bootstrap_targets:

			try:
				logger.info("Trying bootstrap target: %s", target)

				crisis_resp = requests.get(f"{target}/crisis", timeout=5)
				if not crisis_resp.ok:
					continue

				crisis_obj = crisis_resp.json() or {}
				crisis_id = crisis_obj.get("id")
				block_public_key = crisis_obj.get("block_public_key")

				if not crisis_id or not block_public_key:
					continue

				chain_resp = requests.get(f"{target}/blockchain", timeout=10)
				if not chain_resp.ok:
					continue

				chain = chain_resp.json()
				if not isinstance(chain, list) or not chain:
					continue

				genesis = None
				for block in chain:
					if block.get("block_index") == 0:
						genesis = block
						break

				if not genesis:
					continue

				expected_hash = compute_block_hash(genesis)
				if not expected_hash or expected_hash != genesis.get("hash"):
					continue

				if not verify_block_signature(genesis, block_public_key):
					continue

				# PIN RELAY
				db_set_meta("crisisId", crisis_id)
				db_set_meta("block_public_key", block_public_key)

				# Determine provisioning target label
				provisioned_target = None

				try:
					profile_resp = requests.get(f"{target}/station/profile", timeout=3)
					if profile_resp.ok:
						profile = profile_resp.json()
						if isinstance(profile.get("station_id"), str):
							provisioned_target = profile["station_id"]
				except Exception:
					pass

				if not provisioned_target:
					provisioned_target = target

				db_set_meta("provisioned_target", provisioned_target)
				db_set_meta("provisioned_at", str(int(time.time())))

				db_put_block_verified(genesis)
				process_incoming_blocks(chain[-MAX_BLOCKS_STORED:])

				logger.warning(
					"Relay bootstrapped from %s (crisisId=%s)",
					provisioned_target,
					crisis_id,
				)

				logger.info(
					"Provision metadata: target=%s at=%s",
					db_get_meta("provisioned_target"),
					db_get_meta("provisioned_at"),
				)

				return

			except Exception as e:
				logger.warning(
					"Bootstrap attempt failed for %s: %s",
					target,
					e,
				)

		time.sleep(RELAY_BOOTSTRAP_SLEEP_SECONDS)

	logger.warning("Relay bootstrap attempts exhausted; remaining UNINITIALIZED.")

# ----------------------------
# DB helpers (blocks)
# ----------------------------
def db_get_tip() -> dict | None:
	with relay_db() as conn:
		row = conn.execute(
			"""
			SELECT json
			FROM blocks
			ORDER BY block_index DESC
			LIMIT 1
			"""
		).fetchone()

	if not row:
		return None

	try:
		return json.loads(row["json"])
	except Exception:
		return None


def db_get_block_hash(block_index: int) -> str | None:
	with relay_db() as conn:
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
	with relay_db() as conn:
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
	with relay_db() as conn:
		rows = conn.execute(
			"SELECT json FROM blocks ORDER BY block_index DESC LIMIT ?",
			(int(limit),),
		).fetchall()
		blocks = [json.loads(r["json"]) for r in rows]
		blocks.reverse()
		return blocks

# ----------------------------
# RELAY LOCAL CHAIN ADAPTERS FOR RECONCILIATION
# ----------------------------
def _relay_get_block_by_index(index: int):
	with relay_db() as conn:
		row = conn.execute(
			"SELECT json FROM blocks WHERE block_index = ?",
			(index,),
		).fetchone()
		if not row:
			return None
		return json.loads(row["json"])


def _relay_get_local_tip_index() -> int:
	with relay_db() as conn:
		row = conn.execute(
			"SELECT MAX(block_index) AS tip FROM blocks"
		).fetchone()
		if row and row["tip"] is not None:
			return int(row["tip"])
		return -1


def _relay_verify_block_signature(block: dict) -> bool:
	try:
		block_public_key = db_get_meta("block_public_key")
		if not block_public_key:
			return False

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

		result = pub.verify(header.encode("utf-8"), sig)
		return bool(result)

	except Exception:
		return False


def _relay_delete_blocks_from_index(index: int):
	with relay_db() as conn:
		conn.execute(
			"DELETE FROM blocks WHERE block_index >= ?",
			(index,),
		)
		conn.commit()


def _relay_fetch_blocks_from_hq(start_index: int, count: int):
	try:
		resp = requests.get(f"{CENTRAL_URL}/blockchain", timeout=15)
		if not resp.ok:
			return []
		chain = resp.json()
		return [
			b for b in chain
			if isinstance(b, dict)
			and b.get("block_index") is not None
			and b["block_index"] >= start_index
		][:count]
	except Exception:
		return []


def _relay_store_block(block: dict):
	db_put_block_verified(block)


def _relay_get_first_stored_index() -> int:
	with relay_db() as conn:
		row = conn.execute(
			"""
			SELECT block_index
			FROM blocks
			WHERE block_index != 0
			ORDER BY block_index ASC
			LIMIT 1
			"""
		).fetchone()

		if row:
			return int(row["block_index"])
		return 0

# RELAY LOCAL CHAIN SELF-VALIDATION + AUTO-REPAIR
def perform_full_canonical_chain_validation_on_boot():
	_validation = validate_local_chain_segment(
		get_block_by_index=_relay_get_block_by_index,
		get_local_tip_index=_relay_get_local_tip_index,
		verify_block_signature=_relay_verify_block_signature,
		start_index=_relay_get_first_stored_index(),
	)

	# DEBUGGING
	logger.info("RELAY BOOT VALIDATION VERSION 2")

	if _validation.get("no_chain"):  # guard missing chain
		logger.warning("Relay has no chain; skipping repair on boot.")  # log
		return  # exit early
	
	elif not _validation["valid"]:
		logger.warning(f"Relay chain corrupted at index {_validation['first_invalid_index']}. Attempting repair.")

		repair_result = repair_local_chain_from(
			first_invalid_index=_validation["first_invalid_index"],  # start repair here
			get_block_by_index=_relay_get_block_by_index,  # fetch block by index
			get_local_tip_index=_relay_get_local_tip_index,  # read local tip
			anchor_floor=_relay_get_first_stored_index(),  # NEW: pruned floor
			verify_block_signature=_relay_verify_block_signature,  # signature check
			delete_blocks_from_index=_relay_delete_blocks_from_index,  # rollback
			fetch_blocks_from_source=_relay_fetch_blocks_from_hq,  # pull from HQ
			store_block=_relay_store_block,  # store verified blocks
		)

		if not repair_result["repaired"]:
			logger.critical("Relay auto-repair failed. Manual intervention required.")
			raise RuntimeError("Relay chain unrecoverable")

		logger.info(f"Relay chain repaired successfully. New tip: {repair_result['new_tip']}")

	else:
		logger.info(f"Relay chain validated successfully. Tip index: {_validation['local_tip']}")


# ----------------------------
# Block verification + confirmations
# ----------------------------
def compute_block_hash(block: dict) -> str | None:  # wrapper for legacy calls
    return canonical_block_hash(block)  # use shared canonical hash


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


def _apply_confirmations_from_block(block: dict) -> None:
	"""
	Derive confirmations from a verified, accepted block:
	- if a transaction has relay_hash, mark it confirmed and prune queued.
	"""
	for tx in block.get("transactions") or []:
		if not isinstance(tx, dict):
			continue

		rh = tx.get("relay_hash")
		if not isinstance(rh, str) or not rh:
			continue

		info = {
			"confirmedAt": int(time.time() * 1000),
			"block_index": int(block["block_index"]),
			"txId": tx.get("transaction_id"),
			"timestampPosted": tx.get("timestamp_posted"),
		}

		db_put_confirmed(rh, info)
		db_delete_queued(rh)


def process_incoming_blocks(incoming_blocks: list[dict]) -> int:
	"""
	Verify incoming blocks (hash + signature) before storing.

	Chain merge rule (conservative, matches client intent):
	- If relay has a local tip:
		- only accept blocks that extend the tip (index+1 and previous_hash match)
	- If relay has NO blocks yet:
		- accept the longest contiguous verified run from the incoming payload
		  (this allows bootstrapping from a suffix of the chain)

	Returns: number of newly stored blocks.
	"""
	if not isinstance(incoming_blocks, list) or not incoming_blocks:
		return 0

	block_public_key = db_get_block_public_key()
	if not block_public_key:
		return 0

	# 1) Cheap shape checks + verify hash/signature first (bounded)
	candidates: list[dict] = []
	for b in incoming_blocks[:MAX_BLOCKS_PER_PAYLOAD]:
		if not isinstance(b, dict):
			continue
		if not isinstance(b.get("block_index"), int):
			continue
		if not isinstance(b.get("hash"), str):
			continue
		if not isinstance(b.get("previous_hash"), str):
			continue
		if not isinstance(b.get("signature"), str):
			continue

		expected = compute_block_hash(b)
		if not expected or expected != b["hash"]:
			continue

		if not verify_block_signature(b, block_public_key):
			continue

		candidates.append(b)

	if not candidates:
		return 0

	candidates.sort(key=lambda x: int(x["block_index"]))

	tip = db_get_tip()
	stored = 0

	# 2) Bootstrap: no local blocks yet => accept a contiguous verified run
	if not tip:
		best_run: list[dict] = []
		run: list[dict] = []

		for b in candidates:
			if not run:
				run = [b]
			else:
				prev = run[-1]
				ok_link = (
					int(b["block_index"]) == int(prev["block_index"]) + 1
					and str(b["previous_hash"]) == str(prev["hash"])
				)
				run = run + [b] if ok_link else [b]

			if len(run) > len(best_run):
				best_run = list(run)

		for b in best_run:
			existing_hash = db_get_block_hash(b["block_index"])
			if existing_hash:
				continue
			db_put_block_verified(b)
			_apply_confirmations_from_block(b)
			stored += 1

		return stored

	# 3) Normal: we have a tip => only accept direct extensions
	current_tip = tip
	for b in candidates:
		idx = int(b["block_index"])

		existing_hash = db_get_block_hash(idx)
		if existing_hash:
			continue

		ok_link = (
			idx == int(current_tip["block_index"]) + 1
			and str(b["previous_hash"]) == str(current_tip["hash"])
		)
		if not ok_link:
			continue

		db_put_block_verified(b)
		_apply_confirmations_from_block(b)
		current_tip = b
		stored += 1

	return stored


# ----------------------------
# Mesh payload sanitization + export
# ----------------------------

def sanitize_sync_payload_server(payload: dict) -> list[dict]:
	"""
	"Smell test" sanitization for incoming queued messages.
	This does NOT mean confirmed; it only means safe enough to store + relay.

	Relay does not trust client-confirmed hints. Confirmations come only from
	verified blocks.
	"""
	if not isinstance(payload, dict):
		return []

	raw_queued = payload.get("queued") or []
	if not isinstance(raw_queued, list):
		raw_queued = []

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

		# IMPORTANT: Keep canonical tx schema field name: station_address
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
		if message_data and len(message_data) > MAX_MESSAGE_LENGTH:
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

	return sanitized_queued


# DEV TODO: Block‑vs‑queue bandwidth negotiation
def export_relay_payload() -> dict:
	"""
	Build a sync payload from the relay's persisted state.
	Clients use this to update their local caches.
	"""
	now_ms = int(time.time() * 1000)

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

	with relay_db() as conn:
		row = conn.execute("SELECT COUNT(1) AS c FROM queued").fetchone()
		count = int(row["c"]) if row else 0
	warnings = []
	if is_storage_under_pressure(count):
		warnings.append("storage_pressure")

	return {
		"version": 1,
		"deviceId": "relay_local",
		"crisisId": db_get_crisis_id(),
		"generatedAt": now_ms,
		"chain_tip": chain_tip,
		"blocks": blocks,
		"queued": sorted_queued,
		# Confirmations are returned via inventory (filtered by relay_hashes).
		"confirmed": {},
		# DEV NOTE: warnings are informational only. Clients should not change behavior yet.
		"warnings": warnings,
	}


init_relay_db()
logger.info("Relay DB initialized")
logger.info("Initial relay state: %s", relay_state())

perform_full_canonical_chain_validation_on_boot()

relay_bootstrap_from_candidates()


# ----------------------------
# Routes
# ----------------------------
@app.route("/health", methods=["GET"])
def health():
	state = relay_state()
	return jsonify({
		"role": "relay",
		"status": "ok",
		"state": state,
		"crisisId": db_get_crisis_id(),
		"provisioned_target": db_get_meta("provisioned_target"),
		"provisioned_at": db_get_meta("provisioned_at"),
	}), 200


@app.route("/relay/provision", methods=["POST"])
def relay_provision():
	"""
	Station-mediated provisioning. Can only run if relay is UNINITIALIZED.

	Example /relay/provision POST payload structure:
	{
		...GET /crisis,
		"genesis_block": GET /blockchain[0],
		"blocks": GET /blockchain[-N:],
		"station_id": "optional"
	}

	Notes:
	- genesis_block MUST be verified (hash + signature) before pinning.
	- block_public_key MUST match genesis signature.
	- blocks array is optional but recommended (recent suffix).
	- station_id is optional; used only for provisioned_target metadata

	Relay Provisioning Endpoint (EXPLICITLY pin a crisisID if automatic discovery doesn't work)
	"""

	logger.info("Received explicit relay provisioning request from %s", request.remote_addr,)

	if relay_is_pinned():
		return jsonify({"error": "Relay already PINNED. Reset required to reprovision."}), 409

	incoming = request.get_json(force=True, silent=True) or {}

	crisis_id = incoming.get("crisis_id")
	block_public_key = incoming.get("block_public_key")
	genesis_block = incoming.get("genesis_block")
	suffix_blocks = incoming.get("blocks") or []

	if not isinstance(crisis_id, str) or not crisis_id.strip():
		logger.warning("Provision failed: missing crisis_id")
		return jsonify({"error": "Missing crisis_id"}), 400

	if not isinstance(block_public_key, str) or not block_public_key.strip():
		logger.warning("Provision failed: missing block_public_key")
		return jsonify({"error": "Missing block_public_key"}), 400

	if not isinstance(genesis_block, dict):
		logger.warning("Provision failed: missing genesis_block")
		return jsonify({"error": "Missing genesis_block"}), 400

	# Verify genesis integrity
	expected_hash = compute_block_hash(genesis_block)
	if not expected_hash or expected_hash != genesis_block.get("hash"):
		logger.warning("Provision failed: missing expected_hash")
		return jsonify({"error": "Genesis hash invalid"}), 400

	if not verify_block_signature(genesis_block, block_public_key):
		logger.warning("Provision failed: missing block signature verification")
		return jsonify({"error": "Genesis signature invalid"}), 400

	# Store crisis pin
	db_set_meta("crisisId", crisis_id.strip())
	db_set_meta("block_public_key", block_public_key.strip())

	# Determine provisioning target label if request included station_id, prefer that
	station_id = incoming.get("station_id")

	if isinstance(station_id, str) and station_id.strip():
		provisioned_target = station_id.strip()
	else:
		# Fallback to request remote address
		provisioned_target = request.remote_addr or "unknown"

	db_set_meta("provisioned_target", provisioned_target)
	db_set_meta("provisioned_at", str(int(time.time())))

	# Store verified genesis
	db_put_block_verified(genesis_block)

	# Process suffix blocks
	if isinstance(suffix_blocks, list):
		process_incoming_blocks(suffix_blocks)

	logger.warning(
		"Relay successfully PINNED to crisisId=%s (source=%s)",
		crisis_id,
		provisioned_target,
	)

	return jsonify({"status": "PINNED", "crisis_id": crisis_id}), 200


@app.route("/mesh/inventory", methods=["POST"])
def mesh_inventory():
	"""
	Inventory handshake:
	Client sends relay_hashes and (optionally) block_public_key.

	Relay replies:
	- missing_relay_hashes: which relay hashes the relay does NOT know
	- confirmed: confirmations for hashes the relay knows as confirmed

	Note:
	If the relay is unpinned, the caller must include block_public_key so the
	relay can pin + later verify blocks.
	"""
	incoming = request.get_json(force=True, silent=True) or {}

	ok, err = require_pinned()
	if not ok:
		logger.warning("Mesh request rejected: %s", err)
		return jsonify({"error": err}), 403

	# Enforce crisis match
	if incoming.get("crisisId") != db_get_crisis_id():
		logger.warning("Mesh request rejected: %s", err)
		return jsonify({"error": "Crisis mismatch"}), 400

	relay_hashes = incoming.get("relay_hashes") or []
	if not isinstance(relay_hashes, list):
		logger.warning("Mesh request rejected: %s", err)
		return jsonify({"error": "relay_hashes must be a list"}), 400

	relay_hashes = relay_hashes[:RELAY_HASH_CAP]
	relay_hashes = [rh for rh in relay_hashes if isinstance(rh, str) and rh.strip()]

	known = get_known_relay_hashes()
	missing_relay_hashes = [rh for rh in relay_hashes if rh not in known]
	confirmed = db_get_confirmed_many(relay_hashes)

	tip = db_get_tip()
	chain_tip = None
	if isinstance(tip, dict):
		chain_tip = {
			"block_index": tip.get("block_index"),
			"hash": tip.get("hash"),
			"previous_hash": tip.get("previous_hash"),
		}

	return jsonify(
		{
			"crisisId": db_get_crisis_id(),
			"missing_relay_hashes": missing_relay_hashes,
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
	- verifies blocks before storing (hash + signature + tip-extension rules)
	- uses verified blocks to confirm relay_hash and prune queued
	"""
	incoming = request.get_json(force=True, silent=True) or {}

	ok, err = require_pinned()
	if not ok:
		return jsonify({"error": err}), 403

	# Enforce crisis match
	if incoming.get("crisisId") != db_get_crisis_id():
		return jsonify({"error": "Crisis mismatch"}), 400
	
	# Hard stop: refuse new queued intake when storage is full
	if db_get_intake_paused():
		logger.error("RELAY storage full: rejecting /mesh/sync intake")
		return (
			jsonify({
				"error": "storage_full",
				"message": "RELAY storage full; not accepting new queued messages",
			}),
			507,
		)

	incoming_queued = sanitize_sync_payload_server(incoming)
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

	# Selective response handling (max blocks if not full payload)
	want_relay_hashes = incoming.get("want_relay_hashes") or []  # Requested relay hashes
	want_blocks_from = incoming.get("want_blocks_from")  # Requested block start index
	max_blocks = incoming.get("max_blocks")  # Requested block cap

	has_selector = bool(want_relay_hashes) or isinstance(want_blocks_from, int)

	if has_selector:
		# Cap max_blocks to prevent abuse.
		try:
			max_blocks_cap = int(max_blocks)
		except Exception:
			max_blocks_cap = MAX_BLOCKS_PER_PAYLOAD
		max_blocks_cap = max(1, min(max_blocks_cap, MAX_BLOCKS_PER_PAYLOAD))

		# Build requested queued payloads.
		queued_payloads = db_get_queued_by_hashes(want_relay_hashes)
		queued_payloads = _sort_queued_for_export(queued_payloads)  # Deterministic order
		queued_payloads = queued_payloads[:MAX_QUEUED_PER_PAYLOAD]  # Safety cap

		# Build requested block suffix.
		blocks_payloads = []
		if isinstance(want_blocks_from, int):
			all_blocks = db_list_blocks(MAX_BLOCKS_STORED)  # Bounded local suffix
			blocks_payloads = [
				b for b in all_blocks
				if isinstance(b, dict)
				and isinstance(b.get("block_index"), int)
				and b["block_index"] >= want_blocks_from
			]
			blocks_payloads = blocks_payloads[:max_blocks_cap]  # Apply cap

		# Build minimal chain_tip to match /mesh/inventory shape.
		tip = db_get_tip()  # Fetch the latest stored block (may be None)
		chain_tip = None  # Default to None if no tip exists
		if isinstance(tip, dict):
			chain_tip = {  # Return only minimal tip fields
				"block_index": tip.get("block_index"),
				"hash": tip.get("hash"),
				"previous_hash": tip.get("previous_hash"),
			}

		return jsonify({
			"version": 1,  # Payload version
			"deviceId": "relay_local",  # Relay identifier
			"crisisId": db_get_crisis_id(),  # Pinned crisis id
			"generatedAt": int(time.time() * 1000),  # Response timestamp
			"chain_tip": chain_tip,  # Minimal chain tip object
			"blocks": blocks_payloads,  # Requested blocks
			"queued": queued_payloads,  # Requested queued payloads
			"confirmed": {},  # Relay does not assert confirmations
		}), 200

	# Otherwise return full payload
	payload = export_relay_payload()
	return jsonify(payload), 200


# Room hosting via Nodejs rtc-host/server.js
@app.route("/relay/allocate-offer", methods=["POST"])
def relay_allocate_offer():
	"""
	Allocate a WebRTC offer from the relay pool.

	Wallet calls this endpoint.
	Flask validates relay is PINNED.
	Flask forwards request to Node RTC host.
	"""

	# Ensure relay is provisioned (must have crisis pinned)
	ok, err = require_pinned()
	if not ok:
		return jsonify({"error": err}), 403

	try:
		# Forward request to internal RTC host running on port 7000
		resp = requests.post("http://localhost:7000/allocate-offer", timeout=5)

	except Exception as e:
		logger.error(f"RTC host unreachable: {e}")
		return jsonify({"error": "RTC host unavailable"}), 502

	# If Node returned an error, forward it cleanly
	if resp.status_code != 200:
		try:
			return jsonify(resp.json()), resp.status_code
		except Exception:
			return jsonify({"error": resp.text}), resp.status_code

	# Return offer directly to wallet (do NOT inspect SDP)
	return jsonify(resp.json()), 200


@app.route("/relay/answer", methods=["POST"])
def relay_answer():
	"""
	Accept WebRTC answer from wallet and forward it to Node RTC host.

	Request JSON:
	{
		"peerId": "...",
		"answer": { ... SDP ... }
	}
	"""

	# Relay must be provisioned
	ok, err = require_pinned()
	if not ok:
		return jsonify({"error": err}), 403

	data = request.get_json(force=True, silent=True) or {}

	peer_id = data.get("peerId")
	answer = data.get("answer")

	# Basic validation
	if not isinstance(peer_id, str) or not peer_id.strip():
		return jsonify({"error": "Missing peerId"}), 400

	if not isinstance(answer, dict):
		return jsonify({"error": "Missing answer"}), 400

	try:
		resp = requests.post(
			"http://localhost:7000/answer",
			json={ "peerId": peer_id, "answer": answer }, timeout=5
		)

	except Exception as e:
		logger.error(f"RTC answer forward failed: {e}")
		return jsonify({"error": "RTC host unavailable"}), 502

	# Forward Node response cleanly
	if resp.status_code != 200:
		try:
			return jsonify(resp.json()), resp.status_code
		except Exception:
			return jsonify({"error": resp.text}), resp.status_code

	return jsonify(resp.json()), 200


def relay_background_loop():
	logger.warning("Relay auto-pull loop started (enabled=%s)",RELAY_AUTO_PULL,)

	while not RELAY_STOP_EVENT.is_set():
		now_ms = _now_ms()

		if not RELAY_AUTO_PULL:
			time.sleep(1.0)
			continue

		if now_ms >= int(RELAY_RUNTIME["next_pull_at_ms"] or 0):
			ok, err = relay_can_reach_central()
			RELAY_RUNTIME["central_ok"] = bool(ok)
			RELAY_RUNTIME["last_err"] = err

			if ok:
				try:
					stored = relay_pull_from_central()
					if stored > 0:
						logger.info("Relay pulled %d new block(s) from HQ", stored)
				except Exception as e:
					logger.warning("Relay pull failed: %s", e)

			# Schedule next attempt regardless of outcome
			RELAY_RUNTIME["next_pull_at_ms"] = now_ms + RELAY_PULL_INTERVAL_MS

		time.sleep(0.25)

_relay_bg_started = False

def start_relay_background_once():
	global _relay_bg_started

	logger.info(f'RELAY STATE IS: {relay_state()}')

	if _relay_bg_started:
		return
	_relay_bg_started = True

	t = threading.Thread(target=relay_background_loop, daemon=True)
	t.start()

start_relay_background_once()

if __name__ == "__main__":
	app.run(host="0.0.0.0", port=5000, debug=True)
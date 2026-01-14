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

Trust model:
- Station trusts the crisis block_public_key obtained during provisioning
- relay_hash (UUID) is the unique identifier for offline messages
- transaction_id only exists after confirmation on the central blockchain

Timestamp conventions:
- timestamp_created: seconds since epoch (int)
- queuedAt / generatedAt: milliseconds since epoch (int)
"""

import os
import time
import sqlite3
import json
from contextlib import contextmanager
import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)

CORS(app, origins=["http://localhost:3000"])

# In-memory cache (not source of truth)
station_state = { "crisisId": None }

# SETUP CONSTANTS
# Limits to protect station from abuse or accidental overload
# These mirror client-side limits where possible
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
RELAY_HASH_CAP = 1000

TOP_PRIORITY = 1
BOTTOM_PRIORITY = 5

CENTRAL_URL = os.environ.get("CENTRAL_API_URL", "http://backend:5000")

DATA_DIR = os.environ.get("STATION_DATA_DIR", "/app/data")
STATION_DB_PATH = os.path.join(DATA_DIR, "station.db")

# Context manager for station SQLite access
# Ensures the data directory exists and connections are closed cleanly
@contextmanager
def station_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(STATION_DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

# Initialize persistent storage tables
# Called once at startup; safe to call repeatedly
def init_station_db():
    with station_db() as conn:
        # Key/value metadata (crisisId, block_public_key, etc.)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        # Unconfirmed queued messages (relay_hash is the primary key)
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
        # Confirmed messages (derived from verified blocks or hints)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS confirmed (
                relay_hash TEXT PRIMARY KEY,
                json TEXT NOT NULL
            )
            """
        )
        # Recent blockchain blocks (used for confirmation + gossip)
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

# Ensure the station is bound to exactly one crisis. The first valid crisisId pins the station permanently
# All subsequent requests must match this crisisId
def ensure_crisis_id(incoming_crisis_id: str | None) -> tuple[bool, str]:
    if not incoming_crisis_id or not isinstance(incoming_crisis_id, str):
        return False, "Missing or invalid crisisId"

    stored = db_get_meta("crisisId")
    if stored is None:                      # First contact: persist crisisId
        db_set_meta("crisisId", incoming_crisis_id)
        station_state["crisisId"] = incoming_crisis_id
        return True, ""

    if stored != incoming_crisis_id:        # Prevent cross-crisis contamination
        return False, "Station crisisId mismatch"

    station_state["crisisId"] = stored
    return True, ""

# Check whether a relay_hash is already confirmed
def db_is_confirmed(relay_hash: str) -> bool:
    with station_db() as conn:
        row = conn.execute(
            "SELECT 1 FROM confirmed WHERE relay_hash = ?",
            (relay_hash,),
        ).fetchone()
        return bool(row)

# Check whether a relay_hash is already queued
def db_is_queued(relay_hash: str) -> bool:
    with station_db() as conn:
        row = conn.execute(
            "SELECT 1 FROM queued WHERE relay_hash = ?",
            (relay_hash,),
        ).fetchone()
        return bool(row)

# Persist a confirmed relay (untrusted hint or verified later)
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

# Retrieve confirmed entries for a set of relay hashes
# Used by inventory to allow clients to prune their queues early
def db_get_confirmed_many(relay_hashes: list[str]) -> dict:
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

# Persist a queued message if it does not already exist
# relay_hash uniqueness is enforced at the DB level
def db_put_queued(msg: dict) -> bool:
    relay_hash = msg.get("relay_hash")
    if not isinstance(relay_hash, str) or not relay_hash:
        return False

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
                msg.get("status"),
                int(msg.get("queuedAt") or 0),
            ),
        )
        conn.commit()
        return cur.rowcount == 1

# Remove a queued message after successful flush or confirmation
def db_delete_queued(relay_hash: str) -> None:
    with station_db() as conn:
        conn.execute(
            "DELETE FROM queued WHERE relay_hash = ?",
            (relay_hash,),
        )
        conn.commit()

# List queued messages in most-recent-first order
# Used by sync payloads and station flush
def db_list_queued(limit: int = 200) -> list[dict]:
    with station_db() as conn:
        rows = conn.execute(
            "SELECT json FROM queued ORDER BY queuedAt DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        return [json.loads(r["json"]) for r in rows]

# Persist a blockchain block received via mesh. Verification (hash + signature) will be added later. Old blocks are pruned to keep storage bounded
def db_put_block(block: dict) -> None:
    with station_db() as conn:
        conn.execute(
            """
            INSERT INTO blocks (block_index, hash, previous_hash, json)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(block_index) DO UPDATE SET
                hash=excluded.hash,
                previous_hash=excluded.previous_hash,
                json=excluded.json
            """,
            (
                int(block.get("block_index")),
                str(block.get("hash")),
                str(block.get("previous_hash")),
                json.dumps(block, separators=(",", ":"), ensure_ascii=False),
            ),
        )

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

# Retrieve recent blocks for gossip / confirmation
def db_list_blocks(limit: int = MAX_BLOCKS_STORED) -> list[dict]:
    with station_db() as conn:
        rows = conn.execute(
            "SELECT json FROM blocks ORDER BY block_index DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        blocks = [json.loads(r["json"]) for r in rows]
        blocks.reverse()
        return blocks

# Return all relay_hash values known to this station. Used to dedupe inventory and incoming sync payloads
def get_known_relay_hashes() -> set[str]:
    known = set()
    # Query persistent storage to ensure dedupe survives restarts.
    with station_db() as conn:
        rows = conn.execute("SELECT relay_hash FROM queued").fetchall()
        known.update([r["relay_hash"] for r in rows])

        rows = conn.execute("SELECT relay_hash FROM confirmed").fetchall()
        known.update([r["relay_hash"] for r in rows])

    return known

# Sanitize and normalize incoming mesh payloads
#
# This performs a cheap "smell test" before any persistence:
# - relay_hash must be valid and unique
# - timestamps must be reasonable
# - payload size and field types are enforced
#
# This does NOT mean the message is confirmed on-chain in a block, it only means it is safe to store and relay as unconfirmed.
def sanitize_sync_payload_server(payload: dict) -> tuple[list[dict], dict]:
    if not isinstance(payload, dict):
        return [], {}

    raw_queued = payload.get("queued") or []
    raw_confirmed = payload.get("confirmed") or {}

    if not isinstance(raw_queued, list):
        raw_queued = []
    if not isinstance(raw_confirmed, dict):
        raw_confirmed = {}
    
    # Time windows used to reject obviously bad timestamps.
    # timestamp_created is in seconds; queuedAt is in milliseconds.
    now_s = int(time.time())
    now_ms = now_s * 1000
    one_day_s = 24 * 60 * 60
    one_day_ms = one_day_s * 1000

    # Track how many messages each origin_device sends in this payload to prevent abuse from a single peer (DoS/spam).
    sanitized_queued: list[dict] = []
    per_origin_count: dict[str, int] = {}

    # Known relay_hashes are fetched from persistent storage. This prevents re-accepting duplicates after station restarts.
    existing_relay_hashes = get_known_relay_hashes()

    def is_string(v):
        return isinstance(v, str)

    def clamp_length(s: str, max_len: int) -> str:
        return s if len(s) <= max_len else s[:max_len]
    # Normalize input shapes to avoid type errors.
    for msg in raw_queued:
        if not isinstance(msg, dict):
            continue
        if len(sanitized_queued) >= MAX_QUEUED_PER_PAYLOAD:
            break

        # relay_hash is the globally unique identifier for this message. If it is missing or already known, ignore the message.
        relay_hash = msg.get("relay_hash")
        if not is_string(relay_hash) or not relay_hash.strip():
            continue
        if relay_hash in existing_relay_hashes:
            continue


	    # Enforce per-origin message quota
        origin = msg.get("origin_device")
        if not is_string(origin) or not origin:
            origin = "unknown"
        per_origin_count[origin] = per_origin_count.get(origin, 0) + 1
        if per_origin_count[origin] > MAX_PER_ORIGIN:
            continue

        try:
            # Validate timestamp_created (seconds since epoch).
            ts = int(msg.get("timestamp_created"))
        except (TypeError, ValueError):
            continue
        if ts < 0 or ts > now_s + one_day_s:
            continue

        try:
            priority = int(msg.get("priority_level"))
        except (TypeError, ValueError):
            continue
	    # Enforce priority bounds defined by the crisis policy
        if priority < TOP_PRIORITY or priority > BOTTOM_PRIORITY:
            continue


	    # Station address is plain text
        station_addr = msg.get("station_address")
        if not is_string(station_addr):
            continue
        station_addr = clamp_length(station_addr, MAX_STATION_ADDRESS_LENGTH)

        type_field = msg.get("type_field")
        if not is_string(type_field):
            continue
        type_field = clamp_length(type_field, MAX_TYPE_FIELD_LENGTH)
        
        # Message body must be plain text and within size limits.
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
        
        # queuedAt is local bookkeeping time (ms). Used only for ordering and persistence, not consensus.
        queued_at = msg.get("queuedAt")
        if isinstance(queued_at, (int, float)):
            queued_at_ms = int(queued_at)
        else:
            queued_at_ms = now_ms
        # Normalize input shapes to avoid type errors.
        normalized = {
            "relay_hash": relay_hash,
            "timestamp_created": ts,  # seconds
            "station_address": station_addr,
            "message_data": message_data,
            "related_addresses": clean_related,
            "type_field": type_field,
            "priority_level": priority,
            "origin_device": origin,
            "status": msg.get("status") or "pending",
            "attempts": int(msg.get("attempts") or 0),
            "queuedAt": queued_at_ms,  # ms
        }
        # Sanitize confirmed-relay hints. These are NOT trusted confirmations; they are used only as hints to help clients prune queues until verified blocks arrive.
        sanitized_queued.append(normalized)

    sanitized_confirmed: dict = {}
    for i, (relay_hash, info) in enumerate(list(raw_confirmed.items())):
        if i >= MAX_CONFIRMED_PER_PAYLOAD:
            break
        if not is_string(relay_hash) or not relay_hash.strip():
            continue
        if not isinstance(info, dict):
            continue

        clean_info = dict(info)

        ca = clean_info.get("confirmedAt")
        if isinstance(ca, (int, float)):
            ca_ms = int(ca)
            if ca_ms < 0 or ca_ms > now_ms + one_day_ms:
                clean_info.pop("confirmedAt", None)

        tp = clean_info.get("timestampPosted")
        if isinstance(tp, (int, float)):
            tp_s = int(tp)
            if tp_s < 0 or tp_s > now_s + one_day_s:
                clean_info.pop("timestampPosted", None)

        sanitized_confirmed[relay_hash] = clean_info

    return sanitized_queued, sanitized_confirmed

# Build a sync payload from the station's persisted state
# This is returned to clients after inventory or sync
def export_station_payload():
    now_ms = int(time.time() * 1000) # Timestamp for when this payload was generated (ms).
    # Load the persisted crisisId into memory for quick access.
    station_state["crisisId"] = db_get_meta("crisisId")

    blocks = db_list_blocks(MAX_BLOCKS_PER_PAYLOAD)
    last_block = blocks[-1] if blocks else None
    # The chain tip summarizes the most recent known block.
    # Clients use this to detect whether they are behind.
    chain_tip = None
    if isinstance(last_block, dict):
        chain_tip = {
            "block_index": last_block.get("block_index"),
            "hash": last_block.get("hash"),
            "previous_hash": last_block.get("previous_hash"),
        }
    # Return the full payload sent back to the client.
    # Note: confirmed is empty for now; confirmations will later be
    # derived strictly from verified blocks.
    return {
        "version": 1,
        "deviceId": "station_local",
        "crisisId": station_state.get("crisisId"),
        "generatedAt": now_ms,
        "chain_tip": chain_tip,
        "blocks": blocks,
        "queued": db_list_queued(limit=MAX_QUEUED_PER_PAYLOAD),
        # Keep empty for now unless you want to persist “hint confirmations”
        "confirmed": {},
    }

# Initialize station database and load persisted crisisId
init_station_db()
station_state["crisisId"] = db_get_meta("crisisId")


# Connection test
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"role": "station", "status": "ok"}), 200


# Offline queue stored on station/device
#
# Clients send relay_hashes only (no message bodies).
# Station replies with:
# - missing_relay_hashes: which messages the station does not have
# - confirmed: any relay_hash already confirmed (hints for pruning)
#
# This prevents duplicate uploads and reduces bandwidth/CPU usage.
@app.route("/mesh/inventory", methods=["POST"])
def mesh_inventory():
    incoming = request.get_json(force=True, silent=True) or {}

    ok, err = ensure_crisis_id(incoming.get("crisisId"))
    if not ok:
        return jsonify({"error": err}), 400

    relay_hashes = incoming.get("relay_hashes") or []
    if not isinstance(relay_hashes, list):
        return jsonify({"error": "relay_hashes must be a list"}), 400

    relay_hashes = relay_hashes[:RELAY_HASH_CAP]
    relay_hashes = [
        rh for rh in relay_hashes if isinstance(rh, str) and rh.strip()
    ]

    known = get_known_relay_hashes()
    missing_relay_hashes = [rh for rh in relay_hashes if rh not in known]

    # If you later persist confirmed hints, replace {} with db lookup.
    confirmed = db_get_confirmed_many(relay_hashes)

    return jsonify(
        {
            "crisisId": station_state.get("crisisId"),
            "missing_relay_hashes": missing_relay_hashes,
            "confirmed": confirmed,
        }
    ), 200

# Clients send full message bodies (queued + blocks).
# Station:
# - sanitizes payload
# - stores new queued messages
# - stores blocks (verification added later)
# - returns current station state
@app.route("/mesh/sync", methods=["POST"])
def mesh_sync():
    incoming = request.get_json(force=True, silent=True) or {}

    ok, err = ensure_crisis_id(incoming.get("crisisId"))
    if not ok:
        return jsonify({"error": err}), 400

    incoming_queued, incoming_confirmed = sanitize_sync_payload_server(incoming)

    # Optional: store “confirmed hints” (untrusted) to help prune duplicates.
    for relay_hash, info in incoming_confirmed.items():
        db_put_confirmed(relay_hash, info)

    # Store only new queued messages
    for msg in incoming_queued:
        rh = msg.get("relay_hash")
        if not rh:
            continue
        if db_is_confirmed(rh) or db_is_queued(rh):
            continue
        db_put_queued(msg)

    # Store blocks as-is for now (verification later)
    incoming_blocks = incoming.get("blocks") or []
    if isinstance(incoming_blocks, list):
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
            db_put_block(b)

    payload = export_station_payload()
    return jsonify(payload), 200

# When internet connectivity is available, the station:
# - posts queued messages to the central backend
# - deletes them locally only after a successful 201 response
#
# This simulates delayed delivery from offline locations.
@app.route("/station/flush", methods=["POST"])
def station_flush():
    # Load queued messages from persistent storage (SQLite) not from in-memory state, so this survives restarts.
    queued = db_list_queued(limit=MAX_QUEUED_PER_PAYLOAD)
    
    # Only attempt to flush messages still marked as "pending".
    pending = [m for m in queued if m.get("status") == "pending"]
    # If there is nothing to send, exit early.
    if not pending:
        return jsonify({"status": "ok", "message": "No pending messages"}), 200

    success = 0
    failed = 0
    errors = []

    for msg in pending:
        # relay_hash uniquely identifies this message across the mesh
        relay_hash = msg.get("relay_hash")
        
        # POST the queued message to the central backend, the dev rate override allows bulk replay during testing.
        try:
            url = f"{CENTRAL_URL}/transaction"
            headers = {
                "Content-Type": "application/json",
                "X-Dev-Rate-Override": "true",
            }
            resp = requests.post(url, json=msg, headers=headers, timeout=5)

            if resp.status_code == 201:
                # Backend accepted the message, now safely remove it from the station queue.
                success += 1
                if isinstance(relay_hash, str) and relay_hash:
                    db_delete_queued(relay_hash)
            else:
                # Backend rejected the message; keep it queued.
                failed += 1
                errors.append(
                    f"{relay_hash}: HTTP {resp.status_code} {resp.text}"
                )
        except Exception as e:
            failed += 1
            errors.append(f"{relay_hash}: {relay_hash}: {e}")
    
    # Return a summary so operators / UI can see what happened.
    return jsonify(
        {
            "status": "ok",
            "central_url": CENTRAL_URL,
            "attempted": len(pending),
            "success": success,
            "failed": failed,
            "errors": errors,
        }
    ), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
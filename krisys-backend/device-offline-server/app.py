# krisys-backend/device-offline-server/app.py
import os
import time
from flask import Flask, jsonify, request
from flask_cors import CORS
import requests

app = Flask(__name__)

# DEV CORS: allow frontend at localhost:3000 to call station APIs
CORS(app, origins=["http://localhost:3000"])

# Simple in-memory mesh store for this station (DEV ONLY).
# In production, this would likely be backed by SQLite under /app/data.
station_state = {
    "queued": [],    # list of normalized pending messages
    "confirmed": {}  # relay_hash -> info
}

# Limits (mirroring the frontend's DisasterStorage limits)
MAX_QUEUED_PER_PAYLOAD = 100
MAX_CONFIRMED_PER_PAYLOAD = 500
MAX_PER_ORIGIN = 50
MAX_MESSAGE_LENGTH = 8192
MAX_ADDRESSES_PER_TX = 16
MAX_ADDRESS_LENGTH = 128
MAX_STATION_ADDRESS_LENGTH = 128
MAX_TYPE_FIELD_LENGTH = 32

# Central backend URL from station's perspective (inside docker network)
CENTRAL_URL = os.environ.get("CENTRAL_API_URL", "http://backend:5000")


def sanitize_sync_payload_server(payload):
    """
    Server-side sanitization of a sync payload from a client.

    Returns:
        (sanitized_queued, sanitized_confirmed)
    where:
        - sanitized_queued is a list of normalized pending messages.
        - sanitized_confirmed is a dict relay_hash -> info.
    """
    if not isinstance(payload, dict):
        return [], {}

    raw_queued = payload.get("queued") or []
    raw_confirmed = payload.get("confirmed") or {}

    if not isinstance(raw_queued, list):
        raw_queued = []
    if not isinstance(raw_confirmed, dict):
        raw_confirmed = {}

    now_ms = int(time.time() * 1000)
    one_day_ms = 24 * 60 * 60 * 1000

    sanitized_queued = []
    per_origin_count = {}

    # Build a set of relay_hash values already known by the station
    existing_relay_hashes = set()
    for q in station_state["queued"]:
        rh = q.get("relay_hash")
        if isinstance(rh, str) and rh:
            existing_relay_hashes.add(rh)
    for rh in station_state["confirmed"].keys():
        if isinstance(rh, str) and rh:
            existing_relay_hashes.add(rh)

    def is_string(v):
        return isinstance(v, str)

    def clamp_length(s, max_len):
        return s if len(s) <= max_len else s[:max_len]

    # 1) Sanitize queued messages
    for msg in raw_queued:
        if not isinstance(msg, dict):
            continue
        if len(sanitized_queued) >= MAX_QUEUED_PER_PAYLOAD:
            break

        relay_hash = msg.get("relay_hash")
        if not is_string(relay_hash) or not relay_hash.strip():
            continue

        # Skip if relay_hash already known to station (either queued or confirmed)
        if relay_hash in existing_relay_hashes:
            continue

        # Per-origin quota
        origin = msg.get("origin_device")
        if not is_string(origin) or not origin:
            origin = "unknown"
        per_origin_count[origin] = per_origin_count.get(origin, 0) + 1
        if per_origin_count[origin] > MAX_PER_ORIGIN:
            continue

        # Basic type/shape checks
        ts = msg.get("timestamp_created")
        try:
            ts = float(ts)
        except (TypeError, ValueError):
            continue
        ts_ms = int(ts * 1000)
        if ts_ms < 0 or ts_ms > now_ms + one_day_ms:
            continue

        priority = msg.get("priority_level")
        try:
            priority = int(priority)
        except (TypeError, ValueError):
            continue
        if priority < 1 or priority > 5:
            continue

        station_addr = msg.get("station_address")
        if not is_string(station_addr):
            continue

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

        normalized = {
            "relay_hash": relay_hash,
            "timestamp_created": ts,
            "station_address": clamp_length(
                station_addr, MAX_STATION_ADDRESS_LENGTH
            ),
            "message_data": message_data,
            "related_addresses": clean_related,
            "type_field": type_field,
            "priority_level": priority,
            "origin_device": origin,
            # Preserve attempts/status/queuedAt if present, with defaults
            "status": msg.get("status") or "pending",
            "attempts": (
                msg["attempts"]
                if isinstance(msg.get("attempts"), (int, float))
                else 0
            ),
            "queuedAt": (
                msg["queuedAt"]
                if isinstance(msg.get("queuedAt"), (int, float))
                else now_ms
            ),
        }

        sanitized_queued.append(normalized)

    # 2) Sanitize confirmed-relay map (lightly)
    sanitized_confirmed = {}
    confirmed_items = list(raw_confirmed.items())
    for i, (relay_hash, info) in enumerate(confirmed_items):
        if i >= MAX_CONFIRMED_PER_PAYLOAD:
            break
        if not is_string(relay_hash) or not relay_hash.strip():
            continue
        if not isinstance(info, dict):
            continue

        clean_info = dict(info)
        ca = clean_info.get("confirmedAt")
        if isinstance(ca, (int, float)):
            if ca < 0 or ca > now_ms + one_day_ms:
                clean_info.pop("confirmedAt", None)
        tp = clean_info.get("timestampPosted")
        if isinstance(tp, (int, float)):
            # timestampPosted in payload is in seconds; compare in seconds
            if tp < 0 or tp > (now_ms + one_day_ms) / 1000.0:
                clean_info.pop("timestampPosted", None)

        sanitized_confirmed[relay_hash] = clean_info

    return sanitized_queued, sanitized_confirmed


def export_station_payload():
    """
    Build a sync payload from the station's current state.

    Shape matches the client exportSyncPayload, but for now:
      - crisisId is None,
      - chain_tip and blocks are None/empty.
    """
    now_ms = int(time.time() * 1000)
    return {
        "version": 1,
        "deviceId": "station_local",  # later: env-configurable STATION_ID
        "crisisId": None,
        "generatedAt": now_ms,
        "chain_tip": None,
        "blocks": [],
        "queued": station_state["queued"],
        "confirmed": station_state["confirmed"],
    }


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"role": "station", "status": "ok"}), 200


@app.route("/mesh/sync", methods=["POST"])
def mesh_sync():
    """
    Station mesh sync endpoint.

    Client sends a sync payload (same schema as frontend exportSyncPayload).
    Station:
      1) sanitizes incoming queued + confirmed,
      2) merges into its own station_state,
      3) returns its own payload back to the client.
    """
    try:
        incoming = request.get_json(force=True, silent=True) or {}
    except Exception:
        incoming = {}

    # 1) Sanitize incoming payload (queued + confirmed)
    incoming_queued, incoming_confirmed = sanitize_sync_payload_server(
        incoming
    )

    # 2) Merge confirmed-relay map into station_state["confirmed"]
    for relay_hash, info in incoming_confirmed.items():
        existing = station_state["confirmed"].get(relay_hash)
        if not existing:
            station_state["confirmed"][relay_hash] = info
        else:
            # If both have confirmedAt, keep the earlier one
            existing_time = existing.get("confirmedAt") or float("inf")
            incoming_time = info.get("confirmedAt") or existing_time
            if incoming_time < existing_time:
                merged = dict(existing)
                merged.update(info)
                station_state["confirmed"][relay_hash] = merged

    # 3) Merge queued messages into station_state["queued"]
    known_relay_hashes = set(
        q.get("relay_hash") for q in station_state["queued"] if q.get("relay_hash")
    )
    known_relay_hashes.update(station_state["confirmed"].keys())

    for msg in incoming_queued:
        rh = msg.get("relay_hash")
        if not rh:
            continue
        if rh in known_relay_hashes:
            continue
        station_state["queued"].append(msg)
        known_relay_hashes.add(rh)

    # 4) Build station payload and return to client
    payload = export_station_payload()
    return jsonify(payload), 200


@app.route("/station/flush", methods=["POST"])
def station_flush():
    """
    Push station's queued messages to the central backend as real transactions.

    DEV ONLY: this is how we simulate "internet came back, station is now
    uploading all the messages it collected while offline".
    """
    # Filter pending messages
    pending = [
        msg for msg in station_state["queued"]
        if msg.get("status") == "pending"
    ]
    if not pending:
        return jsonify(
            {"status": "ok", "message": "No pending messages to flush"}
        ), 200

    success = 0
    failed = 0
    errors = []

    for msg in pending:
        relay_hash = msg.get("relay_hash")
        try:
            # Post to central /transaction with rate-limit override
            url = f"{CENTRAL_URL}/transaction"
            headers = {
                "Content-Type": "application/json",
                "X-Dev-Rate-Override": "true"
            }
            resp = requests.post(url, json=msg, headers=headers, timeout=5)
            if resp.status_code == 201:
                success += 1
                msg["status"] = "sent"
                # Do not mark as confirmed yet; canonical confirmation comes
                # when mined into a block, which the client will learn via
                # normal /blockchain or /wallet/..../transactions sync.
            else:
                failed += 1
                errors.append(
                    f"{relay_hash}: HTTP {resp.status_code} {resp.text}"
                )
        except Exception as e:
            failed += 1
            errors.append(f"{relay_hash}: {e}")

    # Optionally, we could prune 'sent' messages from station_state["queued"]
    station_state["queued"] = [
        msg for msg in station_state["queued"]
        if msg.get("status") != "sent"
    ]

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
    # DEV only
    app.run(host="0.0.0.0", port=5000, debug=True)
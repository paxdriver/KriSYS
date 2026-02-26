# database.py
import sqlite3
import os
from contextlib import contextmanager
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DB_PATH = os.getenv('BLOCKCHAIN_DB_PATH', 'app/blockchain.db')

@contextmanager
def db_connection():
	conn = sqlite3.connect(DB_PATH)
	conn.row_factory = sqlite3.Row  # Enable column access by name
	try:
		yield conn
	finally:
		conn.close()

def init_db():
	with db_connection() as conn:
		# ---- TABLES ----
		conn.execute('''
		CREATE TABLE IF NOT EXISTS blocks (
			id INTEGER PRIMARY KEY,
			block_index INTEGER NOT NULL,
			timestamp INTEGER NOT NULL,
			previous_hash TEXT NOT NULL,
			hash TEXT NOT NULL,
			nonce INTEGER DEFAULT 0,
			signature TEXT
		)
		''')

		conn.execute('''
		CREATE TABLE IF NOT EXISTS transactions (
			id INTEGER PRIMARY KEY,
			block_id INTEGER REFERENCES blocks(id),
			transaction_id TEXT UNIQUE NOT NULL,
			timestamp_created INTEGER NOT NULL,
			timestamp_posted INTEGER NOT NULL,
			station_address TEXT NOT NULL,
			message_data TEXT NOT NULL,
			related_addresses TEXT NOT NULL,
			relay_hash TEXT DEFAULT '',
			posted_id TEXT DEFAULT '',
			type_field TEXT NOT NULL,
			priority_level INTEGER NOT NULL
		)
		''')
		
		# Add wallets table
		conn.execute('''
		CREATE TABLE IF NOT EXISTS wallets (
			id INTEGER PRIMARY KEY,
			family_id TEXT UNIQUE NOT NULL,
			members TEXT NOT NULL,  -- JSON array of members
			devices TEXT DEFAULT '[]',  -- Store as JSON array
			created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
			crisis_id TEXT NOT NULL
		)
		''')
		
		# Add particular crisis details tables
		conn.execute('''
		CREATE TABLE IF NOT EXISTS crises (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			organization TEXT,
			contact TEXT,
			description TEXT,
			created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER))
		)
		''')
		
		# Add keypairs lookup table, with private keys salted by users' passphrase to unlock and decrypt personal messages locally
		conn.execute('''
		CREATE TABLE IF NOT EXISTS wallet_keys (
			id INTEGER PRIMARY KEY,
			family_id TEXT UNIQUE NOT NULL REFERENCES wallets(family_id),
			encrypted_private_key TEXT NOT NULL,  -- Encrypted with user passphrase
			public_key TEXT NOT NULL,             -- For others to encrypt messages sent to this wallet
			created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER))
		)
		''')
		
		# Add stations table for verified check-in stations like food trucks, hospitals, etc.
		conn.execute('''
		CREATE TABLE IF NOT EXISTS stations (
			id INTEGER PRIMARY KEY,
			crisis_id TEXT NOT NULL,
			station_id TEXT NOT NULL,

			name TEXT,
			type TEXT,
			location TEXT,

			-- One-time activation (pending state)
			registration_code_hash TEXT,	-- hash of activation passphrase

			-- Long-term identity (active state)
			api_key_hash TEXT,				-- hash of station API key

			-- Lifecycle
			status TEXT DEFAULT 'pending', -- pending | active | revoked (future)

			-- Audit / metadata
			activated_device_id TEXT,		-- device UUID that activated this station
			activated_at INTEGER,			-- unix seconds when activated
			last_seen_at INTEGER,			-- heartbeat liveness tracking for telemetry of stations in service
			created_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER)),

			UNIQUE(crisis_id, station_id),
			UNIQUE(registration_code_hash)
		)
		''')

		# ---- INDEXING ----
		# Idempotency guard: relay_hash should uniquely identify an offline tx across all time. We allow empty relay_hash for legacy/system txs
		conn.execute('''
		CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_relay_hash_unique
		ON transactions(relay_hash)
		WHERE relay_hash IS NOT NULL AND relay_hash != ''
		''')

		# Speed up lookups by block (essential for syncing)
		conn.execute('''
		CREATE INDEX IF NOT EXISTS idx_transactions_block_id 
		ON transactions(block_id)
		''')

		# Speed up mining selection (sorting by priority/time)
		conn.execute('''
		CREATE INDEX IF NOT EXISTS idx_transactions_mining 
		ON transactions(priority_level ASC, timestamp_created ASC)
		''')

		# ADMIN TELEMETRY TABLE
		# Stores structured operational events from:
		# - HQ backend
		# - Stations
		# - Relays
		#
		# IMPORTANT:
		# - This table is NOT consensus-critical.
		# - It does NOT influence blockchain validity.
		# - It is purely operational/observability.
		#
		# Design goals:
		# - Structured (no free-text logs)
		# - Filterable (severity, source, event_type)
		# - Time-ordered
		# - Bounded via retention policy

		conn.execute('''
		CREATE TABLE IF NOT EXISTS admin_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,

			-- Where event originated
			source TEXT NOT NULL,            -- backend | station | relay

			-- Node identifier (station_id, deviceId, etc.)
			node_id TEXT,

			-- Severity classification
			severity TEXT NOT NULL,          -- info | warning | error | critical

			-- Machine-readable event type
			event_type TEXT NOT NULL,        -- storage_pressure | identity_rejected | mining_error

			-- Optional structured context (JSON string)
			context_json TEXT,

			-- Unix timestamp (seconds)
			created_at INTEGER NOT NULL
		)
		''')

		# INDEXES FOR FAST FILTERING
		# Filter by severity quickly
		conn.execute('''
		CREATE INDEX IF NOT EXISTS idx_admin_events_severity
		ON admin_events(severity)
		''')

		# Filter by event_type
		conn.execute('''
		CREATE INDEX IF NOT EXISTS idx_admin_events_event_type
		ON admin_events(event_type)
		''')

		# Filter by time (most common query)
		conn.execute('''
		CREATE INDEX IF NOT EXISTS idx_admin_events_created_at
		ON admin_events(created_at DESC)
		''')

		conn.commit()
		
if __name__ == "__main__":
	raise RuntimeError('This script should never be called directly, it offers helper functions to be imported by other scripts in this project.')
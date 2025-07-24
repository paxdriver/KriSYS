# database.py
import sqlite3
import os
from contextlib import contextmanager

DB_PATH = os.getenv('BLOCKCHAIN_DB_PATH', 'blockchain/blockchain.db')

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
        conn.execute('''
        CREATE TABLE IF NOT EXISTS blocks (
            id INTEGER PRIMARY KEY,
            block_index INTEGER NOT NULL,
            timestamp REAL NOT NULL,
            previous_hash TEXT NOT NULL,
            hash TEXT NOT NULL,
            nonce INTEGER DEFAULT 0
        )
        ''')
        
        conn.execute('''
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY,
            block_id INTEGER REFERENCES blocks(id),
            transaction_id TEXT UNIQUE NOT NULL,
            timestamp_created REAL NOT NULL,
            timestamp_posted REAL NOT NULL,
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
            created_at REAL DEFAULT (strftime('%s', 'now'))
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
            created_at REAL DEFAULT (strftime('%s', 'now'))
        )
        ''')
        
if __name__ == "__main__":
    raise RuntimeError('This script should never be called directly, it offers helper functions to be imported by other scripts in this project.')
import hashlib
import json
import time
from datetime import datetime, timedelta
from typing import List, Dict, Optional
from database import init_db, db_connection

# DEV NOTE: POLICY will define many parameters to be tailored by the crisis management host and blockchain maintainer, things like class priority of transactions (org, user, warnings, alert, etc)
POLICY = {}
POLICY['block_interval'] = 180  # 3 minutes in seconds

class Transaction:
    def __init__(
        self,
        timestamp_created: float,
        station_address: str,
        message_data: str,
        related_addresses: List[str],
        type_field: str,
        priority_level: int,
        transaction_id: Optional[str] = None,
        relay_hash: str = "",
        posted_id: str = "",
        timestamp_posted: Optional[float] = None
    ):
        self.transaction_id = transaction_id or self.generate_id(timestamp_created, station_address)
        self.timestamp_created = timestamp_created
        self.timestamp_posted = timestamp_posted or time.time()
        self.station_address = station_address
        self.message_data = message_data
        self.related_addresses = related_addresses
        self.relay_hash = relay_hash
        self.posted_id = posted_id
        self.type_field = type_field
        self.priority_level = priority_level

    @staticmethod
    def generate_id(timestamp: float, address: str) -> str:
        return hashlib.sha256(f"{timestamp}{address}".encode()).hexdigest()

    def to_dict(self) -> Dict:
        return self.__dict__

class Block:
    def __init__(
        self,
        index: int,
        timestamp: float,
        transactions: List[Transaction],
        previous_hash: str,
        nonce: int = 0  # Not used for mining, just structure
    ):
        self.index = index
        self.timestamp = timestamp
        self.transactions = transactions
        self.previous_hash = previous_hash
        self.nonce = nonce
        self.hash = self.calculate_hash()

    def calculate_hash(self) -> str:
        block_data = json.dumps({
            "index": self.index,
            "timestamp": self.timestamp,
            "transactions": [tx.to_dict() for tx in self.transactions],
            "previous_hash": self.previous_hash,
            "nonce": self.nonce
        }, sort_keys=True)
        return hashlib.sha256(block_data.encode()).hexdigest()

class Blockchain:
    def __init__(self):
        self.chain: List[Block] = []
        self.pending_transactions: List[Transaction] = []
        self.create_genesis_block()
        self.block_interval = POLICY['block_interval'] 
        
        init_db()
        if not self.chain:  # Load existing chain
            self.load_chain()
    
    # DEV NOTE: WIP
    def load_chain(self):
        with db_connection() as conn:
            # Load blocks and transactions from DB
            pass # Implementation details
        
        
    # DEV NOTE: WIP
    def save_block(self, block):
        with db_connection() as conn:
            # Save block and transactions to dB
            pass # Implementation details

    def create_genesis_block(self):
        genesis = Block(0, time.time(), [], "0")
        self.chain.append(genesis)

    def add_transaction(self, transaction: Transaction):
        # Deduplication by transaction_id
        if not any(tx.transaction_id == transaction.transaction_id 
                   for tx in self.pending_transactions):
            self.pending_transactions.append(transaction)

    def mine_block(self) -> Block:
        last_block = self.chain[-1]
        new_block = Block(
            index = last_block.index + 1,
            timestamp = time.time(),
            transactions = self.pending_transactions,
            previous_hash = last_block.hash
        )
        self.pending_transactions = []
        self.chain.append(new_block)
        return new_block

    def validate_chain(self) -> bool:
        for i in range(1, len(self.chain)):
            current = self.chain[i]
            previous = self.chain[i-1]
            if current.hash != current.calculate_hash():
                return False
            if current.previous_hash != previous.hash:
                return False
        return True

# Admin validation scheduler (pseudo-code)
def block_miner_scheduler(blockchain: Blockchain):
    while True:
        time.sleep(blockchain.block_interval)
        if blockchain.pending_transactions:
            blockchain.mine_block()
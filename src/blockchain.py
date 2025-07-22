import hashlib
import json
import time
from datetime import datetime, timedelta
import threading
import logging
from typing import List, Dict, Optional
from database import init_db, db_connection

# DEV NOTE: POLICY will define many parameters to be tailored by the crisis management host and blockchain maintainer, things like class priority of transactions (org, user, warnings, alert, etc)
# Policy configuration
POLICY = {
    'block_interval': 180,  # 3 minutes in seconds
    'max_tx_size': 5120,    # 5KB in bytes
    'tx_rate_limit': 180    # 3 minutes in seconds
}

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


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
        return {
            "transaction_id": self.transaction_id,
            "timestamp_created": self.timestamp_created,
            "timestamp_posted": self.timestamp_posted,
            "station_address": self.station_address,
            "message_data": self.message_data,
            "related_addresses": self.related_addresses,
            "relay_hash": self.relay_hash,
            "posted_id": self.posted_id,
            "type_field": self.type_field,
            "priority_level": self.priority_level
        }

class Block:
    def __init__(
        self,
        block_index: int,
        timestamp: float,
        transactions: List[Transaction],
        previous_hash: str,
        nonce: int = 0
    ):
        self.block_index = block_index
        self.timestamp = timestamp
        self.transactions = transactions
        self.previous_hash = previous_hash
        self.nonce = nonce
        self.hash = self.calculate_hash()

    def calculate_hash(self) -> str:
        block_data = json.dumps({
            "block_index": self.block_index,
            "timestamp": self.timestamp,
            "transactions": [tx.to_dict() for tx in self.transactions],
            "previous_hash": self.previous_hash,
            "nonce": self.nonce
        }, sort_keys=True)
        return hashlib.sha256(block_data.encode()).hexdigest()

    def to_dict(self) -> Dict:
        return {
            "block_index": self.block_index,
            "timestamp": self.timestamp,
            "transactions": [tx.to_dict() for tx in self.transactions],
            "previous_hash": self.previous_hash,
            "hash": self.hash,
            "nonce": self.nonce
        }

class Blockchain:
    def __init__(self):
        self.chain: List[Block] = []
        self.pending_transactions: List[Transaction] = []
        self.block_interval = POLICY['block_interval']
        
        # Initialize database
        init_db()
        
        # Load existing chain or create genesis
        if not self.load_chain():
            self.create_genesis_block()
        
        # Start automatic background miner (DEV NOTE: set by the blockchain host's POLICY at initalization)
        self.miner_thread = threading.Thread(target=self.miner_loop, daemon=True)
        self.miner_thread.start()
    
    def load_chain(self) -> bool:
        """Load blockchain from database, return True if successful"""
        try:
            with db_connection() as conn:
                # Load blocks
                blocks = conn.execute(
                    'SELECT * FROM blocks ORDER BY block_index'
                ).fetchall()
                
                if not blocks:
                    return False
                
                for db_block in blocks:
                    # Load transactions for this block
                    transactions_data = conn.execute(
                        'SELECT * FROM transactions WHERE block_id = ?',
                        (db_block['id'],)
                    ).fetchall()
                    
                    transactions = []
                    for tx_data in transactions_data:
                        tx = Transaction(
                            timestamp_created=tx_data['timestamp_created'],
                            station_address=tx_data['station_address'],
                            message_data=tx_data['message_data'],
                            related_addresses=tx_data['related_addresses'].split(','),
                            type_field=tx_data['type_field'],
                            priority_level=tx_data['priority_level'],
                            transaction_id=tx_data['transaction_id'],
                            relay_hash=tx_data['relay_hash'],
                            posted_id=tx_data['posted_id'],
                            timestamp_posted=tx_data['timestamp_posted']
                        )
                        transactions.append(tx)
                    
                    block = Block(
                        block_index=db_block['block_index'],
                        timestamp=db_block['timestamp'],
                        transactions=transactions,
                        previous_hash=db_block['previous_hash'],
                        nonce=db_block['nonce']
                    )
                    # Override calculated hash with stored hash
                    block.hash = db_block['hash']
                    self.chain.append(block)
                
                logger.info(f"Loaded {len(self.chain)} blocks from database")
                return True
                
        except Exception as e:
            logger.error(f"Error loading chain: {str(e)}")
            return False

    def save_block(self, block: Block):
        """Save block to database"""
        with db_connection() as conn:
            # Save block
            cur = conn.execute(
                '''
                INSERT INTO blocks 
                (block_index, timestamp, previous_hash, hash, nonce) 
                VALUES (?, ?, ?, ?, ?)
                ''',
                (
                    block.block_index,
                    block.timestamp,
                    block.previous_hash,
                    block.hash,
                    block.nonce
                )
            )
            block_id = cur.lastrowid
            
            # Save transactions
            for tx in block.transactions:
                conn.execute(
                    '''
                    INSERT INTO transactions 
                    (block_id, transaction_id, timestamp_created, timestamp_posted, 
                     station_address, message_data, related_addresses, 
                     relay_hash, posted_id, type_field, priority_level) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''',
                    (
                        block_id,
                        tx.transaction_id,
                        tx.timestamp_created,
                        tx.timestamp_posted,
                        tx.station_address,
                        tx.message_data,
                        ','.join(tx.related_addresses),
                        tx.relay_hash,
                        tx.posted_id,
                        tx.type_field,
                        tx.priority_level
                    )
                )
            conn.commit()
            logger.info(f"Saved block #{block.block_index} to database")

    def create_genesis_block(self):
        """Create and save the genesis block"""
        genesis = Block(
            block_index=0,
            timestamp=time.time(),
            transactions=[],
            previous_hash="0"
        )
        self.chain.append(genesis)
        self.save_block(genesis)
        logger.info("Created genesis block")

    def add_transaction(self, transaction: Transaction):
        """Add transaction with POLICY enforcement"""
        # POLICY: Size check (5KB max)
        tx_size = len(json.dumps(transaction.to_dict()))
        if tx_size > POLICY['max_tx_size']:
            raise ValueError(
                f"Transaction exceeds size limit ({tx_size}/{POLICY['max_tx_size']} bytes)"
            )
        
        # POLICY: Deduplication
        if any(tx.transaction_id == transaction.transaction_id 
               for tx in self.pending_transactions):
            raise ValueError("Duplicate transaction ID")
        
        # POLICY: Rate limiting (1 tx per station per block interval)
        recent_txs = [
            tx for tx in self.pending_transactions 
            if tx.station_address == transaction.station_address
            and (time.time() - tx.timestamp_created) < POLICY['tx_rate_limit']
        ]
        
        if recent_txs:
            raise ValueError(
                f"Only one transaction per station every {POLICY['tx_rate_limit']} seconds"
            )
        
        self.pending_transactions.append(transaction)
        logger.info(f"Added transaction: {transaction.transaction_id}")

    def mine_block(self) -> Block:
        """Create new block with pending transactions"""
        if not self.pending_transactions:
            raise ValueError("No transactions to mine")
            
        last_block = self.chain[-1]
        new_block = Block(
            block_index=last_block.block_index + 1,
            timestamp=time.time(),
            transactions=self.pending_transactions.copy(),
            previous_hash=last_block.hash
        )
        self.pending_transactions = []
        self.chain.append(new_block)
        logger.info(f"Mined block #{new_block.block_index}")
        return new_block

    # Automatic block mining
    def mine_and_save(self):
        """Mine block and persist to database"""
        if self.pending_transactions:
            block = self.mine_block()
            self.save_block(block)

    def miner_loop(self):
        """Background thread for automatic block mining"""
        while True:
            time.sleep(self.block_interval)
            try:
                self.mine_and_save()
            except Exception as e:
                logger.error(f"Mining error: {str(e)}")

    def validate_chain(self) -> bool:
        """Validate blockchain integrity"""
        for i in range(1, len(self.chain)):
            current = self.chain[i]
            previous = self.chain[i-1]
            
            # Recalculate hash to verify
            if current.hash != current.calculate_hash():
                logger.error(f"Block #{current.block_index} hash mismatch")
                return False
                
            # Verify chain linkage
            if current.previous_hash != previous.hash:
                logger.error(
                    f"Block #{current.block_index} invalid previous hash"
                )
                return False
                
        return True
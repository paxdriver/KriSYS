# blockchain.py
import hashlib
import json
import time
from datetime import datetime, timedelta
import pgpy
from pgpy.constants import PubKeyAlgorithm, KeyFlags, HashAlgorithm, SymmetricKeyAlgorithm
import threading
import secrets
from typing import List, Dict, Optional
from database import init_db, db_connection
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# DEV NOTE: POLICY will define many parameters to be tailored by the crisis management host and blockchain maintainer, things like class priority of transactions (org, user, warnings, alert, etc)
# Policy configuration
# blockchain.policy_system.policies['earthquake'] = {
#     'block_interval': 120,  # 2 minutes for high urgency
#     'size_limit': 10240,    # 10KB for detailed reports
#     'rate_limit': 60,       # 1 minute between messages
#     # ... other parameters ...
# }
# blockchain.policy_system.current_policy = 'earthquake'
# POLICY = {
#     'block_interval': 180,  # 3 minutes in seconds
#     'max_tx_size': 5120,    # 5KB in bytes
#     'tx_rate_limit': 180    # 3 minutes in seconds
# }

# Policy system for setting up a new KriSYS blockchain
class PolicySystem:
    def __init__(self):
        self.policies = {
            'default': {
                'name': "Default Crisis Policy",
                'id': "default",
                'created_at': datetime.now().isoformat(),
                'organization': "KriSYS Foundation",
                'contact': "support@krisys.org",
                'description': "Standard policy for crisis response",
                'policy': {
                    'block_interval': 180,
                    'size_limit': 5120,
                    'rate_limit': 180,
                    'priority_levels': {
                        'medical': 1,
                        'food': 2,
                        'shelter': 3,
                        'personal': 4
                    },
                    'types': ['check_in', 'message', 'alert']
                }
            }
        }
        self.current_policy = 'default'
    
    def create_crisis_policy(self, name, organization, contact, description, policy_settings):
        """Create a new crisis-specific policy"""
        policy_id = name.lower().replace(" ", "_")
        self.policies[policy_id] = {
            'name': name,
            'id': policy_id,
            'created_at': datetime.now().isoformat(),
            'organization': organization,
            'contact': contact,
            'description': description,
            'policy': policy_settings
        }
        return policy_id
    
    def get_policy(self, name=None):
        policy_id = name or self.current_policy
        return self.policies.get(policy_id, self.policies['default'])
    
    def validate_transaction(self, transaction):
        policy = self.get_policy()['policy']
        
        # Type validation
        if transaction.type_field not in policy['types']:
            raise ValueError(f"Invalid transaction type: {transaction.type_field}")
        
        # Size validation
        tx_size = len(json.dumps(transaction.to_dict()))
        if tx_size > policy['size_limit']:
            raise ValueError(f"Transaction exceeds size limit ({tx_size}/{policy['size_limit']} bytes)")
        
        # Priority validation
        valid_priorities = policy['priority_levels'].values()
        if transaction.priority_level not in valid_priorities:
            raise ValueError(f"Invalid priority level: {transaction.priority_level}")
        
        return True

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
        
class Wallet:
    def __init__(self, family_id):
        self.family_id = family_id
        self.auth = WalletAuth()
        self.keypair = self.auth.generate_keypair()
        self.keypair_str = str(self.keypair)
        self.members = []
        self.devices = []
    
    def add_member(self, name):
        """Add new family member"""
        member_id = f"{self.family_id}-{secrets.token_hex(4)}"
        keypair = self.auth.generate_keypair()
        keypair_str = str(keypair)
        self.members.append({
            "id": member_id,
            "name": name,
            "address": member_id,
            "keypair": keypair_str
        })
        return member_id
    
    def register_device(self, device_id, public_key):
        """Register new device for wallet access"""
        
        # Ensure we have a public key
        if not public_key.is_public:
            public_key = public_key.pubkey
        
        # Create device object
        public_key_str = str(public_key)
        device = {
            "device_id": device_id,
            "public_key": public_key_str,
            "registered_at": time.time()
        }
        
        # Encrypt credentials
        creds = pgpy.PGPMessage.new(json.dumps({
            "wallet_id": self.family_id,
            "access_level": "full"
        }))
        encrypted_creds = public_key.encrypt(creds)
        device["encrypted_creds"] = str(encrypted_creds)
        
        # Store device
        self.devices.append(device)
        return public_key_str
        # return encrypted_creds

class WalletManager:
    def __init__(self):
        """Initialize wallet manager with in-memory cache"""
        self.wallets = {}  # In-memory cache: family_id -> Wallet object
    
    def create_wallet(self, family_id, members):
        """
        Create a new wallet and store in database
        :param family_id: Unique family identifier
        :param members: List of member objects (each with 'name')
        :return: Wallet object
        """
        # Create wallet instance
        wallet = Wallet(family_id)
        
        # Add members to wallet
        for member in members:
            wallet.add_member(member['name'])
        
        # Save to database
        with db_connection() as conn:
            # Convert members to serializable format
            serializable_members = [{
                "id": m["id"],
                "name": m["name"],
                "address": m["address"],
                "keypair_str": m["keypair"]
            } for m in wallet.members]
            # Convert devices to serializable format
            serializable_devices = [{
                "device_id": d["device_id"],
                "public_key_str": d["public_key"],
                "registered_at": d["registered_at"]
            } for d in wallet.devices]
            
            conn.execute(
                "INSERT INTO wallets (family_id, members, devices) VALUES (?, ?, ?)",
                (family_id, 
                 json.dumps(serializable_members),
                 json.dumps(serializable_devices))
            )
            conn.commit()
        
        # Cache in memory
        self.wallets[family_id] = wallet
        return wallet
    
    def get_wallet(self, family_id):
        """
        Retrieve wallet by family ID
        :param family_id: Family identifier to retrieve
        :return: Wallet object or None if not found
        """
        # First check in-memory cache
        if family_id in self.wallets:
            return self.wallets[family_id]
        
        # Then check database
        with db_connection() as conn:
            row = conn.execute(
                "SELECT * FROM wallets WHERE family_id = ?",
                (family_id,)
            ).fetchone()
            
            if row:
                # Reconstruct wallet from database
                wallet = Wallet(row['family_id'])
                wallet.members = json.loads(row['members'])
                wallet.devices = json.loads(row.get('devices', '[]'))
                
                # Add to cache
                self.wallets[family_id] = wallet
                return wallet
        
        return None
    
    def add_device_to_wallet(self, family_id, device_id, public_key):
        """
        Register a new device for a wallet
        :param family_id: Family identifier
        :param device_id: Unique device identifier
        :param public_key: Device's public key
        :return: True if successful, False otherwise
        """
        wallet = self.get_wallet(family_id)
        if not wallet:
            return False
        
        # Add device to wallet
        encrypted_creds = wallet.register_device(device_id, public_key)
        
        # Update database
        with db_connection() as conn:
            conn.execute(
                "UPDATE wallets SET devices = ? WHERE family_id = ?",
                (json.dumps(wallet.devices), family_id)
            )
            conn.commit()
        
        return True
    
    def delete_wallet(self, family_id):
        """Delete wallet by family ID"""
        # Remove from cache
        if family_id in self.wallets:
            del self.wallets[family_id]

        # Delete from database
        with db_connection() as conn:
            conn.execute(
                "DELETE FROM wallets WHERE family_id = ?",
                (family_id,)
            )
            conn.commit()

class Blockchain:
    def __init__(self, policy_system=None):
        self.policy_system = policy_system or PolicySystem()    # Use provided policy or default if none provided
        self.chain: List[Block] = []
        self.pending_transactions: List[Transaction] = []
        self.policy_system = PolicySystem()
        self.wallets = WalletManager()
        
        # Get policy values from PolicySystem
        
        # policy_data = self.policy_system.get_policy()
        # policy_settings = policy_data['policy']
        policy_settings = self.policy_system.get_policy()['policy']
        self.block_interval = policy_settings['block_interval']
        self.max_tx_size = policy_settings['size_limit']
        self.tx_rate_limit = policy_settings['rate_limit']
        
        init_db()       # Initialize database
        
        if not self.load_chain():   # Load existing chain or create genesis block for new blockchain
            self.create_genesis_block()
        
        # Start automatic background miner
        self.miner_thread = threading.Thread(target=self.miner_loop, daemon=True)
        self.miner_thread.start()
    
    def add_transaction(self, transaction: Transaction):
        """Add transaction with policy enforcement"""
        
        # Get current policy settings
        policy_config = self.policy_system.get_policy()['policy']
        ############# DEVELOPMENT ONLY ################
        if policy_config: 
            for item in policy_config:
                logger.info(f'{item}: {policy_config[item]}')
                logger.info('-'*20)
        ############################################
        
        # 1. Validate transaction against policy
        self.policy_system.validate_transaction(transaction)
        
        # 2. Size check
        tx_size = len(json.dumps(transaction.to_dict()))
        if tx_size > self.max_tx_size:
            raise ValueError(
                f"Transaction exceeds size limit ({tx_size}/{self.max_tx_size} bytes)"
            )
        
        # 3. Deduplication
        if any(tx.transaction_id == transaction.transaction_id 
               for tx in self.pending_transactions):
            raise ValueError("Duplicate transaction ID")
        
        # 4. Rate limiting
        recent_txs = [
            tx for tx in self.pending_transactions 
            if tx.station_address == transaction.station_address
            and (time.time() - tx.timestamp_created) < policy_config['rate_limit']
        ]
        if recent_txs:
            raise ValueError(
                f"Only one transaction per station every {policy_config['rate_limit']} seconds"
            )
        
        self.pending_transactions.append(transaction)
        logger.info(f"Added transaction: {transaction.transaction_id}")
        
    
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
            # time.sleep(self.block_interval)
            # Get current block interval from policy
            block_interval = self.policy_system.get_policy()['policy']['block_interval']
            time.sleep(block_interval)
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


# PGP key-pair system for blockchain msg obfuscation and for wallets to store labels and notes
    # Wallets to use PGP to authenticate transactions posted, and to decrypt messages received
    
    # sequenceDiagram
        # participant Client
        # participant Server
        # participant Blockchain
        # Client->>Server: Request challenge
        # Server->>Client: Send nonce
        # Client->>Client: Sign nonce with private key
        # Client->>Server: Send signed nonce + public key fingerprint
        # Server->>Blockchain: Retrieve public key by fingerprint
        # Blockchain->>Server: Return public key
        # Server->>Server: Verify signature
        # Server->>Client: Auth token if valid
class PGPAuth:
    def __init__(self):
        self.keys = {}
    
    def generate_keypair(self, passphrase=None):
        """Generate PGP key pair for a wallet"""
        key = pgpy.PGPKey.new(PubKeyAlgorithm.RSAEncryptOrSign, 4096)
        uid = pgpy.PGPUID.new('KriSYS User', comment='Auto-generated by KriSYS')
        key.add_uid(uid, usage={KeyFlags.Sign, KeyFlags.EncryptCommunications},
                    hashes=[HashAlgorithm.SHA256],
                    ciphers=[SymmetricKeyAlgorithm.AES256])
        
        if passphrase:
            key.protect(passphrase, SymmetricKeyAlgorithm.AES256, HashAlgorithm.SHA256)
        
        return key
    
    def sign_message(self, private_key, message, passphrase=None):
        """Sign a message with private key"""
        if passphrase:
            with private_key.unlock(passphrase):
                signature = private_key.sign(message)
        else:
            signature = private_key.sign(message)
        return signature
    
    def verify_signature(self, public_key, message, signature):
        """Verify message signature"""
        return public_key.verify(message, signature)    

# Wallet login to decrypt and make visible labels, messages and data related to addresses belonging to this group
class WalletAuth:
    def __init__(self):
        self.device_registry = {}  # device_id: encrypted_credentials
    
    def generate_keypair(self, passphrase=None):
        """Generate PGP key pair for wallet"""
        key = pgpy.PGPKey.new(PubKeyAlgorithm.RSAEncryptOrSign, 4096)
        uid = pgpy.PGPUID.new('KriSYS Wallet', comment='Auto-generated')
        key.add_uid(uid, usage={KeyFlags.Sign, KeyFlags.EncryptCommunications},
                    hashes=[HashAlgorithm.SHA256],
                    ciphers=[SymmetricKeyAlgorithm.AES256])
        
        if passphrase:
            key.protect(passphrase, SymmetricKeyAlgorithm.AES256, HashAlgorithm.SHA256)
        
        return key
    
    def register_device(self, device_id, public_key, encrypted_creds):
        """Register trusted device"""
        self.device_registry[device_id] = {
            'public_key': public_key,
            'creds': encrypted_creds
        }
    
    def authenticate(self, challenge, signature, device_id=None):
        """Authenticate using either device or password"""
        if device_id and device_id in self.device_registry:
            public_key = self.device_registry[device_id]['public_key']
            return public_key.verify(challenge, signature)
        return False
    
    def authenticate_with_password(self, password_hash):
        """Fallback password authentication"""
        # Compare with stored hash
        pass

######### WIP


######### WALLET DATA IMPLEMENTATION NOTES: ############
# app.py:
# 	- Uses blockchain.wallets.create_wallet() to create wallets
# 	- Uses blockchain.wallets.get_wallet() to retrieve wallets
# Blockchain:
# 	- Contains WalletManager instance as self.wallets
# 	- Delegates wallet operations to the wallet manager
# WalletManager:
# 	- Handles database persistence
# 	- Manages in-memory cache of wallets
# 	- Implements CRUD operations for wallets
# Wallet:
# 	- Represents a single family wallet
# 	- Contains members and devices
# 	- Handles business logic (adding members/devices)
# WalletAuth:
# 	- Handles authentication mechanisms
# 	- Manages device registration and credentials
# Database:
# 	- Provides connection management
# 	- Ensures proper table structure
# 	- Handles SQL execution
######### WALLET DATA IMPLEMENTATION NOTES: ############
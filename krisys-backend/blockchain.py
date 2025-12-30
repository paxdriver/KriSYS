# blockchain.py
import hashlib
import json
import time
from datetime import datetime, timedelta
import os
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

# PRODUCTION: Implement proper session storage for private keys

# Policy system for setting up a new KriSYS blockchain
class PolicySystem:
    # Required policy fields with default values
    REQUIRED_POLICY_FIELDS = {
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
    
    def __init__(self):
        self.policies = {}
        self.current_policy = "default"
        self._create_default_policy()   

    def _create_default_policy(self):
        """Create a base default policy"""
        self.policies['default'] = {
            'name': "Default Crisis Policy",
            'id': "default",
            'created_at': datetime.now().isoformat(),
            'organization': "KriSYS Foundation",
            'contact': "support@krisys.org",
            'description': "Standard policy for crisis response",
            'policy': self.REQUIRED_POLICY_FIELDS,
        }
    
    def create_crisis_policy(self, 
        name: str, organization: str, 
        contact: str, description: str, 
        policy_settings: dict, policy_id: Optional[str] = None):
        """
        Create a new crisis policy with custom settings
        - policy_id: Optional custom ID (auto-generated if not provided)
        - policy_settings: Partial settings (missing fields use defaults)
        - Returns: policy_id of created policy
        """
        
        # Generate unique ID if not provided
        if not policy_id:
            base_id = name.lower().replace(" ", "_")
            policy_id = base_id
            counter = 1
            while policy_id in self.policies:
                policy_id = f"{base_id}_{counter}"
                counter += 1
        
        # Merge defaults with provided custom policy details
        full_policy = self.REQUIRED_POLICY_FIELDS.copy()
        full_policy.update(policy_settings)
        
        # Create the complete policy object
        policy_data = {
            "name": name,
            "id": policy_id, 
            "organization": organization,
            "contact": contact,
            "description": description,
            "policy": full_policy,
            "created_at": datetime.now().isoformat(),
        }
        
        # Store the policy in the system
        self.policies[policy_id] = policy_data
        
        return policy_id
        
    
    def get_policy(self, name=None):
        policy_id = name or self.current_policy
        policy = self.policies.get(policy_id, self.policies['default'])
        policy['id'] = policy_id
        return policy
    
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
        timestamp_posted: Optional[float] = None):
        
        """
        Represents a blockchain transaction
        - message_data: Encrypted for 'message' type transactions
        - related_addresses: List of wallet addresses affected
        - type_field: Transaction type (check_in, message, alert, etc)
        - priority_level: From 1 (highest) to 5 (lowest)
        """
        
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
        nonce: int = 0,
            # NOTE: blockchain's public key is also the signature for signing blocks! If compromised, terminate entire blockchain and start a new one, freezing the old blockchain entirely.
        signature: Optional[str] = None     
    ):
        """
        Represents a block in the blockchain
        - transactions: List of Transaction objects
        - previous_hash: Hash of previous block
        - nonce: Proof-of-work value
        - hash: Auto-calculated on initialization
        """
        self.block_index = block_index
        self.timestamp = timestamp
        self.transactions = transactions
        self.previous_hash = previous_hash
        self.nonce = nonce
        self.hash = self.calculate_hash()
        self.signature = signature  # Server PGP signing of blocks so users can validate blocks relayed from other users. 

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
            "nonce": self.nonce,
            "signature": self.signature,
        }
        
class Wallet:
    def __init__(self, family_id, crisis_id):
        self.family_id = family_id
        self.crisis_id = crisis_id
        self.members = []
        self.devices = []        
        
    def to_dict(self):
        return {
            "family_id": self.family_id,
            "crisis_id": self.crisis_id,
            "members": self.members,
            "devices": self.devices,
        }
    
    def add_member(self, name):
        """Add new family member"""
        member_id = f"{self.family_id}-{secrets.token_hex(4)}"
        self.members.append({
            "id": member_id,
            "name": name,
            "address": member_id,
        })
        return member_id
    
    def register_device(self, device_id, public_key_str):
    # def register_device(self, device_id, public_key):
        """Register new device for wallet access"""

        device = {
            "device_id": device_id,
            "public_key": public_key_str,
            "registered_at": time.time()
        }
               
        # Store device
        self.devices.append(device)
        return device_id


class WalletManager:
    def __init__(self, blockchain):
        """Initialize wallet manager with in-memory cache"""
        self.blockchain = blockchain # reference to parent blockchain
        self.wallets = {}  # In-memory cache: family_id -> Wallet object
        self.auth = WalletAuth()
    
    # THIS SEEMS WRONG TOO
    def create_wallet(self, family_id, members, crisis_id, passphrase=""):
        """
        Create a new wallet and store in database
        :param family_id: Unique family identifier
        :param members: List of member objects (each with 'name')
        :param crisis_id: Crisis identifier (hurricane name, location-date-earthquake, for eg)
        :param passphrase: passphrase to encrypt private key (empty for development, allows users to retrieve personal messages from blockchain from an unrecognized device)
        :return: Wallet object
        """
        # Create wallet instance
        wallet = Wallet(family_id, crisis_id)
        
        # Add members to wallet
        for member in members:
            wallet.add_member(member['name'])
            
        # Generate PGP keypair for this wallet
        keypair = self.auth.generate_keypair(passphrase)
        
        # Encrypt private key with passphrase
        user_encrypted_private_key = str(keypair)
        public_key = str(keypair.pubkey)
        
        
        # Encrypt the encrypted private key with the blockchain master key, so that blockchain only returns the encrypted private key and no-one else can do this step but the blockchain that stores it. The passphrase then decrypts the response, so having the passphrase is required to unlock the wallet but the blockchain admin has no access to anyone's wallets.
        ### DOUBLE CHECK THIS TOO PLEASE, YOURS IS DIFFERENT BUT THAT DIDN'T SEEM TO MAKE SENSE TO ME
        master_encrypted_private_key = self.encrypt_with_master_key(user_encrypted_private_key)
        
        # Save wallet data and keys to database
        with db_connection() as conn:
            # Save lean wallet data
            serializable_members = [{
                "id": m["id"],
                "name": m["name"],
                "address": m["address"]
            } for m in wallet.members]
            
            conn.execute(
                "INSERT INTO wallets (family_id, crisis_id, members, devices) VALUES (?, ?, ?, ?)",
                (family_id, crisis_id, json.dumps(serializable_members), json.dumps([]))
            )
            
            # Save keys separately
            conn.execute(
                "INSERT INTO wallet_keys (family_id, encrypted_private_key, public_key) VALUES (?, ?, ?)",
                # "INSERT INTO wallet_keys (family_id, encrypted_private_key, public_key) VALUES (?, ?, ?)",
                (family_id, master_encrypted_private_key, public_key)
            )
            
            conn.commit()
        
        # Cache in memory
        self.wallets[family_id] = wallet
        logger.info(f"Created wallet {family_id} with {len(wallet.members)} members")
        return wallet


    def encrypt_with_master_key(self, data):
        """Encrypt data with blockchain's master public key"""
        # Parse public key string to PGP object
        pub_key = pgpy.PGPKey()
        pub_key.parse(self.blockchain.master_public_key)
        
        # Encrypt the data from the user for obfuscation of direct messages
        message = pgpy.PGPMessage.new(data)
        return str(pub_key.encrypt(message))


    def authenticate_and_get_private_key(self, family_id, passphrase):
        """
        Retrieve and decrypt wallet's private key
        1. Get doubly-encrypted key from database
        2. Decrypt with master private key
        3. Decrypt with user passphrase
        """
        with db_connection() as conn:
            cursor = conn.execute(
                "SELECT encrypted_private_key FROM wallet_keys WHERE family_id = ?",
                (family_id,)
            )
            row = cursor.fetchone()
            
            if row:
                try:
                    # Step 1: Decrypt with master key
                    encrypted_key = row['encrypted_private_key']
                    # USE BLOCKCHAIN'S DECRYPTION METHOD
                    user_encrypted_key = self.blockchain.decrypt_with_master_key(encrypted_key)
                    
                    # Step 2: Decrypt with user's passphrase
                    user_key = pgpy.PGPKey()
                    user_key.parse(user_encrypted_key)
                    with user_key.unlock(passphrase):
                        return str(user_key)
                except Exception as e:
                    logger.error(f"Authentication failed for {family_id}: {str(e)}")
                    return None
        return None

        
    def get_wallet(self, family_id):
        # First check in-memory cache
        if family_id in self.wallets:
            return self.wallets[family_id]
                
        # Then check database
        with db_connection() as conn:
            cursor = conn.execute(
                "SELECT * FROM wallets WHERE family_id = ?",
                (family_id,)
            )
            row = cursor.fetchone()
            
            if row:
                # Convert Row to dictionary
                columns = [col[0] for col in cursor.description]
                row_dict = dict(zip(columns, row))
                
                # Reconstruct wallet from database
                wallet = Wallet(row_dict['family_id'], row_dict['crisis_id'])
                wallet.members = json.loads(row_dict['members'])
                
                # Handle devices if present
                if 'devices' in row_dict and row_dict['devices']:
                    wallet.devices = json.loads(row_dict['devices'])
                else:
                    wallet.devices = []
                
                # Add to cache
                self.wallets[family_id] = wallet
                return wallet
        
        return None
    
    # To obfuscate p2p messages, recipient's public_key is retrieved to encryt message prior to posting to blockchain
    def get_wallet_public_key(self, family_id):
        """Get public key for encrypting messages to this wallet"""
        with db_connection() as conn:
            cursor = conn.execute(
                "SELECT public_key FROM wallet_keys WHERE family_id = ?",
                (family_id,)
            )
            row = cursor.fetchone()
            
            if row:
                return row['public_key']
        return None

    
    def delete_wallet(self, family_id):
        """Delete wallet and its keys"""
        # Remove from cache
        if family_id in self.wallets:
            del self.wallets[family_id]

        # Delete from database
        with db_connection() as conn:
            conn.execute("DELETE FROM wallets WHERE family_id = ?", (family_id,))
            conn.execute("DELETE FROM wallet_keys WHERE family_id = ?", (family_id,))
            conn.commit()
    

class Blockchain:
    def __init__(self, policy_system=None):
        self.policy_system = policy_system or PolicySystem()    # Use provided policy or default if none provided
        self.crisis_metadata = self.policy_system.get_policy()
        self.chain: List[Block] = []
        self.pending_transactions: List[Transaction] = []
        self.wallets = WalletManager(self)
        
        # Get policy values from PolicySystem
        policy_settings = self.policy_system.get_policy()['policy']
        self.block_interval = policy_settings['block_interval']
        self.max_tx_size = policy_settings['size_limit']
        self.tx_rate_limit = policy_settings['rate_limit']
        
        # Generate master keypair when new KriSYS Blockchain is instantiated
        self.master_public_key = self.load_or_generate_master_key()
        logger.info(f"Master public key: {self.master_public_key}")
        
        # Store public key in crisis metadata
        self.crisis_metadata['public_key'] = str(self.master_public_key)
        
        init_db()       # Initialize database
        
        if not self.load_chain():   # Load existing chain or create genesis block for new blockchain
            self.create_genesis_block()
        
        # Start automatic background miner
        self.miner_thread = threading.Thread(target=self.miner_loop, daemon=True)
        self.miner_thread.start()
        

    def load_or_generate_master_key(self):
        """
        Load existing or generate new master keypair
        - Public key stored in blockchain/master_public_key.asc
        - Private key stored in blockchain/master_private_key.asc
        - Returns public key string
        """
        key_dir = 'blockchain'   # Docker volume path, /app is already the working dir
        public_key_file = os.path.join(key_dir, 'master_public_key.asc')
        private_key_file = os.path.join(key_dir, 'master_private_key.asc')
        
        # Ensure folder exists, or create it
        os.makedirs(key_dir, exist_ok=True)
        
        if os.path.exists(public_key_file) and os.path.exists(private_key_file):
            # Load existing public key
            with open(public_key_file, 'r') as f:
                return f.read()
        else:
            # Generate new keypair
            key = pgpy.PGPKey.new(PubKeyAlgorithm.RSAEncryptOrSign, 4096)
            uid = pgpy.PGPUID.new('KriSYS Blockchain', comment='Master Key')
            key.add_uid(uid, 
                usage={KeyFlags.Sign, KeyFlags.EncryptCommunications},
                hashes=[HashAlgorithm.SHA256],
                ciphers=[SymmetricKeyAlgorithm.AES256])
            
            # Save keys
            with open(public_key_file, 'w') as f:
                f.write(str(key.pubkey))
            with open(private_key_file, 'w') as f:
                f.write(str(key))
                logger.warning(f"MASTER PRIVATE KEY SAVED TO {private_key_file}")
            return str(key.pubkey)


    def decrypt_with_master_key(self, encrypted_data):
        """
        Decrypt data using master private key
        - Reads private key from file on demand
        - Does not store key in memory
        """
        key_dir = "blockchain"  # "/app" is already the working directory
        private_key_file = os.path.join(key_dir, 'master_private_key.asc')
        
        if not os.path.exists(private_key_file):
            logger.error("Master private key not found")
            return None
        
        try:
            # Load private key from file
            with open(private_key_file, 'r') as f:
                key_str = f.read()
            
            key = pgpy.PGPKey()
            key.parse(key_str)
            
            # Decrypt the data
            enc_message = pgpy.PGPMessage.from_blob(encrypted_data)
            decrypted = key.decrypt(enc_message)
            return str(decrypted.message)
        except Exception as e:
            logger.error(f"Decryption failed: {str(e)}")
            return None
    
    
    
    def get_wallet(self, family_id):
        """Get wallet by family ID"""
        return self.wallets.get_wallet(family_id)
    
    def add_transaction(self, transaction: Transaction, rate_limit_override: bool = False):
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
        if not rate_limit_override:
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
        logger.info(f"Added transaction: {transaction.transaction_id} to blockchain.pending_transactions")
        
    
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
                        nonce=db_block['nonce'],
                        signature=db_block['signature'],
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
        # Ensure block has a signature
        if not block.signature:
            block.signature = self.sign_block(block)
        
        with db_connection() as conn:
            # Save block
            cur = conn.execute(
                '''
                INSERT INTO blocks 
                (block_index, timestamp, previous_hash, hash, nonce, signature) 
                VALUES (?, ?, ?, ?, ?, ?)
                ''',
                (
                    block.block_index,
                    block.timestamp,
                    block.previous_hash,
                    block.hash,
                    block.nonce,
                    block.signature,
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

    # def create_genesis_block(self):
    #     """Create and save the genesis block"""
    #     genesis = Block(
    #         block_index=0,
    #         timestamp=time.time(),
    #         transactions=[],
    #         previous_hash="0"
    #     )
    #     self.chain.append(genesis)
    #     self.save_block(genesis)
    #     logger.info("Created genesis block")
    def create_genesis_block(self):
        """Create and save the genesis block with crisis metadata"""

        # Build metadata payload for the first transaction
        metadata_payload = {
            "type": "crisis_metadata",
            "crisis_id": self.crisis_metadata["id"],
            "name": self.crisis_metadata["name"],
            "organization": self.crisis_metadata["organization"],
            "contact": self.crisis_metadata["contact"],
            "description": self.crisis_metadata["description"],
            "created_at": self.crisis_metadata["created_at"],
            "block_public_key": self.crisis_metadata["public_key"],
        }

        meta_tx = Transaction(
            timestamp_created=time.time(),
            station_address="SYSTEM",  # synthetic origin for metadata, not pertinent to any code of functionality right now
            message_data=json.dumps(metadata_payload),
            related_addresses=[],
            type_field="metadata",
            priority_level=1,
        )

        genesis = Block(
            block_index=0,
            timestamp=time.time(),
            transactions=[meta_tx],
            previous_hash="0",
        )

        self.chain.append(genesis)
        self.save_block(genesis)
        logger.info("Created genesis block with crisis metadata")

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
            try:
                # Get current block interval from policy
                block_interval = self.policy_system.get_policy()['policy']['block_interval']
                
                # Only mine if we have transactions
                if self.pending_transactions:
                    self.mine_and_save()
                
                # Sleep for the remaining time in the block interval
                sleep_time = block_interval - (time.time() % block_interval)
                time.sleep(sleep_time)
            except Exception as e:
                logger.error(f"Mining error: {str(e)}")
                time.sleep(5)  # Wait before retrying

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
    
    # For signing official mined blocks, to validate data relayed between offline users without using the server
    def sign_block(self, block:Block) -> str:
        """
        Sign a block using the master private PGP key.

        For simplicity, we sign a canonical JSON header containing:
        - block_index
        - previous_hash
        - hash

        The signature is ASCII-armored PGP.
        """
        key_dir = "blockchain"
        private_key_file = os.path.join(key_dir, "master_private_key.asc")

        if not os.path.exists(private_key_file):
            logger.error("Master private key not found for block signing")
            raise RuntimeError("Missing master private key")

        try:
            with open(private_key_file, "r") as f:
                key_str = f.read()

            key = pgpy.PGPKey()
            key.parse(key_str)

            header = json.dumps(
                {
                    "block_index": block.block_index,
                    "previous_hash": block.previous_hash,
                    "hash": block.hash,
                },
                sort_keys=True,
                separators=(',', ':'),  # match JSON.stringify (no spaces)
            )

            message = pgpy.PGPMessage.new(header)
            sig = key.sign(message, detached=True)
            return str(sig)
        except Exception as e:
            logger.error(f"Block signing failed: {str(e)}")
            raise 
    

# Wallet login to decrypt and make visible labels, messages and data related to addresses belonging to this group
class WalletAuth:
    def __init__(self):
        self.device_registry = {}  # device_id: encrypted_credentials
    
    # DEV NOTE: update passphrase code here, empty string only valid for development!!!!!
    def generate_keypair(self, passphrase=""):
        """Generate PGP key pair for wallet"""
        key = pgpy.PGPKey.new(PubKeyAlgorithm.RSAEncryptOrSign, 4096)
        uid = pgpy.PGPUID.new('KriSYS Wallet', comment='Auto-generated')
        key.add_uid(uid, usage={KeyFlags.Sign, KeyFlags.EncryptCommunications},
                    hashes=[HashAlgorithm.SHA256],
                    ciphers=[SymmetricKeyAlgorithm.AES256])
              
        key.protect(passphrase, SymmetricKeyAlgorithm.AES256, HashAlgorithm.SHA256)
        return key

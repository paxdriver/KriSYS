# app.py
import hashlib
from flask import Flask, request, jsonify, render_template, send_file
from blockchain import Blockchain, Transaction, WalletManager, PolicySystem
import time
import json
import os
from functools import wraps
from database import db_connection
import pgpy
import secrets
import qrcode
import base64
from io import BytesIO

# DEV NOTE: logging for development only
import logging
# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MAX_MEMBERS = 20     # DEV NOTE: THIS SHOULD BE DEFINED IN THE BLOCKCHAIN ISNTANTIATION POLICY BY ADMIN

app = Flask(__name__, static_folder='static')
app.secret_key = os.environ.get('SECRET_KEY', 'dev_secret_key_please_change_in_prod')  # PRODUCTION: Use secure random key

################
# CREATING CRISIS
policy_system = PolicySystem()
hurricane_policy_id = policy_system.create_crisis_policy(
    name="Hurricane Response 2024",
    organization="Orange Cross",
    contact="hurricane-response@orangecross.org",
    description="Emergency response protocol for 2025 Atlantic hurricane season",
    policy_settings={
        'block_interval': 180,  # 3 minutes
        'size_limit': 10240,    # 10KB for more detailed reports
        'rate_limit': 600,      # 10 minute between messages
        'priority_levels': {
            'evacuation': 1,
            'medical': 2,
            'shelter': 3,
            'supplies': 4,
            'personal': 5
        },
        'types': ['check_in', 'message', 'alert', 'damage_report']
    },
    policy_id="custom_crisis_id"
)
# Activate the hurricane policy
policy_system.current_policy = hurricane_policy_id
##############

# Create the blockchain
blockchain = Blockchain(policy_system)
# Create wallet manager for the new blockchain
blockchain.wallets = WalletManager()

logger.info(f"Created crisis policy: {hurricane_policy_id}")
logger.info(f"Current policy: {policy_system.current_policy}")
logger.info(f"Policy details: {json.dumps(policy_system.get_policy(), indent=2)}")

########### TESTING IN DEV MODE ###############
def DEV_POLICY_CHECK():
    # Get current policy information
    current_policy = blockchain.policy_system.get_policy()
    logger.info(f"Crisis: {current_policy['name']}")
    logger.info(f"Organization: {current_policy['organization']}")
    logger.info(f"Contact: {current_policy['contact']}")
    logger.info(f"Description: {current_policy['description']}")

    # Get specific policy setting
    block_interval = current_policy['policy']['block_interval']
    logger.info(f"block_interval: {block_interval}")
    
# Call policy check after the blockchain and policy are instatiated
DEV_POLICY_CHECK()
########### TESTING IN DEV MODE ###############

# Admin token setup : this is for the organization hosting the entire KriSYS system for a given disaster
ADMIN_TOKEN = os.getenv('ADMIN_TOKEN', 'default_admin_token_please_change')

# Admin authentication decorator - this is for the blockchain provider, the agent hosting the entire chain
def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_token = request.headers.get('X-Admin-Token')
        if auth_token not in [ADMIN_TOKEN, "valid_admin_token"]:  # DEV NOTE: Allow test token during testing
            return jsonify({"error": "UNAUTHORIZED: INVALID ADMIN TOKEN"}), 401
        return f(*args, **kwargs)
    return decorated_function

###### DEV NOTE: TEMPLATES - Flask automatically looks for templates in the /templates/ folder so /templates/scanner.html and /templates/index.html are correct as they are

# HTML browser to explore the public blockchain
@app.route('/')
def blockchain_explorer():
    return render_template('index.html')

# Crisis metadata
@app.route('/crisis', methods=['GET'])
def get_crisis_info():
    """Get metadata about the current crisis"""
    return jsonify({
        "name": blockchain.crisis_metadata['name'],
        "organization": blockchain.crisis_metadata['organization'],
        "contact": blockchain.crisis_metadata['contact'],
        "description": blockchain.crisis_metadata['description'],
        "created_at": blockchain.crisis_metadata['created_at']
    })

# Scanner web interface
@app.route('/scanner')
def scanner_interface():
    return render_template('scanner.html')

# Wallet info
@app.route('/wallet/<family_id>', methods=['GET'])
def get_wallet(family_id):
    wallet = blockchain.wallets.get_wallet(family_id)
    if wallet:
        crisis_meta = blockchain.policy_system.get_policy()
        response = wallet.to_dict()
        response['crisis'] = {
            "id": crisis_meta['id'],
            "name": crisis_meta['name']
        }
        return jsonify(response)
    
    return jsonify({"error": "Wallet not found"}), 404

@app.route('/wallet/<family_id>/transactions')
def get_wallet_transactions(family_id):
    wallet = blockchain.wallets.get_wallet(family_id)
    if not wallet:
        return jsonify({"error": "Wallet not found"}), 404
    
    # Get all member addresses
    addresses = [member['address'] for member in wallet.members]
    
    # Find transactions related to any member
    transactions = []
    for block in blockchain.chain:
        for tx in block.transactions:
            if any(addr in tx.related_addresses for addr in addresses):
                transactions.append(tx.to_dict())
    
    return jsonify(transactions)


# Submissions from public queue
@app.route('/transaction', methods=['POST'])
def add_transaction():
    data = request.json
    if data:
        if data['type_field'] == 'message':
            
            # Handle message encryption
            message_data = data['message_data']
            if data['type_field'] == 'message' and 'recipient_id' in data:
                recipient = blockchain.wallets.get_wallet(data['recipient_id'])
                if recipient:
                    # Encrypt message with recipient's public key
                    pub_key = pgpy.PGPKey()
                    pub_key.parse(recipient.keypair_str)
                    encrypted_msg = pub_key.encrypt(pgpy.PGPMessage.new(message_data))
                    message_data = str(encrypted_msg)
                    
            try:
                tx = Transaction(
                    timestamp_created = data['timestamp_created'],
                    station_address = data['station_address'],
                    message_data = message_data,
                    related_addresses = data['related_addresses'],
                    type_field = data['type_field'],
                    priority_level = data['priority_level'],
                    relay_hash = data.get('relay_hash', ''),
                    posted_id = data.get('posted_id', '')
                )
                blockchain.add_transaction(tx)
                return jsonify({"status": "success", "transaction_id": tx.transaction_id}), 201
        
            except KeyError as e:
                return jsonify({"error": f"Missing field: {str(e)}"}), 400
        
            except Exception as e:
                logger.error(f"Transaction error: {str(e)}")
                return jsonify({"error": "Internal server error"}), 500
        else:
            # OTHER TYPES OF TRANSACTIONS LIKE UPDATING PROFILE OR SOMETHING...
            return jsonify({"error": "THIS TYPE OF TRANSACTION IS NOT YET DEFINED"}), 500
            pass
    else:
        # raise ValueError("add_transation() function can't build tx if data is not an object returned from the request it was provided.")
        return jsonify({"error": "No data provided"}), 400
    
@app.route('/blockchain', methods=['GET'])
def get_chain():
    # chain_data = [{
    #     "index": block.index,
    #     "timestamp": block.timestamp,
    #     "transactions": [tx.to_dict() for tx in block.transactions],
    #     "previous_hash": block.previous_hash,
    #     "hash": block.hash
    # } for block in blockchain.chain]
    chain_data = [block.to_dict() for block in blockchain.chain]
    
    logger.info(jsonify(chain_data))
    
    return jsonify(chain_data), 200

@app.route('/address/<string:address>', methods=['GET'])
def get_address_transactions(address):
    txs = []
    for block in blockchain.chain:
        for tx in block.transactions:
            if address in tx.related_addresses:
                txs.append(tx.to_dict())
    return jsonify(txs), 200


# Admin endpoint for manual mining
@app.route('/admin/mine', methods=['POST'])
def mine_block():
    try: 
        if not blockchain.pending_transactions:
            return jsonify({"error": "No transactions to mine"}), 400
        block = blockchain.mine_block()
        blockchain.save_block(block)
        return jsonify({
            "message": f"Block #{block.block_index} mined",
            "hash": block.hash
        }), 200
    except Exception as e:
        logger.error(f"Mining error: {str(e)}")
        return jsonify({"error": "Mining failed"}), 500

# Wallet management endpoints
@app.route('/wallet', methods=['POST'])
def create_wallet():
    """Create a new family/group/agency/rurouni wallet containing individuals' addresses"""
    try: 
        data = request.json
        num_members = int(data.get('num_members', 1))
        
        if num_members < 1 or num_members > MAX_MEMBERS:
            return jsonify({"error": "Number of members must be between 1-20"}), 400

        # Create members list with default names
        members = [{"name": f"Member {i+1}"} for i in range(num_members)]
        
        # Use WalletManager to create wallet
        wallet = blockchain.wallets.create_wallet(
            family_id=hashlib.sha256(secrets.token_bytes(32)).hexdigest()[:24],
            members=members,
            crisis_id=blockchain.crisis_metadata['id']
        )
        
        return jsonify(wallet.to_dict()), 201


    except Exception as e:
        logger.error(f"Wallet creation error: {str(e)}")
        return jsonify({"error": "Wallet creation failed"}), 500

@app.route('/admin/alert', methods=['POST'])
@admin_required
def admin_alert():
    data = request.json
    try: 
        tx = Transaction(
            timestamp_created=time.time(),
            station_address="ADMIN_ALERT",
            message_data=data['message'],
            related_addresses=[],
            type_field="alert",
            priority_level=data['priority']
        )
        blockchain.add_transaction(tx)
        return jsonify({"status": "success", "transaction_id": tx.transaction_id}), 201
    except KeyError as e:
        return jsonify({"error": f"Missing field: {str(e)}"}), 400
    except Exception as e:
        logger.error(f"Admin alert error: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

@app.route('/wallet/<family_id>/qr/<address>')
def get_address_qr(family_id: str, address: str):
    """Generate QR code for a specific address"""
    try:
        # Generate QR code
        img = qrcode.make(address)
        buffered = BytesIO()
        img.save(buffered, "PNG")
        img_str = base64.b64encode(buffered.getvalue()).decode('utf-8')
        return jsonify({
            "qr_code": f"data:image/png;base64,{img_str}"
        })
        
    except Exception as e:
        logger.error(f"QR generation error: {str(e)}")
        return jsonify({"error": "QR generation failed"}), 500


# DEV NOTE: Checking policy details at this endpoint, consider removing if not needed in prod
@app.route('/policy', methods=['GET'])
def get_current_policy():
    policy = blockchain.policy_system.get_policy()
    return jsonify(policy)

# Change the blockchain's policy details after it's been initialized
@app.route('/admin/policy', methods=['POST'])
@admin_required
def set_policy():
    data = request.json
    policy_id = data.get('policy_id')
    if policy_id in blockchain.policy_system.policies:
        blockchain.policy_system.current_policy = policy_id
        return jsonify({"status": "success", "policy": policy_id})
    return jsonify({"error": "Invalid Policy ID provided"}), 400

# Check in stations with templated message data
@app.route('/checkin', methods=['POST'])
def check_in():
    """Process QR code scan and create check-in transaction"""
    try:
        data = request.json
        address = data.get('address')
        station_id = data.get('station_id', 'STATION_001')
        
        if not address:
            return jsonify({"error": "Missing address"}), 400
        
        # Create check-in transaction
        tx = Transaction(
            timestamp_created=time.time(),
            station_address=station_id,
            message_data="Check-in",
            related_addresses=[address],
            type_field="check_in",
            priority_level=1
        )
        
        blockchain.add_transaction(tx)
        return jsonify({
            "status": "success",
            "transaction_id": tx.transaction_id,
            "message": f"Checked in {address} at station {station_id}"
        }), 201
        
    except Exception as e:
        logger.error(f"Check-in error: {str(e)}")
        return jsonify({"error": str(e)}), 400


# Wallet Data Endpoint
@app.route('/wallet/data', methods=['GET'])
def get_wallet_data():
    # In production: verify authentication
    family_id = request.args.get('family_id')
    
    # Mock data - will be replaced with real DB queries
    return jsonify({
        "family_id": family_id,
        "members": [
            {"address": f"{family_id}-0", "label": "John Doe"},
            {"address": f"{family_id}-1", "label": "Jane Smith"}
        ],
        "notifications": [
            {
                "type": "checkin",
                "timestamp": time.time() - 3600,
                "message": "Checked in at Medical Station",
                "sender": "Medical Station 1"
            },
            {
                "type": "message",
                "timestamp": time.time() - 7200,
                "message": "We have supplies at Shelter 3",
                "sender": "Shelter Coordinator"
            }
        ],
        "registered_devices": ["mobile-12345", "tablet-67890"]
    })

# Dashboard to view family wallet
@app.route('/wallet/dashboard/<family_id>', methods=['GET', 'POST'])
def wallet_dashboard(family_id):
    try:
        wallet = blockchain.wallets.get_wallet(family_id)
        if not wallet:
            return render_template('error.html', message="Wallet not found"), 404
        
        # Handle unlock form submission
        passphrase = None
        if request.method == 'POST':
            passphrase = request.form.get('passphrase')
            if passphrase: wallet.unlock(passphrase)
        
        # Prepare wallet data
        wallet_data = wallet.to_dict()
        crisis_meta = blockchain.policy_system.get_policy()
        wallet_data['crisis'] = {
            "id": crisis_meta['id'],
            "name": crisis_meta['name']
        }
        
        if wallet_data: logger.info(wallet_data)
        else:
            logger.info(f'blockchain.policy_system.get_policy(): {crisis_meta}') 
            logger.exception("NO WALLET DATA RECEIVED!!!")
        
        # Get transactions
        transactions = []
        for block in blockchain.chain:
            for tx in block.transactions:
                tx_data = tx.to_dict()
                
                # Attempt decryption if wallet is unlocked
                if wallet.private_key and tx.type_field == "message":
                    try:
                        decrypted = wallet.decrypt_message(tx.message_data)
                        if decrypted:
                            tx_data['message_data'] = decrypted
                            tx_data['decrypted'] = True
                    except Exception as e:
                        logger.error(f"Decryption failed: {str(e)}")
                        tx_data['decrypted'] = False
                
                transactions.append(tx_data)
        
        # Filter and sort
        member_addresses = [m['address'] for m in wallet.members]
        relevant_txs = [
            tx for tx in transactions
            # Include if:
            # 1. It's a broadcast message (no specific addresses)
            # 2. It's addressed to any wallet member
            # 3. It's an admin alert (or other broadcast type)
            if (not tx['related_addresses'] or  # Broadcast messages
                tx['type_field'] == 'alert' or  # All alerts
                any(addr in tx['related_addresses'] for addr in member_addresses))
        ]
        
        relevant_txs = sorted(relevant_txs, key=lambda x: x['timestamp_posted'], reverse=True)[:10]
        
        logger.info(f'wallet: {wallet} being sent to dashboard html template')
        logger.info(f'relevant_txs: {relevant_txs} being sent to dashboard html template')
        logger.info(f'family_id: {family_id} being sent to dashboard html template')
        
        return render_template('wallet_dashboard.html', 
                               wallet = wallet_data, # passing dict for jinja to parse on the other side
                               transactions = relevant_txs,
                               family_id = family_id)
    
    except Exception as e:
        logger.exception("Wallet dashboard error")
        return render_template('error.html', message=str(e)), 500


# Add New Member in Wallet Endpoint
@app.route('/wallet/member', methods=['POST'])
def add_wallet_member():
    family_id = request.json.get('family_id')
    label = request.json.get('label')
    
    # Generate new address
    new_address = f"{family_id}-{secrets.token_hex(4)}"
    
    # Add to database
    with db_connection() as conn:
        conn.execute(
            "UPDATE wallets SET members = json_insert(members, '$[#]', json_object('address', ?, 'label', ?)) WHERE family_id = ?",
            (new_address, label, family_id)
        )
        conn.commit()
    
    return jsonify({
        "status": "success",
        "new_member": {"address": new_address, "label": label}
    }), 201
#################

@app.route('/auth/unlock', methods=['POST'])


@app.route('/debug/wallet/<family_id>')
def debug_wallet(family_id):
    wallet = blockchain.wallets.get_wallet(family_id)
    if not wallet:
        return jsonify({"error": "Wallet not found"}), 404
    return jsonify(wallet.to_dict())

@app.route('/debug/transactions')
def debug_transactions():
    all_transactions = []
    for block in blockchain.chain:
        for tx in block.transactions:
            all_transactions.append(tx.to_dict())
    return jsonify(all_transactions)

@app.route('/debug/blockchain')
def debug_blockchain():
    return jsonify([block.to_dict() for block in blockchain.chain])



if __name__ == '__main__':
    # Start background miner thread in production
    app.run(host='0.0.0.0', port=5000)
    
    
    
    

    
    
    
    
# @app.route('/auth/init', methods=['POST'])
# def init_auth():
#     """Begin authentication process"""
#     wallet_id = request.json.get('wallet_id')
#     device_id = request.json.get('device_id')
    
#     # Generate challenge
#     challenge = secrets.token_hex(32)
    
#     # Check if device is registered
#     is_registered = device_id in blockchain.get_wallet(wallet_id).devices
    
#     return jsonify({
#         "challenge": challenge,
#         "device_registered": is_registered
#     })
    

# WALLET AUTHENTICATION - on devices (PGP-based, password-based, or TPM/device registration)
# @app.route('/auth/verify', methods=['POST'])
# def verify_auth():
#     """Verify authentication signature"""
#     signature = request.json.get('signature')
#     device_id = request.json.get('device_id')
    
#     if not all([signature, wallet_id, challenge]):
#         return jsonify({"error": "Missing authentication data"}), 400
    
#     wallet = blockchain.get_wallet(family_id)
#     if wallet.auth.authenticate(challenge, signature, device_id):
#         # Create session token
#         session_token = secrets.token_urlsafe(32)
#         session['wallet_session'] = session_token
#         return jsonify({"status": "authenticated", "token": session_token})
    
#     return jsonify({"error": "Authentication failed"}), 401

# @app.route('/auth/password', methods=['POST'])
# def password_auth():
#     """Password fallback authentication"""
#     wallet_id = session.get('auth_wallet')
#     password = request.json.get('password')
    
#     if not password or not wallet_id:
#         return jsonify({"error": "Missing credentials"}), 400
    
#     wallet = blockchain.get_wallet(wallet_id, session)
#     if wallet.auth.authenticate_with_password(password):
#         session_token = secrets.token_urlsafe(32)
#         session['wallet_session'] = session_token
#         return jsonify({"status": "authenticated", "token": session_token})
    
#     return jsonify({"error": "Invalid credentials"}), 401

# Wallet Auth - Device Registration endpoint (TPM module, for eg)
# @app.route('/wallet/register-device', methods=['POST'])
# def register_device():
#     wallet_id = request.json.get('wallet_id')
#     public_key = request.json.get('public_key')
#     device_id = request.json.get('device_id')
    
#     wallet = blockchain.get_wallet(wallet_id, session)
#     encrypted_creds = wallet.register_device(device_id, public_key)
    
#     return jsonify({
#         "status": "registered",
#         "device_id": device_id,
#         "encrypted_creds": str(encrypted_creds)
#     })
### END wallet auth

# Authentication challenge via PGP
# @app.route('/auth/challenge', methods=['GET'])
# def get_auth_challenge():
#     """Generate authentication challenge"""
#     challenge = secrets.token_hex(16)
#     session['auth_challenge'] = challenge
#     return jsonify({"challenge": challenge})

# @app.route('/auth/login', methods=['POST'])
# def pgp_login():
#     """Authenticate using PGP signature"""
#     data = request.json
#     challenge = session.get('auth_challenge')
#     signature = data.get('signature')
#     fingerprint = data.get('fingerprint')
    
#     if not challenge or not signature or not fingerprint:
#         return jsonify({"error": "Missing authentication data"}), 400
    
#     try:
#         # Retrieve public key from blockchain
#         public_key = get_public_key(fingerprint)  # Implement this function
        
#         # Verify signature
#         signed_challenge = pgpy.PGPMessage.from_blob(signature)
#         if public_key.verify(challenge, signed_challenge):
#             # Create session
#             # session['wallet_fingerprint'] = fingerprint
#             return jsonify({"status": "authenticated"})
#         else:
#             return jsonify({"error": "Invalid signature"}), 401
#     except Exception as e:
#         logger.error(f"PGP login error: {str(e)}")
#         return jsonify({"error": "Authentication failed"}), 500

# def get_public_key(fingerprint):
#     """Retrieve public key from blockchain (simplified)"""
#     # In real implementation, this would query the blockchain
#     # For now, we'll use a mock
#     key, _ = pgpy.PGPKey.from_file('path/to/public_key.asc')
#     return key
#### END SIMPLE AUTH




    
    
#######

# All wallets on blockchain, from blockchain.py methods
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


###########################
#  Dev NOTE: Implementation Details for family/group wallet management of addresses and notifications

# graph TD -> WALLET MANAGEMENT SYSTEM ARCHITECTURE
#     A[Family Wallet] --> B[Authentication]
#     A --> C[Member Management]
#     A --> D[Address Generation]
#     A --> E[Notifications]
#     B --> B1[Password/Device Auth]
#     C --> C1[Add Members]
#     C --> C2[Edit Labels]
#     D --> D1[New Addresses]
#     E --> E1[All Transactions]
#     E --> E2[Individual Filters]

 
# sequenceDiagram -> DEVICE REGISTRATION FLOW
#     participant User
#     participant Device
#     participant Server
#     User->>Device: Initiate device registration
#     Device->>Server: Request registration challenge
#     Server->>Device: Send encrypted challenge
#     Device->>User: Prompt for wallet password
#     User->>Device: Enter password
#     Device->>Server: Submit challenge response + device ID
#     Server->>Device: Confirm registration
#     Device->>LocalStorage: Store encrypted credentials


# sequenceDiagram -> WALLET AUTH FLOW
#     participant Client
#     participant Server
#     participant Blockchain
#     Client->>Server: Request challenge
#     Server->>Client: Send nonce
#     Client->>Client: Sign nonce with private key
#     Client->>Server: Send signed nonce + public key fingerprint
#     Server->>Blockchain: Retrieve public key by fingerprint
#     Blockchain->>Server: Return public key
#     Server->>Server: Verify signature
#     Server->>Client: Auth token if valid

###########################
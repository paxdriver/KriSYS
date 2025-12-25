# app.py
import hashlib
from flask import Flask, request, jsonify
from flask_cors import CORS
from blockchain import Blockchain, Transaction, PolicySystem
import time
import json
import os
import base64
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
MIN_PASSPHRASE_LENGTH = 1   # set small limit, just for obfuscation not security

app = Flask(__name__, static_folder='static')
################ DEV NOTE: CHANGE ADMIN SECRETS!!!!!!!
CORS(app, origins=['http://localhost:3000', 'http://localhost:5000', 'http://localhost:5000/crisis'])
# app.secret_key = os.environ.get('SECRET_KEY', 'dev_secret_key_please_change_in_prod')  # PRODUCTION: Use secure random key
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
    policy_id="Hurricane_Bobo"
)

# Activate the hurricane policy
policy_system.current_policy = hurricane_policy_id

# Create the blockchain
blockchain = Blockchain(policy_system)

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


#####################
# Admin token setup : this is for the organization hosting the entire KriSYS system for a given disaster
ADMIN_TOKEN = ""

private_key_file = os.path.join('blockchain', 'master_private_key.asc')
if not os.path.exists(private_key_file):
    logger.critical("MASTER PRIVATE KEY FILE NOT FOUND. SHUTTING DOWN.")
    import sys
    sys.exit(1)
with open(private_key_file, 'r') as f:
    ADMIN_TOKEN = f.read()

# Admin authentication decorator
def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_token = request.headers.get('X-Admin-Token')
        
        if not auth_token:
            return jsonify({"error": "UNAUTHORIZED: MISSING ADMIN TOKEN"}), 401        
        
        try:
            # Decode the base64-encoded token
            decoded_token = base64.b64decode(auth_token).decode('utf8')
            if decoded_token != ADMIN_TOKEN:
                return jsonify({"error": "UNAUTHORIZED: INVALID ADMIN TOKEN"}), 401
        except Exception as e:
            logger.error(f"Token decoding error: {str(e)}")
            return jsonify({"error": "UNAUTHORIZED: INVALID TOKEN FORMAT"}), 401    
        return f(*args, **kwargs)
    return decorated_function
#####################

# # Create admin key file
# admin_key_file = os.path.join('blockchain', 'admin_keys.txt')
# try:
#     with open(admin_key_file, 'w') as f:
#         f.write(f"Blockchain ID: {blockchain.crisis_metadata['id']}\n")
#         f.write(f"Master Public Key: {str(blockchain.master_keypair.pubkey)}\n")
#         f.write(f"ADMIN_TOKEN: {os.environ['ADMIN_TOKEN']}\n")
#         f.write("WARNING: This token decrypts all wallet keys - PROTECT IT!\n")
#     logger.info(f"Admin key file created at {admin_key_file}")
# except Exception as e:
#     logger.error(f"Failed to create admin key file: {str(e)}")

# logger.info(f"Created crisis policy: {hurricane_policy_id}")
# logger.info(f"Current policy: {policy_system.current_policy}")
# logger.info(f"Policy details: {json.dumps(policy_system.get_policy(), indent=4)}")

#####################

# Crisis metadata
@app.route('/crisis', methods=['GET'])
def get_crisis_info():
    """Get metadata about the current crisis"""
    return jsonify({
        "name": blockchain.crisis_metadata['name'],
        "organization": blockchain.crisis_metadata['organization'],
        "contact": blockchain.crisis_metadata['contact'],
        "description": blockchain.crisis_metadata['description'],
        "created_at": blockchain.crisis_metadata['created_at'],
        "block_public_key": blockchain.crisis_metadata['public_key'],
    })

# Wallet info - NO KEYS INCLUDED
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
    
    # Find transactions related to any member - NO DECRYPTION ON SERVER
    transactions = []
    for block in blockchain.chain:
        for tx in block.transactions:
            if any(addr in tx.related_addresses for addr in addresses):
                transactions.append(tx.to_dict())
    
    return jsonify(transactions)

# Message submission with encryption
@app.route('/transaction', methods=['POST'])
def add_transaction():
    data = request.json
    
    # Check for dev rate limit override
    rate_limit_override = request.headers.get('X-Dev-Rate-Override') == 'true'
    
    if data:
        if data['type_field'] == 'message':
            
            # Handle message encryption using wallet_keys table
            message_data = data['message_data']
            if data['type_field'] == 'message' and 'recipient_id' in data:
                # Get recipient's public key from wallet_keys table
                public_key_str = blockchain.wallets.get_wallet_public_key(data['recipient_id'])
                if public_key_str:
                    # Encrypt message with recipient's public key
                    pub_key = pgpy.PGPKey()
                    pub_key.parse(public_key_str)
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
                # Add transaction with optional rate limit override
                blockchain.add_transaction(tx, rate_limit_override=rate_limit_override)
                return jsonify({"status": "success", "transaction_id": tx.transaction_id}), 201
            
            except KeyError as e:
                return jsonify({"error": f"Missing field: {str(e)}"}), 400
        
            except Exception as e:
                logger.error(f"Transaction error: {str(e)}")
                return jsonify({"error": "Internal server error"}), 500
        else:
            return jsonify({"error": "THIS TYPE OF TRANSACTION IS NOT YET DEFINED"}), 500
    else:
        return jsonify({"error": "No data provided"}), 400
    
@app.route('/blockchain', methods=['GET'])
def get_chain():
    chain_data = [block.to_dict() for block in blockchain.chain]
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

# Wallet management endpoints - with passphrase encryption
@app.route('/wallet', methods=['POST'])
def create_wallet():
    """Create a new family wallet with keys stored separately"""
    try: 
        data = request.json
        num_members = int(data.get('num_members', 1))
        passphrase = data.get('passphrase', '')  # Get passphrase from request
        
        if not passphrase or len(passphrase) < MIN_PASSPHRASE_LENGTH:
            return jsonify({"error": f"Passphrase must be at least {MIN_PASSPHRASE_LENGTH} characters"}), 400

        if num_members < 1 or num_members > MAX_MEMBERS:
            return jsonify({"error": "Number of members must be between 1-20"}), 400

        members = [{"name": f"Member {i+1}"} for i in range(num_members)]
        
        wallet = blockchain.wallets.create_wallet(
            family_id=hashlib.sha256(secrets.token_bytes(32)).hexdigest()[:24],
            members=members,
            crisis_id=blockchain.crisis_metadata['id'],
            passphrase=passphrase   # Passphrase deciphers private_key stored by blockchain host in wallet_keys, which is encrypted value by blockchain host's public/private keys to never store user's private key, but to allow simple passphrase for user to retrieve their private_key by memory
        )
        
        return jsonify(wallet.to_dict()), 201

    except Exception as e:
        logger.error(f"Wallet creation error: {str(e)}")
        return jsonify({"error": "Wallet creation failed"}), 500
    ########### OLD
    # try: 
    #     data = request.json
    #     num_members = int(data.get('num_members', 1))
        
    #     if num_members < 1 or num_members > MAX_MEMBERS:
    #         return jsonify({"error": "Number of members must be between 1-20"}), 400

    #     # Create members list with default names
    #     members = [{"name": f"Member {i+1}"} for i in range(num_members)]
        
    #     # Use WalletManager to create wallet (keys stored in wallet_keys table)
    #     wallet = blockchain.wallets.create_wallet(
    #         family_id=hashlib.sha256(secrets.token_bytes(32)).hexdigest()[:24],
    #         members=members,
    #         crisis_id=blockchain.crisis_metadata['id'],
    #         passphrase=""  # Empty passphrase for development
    #     )
        
    #     logger.info(wallet.family_id)
        
    #     return jsonify(wallet.to_dict()), 201

    # except Exception as e:
    #     logger.error(f"Wallet creation error: {str(e)}")
    #     return jsonify({"error": "Wallet creation failed"}), 500
    ########### OLD

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

@app.route('/policy', methods=['GET'])
def get_current_policy():
    policy = blockchain.policy_system.get_policy()
    return jsonify(policy)

@app.route('/admin/policy', methods=['POST'])
@admin_required
def set_policy():
    data = request.json
    policy_id = data.get('policy_id')
    if policy_id in blockchain.policy_system.policies:
        blockchain.policy_system.current_policy = policy_id
        return jsonify({"status": "success", "policy": policy_id})
    return jsonify({"error": "Invalid Policy ID provided"}), 400

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

# NEW: Authentication endpoint that returns private key for client-side decryption
@app.route('/auth/unlock', methods=['POST'])
def unlock_wallet_endpoint():
    """
    Authenticate user and return private key for client-side decryption
    This is the ONLY server-side decryption - just for key delivery
    """
    try:
        data = request.json
        family_id = data.get('family_id')
        passphrase = data.get('passphrase', "")  # Empty for development
        
        if not family_id:
            return jsonify({"error": "Missing family_id"}), 400
        
        # Check if wallet exists
        wallet = blockchain.wallets.get_wallet(family_id)
        if not wallet:
            return jsonify({"error": "Wallet not found"}), 404
        
        # Authenticate and get private key
        private_key_str = blockchain.wallets.authenticate_and_get_private_key(family_id, passphrase)
        
        if private_key_str:
            return jsonify({
                "status": "unlocked",
                "private_key": private_key_str,  # Send key to React frontend
                "message": "Wallet unlocked - private key delivered for client-side decryption"
            })
        else:
            return jsonify({"error": "Invalid passphrase"}), 401
            
    except Exception as e:
        logger.error(f"Unlock error: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500

# Debug endpoints
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


@app.route('/wallet/<family_id>/public-key')
def get_wallet_public_key(family_id):
    """Get public key for a wallet (for encryption)"""
    try:
        public_key_str = blockchain.wallets.get_wallet_public_key(family_id)
        if public_key_str:
            return jsonify({
                "family_id": family_id,
                "public_key": public_key_str
            })
        else:
            return jsonify({"error": "Public key not found"}), 404
    except Exception as e:
        logger.error(f"Error getting public key: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
import hashlib
import json
from flask import Flask, request, jsonify, render_template, send_file
import time
import os
from functools import wraps
from blockchain import Blockchain, Transaction
from database import db_connection
import secrets
import qrcode
import base64
from io import BytesIO

# DEV NOTE: logging for development only
import logging
# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MAX_MEMBERS = 20                    # DEV NOTE: THIS SHOULD BE DEFINED IN THE BLOCKCHAIN ISNTANTIATION POLICY BY ADMIN

app = Flask(__name__)
blockchain = Blockchain()

# Admin token setup : this is for the organization hosting the entire KriSYS system for a given disaster
ADMIN_TOKEN = os.getenv('ADMIN_TOKEN', 'default_admin_token_please_change')

# Admin authentication decorator - this is for the blockchain provider, the agent hosting the entire chain
def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_token = request.headers.get('X-Admin-Token')
        if auth_token != ADMIN_TOKEN:
            return jsonify({"error": "UNAUTHORIZED: INVALID ADMIN TOKEN"}), 401
        return f(*args, **kwargs)
    return decorated_function

###### DEV NOTE: TEMPLATES - Flask automatically looks for templates in the /templates/ folder so /templates/scanner.html and /templates/index.html are correct as they are

# HTML browser to explore the public blockchain
@app.route('/')
def blockchain_explorer():
    return render_template('index.html')

# Scanner web interface
@app.route('/scanner')
def scanner_interface():
    return render_template('scanner.html')
#######

# Submissions from public queue
@app.route('/transaction', methods=['POST'])
def add_transaction():
    data = {}
    data = request.json
    if data:
        try:
            tx = Transaction(
                timestamp_created = data['timestamp_created'],
                station_address = data['station_address'],
                message_data = data['message_data'],
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
        
        # Generate family wallet ID
        family_id = hashlib.sha256(secrets.token_bytes(32)).hexdigest()[:24]
        
        # Generate member addresses
        members = []
        for i in range(num_members):
            member_id = f"{family_id}-{i}"
            members.append({
                "address": member_id,
                "label": f"Member {i+1}"
            })
        
        # Save to database DEV NOTE: simplified for now
        with db_connection() as conn:
            conn.execute(
                "INSERT INTO wallets (family_id, members) VALUES (?, ?)",
                (family_id, json.dumps(members))
            )
            conn.commit()
        
        return jsonify({"family_id": family_id, "members": members}), 201

    except Exception as e:
        logger.error(f"Wallet creation error: {str(e)}")
        return jsonify({"error": "Wallet creation failed"}), 500

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

if __name__ == '__main__':
    # Start background miner thread in production
    app.run(host='0.0.0.0', port=5000)
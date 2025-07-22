from flask import Flask, request, jsonify
from blockchain import Blockchain, Transaction

# DEV NOTE: logging for development only
import logging
logging.basicConfig(level=logging.INFO)


app = Flask(__name__)
blockchain = Blockchain()

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
            logging.error(f"Transaction error: {str(e)}")
            return jsonify({"error": "Internal server error"}), 500
    else:
        raise ValueError("add_transation() function can't build tx if data is not an object returned from the request it was provided.")
    
        

@app.route('/blockchain', methods=['GET'])
def get_chain():
    chain_data = [{
        "index": block.index,
        "timestamp": block.timestamp,
        "transactions": [tx.to_dict() for tx in block.transactions],
        "previous_hash": block.previous_hash,
        "hash": block.hash
    } for block in blockchain.chain]
    return jsonify(chain_data), 200

@app.route('/address/<string:address>', methods=['GET'])
def get_address_transactions(address):
    txs = []
    for block in blockchain.chain:
        for tx in block.transactions:
            if address in tx.related_addresses:
                txs.append(tx.to_dict())
    return jsonify(txs), 200

# Admin endpoint (simplified)
@app.route('/admin/mine', methods=['POST'])
def mine_block():
    if not blockchain.pending_transactions:
        return jsonify({"error": "No transactions to mine"}), 400
    block = blockchain.mine_block()
    return jsonify({"message": f"Block #{block.index} mined", "hash": block.hash}), 200

if __name__ == '__main__':
    # Start background miner thread in production
    app.run(host='0.0.0.0', port=5000)
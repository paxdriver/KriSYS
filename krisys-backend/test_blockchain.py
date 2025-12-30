import os
import tempfile
import time
import pytest
from blockchain import Blockchain, Transaction, POLICY

@pytest.fixture
def temp_db():
    # Create a temporary file for the database and set the environment variable.
    temp = tempfile.NamedTemporaryFile(delete=False)
    os.environ["BLOCKCHAIN_DB_PATH"] = temp.name
    yield temp
    temp.close()
    os.remove(temp.name)

def test_genesis_block_created(temp_db):
    blockchain = Blockchain()
    # Check that the chain has at least one block (the genesis block).
    assert len(blockchain.chain) >= 1
    genesis = blockchain.chain[0]
    assert genesis.block_index == 0
    assert genesis.transactions == []  # Genesis block usually has no transactions

def test_mining_block_and_validation(temp_db):
    blockchain = Blockchain()
    start_chain_length = len(blockchain.chain)
    
    # Add a transaction.
    tx = Transaction(
        timestamp_created=time.time(),
        station_address="station1",
        message_data="Test transaction",
        related_addresses=["address1"],
        type_field="test",
        priority_level=1
    )
    blockchain.add_transaction(tx)
    
    # Mine a new block manually.
    block = blockchain.mine_block()
    # Check that the block index is what we expect.
    assert block.block_index == start_chain_length
    # Validate the entire chain.
    assert blockchain.validate_chain() is True

def test_duplication_transaction(temp_db):
    blockchain = Blockchain()
    t = time.time()
    
    tx1 = Transaction(
        timestamp_created=t,
        station_address="station1",
        message_data="Transaction 1",
        related_addresses=["address1"],
        type_field="test",
        priority_level=1,
        transaction_id="unique123"
    )
    blockchain.add_transaction(tx1)
    
    tx2 = Transaction(
        timestamp_created=t,
        station_address="station1",
        message_data="Transaction 2",
        related_addresses=["address1"],
        type_field="test",
        priority_level=1,
        transaction_id="unique123"  # duplicate transaction_id
    )
    with pytest.raises(ValueError):
        blockchain.add_transaction(tx2)

def test_transaction_size_limit(temp_db):
    blockchain = Blockchain()
    # Build a message that will cause the JSON string size to exceed POLICY['max_tx_size']
    base_message = "a" * (POLICY["max_tx_size"])
    # Append extra characters to ensure it exceeds the limit after JSON encoding.
    oversize_message = base_message + "a"
    
    tx = Transaction(
        timestamp_created=time.time(),
        station_address="station1",
        message_data=oversize_message,
        related_addresses=["address1"],
        type_field="test",
        priority_level=1
    )
    with pytest.raises(ValueError):
        blockchain.add_transaction(tx)
import pgpy
from blockchain import Transaction
from app import blockchain
import time

family_id = "2176bc19271e2ff51612ed8f"
member_address = "2176bc19271e2ff51612ed8f-fe002447"

# Get wallet and member
wallet = blockchain.wallets.get_wallet(family_id)
member = next(m for m in wallet.members if m['address'] == member_address)

# Parse public key
pub_key = pgpy.PGPKey()
pub_key.parse(member['keypair_str'])
public_key = pub_key.pubkey

# Encrypt message
message = "Testing personal private message system. If you can read this, then it has been encrypted and decrypted successfully!"
encrypted_msg = public_key.encrypt(pgpy.PGPMessage.new(message))

# Send message
tx = Transaction(
    timestamp_created=time.time(),
    station_address="new_test_sender",
    message_data=str(encrypted_msg),
    related_addresses=["2176bc19271e2ff51612ed8f-fe002447"],
    type_field="message",
    priority_level=5
)

# Add message to blockchain
blockchain.add_transaction(tx)
print(f"Sent encrypted message to {member_address}\nMESSAGE: {message}")

time.sleep(3)

# force mining a block after transaction is added
blockchain.mine_and_save()
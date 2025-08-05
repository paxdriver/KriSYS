# /src/test_pgpwallet.py

from blockchain import Blockchain
blockchain = Blockchain()
wallet = blockchain.wallets.create_wallet("Driver_Family", [{"name": "Kris"}, {"name": "Nicole"}], "hurricane_response_2024")

print(f"Wallet ID: {wallet.family_id}")

# http://localhost:5000/wallet/dashboard/Driver_Family
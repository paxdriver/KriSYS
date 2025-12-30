# test_walletmanager.py
import unittest
import pgpy
from pgpy.constants import PubKeyAlgorithm, KeyFlags, HashAlgorithm, SymmetricKeyAlgorithm
from blockchain import Blockchain
import secrets
import time

class TestWalletManager(unittest.TestCase):
    def setUp(self):
        self.blockchain = Blockchain()
        self.wallet_manager = self.blockchain.wallets
        self.family_id = f"fam_test_{int(time.time())}_{secrets.token_hex(4)}"
        
    def create_valid_key(self):
        """Create properly initialized PGP key with User ID"""
        key = pgpy.PGPKey.new(PubKeyAlgorithm.RSAEncryptOrSign, 2048)
        uid = pgpy.PGPUID.new('Test User', comment='Test key')
        key.add_uid(
            uid,
            usage={KeyFlags.Sign, KeyFlags.EncryptCommunications},
            hashes=[HashAlgorithm.SHA256],
            ciphers=[SymmetricKeyAlgorithm.AES256]
        )
        return key.pubkey  # Return public key directly
        
    def test_wallet_lifecycle(self):
        # Create wallet
        wallet = self.wallet_manager.create_wallet(
            self.family_id, 
            [{"name": "John Doe"}]
        )
        self.assertIsNotNone(wallet)
        print(f"Created wallet: {self.family_id}")
        
        # Get wallet
        retrieved_wallet = self.wallet_manager.get_wallet(self.family_id)
        self.assertEqual(retrieved_wallet.family_id, self.family_id)
        print(f"Retrieved wallet: {retrieved_wallet.family_id}")
        
        # Generate valid public key
        public_key = self.create_valid_key()
        
        # Add device
        device_id = f"device_{secrets.token_hex(8)}"
        result = self.wallet_manager.add_device_to_wallet(
            self.family_id, 
            device_id, 
            public_key
        )
        self.assertTrue(result)
        print(f"Added device {device_id} to wallet")
        
        # Verify device was added
        updated_wallet = self.wallet_manager.get_wallet(self.family_id)
        self.assertEqual(len(updated_wallet.devices), 1)
        self.assertEqual(updated_wallet.devices[0]["device_id"], device_id)

    def tearDown(self):
        """Clean up test wallet"""
        self.wallet_manager.delete_wallet(self.family_id)

if __name__ == '__main__':
    unittest.main()
    
    
# To run test:
# docker cp ./src/test_walletmanager.py krisys_blockchain_1:/app/test_walletmanager.py
# docker exec -it krisys_blockchain_1 python test_walletmanager.py
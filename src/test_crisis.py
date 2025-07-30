# /src/test_crisis.py
import unittest
import time
from blockchain import Blockchain, Transaction
from app import app  # Import Flask app context

class CrisisSystemTest(unittest.TestCase):
    def setUp(self):
        self.blockchain = Blockchain()
        self.app = app.test_client()
        
    def test_1_wallet_creation(self):
        """Test family wallet creation"""
        response = self.app.post('/wallet', json={
            'num_members': 3
        })
        self.assertEqual(response.status_code, 201)
        wallet_data = response.json
        self.assertIn('family_id', wallet_data)
        self.assertEqual(len(wallet_data['members']), 3)
        print(f"✅ Created wallet: {wallet_data['family_id']}")

    def test_2_user_message(self):
        """Test user-to-user message transaction"""
        wallet = self._create_test_wallet()
        user_address = wallet['members'][0]['address']
        
        response = self.app.post('/transaction', json={
            'timestamp_created': time.time(),
            'station_address': 'user_device_123',
            'message_data': 'Family safe at shelter 5',
            'related_addresses': [user_address],
            'type_field': 'message',
            'priority_level': 5  # Personal message
        })
        self.assertEqual(response.status_code, 201)
        print("✅ User message transaction submitted")

    def test_3_station_checkin(self):
        """Test station check-in transaction"""
        response = self.app.post('/checkin', json={
            'address': 'family_123-member_1',
            'station_id': 'medical_station_3'
        })
        self.assertEqual(response.status_code, 201)
        print("✅ Station check-in completed")

    def test_4_admin_alert(self):
        """Test admin alert broadcast"""
        response = self.app.post('/admin/alert', json={
            'message': 'Evacuation order for zone B',
            'priority': 1  # Evacuation alert
        }, headers={'X-Admin-Token': 'valid_admin_token'})
        
        self.assertEqual(response.status_code, 201)
        print("✅ Admin alert broadcasted")

    def test_5_transaction_verification(self):
        """Verify transactions on blockchain"""
        # Mine pending transactions
        self.app.post('/admin/mine', headers={'X-Admin-Token': 'valid_admin_token'})
        
        chain = self.app.get('/blockchain').json
        self.assertGreater(len(chain), 0)
        
        # Find our test transactions
        user_msg_found = any(
            tx['type_field'] == 'message' and tx['message_data'] == 'Family safe at shelter 5'
            for block in chain 
            for tx in block['transactions']
        )
        
        admin_alert_found = any(
            tx['type_field'] == 'alert' and tx['message_data'] == 'Evacuation order for zone B'
            for block in chain 
            for tx in block['transactions']
        )
        
        self.assertTrue(user_msg_found, "User message not found on blockchain")
        self.assertTrue(admin_alert_found, "Admin alert not found on blockchain")
        print("✅ Transactions verified on blockchain")

    def _create_test_wallet(self):
        response = self.app.post('/wallet', json={'num_members': 1})
        return response.json

if __name__ == '__main__':
    unittest.main()
    

# TO RUN THIS TEST SCRIPT...
# docker cp test_crisis.py krisys_blockchain_1:/app/test_crisis.py
# docker exec -it krisys_blockchain_1 python test_crisis.py


# sqlite3 ./blockchain/blockchain.db "SELECT * FROM wallets"
// services/localStorage.js

/*
  LOCAL STORAGE FOR DISASTER COMMUNICATION
  
  This system stores everything locally so users can:
  1. Read old messages while offline
  2. Queue new messages for later transmission  
  3. Sync blockchain data with other nearby devices
  4. Relay messages for strangers when they get connectivity
 */

class DisasterStorage {
    constructor() {
        this.STORAGE_KEYS = {
            PRIVATE_KEY: 'krisys_private_key',
            WALLET_DATA: 'krisys_wallet_data', 
            BLOCKCHAIN: 'krisys_blockchain',
            MESSAGE_QUEUE: 'krisys_message_queue',
            PUBLIC_KEYS: 'krisys_public_keys', // Other people's keys for encryption
            SYNC_STATUS: 'krisys_sync_status'
        }
    }

    // PRIVATE KEY MANAGEMENT - Store locally for offline access
    savePrivateKey(familyId, privateKey) {
        console.log('💾 Storing private key locally for offline access')
        const keyData = {
            familyId: familyId,
            privateKey: privateKey,
            storedAt: Date.now(),
            // Add device identifier for multi-device sync later
            deviceId: this.getDeviceId()
        }
        
        localStorage.setItem(this.STORAGE_KEYS.PRIVATE_KEY, JSON.stringify(keyData))
        console.log('✅ Private key stored locally - user can read messages offline!')
    }

    getPrivateKey(familyId) {
        const stored = localStorage.getItem(this.STORAGE_KEYS.PRIVATE_KEY)
        if (!stored) {
            console.log('🔍 No private key found in local storage')
            return null
        }

        const keyData = JSON.parse(stored)
        if (keyData.familyId !== familyId) {
            console.log('⚠️ Stored key is for different family')
            return null
        }

        console.log('🔑 Retrieved private key from local storage')
        return keyData.privateKey
    }

    // BLOCKCHAIN STORAGE - Store entire blockchain locally
    saveBlockchain(blockchain) {
        console.log('⛓️ Storing blockchain locally for offline access')
        localStorage.setItem(this.STORAGE_KEYS.BLOCKCHAIN, JSON.stringify({
            blocks: blockchain,
            lastUpdated: Date.now()
        }))
    }

    getBlockchain() {
        const stored = localStorage.getItem(this.STORAGE_KEYS.BLOCKCHAIN)
        return stored ? JSON.parse(stored).blocks : []
    }

    // MESSAGE QUEUE - Store messages to send when connectivity returns
    queueMessage(message) {
        console.log('📤 Queueing message for transmission when online')
        const queue = this.getMessageQueue()
        queue.push({
            ...message,
            queuedAt: Date.now(),
            attempts: 0,
            status: 'pending'
        })
        localStorage.setItem(this.STORAGE_KEYS.MESSAGE_QUEUE, JSON.stringify(queue))
    }

    getMessageQueue() {
        const stored = localStorage.getItem(this.STORAGE_KEYS.MESSAGE_QUEUE)
        return stored ? JSON.parse(stored) : []
    }

    // PUBLIC KEYS - Store other wallets' keys for offline encryption
    savePublicKey(familyId, publicKey) {
        console.log('🔐 Storing public key for offline encryption')
        const keys = this.getPublicKeys()
        keys[familyId] = {
            publicKey: publicKey,
            storedAt: Date.now()
        }
        localStorage.setItem(this.STORAGE_KEYS.PUBLIC_KEYS, JSON.stringify(keys))
    }

    getPublicKeys() {
        const stored = localStorage.getItem(this.STORAGE_KEYS.PUBLIC_KEYS)
        return stored ? JSON.parse(stored) : {}
    }

    // DEVICE MANAGEMENT
    getDeviceId() {
        let deviceId = localStorage.getItem('krisys_device_id')
        if (!deviceId) {
            deviceId = 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
            localStorage.setItem('krisys_device_id', deviceId)
        }
        return deviceId
    }

    // UTILITY - Clear all data (for testing/reset)
    clearAll() {
        Object.values(this.STORAGE_KEYS).forEach(key => {
            localStorage.removeItem(key)
        })
        console.log('🗑️ Cleared all local storage')
    }
}

export const disasterStorage = new DisasterStorage()
// services/localStorage.js

/*
  LOCAL STORAGE FOR DISASTER COMMUNICATION
  
  This system stores everything locally so users can:
  1. Read old messages while offline
  2. Queue new messages for later transmission  
  3. Sync blockchain data with other nearby devices
  4. Relay messages for strangers when they get connectivity

  NOTE: FOR ACTUAL ENCRYPTION users can create their own keypair and use that extra private keypair as the passphrase, so that the decrypted response still needs to be decrypted once more by them manually to get the actual private key from the blockchain. then they can take messages from the blockchain, copy it to Kleopatra or whatever, and decrypt their messages manually without any chance of their private_key being unlocked by just the passphrase alone (but this is not the regular use case, just an option to upgrade from obfuscation to secure)
 */

class DisasterStorage {
    constructor() {
        this.STORAGE_KEYS = {
            PRIVATE_KEY: 'krisys_private_key',
            WALLET_DATA: 'krisys_wallet_data', 
            BLOCKCHAIN: 'krisys_blockchain',        // DEV NOTE: This should be pruned based on lastest timestamp or something down the road
            MESSAGE_QUEUE: 'krisys_message_queue',  // For message relaying when offline
            PUBLIC_KEYS: 'krisys_public_keys',      // Other people's keys for encryption
            SYNC_STATUS: 'krisys_sync_status',
            CONFIRMED_RELAYS: 'krisys_confirmed_relays' // relay_hash for offline message queues / confirmations
        }
    }

    deletePrivateKey(familyId) { // DEV NOTE: familyId might be needed if one device shared by a few families, but NOT at public device stations where users log in to public devices.
        console.log('Deleting invalid private key from localStorage')
        localStorage.removeItem(this.STORAGE_KEYS.PRIVATE_KEY)
    }

    // PRIVATE KEY MANAGEMENT - Store locally for offline access
    savePrivateKey(familyId, privateKey) {
        console.log('Storing private key locally for offline access')
        const keyData = {
            familyId: familyId,
            privateKey: privateKey,
            storedAt: Date.now(),
            // Add device identifier for multi-device sync later
            deviceId: this.getDeviceId()
        }
        
        localStorage.setItem(this.STORAGE_KEYS.PRIVATE_KEY, JSON.stringify(keyData))
        console.log('Private key stored locally - user can read messages offline!')
    }

    getPrivateKey(familyId) {
        const stored = localStorage.getItem(this.STORAGE_KEYS.PRIVATE_KEY)
        if (!stored) {
            console.log('No private key found in local storage')
            return null
        }

        const keyData = JSON.parse(stored)
        if (keyData.familyId !== familyId) {
            console.log('Stored key is for different family')
            return null
        }

        console.log('Retrieved private key from local storage')
        return keyData.privateKey
    }

    // BLOCKCHAIN STORAGE - Store entire blockchain locally
    saveBlockchain(blockchain) {
        console.log('Storing blockchain locally for offline access')
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
        console.log('Queueing message for transmission when online')
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

    // CONFIRMED MESSAGES (by relay_hash) -----------------------------
    getConfirmedRelays() {
        const stored = localStorage.getItem(
            this.STORAGE_KEYS.CONFIRMED_RELAYS
        )
        return stored ? JSON.parse(stored) : {}
    }

    isMessageConfirmed(relayHash) {
        if (!relayHash) return false
        const confirmed = this.getConfirmedRelays()
        return !!confirmed[relayHash]
    }

    markMessageConfirmed(relayHash, info = {}) {
        if (!relayHash) return
        const confirmed = this.getConfirmedRelays()
        confirmed[relayHash] = {
            confirmedAt: Date.now(),
            ...info
        }
        localStorage.setItem(
            this.STORAGE_KEYS.CONFIRMED_RELAYS,
            JSON.stringify(confirmed)
        )
        console.log(`Marked relay as confirmed: ${relayHash}`)
    }
    
    // Remove from the local queue any messages whose relay_hash has been marked as confirmed. Returns the new queue array. 
    pruneConfirmedFromQueue() {
        const queue = this.getMessageQueue()
        const confirmed = this.getConfirmedRelays()

        if (!queue.length || !Object.keys(confirmed).length) {
            return queue
        }

        const filtered = queue.filter(msg => {
            const rh = msg.relay_hash
            if (!rh) return true // keep items without relay_hash
            return !confirmed[rh]
        })

        localStorage.setItem(
            this.STORAGE_KEYS.MESSAGE_QUEUE,
            JSON.stringify(filtered)
        )

        console.log(
            `Pruned ${
                queue.length - filtered.length
            } confirmed messages from queue`
        )

        return filtered
    }
    // Syncing messages between blockchain diffs, used with pruneConfirmedFromQueue
    syncConfirmedFromTransactions(transactions) {
        if (!Array.isArray(transactions) || transactions.length === 0) {
            return
        }

        const confirmed = this.getConfirmedRelays()
        let updated = false

        for (const tx of transactions) {
            const relayHash = tx.relay_hash
            if (!relayHash || confirmed[relayHash]) {
                continue
            }

            confirmed[relayHash] = {
                confirmedAt: Date.now(),
                txId: tx.transaction_id,
                timestampPosted: tx.timestamp_posted
            }
            updated = true
        }

        if (updated) {
            localStorage.setItem(
                this.STORAGE_KEYS.CONFIRMED_RELAYS,
                JSON.stringify(confirmed)
            )
            this.pruneConfirmedFromQueue()
        }
    }

    // UTILITY - Clear all data (for testing/reset)
    clearAll() {
        Object.values(this.STORAGE_KEYS).forEach(key => {
            localStorage.removeItem(key)
        })
        console.log('Cleared all local storage')
    }
}

export const disasterStorage = new DisasterStorage()
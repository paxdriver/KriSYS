// services/keyManager.js
import { disasterStorage } from './localStorage'
import * as openpgp from 'openpgp'

export class KeyManager {
    static async validatePrivateKey(familyId, privateKey) {
        try {
            console.log('🔍 Validating private key for wallet...')
            
            // Get the public key for this wallet from server
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/wallet/${familyId}/public-key`)
            const { public_key } = await response.json()
            
            if (!public_key) {
                throw new Error('No public key found for wallet')
            }
            
            // Test message
            const testMessage = 'krisys_key_validation_test'
            
            // Encrypt with public key
            const publicKeyObj = await openpgp.readKey({ armoredKey: public_key })
            const message = await openpgp.createMessage({ text: testMessage })
            const encrypted = await openpgp.encrypt({
                message,
                encryptionKeys: publicKeyObj,
                format: 'armored'
            })
            
            // Try to decrypt with private key - DON'T decrypt the key again if already decrypted
            let privateKeyObj;
            try {
                privateKeyObj = await openpgp.readPrivateKey({ armoredKey: privateKey })
                // Check if key needs unlocking
                if (!privateKeyObj.isDecrypted()) {
                    privateKeyObj = await openpgp.decryptKey({
                        privateKey: privateKeyObj,
                        passphrase: '' // Empty for development
                    })
                }
            } catch (error) {
                console.error('Error preparing private key:', error)
                console.log(privateKeyObj)
                console.log(publicKeyObj)
                throw error
            }
            
            const encryptedMessage = await openpgp.readMessage({ armoredMessage: encrypted })
            const { data: decrypted } = await openpgp.decrypt({
                message: encryptedMessage,
                decryptionKeys: privateKeyObj,
                format: 'utf8'
            })
            
            const isValid = decrypted === testMessage
            console.log(isValid ? '✅ Private key validated' : '❌ Private key invalid')
            return isValid
            
        } catch (error) {
            console.error('❌ Key validation failed:', error)
            return false
        }
    }

    static async getPrivateKey(familyId, passphrase) {
        console.log('🔑 Getting private key for message decryption...')
        
        // 1. Check localStorage first
        let privateKey = disasterStorage.getPrivateKey(familyId)
        if (privateKey) {
            console.log('🔍 Found cached key, validating...')
            const isValid = await this.validatePrivateKey(familyId, privateKey)
            if (isValid) {
                console.log('✅ Using validated cached private key')
                return privateKey
            } else {
                console.log('🗑️ Cached key is invalid, removing...')
                disasterStorage.deletePrivateKey(familyId) // Add this method to disasterStorage
            }
        }
        
        // 2. Request from server (server decrypts with master key)
        console.log('🌐 Requesting private key from server...')
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/unlock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ family_id: familyId, passphrase: passphrase || '' })
            })
            const data = await response.json()
            
            if (!data.private_key) {
                throw new Error('No private key received from server')
            }
            
            // 3. The server returns the private key already decrypted from master key
            // But it might still be encrypted with user passphrase
            let actualPrivateKey = data.private_key
            
            // 4. Try to decrypt the passphrase if needed to get actual private key
            try {
                const keyObj = await openpgp.readPrivateKey({ armoredKey: actualPrivateKey })
                if (!keyObj.isDecrypted() && passphrase) {
                    const decryptedKeyObj = await openpgp.decryptKey({
                        privateKey: keyObj,
                        passphrase: passphrase
                    })
                    actualPrivateKey = decryptedKeyObj.armor()
                }
            } catch (error) {
                // If decryption fails, maybe the key is already decrypted
                console.log('Key might already be decrypted, proceeding with validation...')
            }
                        
            // 5. Validate the key before caching
            const isValid = await this.validatePrivateKey(familyId, actualPrivateKey)
            if (!isValid) {
                throw new Error('Retrieved private key does not match wallet')
            }
            
            // 6. Cache validated key in localStorage
            disasterStorage.savePrivateKey(familyId, actualPrivateKey)
            console.log('✅ Private key validated and cached locally')
            
            return actualPrivateKey
            
        } catch (error) {
            console.error('❌ Failed to get private key:', error)
            throw new Error(`Key retrieval failed: ${error.message}`)
        }
    }
}
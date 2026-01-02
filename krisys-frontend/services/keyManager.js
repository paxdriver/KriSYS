// services/keyManager.js
import { disasterStorage } from './localStorage'
import * as openpgp from 'openpgp'

export class KeyManager {
    // Validate private key against the wallet's public key (ONLINE ONLY)
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

            // Try to decrypt with private key
            let privateKeyObj

            try {
                privateKeyObj = await openpgp.readPrivateKey( {armoredKey: privateKey} )

                if (!privateKeyObj.isDecrypted()) {
                    privateKeyObj = await openpgp.decryptKey({
                        privateKey: privateKeyObj,
                        passphrase: '' // Empty for development
                    })
                }
            } 
            catch (error) {
                console.error('Error preparing private key:', error)
                throw error
            }

            const encryptedMessage = await openpgp.readMessage({
                armoredMessage: encrypted
            })
            const { data: decrypted } = await openpgp.decrypt({
                message: encryptedMessage,
                decryptionKeys: privateKeyObj,
                format: 'utf8'
            })

            const isValid = decrypted === testMessage
            console.log(isValid ? '✅ Private key validated': '❌ Private key invalid')
        
            return isValid
        } 
        catch (error) {
            console.error('❌ Key validation failed:', error)
        
            return false
        }
    }

    static async getPrivateKey(familyId, passphrase) {
        console.log('Getting private key for message decryption...')

        // 1. Check localStorage first (offline-friendly)
        const cachedKey = disasterStorage.getPrivateKey(familyId)
        if (cachedKey) {
            console.log('Found cached private key in local storage; using without re-validation (was validated when first stored).')
            return cachedKey
        }

        // 2. Request from server (online unlock / first time on this device)
        console.log('🌐 Requesting private key from server...')
        try {
            const response = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/auth/unlock`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        family_id: familyId,
                        passphrase: passphrase || ''
                    })
                }
            )
            const data = await response.json()

            if (!data.private_key) {
                throw new Error('No private key received from server')
            }

            // 3. The server returns the private key already decrypted from master key
            // But it might still be encrypted with user passphrase
            let actualPrivateKey = data.private_key

            // 4. Try to decrypt with passphrase if needed
            try {
                const keyObj = await openpgp.readPrivateKey({armoredKey: actualPrivateKey})
                if (!keyObj.isDecrypted() && passphrase) {
                    const decryptedKeyObj = await openpgp.decryptKey({
                        privateKey: keyObj,
                        passphrase: passphrase
                    })
                    actualPrivateKey = decryptedKeyObj.armor()
                }
            } 
            catch (error) {
                // If decryption fails, maybe the key is already decrypted
                console.log('Key might already be decrypted, proceeding with validation...')
            }

            // 5. Validate the key before caching (online only, once)
            const isValid = await KeyManager.validatePrivateKey(
                familyId,
                actualPrivateKey
            )
            if (!isValid) {
                throw new Error(
                    'Retrieved private key does not match wallet'
                )
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

    // Simple message decryption method
    static async decryptMessage(encryptedMessage, privateKey) {
        try {
            console.log('🔓 KeyManager decrypting message...')

            // Prepare private key
            let privateKeyObj = await openpgp.readPrivateKey({
                armoredKey: privateKey
            })

            // Unlock if needed
            if (!privateKeyObj.isDecrypted()) {
                privateKeyObj = await openpgp.decryptKey({
                    privateKey: privateKeyObj,
                    passphrase: '' // Empty for development
                })
            }

            // Decrypt message
            const messageObj = await openpgp.readMessage({armoredMessage: encryptedMessage})

            const { data: decrypted } = await openpgp.decrypt({
                message: messageObj,
                decryptionKeys: privateKeyObj,
                format: 'utf8'
            })

            console.log('✅ KeyManager decryption successful')

            return decrypted
        } 
        catch (error) {
            console.error('❌ KeyManager decryption failed:', error)
            throw new Error(`Decryption failed: ${error.message}`)
        }
    }

    // Encrypt message for sending
    static async encryptMessage(plaintext, recipientFamilyId) {
        try {
            console.log('🔐 KeyManager encrypting message...')

            // Get recipient's public key (from cache or server)
            const publicKeyString = await KeyManager.getPublicKey(recipientFamilyId)

            if (!publicKeyString) {
                throw new Error('No public key found for recipient')
            }

            // Encrypt
            const publicKey = await openpgp.readKey({
                armoredKey: publicKeyString
            })
            const message = await openpgp.createMessage({ text: plaintext })
            const encrypted = await openpgp.encrypt({
                message: message,
                encryptionKeys: publicKey,
                format: 'armored'
            })

            console.log('✅ KeyManager encryption successful!')

            return encrypted
        } 
        catch (error) {
            console.error('❌ KeyManager encryption failed:', error)
            throw new Error(`Encryption failed: ${error.message}`)
        }
    }

    // Get public key (from cache or server)
    static async getPublicKey(familyId) {
        // Check cache first
        const publicKeys = disasterStorage.getPublicKeys()
        const publicKeyString = publicKeys[familyId]?.publicKey

        if (publicKeyString) {
            console.log('📋 Using cached public key for family:', familyId)
            return publicKeyString
        }

        // Fetch from server if not in cache
        console.log('🌐 Fetching public key from server...')
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/wallet/${familyId}/public-key`)

        if (!response.ok) {
            throw new Error(`Failed to fetch public key: ${response.status}`)
        }

        const { public_key } = await response.json()

        if (public_key) {
            disasterStorage.savePublicKey(familyId, public_key)
            console.log('💾 Cached public key for future use')
            
            return public_key
        }

        throw new Error('No public key found for recipient family')
    }
}
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
            if (!response.ok) throw new Error(`Failed to fetch public key: ${response.status}`)
            
            const { public_key } = await response.json()
            if (!public_key) throw new Error('No public key found for wallet')
            disasterStorage.savePublicKey(familyId, public_key) // cache own private key if not already saved to localStorage

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

            const encryptedMessage = await openpgp.readMessage({ armoredMessage: encrypted })
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

        // 1) Check localStorage first (offline-friendly)
        const cachedKey = disasterStorage.getPrivateKey(familyId)
        if (cachedKey) {
            console.log('Found cached private key in local storage; using without re-validation.')
            return cachedKey
        }

        // 2) Request from server (online unlock / first time on this device)
        console.log('Requesting private key from server...')
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/unlock`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        family_id: familyId,
                        passphrase: passphrase || '',
                    }),
                }
            )

            const data = await response.json()

            if (!data.private_key) {
                throw new Error('No private key received from server')
            }

            let actualPrivateKey = data.private_key

            // 3) If needed, decrypt with passphrase (dev may use empty)
            try {
                const keyObj = await openpgp.readPrivateKey({armoredKey: actualPrivateKey,})

                if (!keyObj.isDecrypted() && passphrase) {
                    const decryptedKeyObj = await openpgp.decryptKey({
                        privateKey: keyObj,
                        passphrase: passphrase,
                    })
                    actualPrivateKey = decryptedKeyObj.armor()
                }
            } 
            catch {
                // If parsing/decryption fails, we still try validation below.
            }

            // 4) Validate (online) and cache wallet public key during validation
            const isValid = await KeyManager.validatePrivateKey(
                familyId,
                actualPrivateKey
            )
            if (!isValid) {
                throw new Error('Retrieved private key does not match wallet')
            }

            // 5) Cache validated private key locally
            disasterStorage.savePrivateKey(familyId, actualPrivateKey)

            // 6) Ensure wallet public key is cached (needed for offline send)
            // validatePrivateKey() already fetches/caches it, but we do this as a
            // belt-and-suspenders guarantee in case the unlock flow changes later.
            try {
                await KeyManager.getPublicKey(familyId)
            } 
            catch (e) {
                console.warn('Failed to cache wallet public key:', e)
            }

            // 7) Ensure crisis metadata is cached (needed for offline block verification)
            try {
                const crisisRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/crisis`)
                if (crisisRes.ok) {
                    const crisis = await crisisRes.json()
                    disasterStorage.saveCrisisMetadata(crisis)
                }
            } 
            catch (e) {
                console.warn('Failed to cache crisis metadata:', e)
            }

            console.log('Private key validated and cached locally')
            return actualPrivateKey
        } 
        catch (error) {
            console.error('Failed to get private key:', error)
            throw new Error(`Key retrieval failed: ${error.message}`)
        }
    }

    // Simple message decryption method
    static async decryptMessage(encryptedMessage, privateKey) {
        try {
            console.log('🔓 KeyManager decrypting message...')

            // Prepare private key
            let privateKeyObj = await openpgp.readPrivateKey({armoredKey: privateKey})

            // Unlock if needed
            if (!privateKeyObj.isDecrypted()) {
                privateKeyObj = await openpgp.decryptKey({
                    privateKey: privateKeyObj,
                    passphrase: '' // DEV NOTE: Empty for development
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
    static async encryptMessage(plaintext, recipientFamilyId, senderFamilyId) {
        try {
            console.log('🔐 KeyManager encrypting message...')

            // Get recipient's public key (from cache or server)
            const publicKeyString = await KeyManager.getPublicKey(recipientFamilyId)

            if (!publicKeyString) {
                throw new Error('No public key found for recipient')
            }

            // Encrypt
            const recipientKey = await openpgp.readKey({armoredKey: publicKeyString})

            // Encrypy for both recipient AND for sender, so sender can read sent messages in their own dashboards
            const encryptionKeys = [recipientKey]
            if (senderFamilyId && senderFamilyId !== recipientFamilyId) {    // de-depulication if message is family-to-family member
                const senderArmored = await KeyManager.getPublicKey(senderFamilyId)
                const senderKey = await openpgp.readKey({ armoredKey: senderArmored })
                encryptionKeys.push(senderKey)
            }
                
            // Encrypt once to all keys
            const message = await openpgp.createMessage({ text: plaintext })
            const encrypted = await openpgp.encrypt({
                message: message,
                encryptionKeys: encryptionKeys,
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
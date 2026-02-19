// services/keyManager.js
import { disasterStorage } from './localStorage'
import { sealStringWithPassphrase, unsealStringWithPassphrase } from './keySeal'
import * as openpgp from 'openpgp'

export class KeyManager {
	// Validate private key against the wallet's public key (ONLINE ONLY)
	static async validatePrivateKey({ crisisId, familyId, privateKey }) {
		try {
			console.log('Validating private key for wallet...')

			// Get the public key for this wallet from server
			const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/wallet/${familyId}/public-key`)
			if (!response.ok) throw new Error(`Failed to fetch public key: ${response.status}`)

			const { public_key } = await response.json()
			if (!public_key) throw new Error('No public key found for wallet')

			// Cache own private key if not already saved to localStorage (offline encryption dependency)
			disasterStorage.saveCachedPublicKey({
				crisisId,
				targetFamilyId: familyId,
				publicKey: public_key,
			})

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

			// If the private key is already decrypted, this will be a no-op
			let privateKeyObj = await openpgp.readPrivateKey({ armoredKey: privateKey })
			if (!privateKeyObj.isDecrypted()) {
				privateKeyObj = await openpgp.decryptKey({
					privateKey: privateKeyObj,
					passphrase: '' // DEV NOTE: Only allow empty passphrase during development
				})
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
		}
		catch (error) {
			console.error('❌ Wallet key validation failed:', error)

			return false
		}
	}

	static async getOrUnlockPrivateKey({ crisisId, familyId, passphrase }) {
		console.log('Getting private key for message decryption...')

		// 1) Check sessionStorage first (offline-friendly)
		const cachedKey = disasterStorage.getCachedPrivateKey({ crisisId, familyId })
		if (cachedKey) {
			console.log('Found cached private key in session storage; using without re-validation.')
			return cachedKey
		}

		// 2) Offline-first: try locally sealed blob before attempting remote HQ. This prevents the "refresh while HQ is down" stall.
		// DEV NOTE: If no cache, and HQ remote is down, only an HQ error is presented. This is ideal since advertising that keys may be stored locally on a shared device is not desireable anyway and would only affect the developer working on this. Hence this comment for if that should occur.
		const sealed = disasterStorage.getSealedPrivateKey({ crisisId, familyId })
		if (sealed) {
			if (!passphrase) throw new Error('Passphrase required to unlock wallet on this device')

			try {
				const unsealed = await unsealStringWithPassphrase({ sealed, passphrase })

				disasterStorage.saveCachedPrivateKey({
					crisisId,
					familyId,
					privateKey: unsealed,
				})

				console.log('Unlocked using local sealed key')
				return unsealed
			}
			catch (e) {
				// If this fails due to corruption, we can still recover by going online
				console.warn('Local sealed key unlock failed, attempting HQ unlock', e)
			}
		}

		// 3) Online unlock Request from server
		console.log('Requesting private key from server...')
		let response
		try {
			response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/unlock`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						crisis_id: crisisId,
						family_id: familyId,
						passphrase: passphrase || '',
					}),
				}
			)
		}
		catch (e) {
			throw new Error(`Key retrieval failed: ${e?.message || String(e)}`)
		}

		let data
		try {
			data = await response.json()
		} 
		catch {
			throw new Error(`Key retrieval failed: HQ returned invalid JSON`)
		}

		if (!response.ok) {
			const msg = data?.error || `HTTP ${response.status}`
			throw new Error(`Key retrieval failed: ${msg}`)
		}

		if (!data.private_key) {
			throw new Error('No private key received from HQ')
		}

		let actualPrivateKey = data.private_key

		// If needed, decrypt with passphrase (production path)
		try {
			const keyObj = await openpgp.readPrivateKey({
				armoredKey: actualPrivateKey,
			})

			if (!keyObj.isDecrypted() && passphrase) {
				const decryptedKeyObj = await openpgp.decryptKey({
					privateKey: keyObj,
					passphrase,
				})
				actualPrivateKey = decryptedKeyObj.armor()
			}
		} catch {
			// DEV TODO: Add error boundaries properly 
			// We'll still validate below
		}

		// 4) Validate (online) and cache wallet public key during validation
		const isValid = await KeyManager.validatePrivateKey({
			crisisId,
			familyId,
			privateKey: actualPrivateKey,
		})
		if (!isValid) {
			throw new Error('Retrieved private key does not match wallet')
		}

		// 5) Cache validated private key locally for this session
		disasterStorage.saveCachedPrivateKey({ crisisId, familyId, privateKey: actualPrivateKey })

		// 6) Ensure wallet public key is cached (needed for offline send)
		// validatePrivateKey() already fetches/caches it, but we do this as a
		// belt-and-suspenders guarantee in case the unlock flow changes later.
		try {
			await KeyManager.getPublicKey({ crisisId, targetFamilyId: familyId })
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

		// Persist sealed blob for offline unlock after refresh
		// Passphrase is required for sealing by design.
		if (passphrase) {
			const sealedObj = await sealStringWithPassphrase({
				plaintext: actualPrivateKey,
				passphrase,
			})

			disasterStorage.saveSealedPrivateKey({
				crisisId,
				familyId,
				sealed: sealedObj,
			})
		}

		console.log('Unlocked via HQ and cached locally')
		return actualPrivateKey
	}

	// Simple message decryption method
	static async decryptMessage(encryptedMessage, privateKey) {
		try {
			console.log('🔓 KeyManager decrypting message...')

			// Prepare private key
			let privateKeyObj = await openpgp.readPrivateKey({ armoredKey: privateKey })

			// Unlock if needed
			if (!privateKeyObj.isDecrypted()) {
				privateKeyObj = await openpgp.decryptKey({
					privateKey: privateKeyObj,
					passphrase: '' // DEV NOTE: Empty for development
				})
			}

			// Decrypt message
			const messageObj = await openpgp.readMessage({ armoredMessage: encryptedMessage })

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
	static async encryptMessage(plaintext, recipientFamilyId, senderFamilyId, crisisId) {
		try {
			console.log('🔐 KeyManager encrypting message...')

			// Get recipient's public key (from cache or server)
			const publicKeyString = await KeyManager.getPublicKey({ crisisId, targetFamilyId: recipientFamilyId })
			if (!publicKeyString) { throw new Error('No public key found for recipient') }

			// Encrypt
			const recipientKey = await openpgp.readKey({ armoredKey: publicKeyString })

			// Encrypy for both recipient AND for sender, so sender can read sent messages in their own dashboards
			const encryptionKeys = [recipientKey]
			if (senderFamilyId && senderFamilyId !== recipientFamilyId) {    // de-depulication if message is family-to-family member
				const senderArmored = await KeyManager.getPublicKey({ crisisId, targetFamilyId: senderFamilyId })
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
	static async getPublicKey({ crisisId, targetFamilyId }) {
		// Check cache first
		const publicKeys = disasterStorage.getCachedPublicKeys({ crisisId }) // Get all locally cached public keys stored on this device
		const publicKeyString = publicKeys[targetFamilyId]?.publicKey

		if (publicKeyString) {
			console.log('Using cached public key for family:', targetFamilyId)
			return publicKeyString
		}

		// Fetch from server if not in cache
		console.log('Fetching public key from server, not yet locally cached...')
		const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/wallet/${targetFamilyId}/public-key`)

		if (!response.ok) {
			throw new Error(`Failed to fetch public key: ${response.status}`)
		}

		const { public_key } = await response.json()
		if (public_key) {
			disasterStorage.saveCachedPublicKey({
				crisisId,
				targetFamilyId: targetFamilyId,
				publicKey: public_key,
			})
			console.log('Cached public key for future use...')

			return public_key
		}

		else { throw new Error('No public key found for recipient family') }    // 'else' is only for legibility
	}
}
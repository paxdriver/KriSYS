// services/localStorage.js
import { verifyBlockCanonical } from './blockVerifier'

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
			CONFIRMED_RELAYS: 'krisys_confirmed_relays', // relay_hash for offline message queues / confirmations
			CRISIS_METADATA: 'krisys_crisis_metadata'    // crisis id + block_public_key for offline block verification
		}

		// Emit an event to trigger re-render when localStorage is updated
		this.EVENTS = {
			QUEUE_UPDATED: 'krisys:queue_updated',
			CONFIRMED_UPDATED: 'krisys:confirmed_updated',
		}

		// Limits for incoming sync payloads to protect against abuse
		this.MAX_QUEUED_PER_PAYLOAD = 100
		this.MAX_CONFIRMED_PER_PAYLOAD = 500
		this.MAX_PER_ORIGIN = 50
		this.MAX_MESSAGE_LENGTH = 8192
		this.MAX_ADDRESSES_PER_TX = 16
		this.MAX_ADDRESS_LENGTH = 128
		this.MAX_STATION_ADDRESS_LENGTH = 128
		this.MAX_TYPE_FIELD_LENGTH = 32

		// Sealed key hygiene:
		// - Sealed keys exist to allow offline unlock after refresh (HQ down)
		// - We don't want sealed blobs to accumulate forever on shared computers
		this.SEALED_CLEANUP_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000
		this.SEALED_CLEANUP_KEY = 'krisys:lastSealedKeyCleanupAt'

		this.cleanupSealedPrivateKeysIfNeeded()
	}

	_listSealedPrivateKeyStorageKeys() {
		if (typeof window === 'undefined') return []
		// We keep this scan narrow: only KriSYS keys, only sealed private keys
		const keys = Object.keys(localStorage)
		return keys.filter((k) => k.startsWith('krisys:') && k.includes(':private_key_sealed'))
	}

	clearSealedPrivateKeys() {
		if (typeof window === 'undefined') return 0

		const keys = this._listSealedPrivateKeyStorageKeys()
		for (const k of keys) localStorage.removeItem(k)

		return keys.length
	}

	cleanupSealedPrivateKeysIfNeeded() {
		if (typeof window === 'undefined') return

		// Some browsers/environments can throw on localStorage access
		try {
			const now = Date.now()
			const last = Number(localStorage.getItem(this.SEALED_CLEANUP_KEY) || 0)

			if (!last || now - last > this.SEALED_CLEANUP_INTERVAL_MS) {
				const deleted = this.clearSealedPrivateKeys()
				localStorage.setItem(this.SEALED_CLEANUP_KEY, String(now))

				if (deleted > 0) {
					console.log(`Sealed key hygiene: removed ${deleted} sealed key blob(s)`)
				}
			}
		} catch (e) {
			// Hygiene failure should never break the app
			console.warn('Sealed key hygiene failed:', e)
		}
	}

	// Sealed private key storage (localStorage)
	// - This is NOT plaintext
	// - It is encrypted using the user's passphrase (PBKDF2 + AES-GCM)
	// - Used only when HQ is unreachable (offline unlock after refresh)
	saveSealedPrivateKey({ crisisId, familyId, sealed }) {
		const key = this._walletKey({
			crisisId,
			familyId,
			bucket: 'private_key_sealed',
		})

		this._setJson(key, sealed)
	}

	getSealedPrivateKey({ crisisId, familyId }) {
		const key = this._walletKey({
			crisisId,
			familyId,
			bucket: 'private_key_sealed',
		})

		return this._getJson(key, null)
	}

	deleteSealedPrivateKey({ crisisId, familyId }) {
		if (typeof window === 'undefined') return

		const key = this._walletKey({
			crisisId,
			familyId,
			bucket: 'private_key_sealed',
		})

		localStorage.removeItem(key)
	}

	// global pointer so we can find the active crisis offline
	ACTIVE_CRISIS_ID_KEY = 'krisys:activeCrisisId'

	// Namespacing crises on device cache -----------
	_requireCrisisId(crisisId) {
		if (typeof crisisId !== 'string' || !crisisId.trim()) {
			throw new Error('disasterStorage: crisisId is required')
		}
		return crisisId.trim()
	}
	_requireFamilyId(familyId) {
		if (typeof familyId !== 'string' || !familyId.trim()) {
			throw new Error('disasterStorage: familyId is required')
		}
		return familyId.trim()
	}
	_sharedKey({ crisisId, bucket }) {
		return this._buildKey({ crisisId, domainType: 'shared', bucket })
	}
	_walletKey({ crisisId, familyId, bucket }) {
		const fid = this._requireFamilyId(familyId)
		return this._buildKey({
			crisisId,
			domainType: `wallet:${fid}`,
			bucket,
		})
	}
	_getJson(key, fallback) {
		if (typeof window === 'undefined') return null
		const raw = localStorage.getItem(key)
		if (!raw) return fallback
		try {
			return JSON.parse(raw)
		} catch {
			return fallback
		}
	}
	_setJson(key, value) {
		if (typeof window === 'undefined') return null
		localStorage.setItem(key, JSON.stringify(value))
	}
	// -----------------------------

	setActiveCrisisId(crisisId) {
		if (typeof window === 'undefined') return null
		const cid = this._requireCrisisId(crisisId)
		localStorage.setItem(this.ACTIVE_CRISIS_ID_KEY, cid)
	}

	getActiveCrisisId() {
		if (typeof window === 'undefined') return null
		const cid = localStorage.getItem(this.ACTIVE_CRISIS_ID_KEY)
		return typeof cid === 'string' && cid.trim() ? cid.trim() : null
	}

	// DEV NOTE: Consider changing this to a custom hook to allow re-renders throughout the app on custom event emissions if needed in other parts of the app
	_emit(eventName, detail = undefined) {
		try {
			if (typeof window === 'undefined') return
			window.dispatchEvent(new CustomEvent(eventName, { detail }))
		}
		catch {
			// Ignore event failures; storage is still the source of truth.
		}
	}
	// DEV NOTE: NOT FOR PROD, NAMESPACE FOR PROD!!!
	// Keep device id (identity for relay/origin) and contacts (separate storage).
	// Clear everything that would be invalid across a new genesis/trust anchor.
	_clearCrisisScopedData() {
		const keysToClear = [
			this.STORAGE_KEYS.PRIVATE_KEY,
			this.STORAGE_KEYS.WALLET_DATA,
			this.STORAGE_KEYS.BLOCKCHAIN,
			this.STORAGE_KEYS.MESSAGE_QUEUE,
			this.STORAGE_KEYS.PUBLIC_KEYS,
			this.STORAGE_KEYS.SYNC_STATUS,
			this.STORAGE_KEYS.CONFIRMED_RELAYS,
			this.STORAGE_KEYS.CRISIS_METADATA,
		]

		for (const key of keysToClear) {
			try {
				localStorage.removeItem(key)
			} catch (e) {
				// ignore
			}
		}
	}

	// krisys:<crisisId>:domain:<domainType>:<bucket>
	_buildKey({ crisisId, domainType, bucket }) {
		const cid = this._requireCrisisId(crisisId)
		if (typeof domainType !== 'string' || !domainType.trim()) {
			throw new Error('disasterStorage: domainType is required')
		}
		if (typeof bucket !== 'string' || !bucket.trim()) {
			throw new Error('disasterStorage: bucket is required')
		}
		return `krisys:${cid}:domain:${domainType}:${bucket.trim()}`
	}


	// Sanitize and bound an incoming sync payload (queued + confirmed)
	sanitizeSyncPayload({ crisisId, familyId, payload }) {
		// require explicit context
		if (!payload || typeof payload !== 'object') {
			return { queued: [], confirmed: {} }
		}

		const rawQueued = Array.isArray(payload.queued)
			? payload.queued
			: []
		const rawConfirmed =
			payload.confirmed && typeof payload.confirmed === 'object'
				? payload.confirmed
				: {}

		const now = Date.now()
		const oneDayMs = 24 * 60 * 60 * 1000

		const sanitizedQueued = []
		const perOriginCount = {}

		// Build a quick lookup set of existing relay_hash values in our queue
		const localQueue = this.getMessageQueue({ crisisId, familyId })
		// use namespaced queue + confirmed
		const localRelayHashes = new Set(
			localQueue.map((m) => m && m.relay_hash)
				.filter((rh) => typeof rh === 'string' && rh.length > 0)
		)

		// Helper to check string length
		const isString = (v) => typeof v === 'string'
		const clampLength = (s, max) =>
			s.length <= max ? s : s.slice(0, max)

		// Sanitize queued messages
		for (const msg of rawQueued) {
			if (!msg || typeof msg !== 'object' ||
				sanitizedQueued.length >= this.MAX_QUEUED_PER_PAYLOAD) {
				break
			}

			const relayHash = msg.relay_hash
			if (!isString(relayHash) || !relayHash.trim()) {
				continue
			}

			// Skip if already confirmed locally
			if (this.isMessageConfirmed({ crisisId, relayHash })) continue

			// Skip if we already have this relay in our queue
			if (localRelayHashes.has(relayHash)) {
				continue
			}

			// Per-origin device quota
			const origin = isString(msg.origin_device) ?
				msg.origin_device : 'unknown'
			perOriginCount[origin] = (perOriginCount[origin] || 0) + 1
			if (perOriginCount[origin] > this.MAX_PER_ORIGIN) continue

			// Basic type/shape checks
			const ts = Number(msg.timestamp_created)
			if (!Number.isFinite(ts)) continue
			const tsMs = ts * 1000
			if (tsMs < 0 || tsMs > now + oneDayMs) continue

			const priority = Number(msg.priority_level)
			if (!Number.isFinite(priority)) continue
			if (priority < 1 || priority > 5) continue

			const stationAddr = msg.station_address
			if (!isString(stationAddr)) continue

			let typeField = msg.type_field
			if (!isString(typeField)) continue
			typeField = clampLength(typeField, this.MAX_TYPE_FIELD_LENGTH)

			const messageData = msg.message_data
			if (!isString(messageData)) continue
			if (messageData.length > this.MAX_MESSAGE_LENGTH) continue

			// Ensure related_addresses is an array, filter out invalid entries,
			// limit to MAX_ADDRESSES_PER_TX, and truncate each address to MAX_ADDRESS_LENGTH
			let related = Array.isArray(msg.related_addresses) ?
				msg.related_addresses : []
			related = related.filter((a) => isString(a) && a.length > 0)
				.slice(0, this.MAX_ADDRESSES_PER_TX)
				.map((a) =>
					a.length > this.MAX_ADDRESS_LENGTH ?
						a.slice(0, this.MAX_ADDRESS_LENGTH) : a
				)

			const normalized = {
				relay_hash: relayHash,
				timestamp_created: ts,
				station_address: clampLength(
					stationAddr,
					this.MAX_STATION_ADDRESS_LENGTH
				),
				message_data: messageData,
				related_addresses: related,
				type_field: typeField,
				priority_level: priority,
				origin_device: origin,
				// Preserve attempts/status/queuedAt if present, with defaults
				status: msg.status || 'pending',
				attempts:
					typeof msg.attempts === 'number'
						? msg.attempts
						: 0,
				queuedAt:
					typeof msg.queuedAt === 'number'
						? msg.queuedAt
						: now
			}

			sanitizedQueued.push(normalized)
		}

		// 2) Sanitize confirmed-relay map (lightly)
		const sanitizedConfirmed = {}
		const confirmedEntries = Object.entries(rawConfirmed)
		for (let i = 0; i < confirmedEntries.length; i++) {
			if (i >= this.MAX_CONFIRMED_PER_PAYLOAD) break
			const [relayHash, info] = confirmedEntries[i]
			if (!isString(relayHash) || !relayHash.trim()) continue
			if (!info || typeof info !== 'object') continue

			// Optionally clamp confirmedAt / timestampPosted
			const cleanInfo = { ...info }
			if (typeof cleanInfo.confirmedAt === 'number') {
				if (cleanInfo.confirmedAt < 0 ||
					cleanInfo.confirmedAt > now + oneDayMs) {
					delete cleanInfo.confirmedAt
				}
			}
			if (typeof cleanInfo.timestampPosted === 'number') {
				if (cleanInfo.timestampPosted < 0 || cleanInfo.timestampPosted > (now + oneDayMs) / 1000) {
					delete cleanInfo.timestampPosted
				}
			}

			sanitizedConfirmed[relayHash] = cleanInfo
		}

		return {
			queued: sanitizedQueued,
			confirmed: sanitizedConfirmed
		}
	}

	// PRIVATE KEY MANAGEMENT - Store locally for offline access (MOVED TO SESSION STORAGE)
	clearSession() {
		if (typeof window === 'undefined') return
		sessionStorage.clear()
	}
	_getSessionJson(key) {
		if (typeof window === 'undefined') return null
		const raw = sessionStorage.getItem(key)
		if (!raw) return null
		try { return JSON.parse(raw) } catch { return null }
	}
	_setSessionJson(key, value) {
		if (typeof window === 'undefined') return
		sessionStorage.setItem(key, JSON.stringify(value))
	}
	saveCachedPrivateKey({ crisisId, familyId, privateKey }) {
		const key = this._walletKey({
			crisisId,
			familyId,
			bucket: 'private_key',
		})
		this._setSessionJson(key, {
			familyId,
			privateKey,
			storedAt: Date.now(),
			deviceId: this.getDeviceId(),
		})
	}
	getCachedPrivateKey({ crisisId, familyId }) {
		const key = this._walletKey({
			crisisId,
			familyId,
			bucket: 'private_key',
		})
		const obj = this._getSessionJson(key)
		if (!obj || typeof obj.privateKey !== 'string') return null

		return obj.privateKey
	}
	deleteCachedPrivateKey({ crisisId, familyId }) {
		if (typeof window === 'undefined') return
		const key = this._walletKey({
			crisisId,
			familyId,
			bucket: 'private_key',
		})
		sessionStorage.removeItem(key)
	}

	// WALLET DATA STORAGE - per-family cached wallet metadata for offline use
	saveWalletData({ crisisId, familyId, walletData }) {
		console.log('Storing wallet metadata locally for offline access')
		const key = this._walletKey({
			crisisId,
			familyId,
			bucket: 'wallet_data',
		})

		this._setJson(key, {
			data: walletData,
			storedAt: Date.now(),
		})
	}

	getWalletData({ crisisId, familyId }) {
		try {
			const key = this._walletKey({
				crisisId,
				familyId,
				bucket: 'wallet_data',
			})

			const obj = this._getJson(key, null)
			return obj?.data || null
		}
		catch (e) {
			console.error('Failed to parse cached wallet data:', e)
			return null
		}
	}

	// CRISIS METADATA STORAGE - e.g. crisis id, name, block_public_key
	saveCrisisMetadata(meta) {
		try {
			// Get the old crisis metadata before we write the new one
			const prev = this.getCrisisMetadata()

			const next = {
				id: meta.id || meta.crisis_id || null,
				name: meta.name || null,
				organization: meta.organization || null,
				contact: meta.contact || null,
				description: meta.description || null,
				created_at: meta.created_at || null,
				// Backend may expose this as block_public_key or public_key; normalize here
				block_public_key: meta.block_public_key || meta.public_key || null,
				storedAt: Date.now(),
			}

			if (!next.id) throw new Error('saveCrisisMetadata: missing crisis id')

			// set global active pointer for offline bootstrapping
			this.setActiveCrisisId(next.id)

			// store crisis metadata in shared domain under this crisisId
			const key = this._sharedKey({
				crisisId: next.id,
				bucket: 'crisis_metadata',
			})
			this._setJson(key, next)
		}
		catch (e) {
			console.error('Failed to save crisis metadata:', e)
		}
	}
	getCrisisMetadata({ crisisId } = {}) {
		// allow explicit crisisId, else fall back to active pointer
		const cid = typeof crisisId === 'string' && crisisId.trim() ?
			crisisId.trim() : this.getActiveCrisisId()

		if (!cid) return null

		const key = this._sharedKey({ crisisId: cid, bucket: 'crisis_metadata' })
		return this._getJson(key, null)
	}

	// BLOCKCHAIN STORAGE - Store entire blockchain locally
	// DEV / TODO: battery-saving + pruning strategy
	/*
		Phase 3+ (later work), we will extend this to:
		- Respect a user "battery saving mode" toggle that controls how
		  aggressively the app scans neighbours (Bluetooth/Wi‑Fi/WebRTC)
		  for new sync payloads and blocks. That scanning logic will live
		  in higher-level hooks/services, but it will use this storage
		  (BLOCKCHAIN + WALLET_DATA + MESSAGE_QUEUE) as its backing store.
	    
		- Add pruning rules so we do NOT keep the full chain forever on
		  each device. Examples:
			* Only keep the last N blocks or last M days.
			* Apply a size budget per device (e.g. max X MB for chain data).
			* Prefer keeping blocks that contain this wallet’s own
			  transactions over totally unrelated history.
	    
			  Right now we:
			- dump the full canonical chain into localStorage,
			- never prune it,
	    
			This is acceptable for small dev chains, but MUST be revisited before production / large deployments.
	*/

	// require crisisId explicitly
	saveBlockchain({ crisisId, blocks }) {
		const key = this._sharedKey({ crisisId, bucket: 'blocks' })

		this._setJson(key, {
			blocks,
			lastUpdated: Date.now(),
		})
	}

	getBlockchain({ crisisId }) {
		if (!crisisId) return null
		try {
			const key = this._sharedKey({ crisisId, bucket: 'blocks' })
			const parsed = this._getJson(key, null)
			return parsed?.blocks || []
		}
		catch (e) {
			console.error('Failed to parse cached blockchain:', e)
			return []
		}
	}

	// MESSAGE QUEUE - Store messages to send when connectivity returns
	queueMessage({ crisisId, familyId, message }) {
		const key = this._walletKey({
			crisisId,
			familyId,
			bucket: 'queue',
		})

		const queue = this._getJson(key, [])

		queue.push({
			...message,
			queuedAt: Date.now(),
			attempts: 0,
			status: 'pending',
		})

		this._setJson(key, queue)
		// Fire an event to trigger re-render of memoized values
		this._emit(this.EVENTS.QUEUE_UPDATED, { source: 'queueMessage' })
	}

	getMessageQueue({ crisisId, familyId }) {
		const key = this._walletKey({
			crisisId,
			familyId,
			bucket: 'queue',
		})
		return this._getJson(key, [])
	}

	// add a setter so call sites (like processQueue) never write raw keys
	setMessageQueue({ crisisId, familyId, queue }) {
		const key = this._walletKey({
			crisisId,
			familyId,
			bucket: 'queue',
		})
		this._setJson(key, Array.isArray(queue) ? queue : [])
		this._emit(this.EVENTS.QUEUE_UPDATED, { source: 'setMessageQueue' })
	}

	// PUBLIC KEYS - Store other wallets' keys for offline encryption
	saveCachedPublicKey({ crisisId, targetFamilyId, publicKey }) {
		const key = this._sharedKey({
			crisisId,
			bucket: 'public_keys',
		})

		const keys = this._getJson(key, {})
		keys[targetFamilyId] = {
			publicKey,
			storedAt: Date.now(),
		}
		this._setJson(key, keys)
	}
	getCachedPublicKeys({ crisisId }) {
		const key = this._sharedKey({
			crisisId,
			bucket: 'public_keys',
		})
		return this._getJson(key, {})
	}

	// DEVICE MANAGEMENT
	getDeviceId() {
		let deviceId = localStorage.getItem('krisys_device_id')
		if (!deviceId) {
			// DEV NOTE: CHANGE THIS TO UUID!!!
			deviceId = 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
			localStorage.setItem('krisys_device_id', deviceId)
		}
		return deviceId
	}

	// CONFIRMED MESSAGES (by relay_hash) -----------------------------
	getConfirmedRelays({ crisisId }) {
		const key = this._sharedKey({ crisisId, bucket: 'confirmed_relays' })
		return this._getJson(key, {})
	}

	isMessageConfirmed({ crisisId, relayHash }) {
		if (!relayHash) return false
		const confirmed = this.getConfirmedRelays({ crisisId })
		return !!confirmed[relayHash]
	}

	markMessageConfirmed({ crisisId, relayHash, info = {} }) {
		if (!relayHash) return

		const key = this._sharedKey({ crisisId, bucket: 'confirmed_relays' })
		const confirmed = this._getJson(key, {})

		confirmed[relayHash] = {
			confirmedAt:
				typeof info.timestampPosted === 'number'
					? info.timestampPosted * 1000
					: Date.now(),
			...info,
		}

		this._setJson(key, confirmed)
		// Fire an event to trigger re-render of memoized values
		this._emit(this.EVENTS.CONFIRMED_UPDATED, {
			source: 'markMessageConfirmed',
		})
	}

	// Remove from the local queue any messages whose relay_hash has been marked as confirmed. Returns the new queue array.
	// fully namespaced, wallet-domain queue + shared confirmed relays
	pruneConfirmedFromQueue({ crisisId, familyId }) {
		const queue = this.getMessageQueue({ crisisId, familyId })
		const confirmed = this.getConfirmedRelays({ crisisId })

		if (!queue.length || !Object.keys(confirmed).length) {
			return queue
		}

		const filtered = queue.filter((msg) => {
			const rh = msg.relay_hash

			// drop queued messages if this messaged was successfully relayed to blockchain
			if (!rh) return true // keep items without relay_hash

			// drop messages if they're confirmed on the blockchain
			return !confirmed[rh]
		})

		this.setMessageQueue({
			crisisId,
			familyId,
			queue: filtered,
		})

		// DEV LOG
		console.log(`Pruned ${queue.length - filtered.length} confirmed messages from queue`)

		return filtered
	}

	// Syncing messages between blockchain diffs, used with pruneConfirmedFromQueue
	// fully namespaced, shared confirmed relays + wallet-domain queue
	syncConfirmedFromTransactions({ crisisId, familyId, transactions }) {
		if (!Array.isArray(transactions) || transactions.length === 0) {
			return
		}

		const confirmed = this.getConfirmedRelays({ crisisId })
		let updated = false

		for (const tx of transactions) {
			const relayHash = tx.relay_hash
			if (!relayHash || confirmed[relayHash]) {
				continue
			}

			confirmed[relayHash] = {
				confirmedAt: Date.now(),
				txId: tx.transaction_id,
				timestampPosted: tx.timestamp_posted,
			}
			updated = true
		}

		if (updated) {
			// write back to shared-domain confirmed relays
			const key = this._sharedKey({ crisisId, bucket: 'confirmed_relays' })
			this._setJson(key, confirmed)
			// Fire event to trigger re-render
			this._emit(this.EVENTS.CONFIRMED_UPDATED, { source: 'syncConfirmedFromTransactions', })

			this.pruneConfirmedFromQueue({ crisisId, familyId })
		}
	}

	/*  Build a payload to sync with another device (in DEV use 2 different browsers so they don't share localStorage)

		The chain_tip + blocks fields are placeholders that we will start
		filling and merging in a later step when we implement full
		block-level mesh sync between devices.

		NOTE: This payload is intentionally self-contained and versioned so
		that:
			- older clients can ignore newer fields safely,
			- we can extend it as we add features (battery-saving modes,
			  pruning policies, partial chain segments, etc.).
	*/
	exportSyncPayload({ crisisId, familyId }) {
		const queue = this.getMessageQueue({ crisisId, familyId })
		const confirmed = this.getConfirmedRelays({ crisisId })

		// Only pending messages that are not already confirmed
		let queuedForSync = queue.filter((msg) => msg.status === 'pending' &&
			!this.isMessageConfirmed({ crisisId, relayHash: msg.relay_hash })
		)

		// Bound queued payload size (prevents huge P2P messages)
		queuedForSync = queuedForSync.slice(0, this.MAX_QUEUED_PER_PAYLOAD)
		// Bound confirmed map size deterministically (sorted keys)
		const confirmedKeys = Object.keys(confirmed || {}).sort()
		const limitedConfirmed = {}
		for (let i = 0; i < confirmedKeys.length; i++) {
			if (i >= this.MAX_CONFIRMED_PER_PAYLOAD) break
			const k = confirmedKeys[i]
			limitedConfirmed[k] = confirmed[k]
		}
		// DEV NOTE: WebRTC messages can be large, but you don’t want to depend on that. This bounds risk up-front


		// Crisis metadata (if we have it) for sanity-checking that peers are syncing the same crisis / blockchain.
		const crisisMeta = this.getCrisisMetadata({ crisisId })

		// Look at our locally cached blockchain to expose a simple "tip" pointer and a small suffix of canonical blocks.
		const blocks = this.getBlockchain({ crisisId }) || []
		const lastBlock = Array.isArray(blocks) && blocks.length > 0 ?
			blocks[blocks.length - 1] : null

		// Share only the last N canonical blocks to limit payload size. 
		// later we can make this configurable (battery / storage policy).
		const MAX_BLOCKS_SHARE = 10
		const blocksToShare =
			Array.isArray(blocks) && blocks.length > 0 ?
				blocks.slice(-MAX_BLOCKS_SHARE) : []

		return {
			version: 1,
			deviceId: this.getDeviceId(),
			crisisId: crisisMeta ? crisisMeta.id : crisisId,
			generatedAt: Date.now(),
			chain_tip: lastBlock
				? {
					block_index: lastBlock.block_index,
					hash: lastBlock.hash,
					previous_hash: lastBlock.previous_hash,
				}
				: null,
			blocks: blocksToShare,
			queued: queuedForSync,
			confirmed: limitedConfirmed,
		}
	}

	/*  Merge another device's sync payload into local storage.
			- Incorporates their confirmed relays
			- Adds any new, unconfirmed queued messages we don't already have
			- Then prunes any messages that are now confirmed
	*/

	// DEV NOTE: importSyncPayload will be deprecated as offline transaction handling is fleshed out in importSyncPayloadAsync
	importSyncPayload({ crisisId, familyId, payload }) {
		// Sanitize and bound incoming payload first
		const { queued: incomingQueued, confirmed: incomingConfirmed } = this.sanitizeSyncPayload({ crisisId, familyId, payload })

		if (!Array.isArray(incomingQueued) || typeof incomingConfirmed !== 'object') {
			return
		}

		/* 1) Merge confirmed-relay map
			- Takes the incoming confirmed object.
			- For each relayHash:
			  - If you have no local entry, you store theirs.
			  - If you both have entries and both have confirmedAt,
				you keep the one with the earlier confirmedAt (not strictly
				required, but keeps deterministic-ish data).
			- Writes back the merged CONFIRMED_RELAYS if anything changed.
		*/
		const localConfirmed = this.getConfirmedRelays({ crisisId })
		let confirmedChanged = false

		for (const [relayHash, info] of Object.entries(incomingConfirmed)) {
			if (!relayHash) continue

			const existing = localConfirmed[relayHash]
			if (!existing) {
				// No local entry yet: just take incoming
				localConfirmed[relayHash] = info
				confirmedChanged = true
			}
			else {
				// If both have entries, keep the earlier confirmedAt if provided
				const existingTime = existing.confirmedAt || Infinity   // DEV NOTE: inspect this for logic before production. Not confident in this code but busy refactoring, don't wanna get sidetracked
				const incomingTime = info.confirmedAt || existingTime
				if (incomingTime < existingTime) {
					localConfirmed[relayHash] = {
						...existing,
						...info
					}
					confirmedChanged = true
				}
			}
		}

		if (confirmedChanged) {
			const key = this._sharedKey({ crisisId, bucket: 'confirmed_relays' })
			this._setJson(key, localConfirmed)
			// Fire event to trigger re-render
			this._emit(this.EVENTS.CONFIRMED_UPDATED, { source: 'importSyncPayload' })
		}

		/* 2) Merge incoming queued messages
			- Takes sanitized queued (list of messages).
			- For each incoming message:
				- Skips if relay_hash is already confirmed (sanitizer mostly did this).
				- Skips if there is already a message in your queue with that relay_hash.
				- Otherwise, appends it to your queue.
			- Saves updated queue if anything changed.
		*/
		let queue = this.getMessageQueue({ crisisId, familyId })
		let queueChanged = false

		for (const msg of incomingQueued) {
			const relayHash = msg.relay_hash
			if (!relayHash) continue

			// Skip if already confirmed (locally or after merge above)
			if (this.isMessageConfirmed({ crisisId, relayHash })) continue

			// Skip if we already have this relay in our queue
			const already = queue.find(existing => existing.relay_hash === relayHash)
			if (already) continue

			// msg is already normalized by sanitizeSyncPayload
			queue.push(msg)
			queueChanged = true
		}

		if (queueChanged) {
			this.setMessageQueue({
				crisisId,
				familyId,
				queue,
			})
		}

		// 3) Final cleanup: remove any now-confirmed items from queue
		this.pruneConfirmedFromQueue({ crisisId, familyId })
	}

	// replaces "importSyncPayload" for verifying signed blocks, merging them when imported from offline, etc.
	async importSyncPayloadAsync({ crisisId, familyId, payload }) {

		/* What this code is doing?:
			- First it does exactly what the current import does: bring in new queued messages + confirmed relay hashes with dedupe and bounds.
			- Then it attempts to import/append canonical blocks that came in via the payload.
			- Those blocks are only accepted if their signature verifies using your locally cached crisis `block_public_key`.
			- And (in your current `_mergeBlocksFromPayload`) only blocks that extend your current local tip are appended.
			- Then it looks at transactions from the newest blocks and says:
			- “If any of these on-chain transactions contain `relay_hash` values that match queued messages, those queued messages are now confirmed and can be pruned.”
		*/

		// 1) Merge queued + confirmed using your existing safe logic
		this.importSyncPayload({ crisisId, familyId, payload })

		// 2) Merge blocks (signature-verified) into our cached blockchain
		await this._mergeBlocksFromPayload({ crisisId, payload })

		// 3) After merging blocks, treat any relay_hash found in those canonical
		//    transactions as confirmed, and prune the local queue.
		const blocks = this.getBlockchain({ crisisId }) || []
		const recentBlocks = blocks.slice(-25) // small window; adjust later
		const recentTxs = recentBlocks.flatMap((b) => b.transactions || [])
		this.syncConfirmedFromTransactions({
			crisisId,
			familyId,
			transactions: recentTxs,
		})
	}


	/*
		Merge canonical blocks from a peer's sync payload into the local
		cached blockchain.

		Rules (simple, conservative):
		- Require crisis block_public_key to be present locally so we can
		  verify PGP signatures.
		- If we have NO local blocks yet:
			* Accept any incoming blocks whose signatures verify.
			* Sort them by block_index ascending and store them as our local
			  chain fragment (we may only have the last N blocks; that's OK).
		- If we DO have local blocks:
			* Build a map of block_index -> local block.
			* For each incoming block (sorted by index):
				- If we already have that index:
					- If hashes match: skip (duplicate).
					- If hashes differ: log a warning (fork) and ignore incoming.
				- If we don't have that index:
					- Only accept if:
						block_index === local_tip_index + 1 AND
						previous_hash === local_tip_hash AND
						signature verifies.
					- Then append to local chain and move tip forward.
		- We do NOT yet attempt complex fork resolution or gap-filling.
	*/
	async _mergeBlocksFromPayload({ crisisId, payload }) {
		const incomingBlocks = Array.isArray(payload.blocks) ? payload.blocks : []
		if (!incomingBlocks.length) return

		const crisisMeta = this.getCrisisMetadata({ crisisId })
		const blockPublicKey = crisisMeta?.block_public_key
		if (!blockPublicKey) {
			console.warn('No crisis block_public_key available; skipping block merge from sync payload.')
			return
		}

		let localBlocks = this.getBlockchain({ crisisId }) || []
		if (!Array.isArray(localBlocks)) {
			localBlocks = []
		}

		// Sort incoming by block_index (ascending)
		const sortedIncoming = incomingBlocks
			.filter(
				(b) =>
					b &&
					typeof b.block_index === 'number' &&
					Number.isFinite(b.block_index)
			)
			.sort((a, b) => a.block_index - b.block_index)

		if (!localBlocks.length) {
			// No local chain yet: accept any verified blocks as a fragment.
			const accepted = []
			for (const block of sortedIncoming) {
				try {
					const ok = await verifyBlockCanonical(block, blockPublicKey)
					if (!ok) {
						console.warn(`Incoming block #${block.block_index} failed signature verification; skipped.`)
						continue
					}
					accepted.push(block)
				}
				catch (e) {
					console.error('Error verifying incoming block signature:', e)
				}
			}

			if (accepted.length) {
				this.saveBlockchain({ crisisId, blocks: accepted })
				console.log(`Imported ${accepted.length} canonical block(s) from peer into empty local chain.`)
			}
			return
		}

		// We already have a local chain: only append clean extensions of the tip.
		const existingByIndex = new Map(localBlocks.map((b) => [b.block_index, b]))
		let tip = localBlocks[localBlocks.length - 1]
		let appended = 0

		for (const block of sortedIncoming) {
			const idx = block.block_index

			// If we already have this index, check for conflict or duplicate.
			if (existingByIndex.has(idx)) {
				const localBlock = existingByIndex.get(idx)
				if (localBlock.hash !== block.hash) {
					console.warn(`Incoming block at index ${idx} conflicts with local block (different hash). Ignoring incoming block.`)
				}
				continue
			}

			// Only accept direct tip extensions for now.
			if (idx !== tip.block_index + 1) {
				// Not contiguous; ignore for this simple implementation.
				continue
			}
			if (block.previous_hash !== tip.hash) {
				// Does not link to our current tip; ignore.
				continue
			}

			// Verify signature before accepting.
			try {
				const ok = await verifyBlockCanonical(block, blockPublicKey)
				// const ok = await verifyBlockSignature(block, blockPublicKey)
				if (!ok) {
					console.warn(
						`Incoming block #${idx} failed signature verification; skipped.`
					)
					continue
				}
			} catch (e) {
				console.error(
					'Error verifying incoming block signature:',
					e
				)
				continue
			}

			// All checks passed: append to local chain.
			localBlocks.push(block)
			existingByIndex.set(idx, block)
			tip = block
			appended++
		}

		if (appended > 0) {
			this.saveBlockchain({ crisisId, blocks: localBlocks })
			console.log(`Appended ${appended} block(s) from sync payload to local chain.`)
		}
	}

	// UTILITY - Clear all data (for testing/reset/decommissioning of wallet upon user request)
	clearAll() {
		const keysToDelete = []

		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i)
			if (!key) continue

			// Delete all namespaced KriSYS data
			if (key.startsWith('krisys:')) {
				keysToDelete.push(key)
			}

			// Also delete device identity (fresh node identity on reboot)
			if (key === 'krisys_device_id') {
				keysToDelete.push(key)
			}
		}

		for (const key of keysToDelete) {
			localStorage.removeItem(key)
		}

		console.log(`Cleared ${keysToDelete.length} KriSYS localStorage entries`)
	}
}

export const disasterStorage = new DisasterStorage()
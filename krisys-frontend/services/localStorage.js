// services/localStorage.js
import { verifyBlockSignature } from './blockVerifier'

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

        // Limits for incoming sync payloads to protect against abuse
        this.MAX_QUEUED_PER_PAYLOAD = 100
        this.MAX_CONFIRMED_PER_PAYLOAD = 500
        this.MAX_PER_ORIGIN = 50
        this.MAX_MESSAGE_LENGTH = 8192
        this.MAX_ADDRESSES_PER_TX = 16
        this.MAX_ADDRESS_LENGTH = 128
        this.MAX_STATION_ADDRESS_LENGTH = 128
        this.MAX_TYPE_FIELD_LENGTH = 32
    }


    // Sanitize and bound an incoming sync payload (queued + confirmed)
    sanitizeSyncPayload(payload) {
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
        const localQueue = this.getMessageQueue()
        const localRelayHashes = new Set(
            localQueue
                .map((m) => m && m.relay_hash)
                .filter((rh) => typeof rh === 'string' && rh.length > 0)
        )

        // Helper to check string length
        const isString = (v) => typeof v === 'string'
        const clampLength = (s, max) =>
            s.length <= max ? s : s.slice(0, max)

        // Sanitize queued messages
        for (const msg of rawQueued) {
            if (
                !msg ||
                typeof msg !== 'object' ||
                sanitizedQueued.length >= this.MAX_QUEUED_PER_PAYLOAD
            ) {
                break
            }

            const relayHash = msg.relay_hash
            if (!isString(relayHash) || !relayHash.trim()) {
                continue
            }

            // Skip if already confirmed locally
            if (this.isMessageConfirmed(relayHash)) {
                continue
            }

            // Skip if we already have this relay in our queue
            if (localRelayHashes.has(relayHash)) {
                continue
            }

            // Per-origin device quota
            const origin = isString(msg.origin_device)
                ? msg.origin_device
                : 'unknown'
            perOriginCount[origin] =
                (perOriginCount[origin] || 0) + 1
            if (perOriginCount[origin] > this.MAX_PER_ORIGIN) {
                continue
            }

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

            let related = Array.isArray(msg.related_addresses)
                ? msg.related_addresses
                : []
            related = related
                .filter((a) => isString(a) && a.length > 0)
                .slice(0, this.MAX_ADDRESSES_PER_TX)
                .map((a) =>
                    a.length > this.MAX_ADDRESS_LENGTH
                        ? a.slice(0, this.MAX_ADDRESS_LENGTH)
                        : a
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
                if (
                    cleanInfo.confirmedAt < 0 ||
                    cleanInfo.confirmedAt > now + oneDayMs
                ) {
                    delete cleanInfo.confirmedAt
                }
            }
            if (typeof cleanInfo.timestampPosted === 'number') {
                if (
                    cleanInfo.timestampPosted < 0 ||
                    cleanInfo.timestampPosted >
                        (now + oneDayMs) / 1000
                ) {
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

    // DEV NOTE: NOT yet used
    deletePrivateKey(familyId) {
        // DEV NOTE: familyId might be needed if one device shared by a few families,
        // but NOT at public device stations where users log in to public devices.
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
            deviceId: this.getDeviceId(),
        }

        localStorage.setItem(
            this.STORAGE_KEYS.PRIVATE_KEY,
            JSON.stringify(keyData)
        )
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

    // WALLET DATA STORAGE - per-family cached wallet metadata for offline use
    saveWalletData(familyId, walletData) {
        console.log('Storing wallet metadata locally for offline access')
        const stored = localStorage.getItem(this.STORAGE_KEYS.WALLET_DATA)
        const map = stored ? JSON.parse(stored) : {}

        map[familyId] = {
            data: walletData,
            storedAt: Date.now(),
        }

        localStorage.setItem(
            this.STORAGE_KEYS.WALLET_DATA,
            JSON.stringify(map)
        )
    }

    getWalletData(familyId) {
        const stored = localStorage.getItem(this.STORAGE_KEYS.WALLET_DATA)
        if (!stored) return null

        try {
            const map = JSON.parse(stored)
            const entry = map[familyId]
            return entry ? entry.data : null
        } catch (e) {
            console.error('Failed to parse cached wallet data:', e)
            return null
        }
    }

    // CRISIS METADATA STORAGE - e.g. crisis id, name, block_public_key
    saveCrisisMetadata(meta) {
        try {
            localStorage.setItem(
                this.STORAGE_KEYS.CRISIS_METADATA,
                JSON.stringify({
                    id: meta.id || meta.crisis_id || null,
                    name: meta.name || null,
                    organization: meta.organization || null,
                    contact: meta.contact || null,
                    description: meta.description || null,
                    created_at: meta.created_at || null,
                    // Backend may expose this as block_public_key or public_key; normalize here
                    block_public_key:
                        meta.block_public_key || meta.public_key || null,
                    storedAt: Date.now()
                })
            )
        } 
        catch (e) {
            console.error('Failed to save crisis metadata:', e)
        }
    }
    getCrisisMetadata() {
        const stored = localStorage.getItem(
            this.STORAGE_KEYS.CRISIS_METADATA
        )
        if (!stored) return null
        try {
            return JSON.parse(stored)
        } catch (e) {
            console.error('Failed to parse crisis metadata:', e)
            return null
        }
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
            - and do not differentiate per-crisis or per-wallet.
        This is acceptable for small dev chains, but MUST be revisited
        before production / large deployments.
    */
    saveBlockchain(blockchain) {
        console.log('Storing blockchain locally for offline access')
        localStorage.setItem(
            this.STORAGE_KEYS.BLOCKCHAIN,
            JSON.stringify({
                blocks: blockchain,
                lastUpdated: Date.now(),
            })
        )
    }

    getBlockchain() {
        const stored = localStorage.getItem(this.STORAGE_KEYS.BLOCKCHAIN)
        if (!stored) return []

        try {
            const parsed = JSON.parse(stored)
            return parsed.blocks || []
        } catch (e) {
            console.error('Failed to parse cached blockchain:', e)
            return []
        }
    }

    // MESSAGE QUEUE - Store messages to send when connectivity returns
    queueMessage(message) {
        console.log('Queueing message for transmission when online')
        const queue = this.getMessageQueue()
        queue.push({
            ...message,
            queuedAt: Date.now(),
            attempts: 0,
            status: 'pending',
        })
        localStorage.setItem(
            this.STORAGE_KEYS.MESSAGE_QUEUE,
            JSON.stringify(queue)
        )
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
            storedAt: Date.now(),
        }
        localStorage.setItem(
            this.STORAGE_KEYS.PUBLIC_KEYS,
            JSON.stringify(keys)
        )
    }

    getPublicKeys() {
        const stored = localStorage.getItem(this.STORAGE_KEYS.PUBLIC_KEYS)
        return stored ? JSON.parse(stored) : {}
    }

    // DEVICE MANAGEMENT
    getDeviceId() {
        let deviceId = localStorage.getItem('krisys_device_id')
        if (!deviceId) {
            deviceId =
                'device_' +
                Date.now() +
                '_' +
                Math.random().toString(36).substr(2, 9)
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
            ...info,
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

        const filtered = queue.filter((msg) => {
            const rh = msg.relay_hash

            // Legacy/sent entries without relay_hash can be safely dropped
            if (!rh && msg.status === 'sent') return false

            // Normal path: to drop queued messages if this messaged was successfully relayed to blockchain
            if (!rh) return true // keep items without relay_hash

            return !confirmed[rh]
        })

        localStorage.setItem(
            this.STORAGE_KEYS.MESSAGE_QUEUE,
            JSON.stringify(filtered)
        )

        // DEV LOG
        console.log(
            `Pruned ${queue.length - filtered.length} confirmed messages from queue`
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
                timestampPosted: tx.timestamp_posted,
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

    /*  Build a payload to sync with another device.

        SCHEMA (version 1):
        {
            version: 1,
            deviceId: string,
            crisisId: string | null,      // TODO: populate from crisis metadata later
            generatedAt: number,          // ms since epoch
            chain_tip: {
                block_index: number,
                hash: string,
                previous_hash: string
            } | null,
            blocks: [],                   // reserved for future block-level sync
            queued: MessageTx[],
            confirmed: {
                [relayHash: string]: {
                    confirmedAt?: number,
                    txId?: string,
                    timestampPosted?: number,
                    // ... extra metadata
                }
            }
        }

        For now (Step 3), we only actively use:
            - queued   : pending messages to relay
            - confirmed: map of relay_hash -> confirmation info

        The chain_tip + blocks fields are placeholders that we will start
        filling and merging in a later step when we implement full
        block-level mesh sync between devices.

        NOTE: This payload is intentionally self-contained and versioned so
        that:
            - older clients can ignore newer fields safely,
            - we can extend it as we add features (battery-saving modes,
              pruning policies, partial chain segments, etc.).
    */
    exportSyncPayload() {
            const queue = this.getMessageQueue()
            const confirmed = this.getConfirmedRelays()

            // Only pending messages that are not already confirmed
            const queuedForSync = queue.filter(
                (msg) =>
                    msg.status === 'pending' &&
                    !this.isMessageConfirmed(msg.relay_hash)
            )

            // Crisis metadata (if we have it) for sanity-checking that peers are
            // syncing the same crisis / blockchain.
            const crisisMeta = this.getCrisisMetadata()

            // Look at our locally cached blockchain to expose a simple "tip"
            // pointer and a small suffix of canonical blocks.
            const blocks = this.getBlockchain() || []
            const lastBlock =
                Array.isArray(blocks) && blocks.length > 0
                    ? blocks[blocks.length - 1]
                    : null

            // Share only the last N canonical blocks to limit payload size.
            // Later, we can make this configurable (battery / storage policy).
            const MAX_BLOCKS_SHARE = 10
            const blocksToShare =
                Array.isArray(blocks) && blocks.length > 0
                    ? blocks.slice(-MAX_BLOCKS_SHARE)
                    : []

            return {
                version: 1,
                deviceId: this.getDeviceId(),
                crisisId: crisisMeta ? crisisMeta.id : null,
                generatedAt: Date.now(),
                chain_tip: lastBlock
                    ? {
                        block_index: lastBlock.block_index,
                        hash: lastBlock.hash,
                        previous_hash: lastBlock.previous_hash
                    }
                    : null,
                // NOTE: receiver currently ignores this.blocks; in the next step
                // we will implement block-level merge logic in importSyncPayload,
                // using the crisis block_public_key to verify signatures.
                blocks: blocksToShare,
                queued: queuedForSync,
                confirmed
            }
        }

    /*
        Merge another device's sync payload into local storage.
            - Incorporates their confirmed relays
            - Adds any new, unconfirmed queued messages we don't already have
            - Then prunes any messages that are now confirmed
        
        TODO - via a simple JSON payload we're only defining the data model and merge logic here; actually transmitting it (QR / file / WebRTC / etc.) comes later.
    */
importSyncPayload(payload) {
        // Sanitize and bound incoming payload first
        const { queued: incomingQueued, confirmed: incomingConfirmed } =
            this.sanitizeSyncPayload(payload)

        if (
            !Array.isArray(incomingQueued) ||
            typeof incomingConfirmed !== 'object'
        ) {
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
        const localConfirmed = this.getConfirmedRelays()
        let confirmedChanged = false

        for (const [relayHash, info] of Object.entries(
            incomingConfirmed
        )) {
            if (!relayHash) continue

            const existing = localConfirmed[relayHash]
            if (!existing) {
                // No local entry yet: just take incoming
                localConfirmed[relayHash] = info
                confirmedChanged = true
            } else {
                // If both have entries, keep the earlier confirmedAt if provided
                const existingTime = existing.confirmedAt || Infinity
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
            localStorage.setItem(
                this.STORAGE_KEYS.CONFIRMED_RELAYS,
                JSON.stringify(localConfirmed)
            )
        }

        /* 2) Merge incoming queued messages
            - Takes sanitized queued (list of messages).
            - For each incoming message:
                - Skips if relay_hash is already confirmed (sanitizer mostly did this).
                - Skips if there is already a message in your queue with that relay_hash.
                - Otherwise, appends it to your queue.
            - Saves updated queue if anything changed.
        */
        let queue = this.getMessageQueue()
        let queueChanged = false

        for (const msg of incomingQueued) {
            const relayHash = msg.relay_hash
            if (!relayHash) continue

            // Skip if already confirmed (locally or after merge above)
            if (this.isMessageConfirmed(relayHash)) {
                continue
            }

            // Skip if we already have this relay in our queue
            const already = queue.find(
                (existing) => existing.relay_hash === relayHash
            )
            if (already) {
                continue
            }

            // msg is already normalized by sanitizeSyncPayload
            queue.push(msg)
            queueChanged = true
        }

        if (queueChanged) {
            localStorage.setItem(
                this.STORAGE_KEYS.MESSAGE_QUEUE,
                JSON.stringify(queue)
            )
        }

        // 3) Final cleanup: remove any now-confirmed items from queue
        this.pruneConfirmedFromQueue()
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
    async _mergeBlocksFromPayload(payload) {
        const incomingBlocks = Array.isArray(payload.blocks)
            ? payload.blocks
            : []
        if (!incomingBlocks.length) return

        const crisisMeta = this.getCrisisMetadata()
        const blockPublicKey = crisisMeta?.block_public_key
        if (!blockPublicKey) {
            console.warn(
                'No crisis block_public_key available; skipping block merge from sync payload.'
            )
            return
        }

        let localBlocks = this.getBlockchain() || []
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
                    const ok = await verifyBlockSignature(
                        block,
                        blockPublicKey
                    )
                    if (!ok) {
                        console.warn(
                            `Incoming block #${block.block_index} failed signature verification; skipped.`
                        )
                        continue
                    }
                    accepted.push(block)
                } catch (e) {
                    console.error(
                        'Error verifying incoming block signature:',
                        e
                    )
                }
            }

            if (accepted.length) {
                this.saveBlockchain(accepted)
                console.log(
                    `Imported ${accepted.length} canonical block(s) from peer into empty local chain.`
                )
            }
            return
        }

        // We already have a local chain: only append clean extensions of the tip.
        const existingByIndex = new Map(
            localBlocks.map((b) => [b.block_index, b])
        )
        let tip = localBlocks[localBlocks.length - 1]
        let appended = 0

        for (const block of sortedIncoming) {
            const idx = block.block_index

            // If we already have this index, check for conflict or duplicate.
            if (existingByIndex.has(idx)) {
                const localBlock = existingByIndex.get(idx)
                if (localBlock.hash !== block.hash) {
                    console.warn(
                        `Incoming block at index ${idx} conflicts with local block (different hash). Ignoring incoming block.`
                    )
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
                const ok = await verifyBlockSignature(block, blockPublicKey)
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
            this.saveBlockchain(localBlocks)
            console.log(
                `Appended ${appended} block(s) from sync payload to local chain.`
            )
        }
    }

    // UTILITY - Clear all data (for testing/reset)
    clearAll() {
        Object.values(this.STORAGE_KEYS).forEach( key => localStorage.removeItem(key) )
        console.log('Cleared all local storage')
    }
}

export const disasterStorage = new DisasterStorage()
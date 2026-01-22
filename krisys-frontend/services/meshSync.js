// krisys-frontend/services/meshSync.js
import { disasterStorage } from './localStorage'

function normalizeBaseUrl(baseUrl) {
	if (typeof baseUrl !== 'string') return null
	const trimmed = baseUrl.trim()
	if (!trimmed) return null
	return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

async function postJson(url, body) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const text = await res.text()
		throw new Error(`HTTP ${res.status} ${text}`)
	}

	return res.json()
}

/* 
Sync with a mesh host (station or relay) using:
  * /mesh/inventory (relay_hashes + confirmed map)
  * /mesh/sync (send missing queued payloads + blocks, receive merged payload)

We include block_public_key so an unpinned relay can pin itself on first contact. Stations can ignore it. Confirmations are only trusted once derived from verified blocks, but importing confirmed hints is still useful for queue pruning (and is safe because the app ultimately treats blocks as the proof source).
*/
export async function syncWithMeshHost({
	baseUrl,
	label = 'MeshHost',
	maxQueuedToConsider = 500,
}) {
    console.log(`baseUrl value in meshsync.js: ${baseUrl}`)
	
    const base = normalizeBaseUrl(baseUrl)
    
    console.log(`base value in meshsync.js: ${base}`)

	if (!base) throw new Error(`${label}: invalid baseUrl`)

	const crisis = disasterStorage.getCrisisMetadata()
	const crisisId = crisis?.id
	const blockPublicKey = crisis?.block_public_key

	if (!crisisId) {
		throw new Error(`${label}: missing crisisId (fetch /crisis once online)`)
	}
	if (!blockPublicKey) {
		throw new Error( `${label}: missing block_public_key (fetch /crisis once online)`)
	}

	const queue = disasterStorage.getMessageQueue() || []
	const pending = queue
		.filter((m) => (m?.status || 'pending') === 'pending' &&
				typeof m?.relay_hash === 'string' &&
				m.relay_hash.length > 0 &&
				!disasterStorage.isMessageConfirmed(m.relay_hash)
            )
        .slice(0, maxQueuedToConsider)

	const relay_hashes = pending.map((m) => m.relay_hash)

	// 1) Inventory
	const inv = await postJson(`${base}/mesh/inventory`, {
		crisisId,
		block_public_key: blockPublicKey,
		relay_hashes,
	})

	if (inv?.confirmed && typeof inv.confirmed === 'object') {
		disasterStorage.importSyncPayload({
			queued: [],
			confirmed: inv.confirmed,
		})
	}

	const missingSet = new Set(Array.isArray(inv?.missing_relay_hashes) ? inv.missing_relay_hashes : [])

	// 2) Sync (send only missing queued bodies)
	const fullPayload = disasterStorage.exportSyncPayload()
	const reducedPayload = {
		...fullPayload,
		crisisId,
		block_public_key: blockPublicKey,
		queued: (fullPayload.queued || []).filter((m) => {
			const rh = m?.relay_hash
			return typeof rh === 'string' && rh.length > 0 && missingSet.has(rh)
		}),
	}

	const hostPayload = await postJson(`${base}/mesh/sync`, reducedPayload)
	await disasterStorage.importSyncPayloadAsync(hostPayload)

	return {
		crisisId,
		sentQueuedCount: reducedPayload.queued.length,
		hostBlocksCount: Array.isArray(hostPayload?.blocks)
			? hostPayload.blocks.length
			: 0,
		hostQueuedCount: Array.isArray(hostPayload?.queued)
			? hostPayload.queued.length
			: 0,
		hostTip: hostPayload?.chain_tip || null,
	}
}
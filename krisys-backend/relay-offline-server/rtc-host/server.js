// krisys-backend/relay-offline-server/rtc-host/server.js
const { createChunkReceiver, createChunkSender } = require('./nodeRtcChunking')
console.log("SERVER START")

const express = require('express')
const cors = require('cors')
const { RTCPeerConnection } = require('@roamhq/wrtc')
const crypto = require('crypto')

const app = express()
app.use(cors())
app.use(express.json())

// OFFER POOL MANAGEMENT
const MAX_CONNECTED_PEERS = 20 // Hard cap on active peers for now
const OFFER_POOL_SIZE = 8
const OFFER_REGEN_THRESHOLD = 4
const OFFER_ALLOCATION_EXPIRY_SECONDS = 120
const AVAILABLE_OFFERS = []
const ALLOCATED_OFFERS = {}
async function createNewOffer() {
	// Create a new RTCPeerConnection
	const pc = new RTCPeerConnection({
		iceServers: []
	})
	
	const peerId = crypto.randomUUID()
	
	// Create data channel immediately
	const dc = pc.createDataChannel('krisys', { ordered: true })

	// Attach chunk receiver + message handler
	const receiver = createChunkReceiver({
		onJson: async (obj) => {
			await handleIncoming(peerId, obj)
		}
	})

	dc.onopen = () => {
		console.log(`DataChannel open for ${peerId}`)
	}

	dc.onclose = () => {
		console.log(`DataChannel closed for ${peerId}`)
		try { pc.close() } catch {}
		delete ALLOCATED_OFFERS[peerId]
	}

	dc.onmessage = async (evt) => {
		try {
			if (typeof evt.data !== 'string') return
			await receiver.handleText(evt.data)
		} catch (err) {
			console.error('DataChannel message error:', err)
		}
	}
	
	// Cleanup on close
	pc.onconnectionstatechange = () => {
		if (
			pc.connectionState === 'failed' ||
			pc.connectionState === 'disconnected' ||
			pc.connectionState === 'closed'
		) {
			try { pc.close() } catch {}
			delete ALLOCATED_OFFERS[peerId]
		}
	}
	
	const offer = await pc.createOffer()
	await pc.setLocalDescription(offer)
	
	// Wait for ICE gathering
	await new Promise((resolve) => {
		if (pc.iceGatheringState === 'complete') return resolve()
			pc.onicegatheringstatechange = () => {
		if (pc.iceGatheringState === 'complete') resolve()
		}
})

return {
	peerId,
	pc,
	dc,
	sdp: pc.localDescription,
	createdAt: Date.now()
}
}

async function ensureOfferPool() {
	// If below threshold, generate new offers
	while (AVAILABLE_OFFERS.length < OFFER_POOL_SIZE) {
		const offerObj = await createNewOffer()
		AVAILABLE_OFFERS.push(offerObj)
	}
}
// Initialize pool at startup
ensureOfferPool()

async function handleIncoming(peerId, msg) {
	console.log("RELAY NODE RECEIVED:", msg?.t)

	const offerObj = ALLOCATED_OFFERS[peerId]
	if (!offerObj) return

	const sender = createChunkSender({ dc: offerObj.dc })

	/*	INVENTORY PHASE

	Client sends:
	{
		t: 'krisys_mesh_inventory_v1',
		id,
		crisisId,
		chain_tip,
		relay_hashes
	}

	Relay must:
	1. Compare tips
	2. If relay ahead -> send payload immediately
	3. If relay behind -> trigger sync request
	4. If equal -> do nothing
	*/

	if (msg?.t === 'krisys_mesh_inventory_v1') {

		// Ask Flask what relay's current state is
		const resp = await fetch('http://localhost:5000/mesh/inventory', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(msg)
		})

		const payload = await resp.json()

		const relayTip = payload?.chain_tip?.block_index
		const clientTip = msg?.chain_tip?.block_index

		console.log("RELAY TIP:", relayTip, "CLIENT TIP:", clientTip)


		// CASE 1: Relay Ahead -> Serve Blocks
		if (
			typeof relayTip === 'number' &&
			typeof clientTip === 'number' &&
			relayTip > clientTip
		) {
			console.log("Relay ahead. Sending payload.")

			const syncResp = await fetch('http://localhost:5000/mesh/sync', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					crisisId: msg.crisisId,
					queued: [],
					blocks: []
				})
			})

			const syncPayload = await syncResp.json()

			sender.sendJson({
				t: 'krisys_mesh_payload_v1',
				id: msg.id,
				sentAt: Date.now(),
				blocks: syncPayload.blocks || [],
				queued: syncPayload.queued || []
			})

			return
		}

		// CASE 2: Relay Behind -> Request Sync
		if (
			typeof relayTip === 'number' &&
			typeof clientTip === 'number' &&
			clientTip > relayTip
		) {
			console.log("Relay behind. Requesting sync.")

			// Trigger full sync request from client
			sender.sendJson({
				t: 'krisys_mesh_sync_req_v1',
				id: msg.id,
				sentAt: Date.now(),
				payload: {
					version: 1,
					deviceId: 'relay_node',
					crisisId: msg.crisisId,
					generatedAt: Date.now(),
					chain_tip: payload.chain_tip || null,
					blocks: [],
					queued: [],
					confirmed: {}
				}
			})

			return
		}

		// CASE 3: Equal -> Nothing To Do
		console.log("Tips equal. No action.")
		return
	}

	/* SYNC PHASE

	Client sends:
	krisys_mesh_sync_req_v1

	Relay forwards to Flask /mesh/sync
	Flask processes + stores blocks
	Relay sends krisys_mesh_sync_res_v1 back
	*/

	if (msg?.t === 'krisys_mesh_sync_req_v1') {

		console.log("Processing sync request.")

		const resp = await fetch('http://localhost:5000/mesh/sync', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(msg.payload)
		})

		const syncPayload = await resp.json()

		sender.sendJson({
			t: 'krisys_mesh_sync_res_v1',
			id: msg.id,
			sentAt: Date.now(),
			payload: syncPayload
		})

		return
	}

	// SYNC RESPONSE PHASE (Client sending blocks to relay)
	if (msg?.t === 'krisys_mesh_sync_res_v1') {

		console.log("Relay received sync response. Storing blocks.")

		const resp = await fetch('http://localhost:5000/mesh/sync', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(msg.payload)
		})

		await resp.json()  // ensure Flask processes it

		return
	}
	
	// Implements relay-specific inventory flow (client-initiated polling)
	if (msg?.t === 'krisys_relay_inventory_v1') {
		// Log relay inventory request for debugging
		console.log('Relay inventory request received')

		// Forward inventory payload to Flask
		const resp = await fetch('http://localhost:5000/mesh/inventory', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				crisisId: msg.crisisId, // Pass crisis pin
				chain_tip: msg.chain_tip || null, // Pass client chain tip
				relay_hashes: Array.isArray(msg.relay_hashes) ? msg.relay_hashes : [], // Pass relay hashes
			})
		})
		// Parse Flask response
		const payload = await resp.json()

		// Send relay-specific inventory response back to client.
		sender.sendJson({
			t: 'krisys_relay_inventory_res_v1', // Relay-specific response type
			id: msg.id, // Echo request id
			crisisId: msg.crisisId, // Echo crisisId
			chain_tip: payload.chain_tip || null, // Relay chain tip
			missing_relay_hashes: payload.missing_relay_hashes || [], // Relay missing hashes
			sentAt: Date.now(), // Timestamp for debugging
		})

		return // Stop further processing for this message
	}

	// It implements relay-specific sync flow.
	if (msg?.t === 'krisys_relay_sync_req_v1') {
		// Log relay sync request for debugging.
		console.log('Relay sync request received')

		// Build sync request for Flask.
		const syncReq = {
			crisisId: msg.crisisId, // Pass crisis pin
			queued: [], // Default queued if not provided
			blocks: [], // Default blocks if not provided
		}

		// If client is pushing data (optional), pass through.
		if (Array.isArray(msg.queued)) {
			syncReq.queued = msg.queued // Forward queued messages if provided
		}
		if (Array.isArray(msg.blocks)) {
			syncReq.blocks = msg.blocks // Forward blocks if provided
		}

		// If client is requesting data, pass selectors for Flask to decide.
		// DEV NOTE: Flask currently ignores these fields; safe to include for later.
		if (Array.isArray(msg.want_relay_hashes)) {
			syncReq.want_relay_hashes = msg.want_relay_hashes // Requested relay hashes
		}
		if (typeof msg.want_blocks_from === 'number') {
			syncReq.want_blocks_from = msg.want_blocks_from // Requested block suffix start
		}
		if (typeof msg.max_blocks === 'number') {
			syncReq.max_blocks = msg.max_blocks // Cap on returned blocks
		}

		// Forward sync request to Flask.
		const resp = await fetch('http://localhost:5000/mesh/sync', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(syncReq)
		})

		// Parse Flask sync response.
		const payload = await resp.json()

		// Send relay-specific sync response back to client.
		sender.sendJson({
			t: 'krisys_relay_sync_res_v1', // Relay-specific response type
			id: msg.id, // Echo request id
			blocks: payload.blocks || [], // Relay block suffix
			queued: payload.queued || [], // Relay queued messages
			sentAt: Date.now(), // Timestamp for debugging
		})

		return // Stop further processing for this message
	}

	//	PING
	if (msg?.t === 'krisys_p2p_ping') {
		offerObj.dc.send(JSON.stringify({
			t: 'krisys_p2p_pong',
			at: Date.now()
		}))
		return
	}
}


// Accept an offer's answer: Wallet sends answer after generating it locally (only works with offers that were allocated)
app.post('/answer', async (req, res) => {
	const { peerId, answer } = req.body

	if (!peerId || !answer) {
		return res.status(400).json({ error: 'Missing peerId or answer' })
	}

	const offerObj = ALLOCATED_OFFERS[peerId] // active connections remain until closed

	if (!offerObj) {
		return res.status(404).json({ error: 'Offer not found or expired' })
	}

	try {
		await offerObj.pc.setRemoteDescription(answer)
		// Once answer applied successfully, connection lifecycle now managed by pc.onconnectionstatechange
		// DEV NOTE: We DO NOT delete from ALLOCATED_OFFERS yet — it will be removed automatically on close/failure.
		if (offerObj.expiryTimer) { 
			clearTimeout(offerObj.expiryTimer)	// Guardrail from funky javascript timing issues since timers run off the event loop thread
			delete offerObj.expiryTimer			// Prevents edge case where timer already fired
		}
		return res.json({ status: 'connected' })

	} 
	catch (err) {
		// Clean up on failure
		console.error('Failed to apply answer:', err)
		try { offerObj.pc.close() } 
		catch { 
			// DEV NOTE TODO: Handle this properly before production
		}
		delete ALLOCATED_OFFERS[peerId]
		return res.status(500).json({ error: 'Failed to apply answer' })
	}
})

// ALLOCATE ATOMIC OFFER
app.post('/allocate-offer', async (req, res) => {
	try {
		// Enforce max active peers before allocating a new offer (prevents new offers when active peers reach the cap)
		if (Object.keys(ALLOCATED_OFFERS).length >= MAX_CONNECTED_PEERS) {
			// Return 429 to indicate capacity reached.
			return res.status(429).json({ error: 'Relay at capacity' })
		}

		// Ensure pool is filled
		await ensureOfferPool()

		if (AVAILABLE_OFFERS.length === 0) {
			return res.status(503).json({ error: 'No offers available' })
		}

		// Atomic pop
		const offerObj = AVAILABLE_OFFERS.shift()
		const peerId = offerObj.peerId

		// Move to allocated map
		ALLOCATED_OFFERS[peerId] = offerObj

		// Start expiry timer
		ALLOCATED_OFFERS[peerId].expiryTimer = setTimeout(() => {
			if (ALLOCATED_OFFERS[peerId]) {
				try { ALLOCATED_OFFERS[peerId].pc.close() } catch {}
				delete ALLOCATED_OFFERS[peerId]
			}
		}, OFFER_ALLOCATION_EXPIRY_SECONDS * 1000)

		// Refill pool if needed
		if (AVAILABLE_OFFERS.length < OFFER_REGEN_THRESHOLD) {
			ensureOfferPool()
		}

		return res.json({
			peerId: peerId,
			offer: ALLOCATED_OFFERS[peerId].sdp
		})

	} catch (err) {
		console.error('Allocate offer failed:', err)
		return res.status(500).json({ error: 'Allocation failed' })
	}
})

// Health check
app.get('/health', (req, res) => {
	res.json({
		status: 'ok',
		activePeers: Object.keys(ALLOCATED_OFFERS).length
	})
})

app.listen(7000, () =>{
	console.log('RTC host running on port 7000')
})
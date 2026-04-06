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
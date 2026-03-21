// krisys-backend/device-offline-server/rtc-host/server.js
const { createChunkReceiver, createChunkSender } = require('./nodeRtcChunking')
console.log("SERVER START")

const express = require('express')
const cors = require('cors')
const { RTCPeerConnection } = require('@roamhq/wrtc')
const crypto = require('crypto')

const app = express()
app.use(cors())
app.use(express.json())

// In-memory peer map (persistent while Node process runs) 
// Map<peerId, { pc, dc }>
// This is the persistent runtime state. As long as this Node process runs, all active WebRTC connections live here.
const peers = new Map()

// Helper to wait for ICE gathering to complete
async function waitForIceGatheringComplete(pc) {
	return new Promise((resolve) => {
		// If already complete, resolve immediately
		if (pc.iceGatheringState === 'complete') {
			return resolve()
		}

		// Otherwise wait for state change
		pc.addEventListener('icegatheringstatechange', () => {
			if (pc.iceGatheringState === 'complete') {
				resolve()
			}
		})
	})
}

// Create a NEW offer. Every wallet that connects calls this endpoint. Each call creates a brand new RTCPeerConnection. This is the key to supporting multiple wallets.
app.post('/offer', async (req, res) => {
	try {
		// Create a brand new peer connection
		const pc = new RTCPeerConnection({
			iceServers: [] // LAN only for now
		})

		// DEV - debuggin
		console.log("Current peers:", peers.size)

		// Generate unique peer ID
		const peerId = crypto.randomUUID()

		// Track connection state for cleanup
		pc.onconnectionstatechange = () => {
			console.log(`Peer ${peerId} state:`, pc.connectionState)

			// If connection dies, clean up
			if (
				pc.connectionState === 'failed' ||
				pc.connectionState === 'disconnected' ||
				pc.connectionState === 'closed'
			) {
				try {
					pc.close()
				} catch {}
				peers.delete(peerId)
				console.log(`Peer ${peerId} removed`)
			}
		}

		// Create a data channel
		// Wallet will attach to this
		const dc = pc.createDataChannel('krisys', {
			ordered: true
		})

		// Optional: log when data channel opens
		dc.onopen = () => {
			console.log(`DataChannel open for peer ${peerId}`)
		}

		dc.onclose = () => {
			console.log(`DataChannel closed for peer ${peerId}`)
		}

		const receiver = createChunkReceiver({
			onJson: async (obj) => {
				await handleIncoming(peerId, obj)
			}
		})

		async function handleIncoming(peerId, msg) {
		console.log("=== NODE RECEIVED MESSAGE ===")
		console.log("From peer:", peerId)
		console.log("Message type:", msg?.t)
		console.log("Message keys:", Object.keys(msg || {}))
		console.log("=============================")

		if (msg?.t === 'krisys_mesh_sync_req_v1') {
			console.log("=== NODE FORWARDING TO FLASK ===")
			console.log("Payload keys:", Object.keys(msg.payload || {}))
			console.log("Wallet chain_tip:", msg.payload?.chain_tip?.block_index)
			console.log("Wallet blocks length:", msg.payload?.blocks?.length)
			console.log("================================")

			const resp = await fetch('http://localhost:5000/mesh/sync', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(msg.payload)
			})

			console.log("=== NODE GOT FLASK RESPONSE ===")
			console.log("Status:", resp.status)

			const payload = await resp.json()

			console.log("Returned chain_tip:", payload.chain_tip?.block_index)
			console.log("Returned blocks:", payload.blocks?.map(b => b.block_index))
			console.log("Returned blocks length:", payload.blocks?.length)
			console.log("================================")

			const peer = peers.get(peerId)
			if (!peer) return

			const sender = createChunkSender({ dc: peer.dc })

			try {
			sender.sendJson({
				t: 'krisys_mesh_sync_res_v1',
				id: msg.id,
				sentAt: Date.now(),
				payload
			})
			console.log("=== NODE SENT RESPONSE BACK TO WALLET ===")
			} catch (e) {
			console.error("Send failed:", e)
			}
		}

		if (msg?.t === 'krisys_p2p_ping') {
			const peer = peers.get(peerId)
			if (!peer) return
			peer.dc.send(JSON.stringify({
			t: 'krisys_p2p_pong',
			at: Date.now()
			}))
		}
		}
		dc.onmessage = async (evt) => {
			try {
				if (typeof evt.data !== 'string') return
				await receiver.handleText(evt.data)

			} catch (err) {
				console.error('DataChannel message error:', err)
			}
		}

		// Create SDP offer
		const offer = await pc.createOffer()

		// Set as local description
		await pc.setLocalDescription(offer)

		// Wait until ICE candidates are gathered
		await waitForIceGatheringComplete(pc)

		// Store peer in memory
		peers.set(peerId, {
			pc,
			dc
		})

		// Return peerId + SDP offer to wallet
		res.json({
			peerId,
			offer: pc.localDescription
		})

	} catch (err) {
		console.error(err)
		res.status(500).json({ error: 'Failed to create offer' })
	}
})

// Accept an answer: Wallet sends answer after generating it locally. We attach it to the coorect peer.
app.post('/answer', async (req, res) => {
	const { peerId, answer } = req.body

	const peer = peers.get(peerId)
	if (!peer) {
		return res.status(404).json({ error: 'Peer not found' })
	}

	try {
		await peer.pc.setRemoteDescription(answer)
		res.json({ status: 'connected' })
	} catch (err) {
		console.error(err)
		res.status(500).json({ error: 'Failed to apply answer' })
	}
})

// Health check
app.get('/health', (req, res) => {
	res.json({
		status: 'ok',
		activePeers: peers.size
	})
})

app.listen(7000, () =>{
	console.log('RTC host running on port 7000')
})
// device-offline-server/station-frontend/services/stationRtcHost.js

/*
	StationRTCHost

	Responsibilities:
	- Accept multiple WebRTC peer connections (pairwise only)
	- Enforce mandatory identity handshake before sync
	- Use chunked transport for payload safety
	- Track connected peers
	- Allow broadcast of inventory updates later

	This does NOT:
	- Automatically sync
	- Automatically push payloads
	- Auto-accept peers without handshake

	That logic will be layered above this service.
*/

import { createChunkSender, createChunkReceiver, makeId } from './webrtcChunking'
import { createWebRTCRoomCode, parseWebRTCRoomCode } from './webrtcRoomCode'
import { performStationHandshake } from './stationHandshake'

export class StationRTCHost {
	// initialize station host state and peer registry
	constructor({ crisisId, stationProfileFetcher }) {
		/*
			crisisId: string
			stationProfileFetcher: async function returning station profile
				{
					station_id,
					crisis_id,
					station_public_key,
					fingerprint
				}
		*/

		this.crisisId = crisisId
		this.stationProfileFetcher = stationProfileFetcher

		this.peers = new Map() // peerId -> { pc, dc, sender, receiver, handshakeVerified }

		this.onPeerConnected = null
		this.onPeerDisconnected = null
		this.onJsonMessage = null
	}

	// Create a new RTCPeerConnection for an incoming offer
	// Accepts an offer code and returns an answer while registering the new peer
	async createAnswerFromOffer(offerCode) {
		const parsed = parseWebRTCRoomCode(offerCode)

		if (parsed.kind !== 'offer') {
			throw new Error('Expected offer code')
		}

		if (parsed.crisisId && parsed.crisisId !== this.crisisId) {
			console.warn('Crisis mismatch — continuing for dev')
		}

		const pc = new RTCPeerConnection({ iceServers: [] })
		const peerId = makeId()

		pc.onconnectionstatechange = () => {
			switch (pc.connectionState) {
				case 'connected':
					console.log('Peer connected:', peerId)
					break
				case 'failed':
				case 'disconnected':
				case 'closed':
					this._cleanupPeer(peerId)
					break

				default:
					// ignore other states (connecting, new, etc.)
					break
			}
		}

		pc.ondatachannel = (evt) => {
			const dc = evt.channel
			this._attachDataChannel(peerId, pc, dc)
		}

		await pc.setRemoteDescription(parsed.sdp)

		const answer = await pc.createAnswer()
		await pc.setLocalDescription(answer)

		await this._waitForIce(pc)

		const local = pc.localDescription

		const answerCode = createWebRTCRoomCode({
			kind: 'answer',
			crisisId: this.crisisId,
			sdp: {
				type: local.type,
				sdp: local.sdp,
			},
		})

		this.peers.set(peerId, {
			pc,
			dc: null,
			sender: null,
			receiver: null,
			handshakeVerified: false,
		})

		return { answerCode, peerId }
	}

	// waits until ICE gathering completes before generating room code
	async _waitForIce(pc) {
		if (pc.iceGatheringState === 'complete') return

		await new Promise((resolve) => {
			const check = () => {
				if (pc.iceGatheringState === 'complete') {
					pc.removeEventListener('icegatheringstatechange', check)
					resolve()
				}
			}
			pc.addEventListener('icegatheringstatechange', check)
		})
	}

	// binds chunked sender/receiver and message handlers to a peer data channel
	_attachDataChannel(peerId, pc, dc) {
		console.log('Data channel received for peer:', peerId)

		const sender = createChunkSender({ dc })
		const receiver = createChunkReceiver({
			onJson: async obj => await this._handleIncoming(peerId, obj),
		})

		dc.onopen = () => { console.log('DC open:', peerId) }

		dc.onclose = () => { this._cleanupPeer(peerId) }

		dc.onmessage = async (evt) => {
			if (typeof evt.data !== 'string') return
			await receiver.handleText(evt.data)
		}

		const peer = this.peers.get(peerId)
		if (!peer) return

		peer.dc = dc
		peer.sender = sender
		peer.receiver = receiver
	}

	//  Enforces handshake requirement before allowing peer messages through
	async _handleIncoming(peerId, obj) {
		const peer = this.peers.get(peerId)
		if (!peer) return

		// First, mandatory handshake enforcement
		if (!peer.handshakeVerified) {
			if (obj?.t === 'krisys_handshake_v1') {
				await this._verifyHandshake(peerId, obj)
				return
			}

			console.warn('Rejecting message before handshake')
			return
		}

		// Then, Handle wallet inventory response
		if (obj?.t === 'krisys_mesh_inventory_res_v1') {
			await this._handleInventoryResponse(peerId, obj)
			return
		}

		// Other handlers go here...
		if (typeof this.onJsonMessage === 'function') {
			await this.onJsonMessage(peerId, obj)
		}
	}

	// Verifies remote peer identity before marking connection as trusted
	async _verifyHandshake(peerId, obj) {
		/*
			Expect:
			{
				t: 'krisys_handshake_v1',
				baseUrl: 'http://station-url',
				storedStation: {...}
			}
		*/

		try {
			const result = await performStationHandshake({
				baseUrl: obj.baseUrl,
				storedStation: obj.storedStation,
			})

			if (result?.trusted) {
				console.log('Handshake verified for peer:', peerId)
				const peer = this.peers.get(peerId)
				if (peer) {
					peer.handshakeVerified = true
					
					// Immediately send inventory after successful handshake
					this.sendInventory(peerId)
				}

				if (typeof this.onPeerConnected === 'function') {
					this.onPeerConnected(peerId)
				}
			}
		} 
		catch (e) {
			console.error('Handshake failed:', e)
			this._cleanupPeer(peerId)
		}
	}

	// Handle wallet's inventory response and send requested payload
	async _handleInventoryResponse(peerId, obj) {
		const peer = this.peers.get(peerId)
		if (!peer || !peer.sender) return
		if (!peer.handshakeVerified) return

		const id = obj.id
		console.log('Station received inventory_res:', id)

		try {
			// 1. Fetch full station payload from backend
			const res = await fetch(`${process.env.NEXT_PUBLIC_STATION_API}/mesh/sync`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					crisisId: this.crisisId,
					queued: [],
					blocks: []
				})
			})

			const fullPayload = await res.json()
			const allQueued = Array.isArray(fullPayload.queued) ? fullPayload.queued : []
			const allBlocks = Array.isArray(fullPayload.blocks) ? fullPayload.blocks : []

			// 2. Select only requested relay hashes
			const wantRelay = Array.isArray(obj.want_relay_hashes) ? obj.want_relay_hashes.slice(0, 100) : []
			const queuedToSend = allQueued.filter( m => wantRelay.includes(m?.relay_hash) )

			// 3. Select block suffix if requested
			let blocksToSend = []
			if (typeof obj.want_blocks_from === 'number' && Number.isFinite(obj.want_blocks_from)) {
				blocksToSend = allBlocks.filter(b => 
					typeof b.block_index === 'number' &&
					b.block_index >= obj.want_blocks_from).slice(0, 10)
			}

			// 4. Send payload
			peer.sender.sendJson({
				t: 'krisys_mesh_payload_v1',
				id,
				blocks: blocksToSend,
				queued: queuedToSend,
				sentAt: Date.now(),
			})

			console.log('Station sent payload:',`blocks=${blocksToSend.length}`,`queued=${queuedToSend.length}`)

		}
		catch (err) {
			console.warn('Failed to send requested payload:', err)
		}
	}

	// Send inventory to a specific peer after handshake verification
	sendInventory(peerId) {
		const peer = this.peers.get(peerId)
		if (!peer || !peer.sender) return

		// We do NOT auto-send if handshake not verified
		if (!peer.handshakeVerified) return

		try {
			// Get local relay_hash inventory from station backend. Fetch via HTTP because this is station-frontend context
			fetch(`${process.env.NEXT_PUBLIC_STATION_API}/mesh/inventory`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					crisisId: this.crisisId,
					relay_hashes: [] // empty list → backend returns all known hashes
				})
			})
			.then(res => res.json())
			.then(data => {

				// Extract relay hashes known by station
				const relayHashes = Array.isArray(data?.missing_relay_hashes) ? [] : []

				// We instead need full local known relay hashes.
				// So we ask station backend directly for payload export.
				return fetch(`${process.env.NEXT_PUBLIC_STATION_API}/mesh/sync`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						crisisId: this.crisisId,
						queued: [],
						blocks: []
					})
				})
			})
			.then(res => res.json())
			.then(payload => {

				// --- 2️⃣ Build inventory message ---
				const message = {
					t: 'krisys_mesh_inventory_v1',
					id: crypto.randomUUID(), // correlation id
					crisisId: this.crisisId,
					chain_tip: payload.chain_tip || null,
					relay_hashes: (payload.queued || [])
						.map(m => m.relay_hash)
						.filter(Boolean)
						.slice(0, 100) // bound size
				}

				// --- 3️⃣ Send via chunked sender ---
				peer.sender.sendJson(message)

				console.log('Station inventory sent to peer:', peerId)
			})
			.catch(err => {
				console.warn('Failed to send inventory:', err)
			})

		} catch (e) {
			console.warn('Inventory error:', e)
		}
	}

	// Sends a JSON payload to a specific connected peer
	sendJson(peerId, obj) {
		const peer = this.peers.get(peerId)
		if (!peer || !peer.sender) return

		peer.sender.sendJson(obj)
	}

	// Sends a JSON payload to all verified connected peers
	broadcastJson(obj) {
		for (const [peerId, peer] of this.peers.entries()) {
			if (peer.sender && peer.handshakeVerified) {
				peer.sender.sendJson(obj)
			}
		}
	}

	// Closes and removes a peer connection from the registry
	_cleanupPeer(peerId) {
		const peer = this.peers.get(peerId)
		if (!peer) return

		try {
			peer.dc?.close()
			peer.pc?.close()
		} 
		catch {
			console.warn("stationRtcHost produced an error during _cleanupPeer")
		}

		this.peers.delete(peerId)

		if (typeof this.onPeerDisconnected === 'function') {
			this.onPeerDisconnected(peerId)
		}

		console.log('Peer cleaned up:', peerId)
	}

	// applyAnswerFromPeer: applies remote answer SDP to an existing peer connection
	async applyAnswerFromPeer(peerId, answerCode) {
		const peer = this.peers.get(peerId)
		if (!peer) {
			throw new Error('Peer not found')
		}

		const parsed = parseWebRTCRoomCode(answerCode)

		if (parsed.kind !== 'answer') {
			throw new Error('Expected answer code')
		}

		await peer.pc.setRemoteDescription(parsed.sdp)

		console.log('Answer applied for peer:', peerId)
	}
}
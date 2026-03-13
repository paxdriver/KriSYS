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

		// Mandatory handshake enforcement
		if (!peer.handshakeVerified) {
			if (obj?.t === 'krisys_handshake_v1') {
				await this._verifyHandshake(peerId, obj)
				return
			}

			console.warn('Rejecting message before handshake')
			return
		}

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
				if (peer) peer.handshakeVerified = true

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
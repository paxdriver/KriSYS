// krisys-frontend/contexts/P2PContext.js
'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { disasterStorage } from '@/services/localStorage'
import { createWebRTCRoomCode, parseWebRTCRoomCode } from '@/services/webrtcRoomCode'
import { createChunkReceiver, createChunkSender, makeId } from '@/services/webrtcChunking'

const INVENTORY_MAX_RELAY_HASHES = 100	// DEV NOTE: Set this by env var when building policy wizard
const INVENTORY_MAX_BLOCKS = 10			// DEV NOTE: Set this by env var when building policy wizard
const RELAY_POLL_INTERVAL_MS = 5000 	// Poll 5s after the last attempt completes
const RELAY_MAX_BLOCKS_PER_POLL = 10 	// Max block suffix to request per poll
const STATION_API_URL = 'http://localhost:6001'
const STATION_SIGNAL_URL = 'http://localhost:7000'

const P2PContext = createContext(null)

function waitForIceGatheringComplete(pc, timeoutMs = 12000) {
	return new Promise((resolve, reject) => {
		if (!pc) return reject(new Error('Missing RTCPeerConnection'))
		if (pc.iceGatheringState === 'complete') return resolve()

		let done = false
		const timer = setTimeout(() => {
			if (done) return
			done = true
			cleanup()
			reject(new Error('ICE gathering timeout'))
		}, timeoutMs)

		function onStateChange() {
			if (done) return
			if (pc.iceGatheringState === 'complete') {
				done = true
				cleanup()
				resolve()
			}
		}

		function cleanup() {
			clearTimeout(timer)
			pc.removeEventListener('icegatheringstatechange', onStateChange)
		}

		pc.addEventListener('icegatheringstatechange', onStateChange)
	})
}

function safeNow() {
	return Date.now()
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms))
}

// accept familyId via props
export function P2PProvider({ children, crisisId, familyId }) {
	const pcRef = useRef(null)
	const dcRef = useRef(null)

	const senderRef = useRef(null)
	const receiverRef = useRef(null)

	const pendingSyncIdsRef = useRef(new Set())

	const [status, setStatus] = useState('disconnected') // disconnected | connecting | connected | closed
	const [role, setRole] = useState('idle') // idle | host | join
	const [error, setError] = useState(null)

	const [offerCode, setOfferCode] = useState('')
	const [answerCode, setAnswerCode] = useState('')
	const [remoteOfferInput, setRemoteOfferInput] = useState('')
	const [remoteAnswerInput, setRemoteAnswerInput] = useState('')
	const [connectionMode, setConnectionMode] = useState(null)
	const [logLines, setLogLines] = useState([])

	const [metrics, setMetrics] = useState(null) 	// { send: {bytesSent,...}, recv: {bytesReceived,...} }

	// Persisted across page switches; used by p2pSyncNow()
	const [pushOnlyOnJoin, setPushOnlyOnJoin] = useState(false)

	const relayPollIntervalRef = useRef(null) // Holds setInterval id for relay polling
	const relayPollInFlightRef = useRef(false) // Prevents overlapping relay inventory requests
	const relayPendingInventoryIdRef = useRef(null) // Tracks the latest inventory request id

	if (!crisisId || !familyId) {
		throw new Error('P2PProvider requires crisisId and familyId')
	}

	const canWebRTC = useMemo(() => {
		return typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined'
	}, [])

	const log = useCallback((line) => {
		setLogLines((prev) => {
			const next = Array.isArray(prev) ? prev.slice(-80) : []
			next.push(`${new Date().toLocaleTimeString()} ${line}`)
			return next
		})
	}, [])

	
	const sendJson = useCallback((obj) => {
		// Always read the latest sender from the ref at call time.
		const sender = senderRef.current // Read current sender
		if (!sender) throw new Error('Sender not ready') // Guard against missing sender
		sender.sendJson(obj) // Send the message over RTC
	}, []) // Empty deps keeps this callback stable across renders


	const emitP2PStatus = useCallback((next) => {
		try {
			if (typeof window === 'undefined') return
			window.KRISYS_P2P_STATUS = next
			window.dispatchEvent(new CustomEvent('krisys:p2p_status', { detail: next }))
		} catch {
			// ignore
		}
	}, [])

	const clearRelayPollInterval = useCallback(() => {
		// Log for debugging.
		log('relay poll: clearRelayPollInterval called') // Debug: identify interval clears
		// Cancel any pending relay poll interval.
		if (relayPollIntervalRef.current) {
			clearInterval(relayPollIntervalRef.current) // Stop interval
			relayPollIntervalRef.current = null // Clear ref
		}
	}, [log]) // Depends on log

	const sendRelayInventoryNow = useCallback(async () => {

		// Do not send if a relay inventory request is already in flight
		if (relayPollInFlightRef.current) {
			log('relay poll: blocked (inFlight=true)') // Debug: prevent overlap
			return // Exit if a request is already in flight
		}
		if (status !== 'connected' || connectionMode !== 'relay') {
			log(`relay poll: blocked (status=${status}, mode=${connectionMode})`) // Debug: not connected/relay
			return // Exit if not in relay mode or connected
		}
		log(`relay poll: sendRelayInventoryNow invoked (status=${status}, mode=${connectionMode})`) // Debug: confirm poll fires

		relayPollInFlightRef.current = true // Mark inventory request as in flight

		try {
			// Export local payload to derive chain_tip + relay_hashes
			const localPayload = disasterStorage.exportSyncPayload({
				crisisId,
				familyId,
			})

			// Build bounded relay_hash list from local queued items
			const relayHashes = (localPayload.queued || [])
				.map((m) => m?.relay_hash)
				.filter(Boolean)
				.slice(0, INVENTORY_MAX_RELAY_HASHES)

			// Build a fresh inventory request id
			const id = makeId()
			relayPendingInventoryIdRef.current = id

			// Send relay-specific inventory request over RTC
			sendJson({
				t: 'krisys_relay_inventory_v1',
				id,
				crisisId,
				chain_tip: localPayload.chain_tip || null,
				relay_hashes: relayHashes,
				sentAt: Date.now(),
			})
		} catch (e) {
			// On failure, clear in-flight and schedule a retry.
			relayPollInFlightRef.current = false // Clear in-flight flag on error

		}
	}, [
		connectionMode, // Ensure we only send while in relay mode
		crisisId, // Include crisisId in payload
		familyId, // Include familyId in exportSyncPayload
		sendJson, // Used to send RTC message
		status, // Ensure we only send when connected
	])


	// Replace the existing relay polling useEffect with this interval-based version.
	useEffect(() => {
		// Start polling only when connected to a relay.
		if (status === 'connected' && connectionMode === 'relay') {
			// Avoid double-starting the interval.
			if (!relayPollIntervalRef.current) {
				log('relay poll: starting interval') // Debug: interval start
				relayPollIntervalRef.current = setInterval(() => {
					void sendRelayInventoryNow() // Trigger inventory send every interval
				}, RELAY_POLL_INTERVAL_MS)
			}
			return // Keep interval running while connected
		}

		// Stop polling when not in relay mode or disconnected.
		clearRelayPollInterval() // Cancel interval
		relayPollInFlightRef.current = false // Reset in-flight flag
		relayPendingInventoryIdRef.current = null // Reset inventory id
	}, [
		clearRelayPollInterval, // Used to stop interval
		connectionMode, // Re-run when mode changes
		sendRelayInventoryNow, // Used by interval callback
		status, // Re-run when connection state changes
	])

	useEffect(() => {
		emitP2PStatus({
			active: status === 'connecting' || status === 'connected',
			status,
			role,
			metrics: metrics || null,
		})
	}, [emitP2PStatus, status, role, metrics])

	const destroyWire = useCallback(() => {
		try {
			if (senderRef.current?.destroy) senderRef.current.destroy()
		} catch {
			// ignore for now
		}
		try {
			if (receiverRef.current?.destroy) receiverRef.current.destroy()
		} catch {
			// ignore for now
		}
		senderRef.current = null
		receiverRef.current = null
	}, [])

	const closeRtc = useCallback(() => {
		try {
			if (dcRef.current) dcRef.current.close()
		} catch {
			// ignore for now
		}
		try {
			if (pcRef.current) pcRef.current.close()
		} catch {
			// ignore for now
		}
		dcRef.current = null
		pcRef.current = null
	}, [])

	const reset = useCallback(() => {
		log("RESET CALLED")
		console.warn("RESET CALLED")

		setError(null)
		setStatus('closed')
		setRole('idle')
		setOfferCode('')
		setAnswerCode('')
		setRemoteOfferInput('')
		setRemoteAnswerInput('')
		setLogLines([])
		setMetrics(null)
		pendingSyncIdsRef.current = new Set()
		setPushOnlyOnJoin(false)

		clearRelayPollInterval() // Stop relay interval polling on reset
		relayPollInFlightRef.current = false // Clear in-flight flag on reset.
		relayPendingInventoryIdRef.current = null // Clear pending inventory id on reset.

		destroyWire()
		closeRtc()

		emitP2PStatus({ active: false, status: 'closed', role: 'idle' })
	}, [closeRtc, destroyWire, emitP2PStatus])

	useEffect(() => {
		return () => {
			// Provider unmount => teardown (leaving wallet route)
			try {
				reset()
			} catch {
				// ignore for now
			}
		}
	}, [reset])

	const attachCommonHandlers = useCallback( (pc) => {
		pc.onconnectionstatechange = () => {
			log(`pc.connectionState=${pc.connectionState}`)
			if (pc.connectionState === 'connected') setStatus('connected')
			if (pc.connectionState === 'disconnected') setStatus('disconnected')
			if (pc.connectionState === 'failed') setStatus('disconnected')
			if (pc.connectionState === 'closed') setStatus('closed')
		}

		pc.oniceconnectionstatechange = () => {
			log(`pc.iceConnectionState=${pc.iceConnectionState}`)
		}

		pc.onicegatheringstatechange = () => {
			log(`pc.iceGatheringState=${pc.iceGatheringState}`)
		}
	},[log])

	const handleIncomingJson = useCallback(async (obj) => {
		if (!obj || typeof obj !== 'object') return
		if (!crisisId || !familyId) {
			log('recv message: missing crisisId/familyId context locally')
			return
		}
		const messageType = obj.t
		switch (messageType) {

			// These handle the user-hosted room negotiations
			case 'krisys_user_room_handshake_v1': {
				log(`recv user_room_handshake from ${obj.familyId}`)

				// Crisis validation (basic guard)
				if (obj.crisisId !== crisisId) {
					log('handshake rejected: crisis mismatch')
					return
				}

				// Send acknowledgement
				sendJson({
					t: 'krisys_user_room_handshake_ack_v1',
					role: 'host',
					crisisId,
					sentAt: Date.now(),
				})

				log('sent user_room_handshake_ack')
				return
			}

			case 'krisys_user_room_handshake_ack_v1': {
				log('recv user_room_handshake_ack')
				return
			}

			// These handle relay-specific inventory and sync messages
			case 'krisys_relay_inventory_res_v1': {
				const id = obj.id // Read inventory response id for matching
				log(`recv relay inventory_res id=${id}`) // Log inventory response

				// Ignore stale inventory responses
				if (relayPendingInventoryIdRef.current && id !== relayPendingInventoryIdRef.current) {
					log(`relay inventory_res id=${id} (stale; ignoring)`)
					return
				}

				// Inventory request is complete
				relayPollInFlightRef.current = false

				// Compare chain tips
				const localPayload = disasterStorage.exportSyncPayload({ crisisId, familyId })
				const localTipIndex = typeof localPayload.chain_tip?.block_index === 'number'
					? localPayload.chain_tip.block_index
					: -1
				const relayTipIndex = typeof obj.chain_tip?.block_index === 'number'
					? obj.chain_tip.block_index
					: -1

				// Determine missing relay hashes from relay response
				const missingRelay = Array.isArray(obj.missing_relay_hashes)
					? obj.missing_relay_hashes.slice(0, INVENTORY_MAX_RELAY_HASHES)
					: []

					
				// Determine if we want block suffix
				const wantBlocksFrom = relayTipIndex > localTipIndex ? localTipIndex + 1 : null
				
				// If nothing is needed, do not send a sync request.
				if (!missingRelay.length && wantBlocksFrom == null) {
					log("Relay and client are already aligned")
					return // No-op when relay and client are already aligned
				}

				// If local tip is ahead, push a bounded suffix to the relay.
				if (localTipIndex > relayTipIndex) {
					// Build a bounded payload from local state.
					const localPayload = disasterStorage.exportSyncPayload({
						crisisId, // Use current crisis id
						familyId, // Use current family id
					})

					// Bound blocks to the relay cap to avoid flooding.
					const blocksToSend = Array.isArray(localPayload.blocks)
						? localPayload.blocks.slice(-RELAY_MAX_BLOCKS_PER_POLL) // Send last N blocks only
						: [] // Default empty if no blocks

					// Bound queued to inventory cap to avoid flooding.
					const queuedToSend = Array.isArray(localPayload.queued)
						? localPayload.queued.slice(0, INVENTORY_MAX_RELAY_HASHES) // Send up to cap
						: [] // Default empty if no queued

					// Send relay-specific sync request with payload.
					sendJson({
						t: 'krisys_relay_sync_req_v1', // Relay-specific sync request
						id: makeId(), // New request id for relay sync
						crisisId, // Crisis pin for safety
						blocks: blocksToSend, // Push blocks when local is ahead
						queued: queuedToSend, // Push queued when local is ahead
						sentAt: Date.now(), // Timestamp for debugging
					})

					return // Stop here to avoid falling through
				}

				// Request relay sync for missing items.
				sendJson({
					t: 'krisys_relay_sync_req_v1', // Relay-specific sync request
					id: makeId(), // New request id for sync
					crisisId, // Crisis pin for safety
					want_relay_hashes: missingRelay, // Requested relay hashes
					want_blocks_from: wantBlocksFrom, // Requested block suffix start
					max_blocks: RELAY_MAX_BLOCKS_PER_POLL, // Cap blocks per response
					sentAt: safeNow(), // Timestamp for debugging
				})

				return
			}
			case 'krisys_relay_sync_res_v1': {
				const id = obj.id // Read sync response id
				log(`recv relay sync_res id=${id}`) // Log sync response

				// Extract bounded blocks + queued arrays.
				const blocks = Array.isArray(obj.blocks)
					? obj.blocks.slice(0, RELAY_MAX_BLOCKS_PER_POLL) // Cap blocks
					: [] // Default empty
				const queued = Array.isArray(obj.queued)
					? obj.queued.slice(0, INVENTORY_MAX_RELAY_HASHES) // Cap queued
					: [] // Default empty

				try {
					// Import relay payload into local storage.
					await disasterStorage.importSyncPayloadAsync({
						crisisId, // Pass crisisId
						familyId, // Pass familyId
						payload: {
							version: 1, // Payload version
							deviceId: 'relay_peer', // Identify payload source
							crisisId, // Include crisisId
							generatedAt: safeNow(), // Timestamp for audit/debug
							chain_tip: null, // No chain tip needed here
							blocks, // Verified blocks from relay
							queued, // Unconfirmed queued messages
							confirmed: {}, // Relay does not assert confirmations
						},
					})

					log(`imported relay payload id=${id} blocks=${blocks.length} queued=${queued.length}`) // Debug log
				} catch (e) {
					log(`relay payload import failed id=${id}: ${e?.message || e}`) // Error log
				}

				return // End this case
			}

			// Station → Wallet inventory negotiation
			case 'krisys_mesh_inventory_v1': {
				const id = obj.id
				log(`recv inventory id=${id}`)

				// 1. Get local state
				const localPayload = disasterStorage.exportSyncPayload({
					crisisId,
					familyId,
				})
				const localRelayHashes = new Set( (localPayload.queued || []).map(m => m?.relay_hash).filter(Boolean) )

				// 2. Determine missing relay hashes
				const remoteRelayHashes = Array.isArray(obj.relay_hashes) ? 
					obj.relay_hashes.slice(0, INVENTORY_MAX_RELAY_HASHES) : []
				const wantRelayHashes = remoteRelayHashes.filter(rh => !localRelayHashes.has(rh))

				// 3. Compare chain tips
				let wantBlocksFrom = null
				const localTip = localPayload.chain_tip
				const remoteTip = obj.chain_tip

				if ( remoteTip && typeof remoteTip.block_index === 'number' &&
					localTip && typeof localTip.block_index === 'number') {
					
					if (remoteTip.block_index > localTip.block_index) {
						wantBlocksFrom = localTip.block_index + 1
					}
				}

				// 4. Send inventory response
				sendJson({
					t: 'krisys_mesh_inventory_res_v1',
					id,
					want_relay_hashes: wantRelayHashes.slice(0, INVENTORY_MAX_RELAY_HASHES),
					want_blocks_from: wantBlocksFrom,
					sentAt: Date.now(),
				})

				log(`sent inventory_res id=${id} ` +`want_relay=${wantRelayHashes.length} ` +`want_blocks_from=${wantBlocksFrom}`)
				return
			}

			// Wallet receives inventory response (wallet‑initiated flow)
			case 'krisys_mesh_inventory_res_v1': {
				const id = obj.id
				log(`recv inventory_res id=${id}`)

				const wantRelay = Array.isArray(obj.want_relay_hashes) ? 
					obj.want_relay_hashes.slice(0, INVENTORY_MAX_RELAY_HASHES) : []

				const wantBlocksFrom = typeof obj.want_blocks_from === 'number' ? 
					obj.want_blocks_from : null

				// If nothing requested, stop
				if (!wantRelay.length && wantBlocksFrom == null) {
					log(`inventory_res id=${id} nothing requested`)
					return
				}

				// Send inventory_res back to station to trigger payload
				sendJson({
					t: 'krisys_mesh_inventory_res_v1',
					id,
					want_relay_hashes: wantRelay,
					want_blocks_from: wantBlocksFrom,
					sentAt: Date.now(),
				})

				log(
					`sent inventory_res id=${id} ` +
					`want_relay=${wantRelay.length} ` +
					`want_blocks_from=${wantBlocksFrom}`
				)

				return
			}

			// Station → Wallet payload
			case 'krisys_mesh_payload_v1': {
				const id = obj.id
				log(`recv payload id=${id}`)

				const blocks = Array.isArray(obj.blocks) ? obj.blocks.slice(0, INVENTORY_MAX_BLOCKS) : []
				const queued = Array.isArray(obj.queued) ? obj.queued.slice(0, INVENTORY_MAX_RELAY_HASHES) : []

				try {
					await disasterStorage.importSyncPayloadAsync({
						crisisId,
						familyId,
						payload: {
							version: 1,
							deviceId: 'station_peer',
							crisisId,
							generatedAt: Date.now(),
							chain_tip: null,
							blocks,
							queued,
							confirmed: {},
						}
					})

					log(`imported payload id=${id} ` + `blocks=${blocks.length} queued=${queued.length}`)

				} catch (e) {
					log(`payload import failed id=${id}: ${e?.message || e}`)
				}

				return
			}

			// Legacy wallet↔wallet sync protocol
			case 'krisys_mesh_sync_req_v1': {
				const id = obj.id
				const mode = obj.mode === true
				log(`recv sync req id=${id}`)

				const payload = obj.payload
				if (!payload || typeof payload !== 'object') {
					log('recv sync req: missing payload')
					return
				}

				try {
					await disasterStorage.importSyncPayloadAsync({
						crisisId,
						familyId,
						payload,
					})
					log(`imported peer payload (req id=${id})`)
				} catch (e) {
					log(`import failed (req id=${id}): ${e?.message || String(e)}`)
					return
				}

				if (mode) {
					log('push-only mode: not sending sync response')
					return
				}

				const myPayload = disasterStorage.exportSyncPayload({
					crisisId,
					familyId,
				})

				sendJson({
					t: 'krisys_mesh_sync_res_v1',
					id,
					sentAt: safeNow(),
					payload: myPayload,
				})

				log(`sent sync res id=${id}`)
				return
			}

			case 'krisys_mesh_sync_res_v1': {
				const id = obj.id

				if (!pendingSyncIdsRef.current.has(id)) {
					log(`recv sync res id=${id} (unexpected; ignoring)`)
					return
				}

				pendingSyncIdsRef.current.delete(id)

				const payload = obj.payload
				if (!payload || typeof payload !== 'object') {
					log(`recv sync res id=${id}: missing payload`)
					return
				}

				try {
					await disasterStorage.importSyncPayloadAsync({
						crisisId,
						familyId,
						payload,
					})
					log(`imported peer payload (res id=${id})`)
				} catch (e) {
					log(`import failed (res id=${id}): ${e?.message || String(e)}`)
				}

				return
			}

			// Ping - Pong comms test
			case 'krisys_p2p_ping':
				log('recv ping')
				sendJson({ t: 'krisys_p2p_pong', at: safeNow() })
				return
			case 'krisys_p2p_pong':
				log('recv pong')
				return

			default:
				return
		}

	}, [crisisId, familyId, log, sendJson])

	const attachDataChannelHandlers = useCallback( (dc) => {
		senderRef.current = createChunkSender({
			dc,
			log,
			onStats: (s) => {
				setMetrics((prev) => ({
					...(prev || {}),
					send: s,
				}))
			},
		})

		receiverRef.current = createChunkReceiver({
			onJson: handleIncomingJson,
			log,
			onStats: (s) => {
				setMetrics((prev) => ({
					...(prev || {}),
					recv: s,
				}))
			},
		})

		dc.onopen = () => {
			log('dc.open')
			setStatus('connected')

			// Send mandatory handshake immediately after connection opens
			if (connectionMode === 'station') {

				try {
					const stations = disasterStorage.getStations({ crisisId }) || {}
					const firstStation = Object.values(stations)[0]

				if (!firstStation) {
					log('No trusted station stored for handshake')
					return
				}
				
				sendJson({
					t: 'krisys_handshake_v1',
					baseUrl: 'http://localhost:6001', // dev only for now
					storedStation: firstStation,
				})

				log('sent handshake')
				} catch (e) {
					log(`handshake send failed: ${e?.message || String(e)}`)
				}
			}
			// If this side is a joining peer in user-hosted room (as opposed to station pools or relay rooms)
			else if (connectionMode === 'user_hosted_room_peer') {
				sendJson({
					t: 'krisys_user_room_handshake_v1',
					role: 'peer',
					crisisId,
					familyId,
					sentAt: Date.now(),
				})
				log('sent user_room_handshake')
			}
		}

		dc.onclose = () => {
			console.log('dc.close was triggered!')
			log('dc.close')
		}

		dc.onerror = () => {
			log('dc.error')
		}
		dc.onconnectionstatechange = ()=> {
			log('dc.onconnectionstatechange was triggered in P2PContext')
			console.log('dc.onconnectionstatechange was triggered in P2PContext')
			console.warn(dc.connectionState)
		}

		dc.onmessage = async (evt) => {
			try {
				const text = typeof evt?.data === 'string' ? evt.data : ''
				if (!text) {
					log('dc.message: [non-string or empty]')
					return
				}
				const receiver = receiverRef.current
				if (!receiver) return
				await receiver.handleText(text)
			} catch (e) {
				log(`dc.message error: ${e?.message || String(e)}`)
			}
		}
	}, [handleIncomingJson, log])


	// Connect to Relay via Flask → Node bridge
	const connectToRelay = useCallback(async (baseUrl) => {
		log('Creating new RTCPeerConnection for relay')
		setError(null)
		let _debug = connectionMode
		setConnectionMode("relay")
		log(`SET CONNECTION MODE CHANGED to relay from ${_debug}!`)
		console.warn(`SET CONNECTION MODE CHANGED to relay from ${_debug}!`)

		if (!canWebRTC) {
			setError('WebRTC not available in this browser.')
			return
		}

		if (!baseUrl || typeof baseUrl !== 'string') {
			setError('Invalid relay URL')
			return
		}

		const trimmedUrl = baseUrl.trim()
		if (!trimmedUrl) {
			setError('Invalid relay URL')
			return
		}

		reset()
		setRole('join')
		setStatus('connecting')
		log('Requesting offer from relay...')

		try {
			// 1. Request offer from relay Flask endpoint
			const offerResp = await fetch(`${trimmedUrl}/relay/allocate-offer`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			})

			if (!offerResp.ok) {
				throw new Error(`Relay offer request failed: ${offerResp.status}`)
			}

			const { peerId, offer } = await offerResp.json()

			log(`Received offer from relay (peerId=${peerId})`)

			// 2. Create local RTCPeerConnection
			const pc = new RTCPeerConnection({ iceServers: [] })
			pcRef.current = pc

			attachCommonHandlers(pc)

			// 3. Listen for data channel
			pc.ondatachannel = (evt) => {
				const dc = evt.channel
				dcRef.current = dc
				attachDataChannelHandlers(dc)
				log('Data channel received from relay')
			}

			// 4. Apply relay offer
			await pc.setRemoteDescription(new RTCSessionDescription(offer))

			// 5. Generate answer
			const answer = await pc.createAnswer()
			await pc.setLocalDescription(answer)

			await waitForIceGatheringComplete(pc)

			// 6. Send answer back to relay
			const answerResp = await fetch(`${trimmedUrl}/relay/answer`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					peerId,
					answer: pc.localDescription
				})
			})

			if (!answerResp.ok) {
				throw new Error(`Relay answer POST failed: ${answerResp.status}`)
			}

			log('Answer sent to relay')

		} catch (e) {
			setError(e?.message || String(e))
		}
	}, [
		canWebRTC,
		reset,
		log,
		attachCommonHandlers,
		attachDataChannelHandlers
	])


	// Connect to Station's Node WebRTC host via Flask endpoint
	const connectToStation = useCallback(async () => {
		log('Creating new RTCPeerConnection to station')

		setError(null)
		let _debug = connectionMode
		setConnectionMode("station")
		log(`SET CONNECTION MODE CHANGED to station from ${_debug}!`)
		console.warn(`SET CONNECTION MODE CHANGED to station from ${_debug}!`)

		if (!canWebRTC) {
			setError('WebRTC not available in this browser.')
			return
		}

		reset()
		setRole('join')
		setStatus('connecting')
		log('Requesting offer from station...')

		try {
			// 1. Ask station Node for a new offer
			const offerResp = await fetch(`${STATION_API_URL}/station/allocate-offer`, {
			// const offerResp = await fetch(`${STATION_SIGNAL_URL}/allocate-offer`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			})

			if (!offerResp.ok) {
				throw new Error(`Offer request failed: ${offerResp.status}`)
			}

			const { peerId, offer } = await offerResp.json()

			log(`Received offer from station (peerId=${peerId})`)

			// 2. Create local RTCPeerConnection
			const pc = new RTCPeerConnection({ iceServers: [] })
			pcRef.current = pc

			attachCommonHandlers(pc)

			// 3. Listen for data channel from station
			pc.ondatachannel = (evt) => {
				const dc = evt.channel
				dcRef.current = dc
				attachDataChannelHandlers(dc)
				log('Data channel received from station')
			}

			// 4. Apply station's offer
			// await pc.setRemoteDescription(offer)
			await pc.setRemoteDescription(new RTCSessionDescription(offer)) // browser compat. 

			// 5. Generate answer
			const answer = await pc.createAnswer()
			await pc.setLocalDescription(answer)

			await waitForIceGatheringComplete(pc)

			// 6. Send answer back to station Node
				// DEV NOTE: /answer is part of RTC signaling (Node on port 7000, not Flask on 6001)
				// - It is not policy-sensitive
				// - It attaches to in-memory RTCPeerConnection
				// - Proxying through Flask would add complexity without benefit
				
				// Allocation is policy-sensitive
				// Answer is transport-level
			const answerResp = await fetch(`${STATION_SIGNAL_URL}/answer`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					peerId,
					answer: pc.localDescription
				})
			})

			if (!answerResp.ok) {
				log(`Answer in P2PContext provider failed! Response object:\n\n${answerResp}\n------------------`)
				throw new Error(`Answer POST failed: ${answerResp.status}`)
			}
			log('Answer sent to station')

		} catch (e) {
			setError(e?.message || String(e))
		}
	}, [
		canWebRTC,
		reset,
		log,
		attachCommonHandlers,
		attachDataChannelHandlers
	])

	const createHostOffer = useCallback(async () => {
		setError(null)

		if (!canWebRTC) {
			setError('WebRTC not available in this browser/environment.')
			return
		}

		reset()
		setRole('host')
		setStatus('connecting')
		log('Creating host offer...')

		const pc = new RTCPeerConnection({ iceServers: [] })
		pcRef.current = pc
		attachCommonHandlers(pc)

		const dc = pc.createDataChannel('krisys', { ordered: true })
		dcRef.current = dc
		attachDataChannelHandlers(dc)

		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)
		await waitForIceGatheringComplete(pc)

		const local = pc.localDescription

		const code = createWebRTCRoomCode({
			kind: 'offer',
			crisisId,
			sdp: { type: local.type, sdp: local.sdp },
		})

		setOfferCode(code)
		log('Offer ready (copy/paste or show QR).')
	}, [attachCommonHandlers, attachDataChannelHandlers, canWebRTC, crisisId, log, reset,])

	const joinWithOffer = useCallback( async (rawOfferCode, { pushOnly = false } = {}) => {
		setError(null)

		if (!canWebRTC) {
			setError('WebRTC not available in this browser/environment.')
			return
		}

		const raw = (rawOfferCode || '').trim()
		if (!raw) {
			setError('Paste or scan an offer code first.')
			return
		}

		setPushOnlyOnJoin(!!pushOnly)

		reset()
		setRole('join')
		setStatus('connecting')
		log('Joining with offer...')

		const parsed = parseWebRTCRoomCode(raw)
		if (parsed.kind !== 'offer') {
			setError('That code is not an offer.')
			return
		}
		if (parsed.crisisId && crisisId && parsed.crisisId !== crisisId) {
			const ok = confirm(
				`Offer crisisId mismatch.\n\nLocal: ${crisisId}\nOffer: ${parsed.crisisId}\n\nContinue anyway?`
			)
			if (!ok) return
		}

		const pc = new RTCPeerConnection({ iceServers: [] })
		pcRef.current = pc
		attachCommonHandlers(pc)

		pc.ondatachannel = (evt) => {
			const dc = evt.channel
			dcRef.current = dc
			attachDataChannelHandlers(dc)
			log('Received data channel from host.')
		}

		await pc.setRemoteDescription(parsed.sdp)

		const answer = await pc.createAnswer()
		await pc.setLocalDescription(answer)
		await waitForIceGatheringComplete(pc)

		const local = pc.localDescription

		const code = createWebRTCRoomCode({
			kind: 'answer',
			crisisId,
			sdp: { type: local.type, sdp: local.sdp },
		})

		setAnswerCode(code)
		log('Answer ready. Give it back to the host.')
	}, [ attachCommonHandlers, attachDataChannelHandlers, canWebRTC, crisisId, log, reset,])
	

	const hostApplyAnswer = useCallback( async (rawAnswerCode) => {
		setError(null)

		const raw = (rawAnswerCode || '').trim()
		if (!raw) {
			setError('Paste or scan an answer code first.')
			return
		}

		const pc = pcRef.current
		if (!pc) {
			setError('No active host session. Create an offer first.')
			return
		}

		const parsed = parseWebRTCRoomCode(raw)
		if (parsed.kind !== 'answer') {
			setError('That code is not an answer.')
			return
		}

		if (parsed.crisisId && crisisId && parsed.crisisId !== crisisId) {
			const ok = confirm(
				`Answer crisisId mismatch.\n\nLocal: ${crisisId}\nAnswer: ${parsed.crisisId}\n\nContinue anyway?`
			)
			if (!ok) return
		}

		log('Applying answer...')
		await pc.setRemoteDescription(parsed.sdp)
	}, [crisisId, log])


	const sendPing = useCallback(() => {
		sendJson({ t: 'krisys_p2p_ping', at: safeNow() })
		log('sent ping')
	}, [log, sendJson])

	const closeAfterDrain = useCallback(async () => {
		const maxWaitMs = 8000
		const startedAt = safeNow()

		while (safeNow() - startedAt < maxWaitMs) {
			const senderStats = senderRef.current?.getStats?.()
			const queueDepth = senderStats?.queueDepth ?? null
			const bufferedAmount = senderStats?.bufferedAmount ?? null

			if (queueDepth === 0 && (bufferedAmount === 0 || bufferedAmount < 4096)) {
				break
			}
			await sleep(50)
		}

		try {
			if (dcRef.current) dcRef.current.close()
			if (pcRef.current) pcRef.current.close()
		} catch {
			// ignore
		}

		dcRef.current = null
		pcRef.current = null

		setPushOnlyOnJoin(false)
		setStatus('closed')
		setRole('idle')
		log('push-only: disconnected')
	}, [log])

	const p2pSyncNow = useCallback(async () => {
		setError(null)

		try {
			
			const id = makeId()
			pendingSyncIdsRef.current.add(id)

			const payload = disasterStorage.exportSyncPayload({ crisisId, familyId })
			sendJson({
				t: 'krisys_mesh_sync_req_v1',
				id,
				mode: pushOnlyOnJoin,
				sentAt: safeNow(),
				payload,
			})

			log(`sent sync req id=${id}`)

			if (pushOnlyOnJoin) {
				log('push-only mode: closing after drain')
				closeAfterDrain()
			}
		} catch (e) {
			setError(e?.message || String(e))
		}
	}, [closeAfterDrain, crisisId, familyId, log, pushOnlyOnJoin, sendJson])

	// Manually trigger inventory negotiation with station (station as host sync-ing with connected client)
	const p2pStationInventoryNow = useCallback(async (hostUrl) => {
		/*		When you click Sync Station:
		a) Wallet reads its own block index
		b) Wallet asks station for its block index (via /mesh/sync)
		c) Logs both
		d) Only triggers inventory if station is ahead

		DEV NOTE: This will be expanded later for 1 station to pull from HQ, distribute to sister stations nearby on same LAN and/or include some sort of broadcast but for now it's a new button in ConnectionsPage to help keep dev tests separated until they're no longer needed.
		*/
		setError(null)

		if (status !== 'connected') {
			log(`${connectionMode} sync aborted: not connected`)
			return
		}

		try {
			// 1. Get local wallet chain tip
			const localPayload = disasterStorage.exportSyncPayload({
				crisisId,
				familyId,
			})

			const localTipIndex = typeof localPayload.chain_tip?.block_index === 'number' ? localPayload.chain_tip.block_index : -1

			// 2. Ask station/relay for its current chain tip
			const url = `${hostUrl}/mesh/sync`
			const res = await fetch(
				url,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						crisisId,
						queued: [],
						blocks: [],
					}),
				}
			)

			const stationPayload = await res.json()

			const stationTipIndex = typeof stationPayload.chain_tip?.block_index === 'number' ? 
				stationPayload.chain_tip.block_index : -1

			log(`${connectionMode} sync check local_tip=${localTipIndex} ` + `station_tip=${stationTipIndex}`)

			// 3. If station/relay is ahead, trigger inventory negotiation
			if (stationTipIndex > localTipIndex) {
				log(`${connectionMode} ahead — requesting inventory`)
				const id = makeId()
				pendingSyncIdsRef.current.add(id)
				sendJson({
					t: 'krisys_mesh_inventory_v1',
					id: id,
					crisisId,
					chain_tip: localPayload.chain_tip || null,
					relay_hashes: (localPayload.queued || []).map(m => m?.relay_hash)
					.filter(Boolean)
					.slice(0, INVENTORY_MAX_RELAY_HASHES),
					sentAt: Date.now(),
				})
			}
			else if (localTipIndex > stationTipIndex) {
				log(`local ahead — pushing sync to ${connectionMode}`)
				const id = makeId()
				pendingSyncIdsRef.current.add(id)
				sendJson({
					t: 'krisys_mesh_sync_req_v1',
					id: id,
					mode: false,
					sentAt: Date.now(),
					payload: localPayload
				})
			}
			else {
				log(`${connectionMode} sync not needed — no new blocks`)
			}

		} catch (e) {
			setError(e?.message || String(e))
		}
	}, [status, crisisId, familyId, log, sendJson])


	const value = useMemo(() => {
		return {
			canWebRTC,

			status,
			role,
			error,
			metrics,

			offerCode,
			answerCode,
			remoteOfferInput,
			remoteAnswerInput,
			pushOnlyOnJoin,

			logLines,

			setOfferCode,
			setAnswerCode,
			setRemoteOfferInput,
			setRemoteAnswerInput,
			setPushOnlyOnJoin,

			reset,
			connectToStation,
			connectToRelay,
			createHostOffer,
			joinWithOffer,
			hostApplyAnswer,
			p2pSyncNow,
			p2pStationInventoryNow,
			sendPing,
		}
	}, [
		answerCode,
		canWebRTC,
		connectToStation,
		connectToRelay,
		createHostOffer,
		error,
		hostApplyAnswer,
		joinWithOffer,
		logLines,
		metrics,
		offerCode,
		p2pSyncNow,
		p2pStationInventoryNow,
		pushOnlyOnJoin,
		remoteAnswerInput,
		remoteOfferInput,
		reset,
		role,
		sendPing,
		status,
	])

	return <P2PContext.Provider value={value}>{children}</P2PContext.Provider>
}

export function useP2P() {
	const ctx = useContext(P2PContext)
	if (!ctx) throw new Error('useP2P must be used within a P2PProvider')
	return ctx
}
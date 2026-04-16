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

const PEER_IDLE_TIMEOUT_MS = 3 * 60 * 1000 // DEV NOTE: default 3 minute per-connection timeout - HOSTS DO NOT TIMEOUT!!!
// Math.max(5000, Math.floor(PEER_IDLE_TIMEOUT_MS / 3) // DEV NOTE: guard against really small intervals of 5s or less because it'll break /3
const PEER_IDLE_CHECK_INTERVAL = Math.floor(PEER_IDLE_TIMEOUT_MS / 3)

const STATION_API_URL = 'http://localhost:6001'
const STATION_SIGNAL_URL = 'http://localhost:7000'

const P2PContext = createContext(null)

function waitForIceGatheringComplete(pc, timeoutMs = 12000) {
	/* DEV NOTE: 
	Wait until ICE candidate gathering completes before exporting localDescription (ensures SDP contains full candidate set).
	This is signaling-phase only and is separate from runtime connection lifecycle handled in attachCommonHandlers.

	This runs:
		- During SDP creation
		- Before you serialize localDescription
		- Before you send answer back to signaling server
	
	Later phases of more complex network resolution may demand this be signalling be amended, for eg:
		- Trickle ICE
		- STUN/TURN
		- NAT traversal complexity
	*/
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

// accept familyId via props
export function P2PProvider({ children, crisisId, familyId }) {
	const connectionsRef = useRef(new Map())	// connection registry of all active RTC connections
	const activeConnectionIdRef = useRef(null)	// DEV NOTE: temp legacy compatibility
	const pendingSyncIdsRef = useRef(new Set())

	const [error, setError] = useState(null)

	const [offerCode, setOfferCode] = useState('')
	const [answerCode, setAnswerCode] = useState('')
	const [remoteOfferInput, setRemoteOfferInput] = useState('')
	const [remoteAnswerInput, setRemoteAnswerInput] = useState('')
	const [logLines, setLogLines] = useState([])

	const [metrics, setMetrics] = useState(null) 	// { send: {bytesSent,...}, recv: {bytesReceived,...} }

	// Persisted across page switches
	const [pushOnlyOnJoin, setPushOnlyOnJoin] = useState(false)

	if (!crisisId || !familyId) {
		throw new Error('P2PProvider requires crisisId and familyId')
	}

	const canWebRTC = useMemo(() => {
		return typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined'
	}, [])

	const log = useCallback( line => {
		setLogLines((prev) => {
			const next = Array.isArray(prev) ? prev.slice(-80) : []
			next.push(`${new Date().toLocaleTimeString()} ${line}`)
			return next
		})
	}, [])

	// Connection registry instance creator
	function createConnection({ transportRole }) {
		const id = makeId()
		const pc = new RTCPeerConnection({ iceServers: [] })
		const connection = {
			id,
			transportRole,	// transport layer role: | relay_client | station_client | relay_host // DEV NOTE: CHECK THIS!!!
			// user_hosted_room_peer (values for old global 'connectionMode')
			pc,
			dc: null,
			sender: null,
			receiver: null,
			status: 'connecting',		// initial lifecycle state: 'connecting' | 'connected' | 'closed'
			relayPollInterval: null,	// per-connection inventory polling interval
			lastActivity: safeNow(),	// safe fallback timeout per connection, default to save battery life if connection left open
		}
		connectionsRef.current.set(id, connection)
		activeConnectionIdRef.current = id		// DEV NOTE: legacy compatibility reference pointer to be removed

		logConnectionRegistry()

		return connection
	}

	function logConnectionRegistry() {
		const snapshot = Array.from(connectionsRef.current.entries()).map( ([id, conn]) => ({
			id,
			transportRole: conn.transportRole,
			hasDC: !!conn.dc,
			state: conn.pc?.connectionState,
		}))

		console.log("=== CONNECTION REGISTRY SNAPSHOT ===")
		console.table(snapshot)
	}

	const sendJson = useCallback ( (obj, connectionId = null) => {
		const id = connectionId || activeConnectionIdRef.current	// DEV NOTE: re: connectionId once we start doing rebroadcast across multiple peers we'll need to explicitly pass connectionId otherwise we'll be accidentally sending the peer to the wrong connection here. connectionId is thus a legacy compatibility option during development while transitioning to connection registry connectionRef
		const conn = connectionsRef.current.get(id)

		if (!conn || !conn.sender) {
			throw new Error('Connection sender not ready in P2PContext.js/??')
		}

		conn.sender.sendJson(obj) // createChunkSender()'s sendJson, this is not a recursive reference
		conn.lastActivity = safeNow()	// failsafe timeout so connections aren't accidentally left open
	}, []) // no deps since this function references connectionsRef.current, which is a static reference


	const emitP2PStatus = useCallback( next => {
		try {
			if (typeof window === 'undefined') return
			window.KRISYS_P2P_STATUS = next
			window.dispatchEvent(new CustomEvent('krisys:p2p_status', { detail: next }))
		} catch {
			// ignore
		}
	}, [])


	const sendRelayInventoryNow = useCallback( async (conn) => {
		// Guard: require a connection object
		if (!conn) return

		// Guard: only operate on relay transport connections
		if (conn.transportRole !== 'relay_client') {
			log(`relay poll: blocked (not relay_client)`)
			return
		}

		// Guard: only send if connection is currently usable
		if (conn.status !== 'connected') {
			log(`relay poll: blocked (status=${conn.status})`)
			return
		}

		// Guard: ensure data channel sender exists
		if (!conn.sender) {
			log(`relay poll: blocked (no sender)`)
			return
		}

		log(`relay poll: sending inventory on connection ${conn.id}`)

		try {
			// Export local state snapshot for relay negotiation
			const localPayload = disasterStorage.exportSyncPayload({
				crisisId,
				familyId,
			})

			// Extract bounded relay_hash list from queued messages
			const relayHashes = (localPayload.queued || [])
				.map((m) => m?.relay_hash)
				.filter(Boolean)
				.slice(0, INVENTORY_MAX_RELAY_HASHES)

			// Generate unique request ID
			const id = makeId()

			// Send relay inventory request over THIS connection only
			conn.sender.sendJson({
				t: 'krisys_relay_inventory_v1',
				id,
				crisisId,
				chain_tip: localPayload.chain_tip || null,
				relay_hashes: relayHashes,
				sentAt: safeNow(),
			})
		} catch (e) {
			log(`relay poll error on ${conn.id}: ${e?.message || e}`)
		}
	}, [crisisId, familyId, log, makeId,] )

	// CONNECTION MANAGEMENT
	const getAnyConnectedConnections = () => {	// RET: bool
		return Array.from(connectionsRef.current.values()).some( connection => connection.status === 'connected')
	}
	const getConnectedRelayConnections = () => { // RET: Array
		return Array.from(connectionsRef.current.values())
			.filter(conn => (conn.transportRole === 'relay_client' && conn.status === 'connected')
		)
	}
	const startIdleTimeoutForConnection = conn => {
		if (conn.idleInterval) return // Guard: prevents stacking intervals if one exists already

		// Only apply to peer-type connections
		if (conn.transportRole == 'relay_client' ||
			conn.transportRole == 'station_client' ||
			conn.transportRole == 'user_hosted_room_peer') {
				conn.idleInterval = setInterval( () => {
					if (conn.status !== 'connected') return

					const now = safeNow()
					if (now - conn.lastActivity > PEER_IDLE_TIMEOUT_MS) {
						console.log(`Idle timeout for connection ${conn.id}. Closing connection now...`)
						disconnectById(conn.id)
					}
				}, PEER_IDLE_CHECK_INTERVAL)
			}
	}


	useEffect(() => {
		emitP2PStatus({
			active: getAnyConnectedConnections(),
			metrics: metrics || null,
		})
	}, [emitP2PStatus, metrics])


	const reset = useCallback(() => {
		log("RESET CALLED")
		console.warn("RESET CALLED")

		disconnectAll() // same as destroyAllConnections(), uses disconnectById()

		setError(null)
		setOfferCode('')
		setAnswerCode('')
		setRemoteOfferInput('')
		setRemoteAnswerInput('')
		setLogLines([])
		setMetrics(null)
		pendingSyncIdsRef.current = new Set()
		setPushOnlyOnJoin(false)

		activeConnectionIdRef.current = null	// DEV NOTE: legacy reference pointer, to be removed in Phase 6

		emitP2PStatus({ active: false, status: 'closed', transportRole: 'idle' })
	}, [emitP2PStatus, log])

	useEffect(() => {
		return () => {
			// Provider unmount => teardown (leaving wallet route)
			try {
				destroyAllConnections()
			} catch {
				// ignore for now
			}
		}
	}, [])

	const attachCommonHandlers = useCallback( conn => {
		conn.pc.onconnectionstatechange = () => {
			log(`conn.pc.connectionState=${conn.pc.connectionState}`)

			if (conn.pc.connectionState === 'connected') { 
				conn.status = 'connected'
				console.log(`Connection ${conn.id} connected!`)
				
				// Start the failsafe idle timeoout by via conn.lastActivity...
				startIdleTimeoutForConnection(conn)

				if (conn.transportRole === 'relay_client') {
					if (!conn.relayPollInterval) {
						log(`Starting relay polling for ${conn.id}`)

						conn.relayPollInterval = setInterval(() => {
							if (conn.status !== 'connected') return
							sendRelayInventoryNow(conn)
						}, RELAY_POLL_INTERVAL_MS)
					}
				}
			}
			
			else if (conn.pc.connectionState === 'disconnected' || 
				conn.pc.connectionState === 'closed' || 
				conn.pc.connectionState === 'failed') {
					conn.status = 'closed'
					console.log(`Connection ${conn.id} closed!`)
					disconnectById(conn.id)
			}
		}

		conn.pc.oniceconnectionstatechange = () => {
			log(`conn.pc.iceConnectionState=${conn.pc.iceConnectionState}`)
		}

		conn.pc.onicegatheringstatechange = () => {
			log(`conn.pc.iceGatheringState=${conn.pc.iceGatheringState}`)
		}
	},[log, sendRelayInventoryNow]) // startIdleTimeout is always rendered static with the rest of the functions, so it doesn't need to be a dependency

	const handleIncomingJson = useCallback(async (obj, conn) => {
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
					sentAt: safeNow(),
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
				// if (relayPendingInventoryIdRef.current && id !== relayPendingInventoryIdRef.current) {
				// 	log(`relay inventory_res id=${id} (stale; ignoring)`)
				// 	return
				// }

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

				if (missingRelay.length > 0 || wantBlocksFrom !== null) {
					conn.lastActivity = safeNow() // failsafe timeout for connections left open
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
						sentAt: safeNow(), // Timestamp for debugging
					})

					return // Stop here to avoid falling through
				}

				// Request relay sync for missing items.
				conn.lastActivity = safeNow()	// failsafe timeout so connections aren't accidentally left open
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

				if (remoteTip && typeof remoteTip.block_index === 'number' &&
					localTip && typeof localTip.block_index === 'number') {
					
					if (remoteTip.block_index > localTip.block_index) {
						wantBlocksFrom = localTip.block_index + 1
					}
				}

				if ( wantRelayHashes.length > 0 || (typeof wantBlocksFrom === 'number') ) {
					conn.lastActivity = safeNow() // failsafe timeout for connections left open
				}

				// 4. Send inventory response
				sendJson({
					t: 'krisys_mesh_inventory_res_v1',
					id,
					want_relay_hashes: wantRelayHashes.slice(0, INVENTORY_MAX_RELAY_HASHES),
					want_blocks_from: wantBlocksFrom,
					sentAt: safeNow(),
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

				if ((typeof wantBlocksFrom === 'number') && wantRelayHashes.length > 0) conn.lastActivity = safeNow()	// failsafe timeout so connections aren't accidentally left open

				// Send inventory_res back to station to trigger payload
				sendJson({
					t: 'krisys_mesh_inventory_res_v1',
					id,
					want_relay_hashes: wantRelay,
					want_blocks_from: wantBlocksFrom,
					sentAt: safeNow(),
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
							generatedAt: safeNow(),
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

	const attachDataChannelHandlers = useCallback( (conn, dc) => {
		conn.dc = dc

		conn.sender = createChunkSender({
			dc,
			log,
			onStats: (s) => {
				setMetrics((prev) => ({
					...(prev || {}),
					send: s,
				}))
			},
		})

		conn.receiver = createChunkReceiver({
			onJson: (obj) => handleIncomingJson(obj, conn),
			log,
			onStats: (s) => {
				setMetrics((prev) => ({
					...(prev || {}),
					recv: s,
				}))
			},
		})

		dc.onopen = () => {
			log(`dc.open for ${conn.id} (${conn.transportRole})`)

			// Mark activity at connection open
			conn.lastActivity = safeNow()

			// Station handshake (wallet → station_client)
			if (conn.transportRole === 'station_client') {
				try {
					const stations = disasterStorage.getStations({ crisisId }) || {}
					const firstStation = Object.values(stations)[0]

					if (!firstStation) {
						log('No trusted station stored for handshake')
						return
					}

					conn.sender?.sendJson({
						t: 'krisys_handshake_v1',
						baseUrl: 'http://localhost:6001', // DEV ONLY
						storedStation: firstStation,
					})

					conn.lastActivity = safeNow()
					log('Sent station handshake')
				} catch (e) {
					log(`Station handshake failed: ${e?.message || String(e)}`)
				}
			}

			// User-hosted room peer handshake
			else if (conn.transportRole === 'user_hosted_room_peer') {
				conn.sender?.sendJson({
					t: 'krisys_user_room_handshake_v1',
					role: 'peer',
					crisisId,
					familyId,
					sentAt: safeNow(),
				})

				conn.lastActivity = safeNow()
				log('Sent user room handshake')
			}
		}

		dc.onclose = () => {
			console.log('dc.close was triggered!')
			log('dc.close')
		}

		dc.onerror = () => {
			log('dc.error')
		}

		dc.onmessage = async evt => {
			try {
				const text = typeof evt?.data === 'string' ? evt.data : ''
				if (!text) {
					log('dc.message: [non-string or empty]')
					return
				}

				if (!conn.receiver) return
				await conn.receiver.handleText(text)
			} catch (e) {
				log(`dc.message error: ${e?.message || String(e)}`)
			}
		}
	}, [handleIncomingJson, log])


	// Connect to Relay via Flask → Node bridge
	const connectToRelay = useCallback(async (baseUrl) => {
		log('Creating new RTCPeerConnection for relay')
		setError(null)

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
			const conn = createConnection({transportRole: 'relay_client'})
			attachCommonHandlers(conn)
			
			// 3. Listen for data channel
			conn.pc.ondatachannel = evt => {
				attachDataChannelHandlers(conn, evt.channel)
			}

			// 4. Apply relay offer
			await conn.pc.setRemoteDescription(new RTCSessionDescription(offer))

			// 5. Generate answer
			const answer = await conn.pc.createAnswer()
			await conn.pc.setLocalDescription(answer)

			await waitForIceGatheringComplete(conn.pc)

			// 6. Send answer back to relay
			const answerResp = await fetch(`${trimmedUrl}/relay/answer`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					peerId,
					answer: conn.pc.localDescription
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
		log,
		attachCommonHandlers,
		attachDataChannelHandlers
	])


	// Connect to Station's Node WebRTC host via Flask endpoint
	const connectToStation = useCallback(async () => {
		log('Creating new RTCPeerConnection to station')
		setError(null)

		if (!canWebRTC) {
			setError('WebRTC not available in this browser.')
			return
		}

		log('Requesting offer from station...')

		try {
			// 1. Ask station Node for a new offer
			const offerResp = await fetch(`${STATION_API_URL}/station/allocate-offer`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' }
			})

			if (!offerResp.ok) {
				throw new Error(`Offer request failed: ${offerResp.status}`)
			}

			const { peerId, offer } = await offerResp.json()

			log(`Received offer from station (peerId=${peerId})`)

			// 2. Create local RTCPeerConnection
			const conn = createConnection( {transportRole: 'station_client'} )
			attachCommonHandlers(conn)

			// 3. Listen for data channel from station
			conn.pc.ondatachannel = evt => {
				attachDataChannelHandlers(conn, evt.channel)
			}

			// 4. Apply station's offer
			await conn.pc.setRemoteDescription(new RTCSessionDescription(offer))

			// 5. Generate answer
			const answer = await conn.pc.createAnswer()
			await conn.pc.setLocalDescription(answer)

			await waitForIceGatheringComplete(conn.pc)

			// 6. Send answer back to station Node
				// DEV NOTE: /answer is part of RTC signaling (Node on port 7000, not Flask on 6001)
				// - It is not policy-sensitive
				// - It attaches to in-memory RTCPeerConnection
				// - Proxying through Flask would add complexity without benefit
				
			// Allocation is policy-sensitive, answer is transport-level
			const answerResp = await fetch(`${STATION_SIGNAL_URL}/answer`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					peerId,
					answer: conn.pc.localDescription
				})
			})

			if (!answerResp.ok) {
				log(`Answer in P2PContext provider failed! Response object:\n\n${answerResp}\n`)
				throw new Error(`Answer POST failed: ${answerResp.status}`)
			}
			log('Answer sent to station')

		} catch (e) {
			setError(e?.message || String(e))
		}
	}, [
		canWebRTC,
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

		log('Creating host offer...')

		const conn = createConnection({ transportRole: 'user_hosted_room_host' })
		attachCommonHandlers(conn)

		const dc = conn.pc.createDataChannel('krisys', { ordered: true })
		attachDataChannelHandlers(conn, dc)

		const offer = await conn.pc.createOffer()
		await conn.pc.setLocalDescription(offer)
		await waitForIceGatheringComplete(conn.pc)

		const local = conn.pc.localDescription

		const code = createWebRTCRoomCode({
			kind: 'offer',
			crisisId,
			sdp: { type: local.type, sdp: local.sdp },
		})

		// helps show sdp's are different since they'll look very similar when generated on the same machine
		// console.log("OFFER FIRST 100 CHARS:", conn.pc.localDescription.sdp.slice(0, 100)) 

		setOfferCode(code)
		log('Offer ready (copy/paste or show QR).')
		return {
			connId : conn.id,
			offerCode: code,
		}
	}, [attachCommonHandlers, attachDataChannelHandlers, canWebRTC, crisisId, log])

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

		const conn = createConnection({ transportRole: 'user_hosted_room_peer' })
		attachCommonHandlers(conn)

		conn.pc.ondatachannel = evt => {
			attachDataChannelHandlers(conn, evt.channel)
		}

		await conn.pc.setRemoteDescription(parsed.sdp)

		const answer = await conn.pc.createAnswer()
		await conn.pc.setLocalDescription(answer)
		await waitForIceGatheringComplete(conn.pc)

		const local = conn.pc.localDescription

		const code = createWebRTCRoomCode({
			kind: 'answer',
			crisisId,
			sdp: { type: local.type, sdp: local.sdp },
		})

		setAnswerCode(code)
		log('Answer ready. Give it back to the host.')
	}, [attachCommonHandlers, attachDataChannelHandlers, canWebRTC, crisisId, log])
	

	const hostApplyAnswer = useCallback( async (connId, rawAnswerCode) => {
		setError(null)

		const raw = (rawAnswerCode || '').trim()
		if (!raw) {
			setError('Paste or scan an answer code first.')
			return
		}

		const id = connId
		if (!id){
			setError("No active host session.")
			console.error(activeConnectionIdRef.current)
			return
		}

		const conn = connectionsRef.current.get(id)
		if (!conn) {
			setError("No active host connection found!!!")
			return
		}

		const parsed = parseWebRTCRoomCode(raw)
		if (parsed.kind !== 'answer') {
			setError('That code is not an answer.')
			return
		}

		log('Applying answer...')
		await conn.pc.setRemoteDescription(parsed.sdp)
	}, [crisisId, log])


	// ---------------------
	// Disconnection Helpers
	const disconnectById = useCallback( id => {
		const conn = connectionsRef.current.get(id)
		if (!conn) return

		try { conn.sender?.destroy?.() } catch {}
		try { conn.receiver?.destroy?.() } catch {}
		try { conn.dc?.close() } catch {}
		try { conn.pc?.close() } catch {}

		// Remove interval for this connection before deleting it
		if (conn.relayPollInterval) {
			clearInterval(conn.relayPollInterval)
			conn.relayPollInterval = null
		}
		if (conn.idleInterval) {
			clearInterval(conn.idleInterval)
			conn.idleInterval = null
		}
		conn.status = 'closed'
		connectionsRef.current.delete(id)

		logConnectionRegistry()

		// If active connection removed, clear pointer
		if (activeConnectionIdRef.current === id) {
			activeConnectionIdRef.current = null	// DEV NOTE: legacy compatibility later
		}

		log(`Disconnected connection: ${id}`)

	}, [log])
	const disconnectByTransportRole = useCallback( transportRole => {
		const idsToRemove = []

		for (const [id, conn] of connectionsRef.current.entries()) {
			if (conn.transportRole === transportRole) {
				idsToRemove.push(id)
			}
		}

		idsToRemove.forEach(id => disconnectById(id))

		log(`Disconnected all connections with transportRole ${transportRole}`)
	}, [disconnectById, log])

	// For transport layer to call...
	const destroyAllConnections = useCallback( () => {
		const ids = Array.from(connectionsRef.current.keys())
		ids.forEach( id => disconnectById(id) )
		log("Disconnected all connections")
	}, [disconnectById])	
	// For user UI layer to call...
	const disconnectAll = useCallback(() => {
		destroyAllConnections()

		activeConnectionIdRef.current = null	// DEV NOTE: legacy pointer
		// setStatus('disconnected')

		log('Disconnected all connections')
	}, [disconnectById, log])
	// -------------------

	const sendPing = useCallback(() => {
		for (const [id, conn] of connectionsRef.current.entries()) {
			try {
				conn.sender?.sendJson({
					t: 'krisys_p2p_ping',
					at: safeNow(),
				})
				log(`sent ping to ${id}`)
			} catch (e) {
				console.warn("Ping failed for", id)
			}
		}
	}, [log])

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

			// 3. If station/relay is ahead, trigger inventory negotiation
			if (stationTipIndex > localTipIndex) {
				// log(`${connectionMode} ahead — requesting inventory`)
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
					sentAt: safeNow(),
				})
			}
			else if (localTipIndex > stationTipIndex) {
				// log(`local ahead — pushing sync to ${connectionMode}`)
				const id = makeId()
				pendingSyncIdsRef.current.add(id)
				sendJson({
					t: 'krisys_mesh_sync_req_v1',
					id: id,
					mode: false,
					sentAt: safeNow(),
					payload: localPayload
				})
			}
			else {
				// log(`${connectionMode} sync not needed — no new blocks`)
			}

		} catch (e) {
			setError(e?.message || String(e))
		}
	}, [crisisId, familyId, log, sendJson])


	const value = useMemo(() => {
		return {
			canWebRTC,
			disconnectAll,
			disconnectById,
			disconnectByTransportRole,

			offerCode,
			setOfferCode,

			answerCode,
			setAnswerCode,

			remoteOfferInput,
			setRemoteOfferInput,

			remoteAnswerInput,
			setRemoteAnswerInput,

			pushOnlyOnJoin,
			setPushOnlyOnJoin,

			error,
			metrics,
			logLines,

			reset,
			connectToStation,
			connectToRelay,
			createHostOffer,
			joinWithOffer,
			hostApplyAnswer,
			p2pStationInventoryNow,
			sendPing,
		}
	}, [
		answerCode,
		canWebRTC,
		connectToStation,
		connectToRelay,
		createHostOffer,
		disconnectAll,
		disconnectById,
		disconnectByTransportRole,
		error,
		hostApplyAnswer,
		joinWithOffer,
		logLines,
		metrics,
		offerCode,
		p2pStationInventoryNow,
		pushOnlyOnJoin,
		remoteAnswerInput,
		remoteOfferInput,
		reset,
		sendPing,
	])

	return <P2PContext.Provider value={value}>{children}</P2PContext.Provider>
}

export function useP2P() {
	const ctx = useContext(P2PContext)
	if (!ctx) throw new Error('useP2P must be used within a P2PProvider')
	return ctx
}
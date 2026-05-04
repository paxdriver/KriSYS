// krisys-frontend/contexts/P2PContext.js
'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { disasterStorage } from '@/services/localStorage'
import { createWebRTCRoomCode, parseWebRTCRoomCode } from '@/services/webrtcRoomCode'
import { createChunkReceiver, createChunkSender, makeId } from '@/services/webrtcChunking'

const INVENTORY_MAX_RELAY_HASHES = 100	// DEV NOTE: Set this by env var when building policy wizard
const INVENTORY_MAX_BLOCKS = 10			// DEV NOTE: Set this by env var when building policy wizard
const RELAY_MAX_BLOCKS_PER_POLL = 10 	// Max block suffix to request per poll

// Definition: "How often a wallet acting as relay_client sends inventory negotiation to a relay container."
const RELAY_POLL_INTERVAL_MS = 30000 	// Poll 5s after the last attempt completes. relay_client only!

// Definition: peer timer when connected to a station for how often to check for new data to sync
const PEER_TO_POLL_STATION_INTERVAL = RELAY_POLL_INTERVAL_MS * 10	// less frequently than relays, stations will be busier than relays, don't spam them

// Definition: peer timer when connected to a relay, station, or user-hosted-room: "If this connection sees no meaningful activity for X time, close it."
const PEER_IDLE_TIMEOUT_MS = 30 * 60 * 1000 // DEV NOTE: default 3 minute per-connection timeout - HOSTS DO NOT TIMEOUT!!!
// Math.max(5000, Math.floor(PEER_IDLE_TIMEOUT_MS / 3) // DEV NOTE: guard against really small intervals of 5s or less because it'll break /3

// Defintion: "How often you check whether the timeout threshold has been exceeded." This is battery protection timeout when connection is open but no new data to sync
const PEER_IDLE_CHECK_INTERVAL = Math.floor(PEER_IDLE_TIMEOUT_MS / 3)

/*		Variable				Category		Purpose									Who Uses It
-----------------------------------------------------------------------------------------------------
RELAY_POLL_INTERVAL_MS			Sync polling	Relay inventory negotiation				relay_client
PEER_TO_POLL_STATION_INTERVAL	Sync polling 	Station inventory negotiation			station_client
PEER_IDLE_TIMEOUT_MS			Timeout			Max inactivity allowed					wallet peers
PEER_IDLE_CHECK_INTERVAL		Timeout 		cadence	How often to check inactivity	wallet peers
*/

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
	const pendingSyncIdsRef = useRef(new Set())

	const [error, setError] = useState(null)

	const [offerCode, setOfferCode] = useState('')
	const [answerCode, setAnswerCode] = useState('')
	const [remoteOfferInput, setRemoteOfferInput] = useState('')
	const [remoteAnswerInput, setRemoteAnswerInput] = useState('')
	const [logLines, setLogLines] = useState([])
	
	const [syncing, setSyncing] = useState(false)	// setting button disabled while sync runs
	const [lastResult, setLastResult] = useState(null) // setting a simple viewer for status updates

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
			stationPollInterval: null,	// separate inventory polling interval
			lastActivity: safeNow(),	// safe fallback timeout per connection, default to save battery life if connection left open
		}
		connectionsRef.current.set(id, connection)

		logConnectionRegistry()

		return connection
	}

	// HELPER TO GET AN UPDATED LIST OF ACTIVE CONNECTIONS AND THEIR STATUSES
	const getConnectionsSnapshot = ()=>{
		const snapshot = []

		for (const [id, conn] of connectionsRef.current.entries()) {
			snapshot.push({
				id,															// unique connection id
				transportRole: conn.transportRole,							// relay_client | station_client | etc
				status: conn.status,										// connecting | connected | closed
				connectionState: conn.pc?.connectionState || null, 			// native RTCPeerConnection state
				iceConnectionState: conn.pc?.iceConnectionState || null,
				hasDataChannel: !!conn.dc,									// whether data channel exists
				lastActivity: conn.lastActivity || null,					// ms timestamp
				relayPollActive: !!conn.relayPollInterval,
				stationPollActive: !!conn.stationPollInterval,
			})
		}

		return snapshot
	}

	// Manually trigger a full sync negotiation on a specific connection. This derives which sync routine to run based on transportRole.
	const fullSyncByConnDerivedTransportRole = (connId) => {
		if (!connId || typeof connId !== 'string') {
			log('fullSync: invalid connId')
			return
		}

		const conn = connectionsRef.current.get(connId)

		if (!conn) {
			log(`fullSync: connection not found (${connId})`)
			return
		}

		if (conn.status !== 'connected') {
			log(`fullSync: connection ${connId} not connected (status=${conn.status})`)
			return
		}

		// DEV NOTE: TODO - FULL FLOW
		// Relay client path
		if (conn.transportRole === 'relay_client') {
			log(`fullSync: triggering relay inventory on ${connId}`)
			sendRelayInventoryNow(conn)
			return
		}

		// STATION CLIENT
		// ==============================
		if (conn.transportRole === 'station_client') {
			log(`fullSync: triggering station inventory on ${connId}`)
			sendStationInventoryNow(conn)
			return
		}

		// User-hosted peers do not participate in relay/station inventory model
		log(`fullSync: no sync handler for transportRole=${conn.transportRole}`)
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

	const sendJson = useCallback ( (conn, obj) => {
		
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



	// CLIENT SYNC WITH CONNECTED STATION
	const sendStationInventoryNow = useCallback(async (conn) => {

		if (!conn || conn.transportRole !== 'station_client') {
			log('station sync: invalid connection')
			return
		}

		if (conn.status !== 'connected') {
			log(`station sync: blocked (status=${conn.status})`)
			return
		}

		if (!conn.sender) {
			log('station sync: blocked (no sender)')
			return
		}

		log(`station sync: starting on ${conn.id}`)

		const localPayload = disasterStorage.exportSyncPayload({
			crisisId,
			familyId,
		})

		const relayHashes = (localPayload.queued || [])
			.map(m => m?.relay_hash)
			.filter(Boolean)

		// -------------------------
		// STEP 1: INVENTORY
		// -------------------------
		const inventoryId = makeId()

		const inventoryRes = await new Promise((resolve) => {

			const handler = (obj) => {
				if (obj?.t === 'station_to_client_inventory_res' && obj.id === inventoryId) {
					conn.receiver?.unregisterTempHandler?.(handler)
					resolve(obj)
				}
			}

			conn.receiver?.registerTempHandler?.(handler)

			// SEND AFTER handler is registered (avoids race)
			conn.sender.sendJson({
				t: 'client_to_station_inventory_req',
				id: inventoryId,
				crisisId,
				chain_tip: localPayload.chain_tip || null,
				relay_hashes: relayHashes,
				sentAt: Date.now(),
			})

			setTimeout(() => {
				conn.receiver?.unregisterTempHandler?.(handler)
				resolve(null)
			}, 5000)
		})

		if (!inventoryRes) {
			log('[SYNC] Station inventory timeout')
			return
		}

		log('[SYNC] Station inventory received')
		
		const stationRelayHashes = new Set(inventoryRes.relay_hashes || [])
		const clientRelayHashes = new Set(relayHashes)

		// What client is missing FROM station
		const missingFromStation = [...stationRelayHashes].filter( rh => !clientRelayHashes.has(rh) )

		// What station is missing FROM client
		const stationNeeds = [...clientRelayHashes].filter( rh => !stationRelayHashes.has(rh) )
		let queuedToPush = []

		if (stationNeeds.length > 0) {
			queuedToPush = (localPayload.queued || []).filter(m =>
				stationNeeds.includes(m?.relay_hash)
			)
		}

		// -------------------------
		// STEP 2: SYNC
		// -------------------------
		const syncId = makeId()

		const syncRes = await new Promise((resolve) => {

			const handler = (obj) => {
				if (obj?.t === 'station_to_client_sync_res' && obj.id === syncId) {
					conn.receiver?.unregisterTempHandler?.(handler)
					resolve(obj)
				}
			}

			conn.receiver?.registerTempHandler?.(handler)

			conn.sender.sendJson({
				t: 'client_to_station_sync_req',
				id: syncId,
				crisisId,
				queued: queuedToPush,
				want_relay_hashes: missingFromStation,
				want_blocks_from: inventoryRes.want_blocks_from,
				max_blocks: 10,
				sentAt: Date.now(),
			})

			setTimeout(() => {
				conn.receiver?.unregisterTempHandler?.(handler)
				resolve(null)
			}, 5000)
		})

		if (!syncRes) {
			log('[SYNC] Station sync timeout')
			return
		}

		log('[SYNC] Station sync received',
			'blocks=', (syncRes.blocks || []).length,
			'queued=', (syncRes.queued || []).length)

		// -------------------------
		// STEP 3: IMPORT
		// -------------------------
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
					blocks: syncRes.blocks || [],
					queued: syncRes.queued || [],
					confirmed: {},
				},
			})

			log('[SYNC] Station import complete')

		} catch (e) {
			log('[SYNC] Station import failed: ' + (e?.message || e))
		}

	}, [crisisId, familyId, log])



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

			// DEBUGGING
			console.log('[1] WALLET → RELAY inventory send relay_hashes:', relayHashes)

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

			// FOR EACH 'CONNECTED' CONNECTION
			if (conn.pc.connectionState === 'connected') {
				conn.status = 'connected'
				console.log(`Connection ${conn.id} connected!`)
				
				// Start the failsafe idle timeoout by via conn.lastActivity...
				startIdleTimeoutForConnection(conn)

				// RELAY CLIENT
				if (conn.transportRole === 'relay_client') {
					// Manual sync only (no automatic polling)
					log(`Relay connection ${conn.id} ready (manual sync only)`)
				}

				// STATION CLIENT
				if (conn.transportRole === 'station_client') {
					if (!conn.stationPollInterval) {
						log(`Starting station polling for ${conn.id}`)
						
						conn.stationPollInterval = setInterval(() => {
							if (conn.status !== 'connected') return
							sendStationInventoryNow(conn)
						}, PEER_TO_POLL_STATION_INTERVAL) // DEV NOTE: using same cadence polling schedule as PEER_IDLE_CHECK_INTERVAL
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
	},[log, sendRelayInventoryNow, sendStationInventoryNow]) // startIdleTimeoutForConnection defined in same render scope and does not depend on closure values

	const handleIncomingJson = useCallback(async (obj, conn) => {
		if (!obj || typeof obj !== 'object') return
		if (!crisisId || !familyId) {
			log('recv message: missing crisisId/familyId context locally')
			return
		}
		console.log(obj)
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
				sendJson(conn, {
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

			case 'krisys_relay_inventory_res_v1': {

				// DEBUGGING
				console.log('[5] WALLET received inventory_res want:', obj.want_relay_hashes)
				console.log('[5] WALLET received inventory_res missing:', obj.missing_relay_hashes)

				// 1. We just received an inventory response from the relay.
				//	This came from: Wallet → Node (server.js) → Flask /mesh/inventory → Node → Wallet
				const id = obj.id
				log(`recv relay inventory_res id=${id}`)

				// 2. Read relay's reported chain tip (for block negotiation)
				const localPayload = disasterStorage.exportSyncPayload({
					crisisId,
					familyId,
				})

				const localTipIndex = typeof localPayload.chain_tip?.block_index === 'number' ? 
					localPayload.chain_tip.block_index : -1

				const relayTipIndex = typeof obj.chain_tip?.block_index === 'number' ?
					obj.chain_tip.block_index : -1

				// 3. Determine what the relay says it is missing FROM US
				// (We must PUSH these queued items to the relay)
				const relayMissingFromUs = Array.isArray(obj.missing_relay_hashes) ? 
					obj.missing_relay_hashes.slice(0, INVENTORY_MAX_RELAY_HASHES) : []

				// 4. Determine what we are missing FROM THE RELAY
				// (We must REQUEST these from the relay)
				const weMissingFromRelay = Array.isArray(obj.want_relay_hashes) ? 
					obj.want_relay_hashes.slice(0, INVENTORY_MAX_RELAY_HASHES) : []

				// 5. Determine if we need block suffix from relay
				// (Block negotiation separate from queued negotiation)
				const wantBlocksFrom = relayTipIndex > localTipIndex ? localTipIndex + 1 : null

				// If wallet is ahead, push blocks to relay
				let blocksToPush = []
				if (localTipIndex > relayTipIndex) {
					const allBlocks = disasterStorage.getBlockchain({ crisisId }) || []
					blocksToPush = allBlocks.filter(b =>
						typeof b.block_index === 'number' &&
						b.block_index > relayTipIndex
					).slice(0, RELAY_MAX_BLOCKS_PER_POLL)
				}

				// 6. If NOTHING is needed in either direction, stop
				if (relayMissingFromUs.length === 0 && weMissingFromRelay.length === 0 && wantBlocksFrom == null) {
					log('Relay and client are already aligned')
					return
				}

				// Mark activity to prevent idle timeout
				conn.lastActivity = safeNow()

				// 7. Build selective PUSH payload (only what relay is missing)
				// This is data we SEND TO relay
				let queuedToPush = []
				if (relayMissingFromUs.length > 0) {
					const localQueued = Array.isArray(localPayload.queued) ? localPayload.queued : []

					queuedToPush = localQueued.filter(m => relayMissingFromUs.includes(m?.relay_hash))
				}

				// DEBUGGING
				console.log('[6] WALLET → RELAY sync_req push:', queuedToPush.map(m => m.relay_hash))
				console.log('[6] WALLET → RELAY sync_req request:', weMissingFromRelay)

				// 8. Send relay sync request.
				//    This goes: Wallet → Node server.js → Flask /mesh/sync → Node → Wallet
				sendJson(conn, {
					t: 'krisys_relay_sync_req_v1',	// Relay sync request
					id: makeId(),	// Unique request id
					crisisId,		// Crisis pin for safety

					// PUSH: items relay said it is missing
					queued: queuedToPush,

					// push blocks if we are ahead
					blocks: blocksToPush,

					// REQUEST: items we are missing from relay
					want_relay_hashes: weMissingFromRelay,

					// REQUEST: block suffix if relay tip ahead
					want_blocks_from: wantBlocksFrom,

					// Cap returned blocks per poll
					max_blocks: RELAY_MAX_BLOCKS_PER_POLL,

					sentAt: safeNow(),
				})

				log(
					`sent relay_sync_req push=${queuedToPush.length} ` +
					`request=${weMissingFromRelay.length} ` +
					`blocksFrom=${wantBlocksFrom}` +
					`blocksToPush=${blocksToPush}`
				)

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

					// DEBUGGING
					console.log('[8] WALLET queue after import:',
						disasterStorage.getMessageQueue({ crisisId, familyId })
							.map(m => m.relay_hash)
					)

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
				sendJson(conn, {
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

				if ((typeof wantBlocksFrom === 'number') && wantRelay.length > 0) conn.lastActivity = safeNow()	// failsafe timeout so connections aren't accidentally left open

				// Send inventory_res back to station to trigger payload
				sendJson(conn, {
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

				sendJson(conn, {
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
				sendJson(conn, { t: 'krisys_p2p_pong', at: safeNow() })
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
		setLastResult({
			at: Date.now(),
			label: 'disconnected connection',
			hostUrl: 'TO-DO',
			type: 'ping',
			connId: conn?.id.toString(),
			connObj: JSON.stringify(conn, null, 2),
		})
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
		if (conn.stationPollInterval) {
			clearInterval(conn.stationPollInterval)
			conn.stationPollInterval = null
		}
		conn.status = 'closed'
		connectionsRef.current.delete(id)

		logConnectionRegistry()
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
		log('Disconnected all connections')
	}, [disconnectById, log])
	// -------------------

	// ==============================
	// FULL STATION SYNC (NEW PROTOCOL)
	// ==============================
	const runStationSync = useCallback(async (connId) => {

		const conn = connectionsRef.current.get(connId)
		if (!conn || conn.transportRole !== 'station_client') {
			log('runStationSync: invalid connection')
			return
		}

		if (conn.status !== 'connected') {
			log('runStationSync: connection not ready')
			return
		}

		if (!conn.sender) {
			log('runStationSync: no sender')
			return
		}

		log('[SYNC] Starting station sync')

		// ------------------------------
		// STEP 1: INVENTORY REQUEST
		// ------------------------------
		const localPayload = disasterStorage.exportSyncPayload({
			crisisId,
			familyId,
		})

		const relayHashes = (localPayload.queued || [])
			.map(m => m?.relay_hash)
			.filter(Boolean)

		const inventoryId = makeId()

		conn.sender.sendJson({
			t: 'client_to_station_inventory_req',
			id: inventoryId,
			crisisId,
			chain_tip: localPayload.chain_tip || null,
			relay_hashes: relayHashes,
			sentAt: Date.now(),
		})

		log('[SYNC] Sent inventory request')

		// ------------------------------
		// STEP 2: WAIT FOR RESPONSE
		// ------------------------------
		const waitForInventory = () => new Promise((resolve) => {

			const handler = (obj) => {
				if (obj?.t === 'station_to_client_inventory_res' && obj.id === inventoryId) {
					resolve(obj)
				}
			}

			conn.receiver?.registerTempHandler?.(handler)

			setTimeout(() => resolve(null), 5000)
		})

		const inventoryRes = await waitForInventory()

		if (!inventoryRes) {
			log('[SYNC] Inventory response timeout')
			return
		}

		log('[SYNC] Received inventory response')

		// ------------------------------
		// STEP 3: BUILD SYNC REQUEST
		// ------------------------------
		const missingFromStation = inventoryRes.want_relay_hashes || []
		const stationNeeds = inventoryRes.missing_relay_hashes || []

		let queuedToPush = []

		if (stationNeeds.length > 0) {
			queuedToPush = (localPayload.queued || []).filter(m =>
				stationNeeds.includes(m?.relay_hash)
			)
		}

		const syncId = makeId()

		conn.sender.sendJson({
			t: 'client_to_station_sync_req',
			id: syncId,
			crisisId,

			// PUSH (what station needs)
			queued: queuedToPush,

			// REQUEST (what we want)
			want_relay_hashes: missingFromStation,

			want_blocks_from: inventoryRes.want_blocks_from,
			max_blocks: 10,

			sentAt: Date.now(),
		})

		log(
			'[SYNC] Sent sync request',
			'push=', queuedToPush.length,
			'request=', missingFromStation.length
		)

		// ------------------------------
		// STEP 4: WAIT FOR SYNC RESPONSE
		// ------------------------------
		const waitForSync = () => new Promise((resolve) => {

			const handler = (obj) => {
				if (obj?.t === 'station_to_client_sync_res' && obj.id === syncId) {
					resolve(obj)
				}
			}

			conn.receiver?.registerTempHandler?.(handler)

			setTimeout(() => resolve(null), 5000)
		})

		const syncRes = await waitForSync()

		if (!syncRes) {
			log('[SYNC] Sync response timeout')
			return
		}

		log(
			'[SYNC] Received sync response',
			'blocks=', (syncRes.blocks || []).length,
			'queued=', (syncRes.queued || []).length
		)

		// ------------------------------
		// STEP 5: IMPORT DATA
		// ------------------------------
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
					blocks: syncRes.blocks || [],
					queued: syncRes.queued || [],
					confirmed: {},
				},
			})

			log('[SYNC] Import complete')

		} catch (e) {
			log('[SYNC] Import failed: ' + (e?.message || e))
		}

	}, [crisisId, familyId, log])

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
	// Send ping to a specific connection only
	const sendPingToConnection = useCallback((connId) => {
		if (!connId || typeof connId !== 'string') {
			log('ping: invalid connId')
			return
		}

		const conn = connectionsRef.current.get(connId)

		if (!conn) {
			log(`ping: connection not found (${connId})`)
			return
		}

		if (conn.status !== 'connected') {
			log(`ping: connection ${connId} not connected`)
			return
		}

		try {
			conn.sender?.sendJson({
				t: 'krisys_p2p_ping',
				at: safeNow(),
			})

			log(`sent ping to ${connId}`)

			// mark activity so idle timeout doesn’t kill active test
			conn.lastActivity = safeNow()

		} catch (e) {
			log(`ping failed for ${connId}: ${e?.message || e}`)
		}
	}, [log])

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
			lastResult,
			setLastResult,

			reset,
			connectToStation,
			connectToRelay,
			createHostOffer,
			joinWithOffer,
			hostApplyAnswer,
			sendPing,
			sendPingToConnection,
			syncing,
			setSyncing,

			getConnectionsSnapshot,
			fullSyncByConnDerivedTransportRole,
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
		lastResult,
		metrics,
		offerCode,
		pushOnlyOnJoin,
		remoteAnswerInput,
		remoteOfferInput,
		reset,
		sendPing,
		sendPingToConnection,
		syncing,
	])

	return <P2PContext.Provider value={value}>{children}</P2PContext.Provider>
}

export function useP2P() {
	const ctx = useContext(P2PContext)
	if (!ctx) throw new Error('useP2P must be used within a P2PProvider')
	return ctx
}
// krisys-frontend/contexts/P2PContext.js
'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { disasterStorage } from '@/services/localStorage'
import { createWebRTCRoomCode, parseWebRTCRoomCode } from '@/services/webrtcRoomCode'
import { createChunkReceiver, createChunkSender, makeId } from '@/services/webrtcChunking'

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

	const [logLines, setLogLines] = useState([])

	// { send: {bytesSent,...}, recv: {bytesReceived,...} }
	const [metrics, setMetrics] = useState(null)

	// Persisted across page switches; used by p2pSyncNow()
	const [pushOnlyOnJoin, setPushOnlyOnJoin] = useState(false)

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

	const emitP2PStatus = useCallback((next) => {
		try {
			if (typeof window === 'undefined') return
			window.KRISYS_P2P_STATUS = next
			window.dispatchEvent(new CustomEvent('krisys:p2p_status', { detail: next }))
		} catch {
			// ignore
		}
	}, [])

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
			// ignore
		}
		try {
			if (receiverRef.current?.destroy) receiverRef.current.destroy()
		} catch {
			// ignore
		}
		senderRef.current = null
		receiverRef.current = null
	}, [])

	const closeRtc = useCallback(() => {
		try {
			if (dcRef.current) dcRef.current.close()
		} catch {
			// ignore
		}
		try {
			if (pcRef.current) pcRef.current.close()
		} catch {
			// ignore
		}
		dcRef.current = null
		pcRef.current = null
	}, [])

	const reset = useCallback(() => {
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
				// ignore
			}
		}
	}, [reset])

	const attachCommonHandlers = useCallback(
		(pc) => {
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
		},
		[log]
	)

	const sendJson = useCallback((obj) => {
		const sender = senderRef.current
		if (!sender) throw new Error('Sender not ready')
		sender.sendJson(obj)
	}, [])

	const handleIncomingJson = useCallback(
		async (obj) => {
			if (!obj || typeof obj !== 'object') return
			if (!crisisId || !familyId) {
				log('recv sync req: missing crisisId/familyId context locally')
				return
			}

			if (obj.t === 'krisys_mesh_sync_req_v1') {
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

				try {
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
				} catch (e) {
					log(`send res failed: ${e?.message || String(e)}`)
				}

				return
			}

			if (obj.t === 'krisys_mesh_sync_res_v1') {
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

				if (!crisisId || !familyId) {
					log('recv sync res: missing crisisId/familyId context locally')
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

			if (obj.t === 'krisys_p2p_ping') {
				log('recv ping')
				try {
					sendJson({ t: 'krisys_p2p_pong', at: safeNow() })
				} catch {
					// ignore
				}
				return
			}

			if (obj.t === 'krisys_p2p_pong') {
				log('recv pong')
				return
			}
		},
		[crisisId, familyId, log, sendJson]
	)

	const attachDataChannelHandlers = useCallback(
		(dc) => {
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
			}

			dc.onclose = () => {
				log('dc.close')
			}

			dc.onerror = () => {
				log('dc.error')
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
		},
		[handleIncomingJson, log]
	)

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
	}, [
		attachCommonHandlers,
		attachDataChannelHandlers,
		canWebRTC,
		crisisId,
		log,
		reset,
	])

	const joinWithOffer = useCallback(
		async (rawOfferCode, { pushOnly = false } = {}) => {
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
		},
		[
			attachCommonHandlers,
			attachDataChannelHandlers,
			canWebRTC,
			crisisId,
			log,
			reset,
		]
	)

	const hostApplyAnswer = useCallback(
		async (rawAnswerCode) => {
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
		},
		[crisisId, log]
	)

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
			createHostOffer,
			joinWithOffer,
			hostApplyAnswer,
			p2pSyncNow,
			sendPing,
		}
	}, [
		answerCode,
		canWebRTC,
		createHostOffer,
		error,
		hostApplyAnswer,
		joinWithOffer,
		logLines,
		metrics,
		offerCode,
		p2pSyncNow,
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
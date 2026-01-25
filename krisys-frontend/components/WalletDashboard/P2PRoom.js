'use client'
import { useMemo, useRef, useState, useEffect } from 'react'
import QRScanner from '../Scanner/QRScanner'
import { showTextQr } from '@/utils/qr'
import { createWebRTCRoomCode, parseWebRTCRoomCode } from '@/services/webrtcRoomCode'
import { disasterStorage } from '@/services/localStorage'
import { createChunkReceiver, createChunkSender, makeId } from '@/services/webrtcChunking'

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

export default function P2PRoom() {
	const crisisId = disasterStorage.getCrisisMetadata()?.id || null

	const pcRef = useRef(null)
	const dcRef = useRef(null)

	const senderRef = useRef(null)
	const receiverRef = useRef(null)

	const [status, setStatus] = useState('disconnected') // disconnected | connecting | connected | closed
	const [role, setRole] = useState('idle') // idle | host | join
	const [error, setError] = useState(null)

	const [offerCode, setOfferCode] = useState('')
	const [answerCode, setAnswerCode] = useState('')
	const [remoteOfferInput, setRemoteOfferInput] = useState('')
	const [remoteAnswerInput, setRemoteAnswerInput] = useState('')

	const [scannerOpen, setScannerOpen] = useState(false)
	const [scanTarget, setScanTarget] = useState(null) // 'offer' | 'answer' | null

	const [logLines, setLogLines] = useState([])

	const pendingSyncIdsRef = useRef(new Set())

	const canWebRTC = useMemo(() => {
		return typeof window !== 'undefined' && typeof RTCPeerConnection !== 'undefined'
	}, [])

	const log = (line) => {
		setLogLines((prev) => {
			const next = Array.isArray(prev) ? prev.slice(-80) : []
			next.push(`${new Date().toLocaleTimeString()} ${line}`)
			return next
		})
	}

	const emitP2PStatus = (next) => {
		try {
			if (typeof window === 'undefined') return
			window.KRISYS_P2P_STATUS = next
			window.dispatchEvent(new CustomEvent('krisys:p2p_status', { detail: next }))
		} catch {
			// ignore
		}
	}

	useEffect(() => {
		emitP2PStatus({
			active: status === 'connecting' || status === 'connected',
			status,
			role,
		})
	}, [status, role])

	useEffect(() => {
		return () => {
			// On unmount, close connections and update status
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
			emitP2PStatus({ active: false, status: 'closed', role: 'idle' })
		}
	}, [])

	const reset = () => {
		setError(null)
		setStatus('closed')
		setRole('idle')
		setOfferCode('')
		setAnswerCode('')
		setRemoteOfferInput('')
		setRemoteAnswerInput('')
		setScannerOpen(false)
		setScanTarget(null)
		setLogLines([])
		pendingSyncIdsRef.current = new Set()

		senderRef.current = null
		receiverRef.current = null

		if (dcRef.current) {
			try {
				dcRef.current.close()
			} catch {
				// ignore
			}
			dcRef.current = null
		}

		if (pcRef.current) {
			try {
				pcRef.current.close()
			} catch {
				// ignore
			}
			pcRef.current = null
		}
	}

	const attachCommonHandlers = (pc) => {
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
	}

	const sendJson = (obj) => {
		const sender = senderRef.current
		if (!sender) throw new Error('Sender not ready')
		sender.sendJson(obj)
	}

	const handleIncomingJson = async (obj) => {
		if (!obj || typeof obj !== 'object') return

		if (obj.t === 'krisys_mesh_sync_req_v1') {
			const id = obj.id
			log(`recv sync req id=${id}`)

			const payload = obj.payload
			if (!payload || typeof payload !== 'object') {
				log('recv sync req: missing payload')
				return
			}

			try {
				await disasterStorage.importSyncPayloadAsync(payload)
				log(`imported peer payload (req id=${id})`)
			} catch (e) {
				log(`import failed (req id=${id}): ${e?.message || String(e)}`)
				return
			}

			try {
				const myPayload = disasterStorage.exportSyncPayload()
				sendJson({
					t: 'krisys_mesh_sync_res_v1',
					id,
					sentAt: Date.now(),
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

			try {
				await disasterStorage.importSyncPayloadAsync(payload)
				log(`imported peer payload (res id=${id})`)
			} catch (e) {
				log(`import failed (res id=${id}): ${e?.message || String(e)}`)
			}
			return
		}

		if (obj.t === 'krisys_p2p_ping') {
			log('recv ping')
			try {
				sendJson({ t: 'krisys_p2p_pong', at: Date.now() })
			} catch {
				// ignore
			}
			return
		}

		if (obj.t === 'krisys_p2p_pong') {
			log('recv pong')
			return
		}
	}

	const attachDataChannelHandlers = (dc) => {
		// wire chunk sender/receiver
		senderRef.current = createChunkSender({ dc, log })
		receiverRef.current = createChunkReceiver({ onJson: handleIncomingJson, log })

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
	}

	const createHostOffer = async () => {
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
	}

	const joinWithOffer = async () => {
		setError(null)

		if (!canWebRTC) {
			setError('WebRTC not available in this browser/environment.')
			return
		}

		const raw = remoteOfferInput.trim()
		if (!raw) {
			setError('Paste or scan an offer code first.')
			return
		}

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
	}

	const hostApplyAnswer = async () => {
		setError(null)

		const raw = remoteAnswerInput.trim()
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
	}

	const showQr = async (text, title) => {
		if (!text || typeof text !== 'string') return
		await showTextQr({
			text,
			displayName: title,
			title,
			heading: title,
		})
	}

	const scanInto = (target) => {
		setError(null)
		setScanTarget(target)
		setScannerOpen(true)
	}

	const onScanned = (text) => {
		setScannerOpen(false)

		if (scanTarget === 'offer') {
			setRemoteOfferInput(text)
			log('Scanned offer into Join field.')
		} else if (scanTarget === 'answer') {
			setRemoteAnswerInput(text)
			log('Scanned answer into Host field.')
		} else {
			log('Scanned text (no target set).')
		}
		setScanTarget(null)
	}

	const p2pSyncNow = async () => {
		setError(null)

		try {
			const id = makeId()
			pendingSyncIdsRef.current.add(id)

			const payload = disasterStorage.exportSyncPayload()
			sendJson({
				t: 'krisys_mesh_sync_req_v1',
				id,
				sentAt: Date.now(),
				payload,
			})

			log(`sent sync req id=${id}`)
		} catch (e) {
			setError(e?.message || String(e))
		}
	}

	return (
		<div className="card">
			<div className="card-header">
				<h3 className="card-title">P2P Room (WebRTC)</h3>
			</div>

			<div className="card-body">
				<div className="privacy-notice" style={{ marginBottom: '8px' }}>
					Status: {status} | role: {role} | crisisId: {crisisId || 'unknown'}
				</div>

				{error && <div className="error">{error}</div>}

				{scannerOpen && (
					<QRScanner
						title="Scan WebRTC Room Code"
						onScan={onScanned}
						onClose={() => {
							setScannerOpen(false)
							setScanTarget(null)
						}}
					/>
				)}

				<div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
					<button
						type="button"
						className="btn"
						onClick={p2pSyncNow}
						disabled={status !== 'connected'}
					>
						P2P Sync Now
					</button>

					<button
						type="button"
						className="btn"
						onClick={() => {
							try {
								sendJson({ t: 'krisys_p2p_ping', at: Date.now() })
								log('sent ping')
							} catch (e) {
								setError(e?.message || String(e))
							}
						}}
						disabled={status !== 'connected'}
					>
						Send Ping
					</button>

					<button type="button" className="btn" onClick={reset}>
						Reset P2P
					</button>
				</div>

				<hr style={{ margin: '14px 0', opacity: 0.2 }} />

				<div style={{ display: 'grid', gap: '14px' }}>
					<div>
						<div style={{ fontWeight: 700, marginBottom: '6px' }}>
							Host (create room)
						</div>

						<div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
							<button
								type="button"
								className="btn"
								onClick={createHostOffer}
								disabled={!canWebRTC}
							>
								Create Offer
							</button>

							<button
								type="button"
								className="btn"
								onClick={() => showQr(offerCode, 'WebRTC Offer')}
								disabled={!offerCode}
							>
								Show Offer QR
							</button>
						</div>

						<textarea
							className="form-input"
							rows="4"
							value={offerCode}
							readOnly
							placeholder="Offer code will appear here"
							style={{ marginTop: '8px' }}
						/>

						<div style={{ marginTop: '10px', fontWeight: 700 }}>
							Host: Paste/Scan Answer
						</div>

						<div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
							<button
								type="button"
								className="btn"
								onClick={() => scanInto('answer')}
								disabled={!canWebRTC}
							>
								Scan Answer
							</button>

							<button
								type="button"
								className="btn"
								onClick={hostApplyAnswer}
								disabled={!remoteAnswerInput.trim()}
							>
								Apply Answer
							</button>
						</div>

						<textarea
							className="form-input"
							rows="3"
							value={remoteAnswerInput}
							onChange={(e) => setRemoteAnswerInput(e.target.value)}
							placeholder="Paste answer here"
							style={{ marginTop: '8px' }}
						/>
					</div>

					<div>
						<div style={{ fontWeight: 700, marginBottom: '6px' }}>
							Join (connect to room)
						</div>

						<div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
							<button
								type="button"
								className="btn"
								onClick={() => scanInto('offer')}
								disabled={!canWebRTC}
							>
								Scan Offer
							</button>

							<button
								type="button"
								className="btn"
								onClick={joinWithOffer}
								disabled={!remoteOfferInput.trim()}
							>
								Create Answer
							</button>

							<button
								type="button"
								className="btn"
								onClick={() => showQr(answerCode, 'WebRTC Answer')}
								disabled={!answerCode}
							>
								Show Answer QR
							</button>
						</div>

						<textarea
							className="form-input"
							rows="3"
							value={remoteOfferInput}
							onChange={(e) => setRemoteOfferInput(e.target.value)}
							placeholder="Paste offer here"
							style={{ marginTop: '8px' }}
						/>

						<textarea
							className="form-input"
							rows="4"
							value={answerCode}
							readOnly
							placeholder="Answer code will appear here"
							style={{ marginTop: '8px' }}
						/>
					</div>

					<div>
						<div style={{ fontWeight: 700, marginBottom: '6px' }}>Log</div>
						<textarea
							className="form-input"
							rows="8"
							value={logLines.join('\n')}
							readOnly
						/>
					</div>

					<div className="privacy-notice">
						Console logs show message metadata (type/id/chunks/bytes), not full
						payload contents.
					</div>
				</div>
			</div>
		</div>
	)
}
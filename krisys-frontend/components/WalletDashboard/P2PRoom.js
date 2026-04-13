// krisys-frontend/components/WalletDashboard/P2PRoom.js
'use client'

import { useState } from 'react'
import QRScanner from '../Scanner/QRScanner'
import { showTextQr } from '@/utils/qr'
import { disasterStorage } from '@/services/localStorage'
import { useP2P } from '@/contexts/P2PContext'

export default function P2PRoom() {
	const crisisId = disasterStorage.getCrisisMetadata()?.id || null

	const {
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

		setRemoteOfferInput,
		setRemoteAnswerInput,
		setPushOnlyOnJoin,

		createHostOffer,
		joinWithOffer,
		hostApplyAnswer,
	} = useP2P()

	const [scannerOpen, setScannerOpen] = useState(false)
	const [scanTarget, setScanTarget] = useState(null) // offer | answer | null

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
		setScanTarget(target)
		setScannerOpen(true)
	}

	const onScanned = (text) => {
		setScannerOpen(false)

		if (scanTarget === 'offer') {
			setRemoteOfferInput(text)
		} else if (scanTarget === 'answer') {
			setRemoteAnswerInput(text)
		}

		setScanTarget(null)
	}

	const onJoinCreateAnswer = async () => {
		const raw = (remoteOfferInput || '').trim()
		if (!raw) return

		const mode =
			window.confirm(
				'Join room in push-only mode?\n\n' +
					'OK = Push only (no download)\n' +
					'Cancel = Full sync (push + pull)'
			) === true

		setPushOnlyOnJoin(mode)
		await joinWithOffer(raw, { pushOnly: mode })
	}

	const onHostApplyAnswer = async () => {
		const raw = (remoteAnswerInput || '').trim()
		if (!raw) return
		await hostApplyAnswer(raw)
	}

	const sendBytes = metrics?.send?.bytesSent ?? 0
	const recvBytes = metrics?.recv?.bytesReceived ?? 0
	const sendQueueDepth = metrics?.send?.queueDepth ?? 0
	const inflight = metrics?.recv?.inflight ?? 0

	return (
		<div className="card">
			<div className="card-header">
				<h3 className="card-title">P2P Room (WebRTC)</h3>
			</div>

			<div className="card-body">
				<div className="privacy-notice" style={{ marginBottom: '8px' }}>
					Status: {status} | role: {role} | crisisId: {crisisId || 'unknown'}
					{metrics ? (
						<>
							<br />
							Sent bytes: {sendBytes} | Recv bytes: {recvBytes} | Send
							queue: {sendQueueDepth} | Inflight: {inflight}
							<br />
							Join mode: {pushOnlyOnJoin ? 'push-only' : 'full-sync'}
						</>
					) : null}
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

				<hr style={{ margin: '14px 0', opacity: 0.2 }} />

				<div style={{ display: 'grid', gap: '14px' }}>
					<div>
						<div>
							<div style={{ fontWeight: 700, marginBottom: '6px' }}>Log</div>
							<textarea
								className="form-input"
								rows="8"
								value={logLines.join('\n')}
								readOnly
							/>
						</div>
						
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
								onClick={onHostApplyAnswer}
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
								onClick={onJoinCreateAnswer}
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

					<div className="privacy-notice">
						Logs show message metadata (type/id/chunks/bytes), not full payload
						contents.
					</div>
				</div>
			</div>
		</div>
	)
}
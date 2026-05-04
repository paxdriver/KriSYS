// krisys-frontend/components/WalletDashboard/UserHostedRoom.js
'use client'

import { useState } from 'react'
import { useP2P } from '@/contexts/P2PContext'
import { parseWebRTCRoomCode } from '@/services/webrtcRoomCode'
import { showTextQr } from '@/utils/qr'

export default function UserHostedRoom({ crisisId }) {

	// Pull required transport-layer functions from P2P context
	const {
	createHostOffer,	// generates a new host offer (creates new connection)
	joinWithOffer,		// join another host using offer
	hostApplyAnswer,	// apply answer to a specific connection
	offerCode,			// DEV NOTE: legacy single-offer value, deprecated now, phasing out
	answerCode,			// answer generated when joining
		setRemoteOfferInput,
		remoteOfferInput,
		status,
		logLines,
	} = useP2P()

	// Track whether we are hosting or joining
	const [mode, setMode] = useState(null) // 'host' | 'join' | null

	// Offer pool state: array of { connId, offerCode }
	const [hostOffers, setHostOffers] = useState([])

	// Track per-offer answer input temporarily
	const [answers, setAnswers] = useState({}) // { connId: answerText }

	
	// USER HOSTS ROOM
	async function handleGenerateOffer() {
		// Call transport-layer function to create new host offer
		const result = await createHostOffer()
		// createHostOffer RET { connId, offerCode }

		if (!result) return
		const { connId, offerCode } = result
		console.log(result)
		setHostOffers(prev => [
			...prev,
			{ connId, offerCode }
		])
	}

	async function handleApplyAnswer(connId) {
		const raw = answers[connId]
		if (!raw) return

		// Parse answer to ensure valid format
		const parsed = parseWebRTCRoomCode(raw)

		console.log(parsed)

		if (parsed.kind !== 'answer') {
			alert('Invalid answer code')
			return
		}

		// Apply answer to correct connection
		await hostApplyAnswer(connId, raw)

		// Remove consumed offer from pool
		setHostOffers(prev => prev.filter(o => o.connId !== connId))

		// Clear answer input
		setAnswers(prev => {
			const copy = { ...prev }
			delete copy[connId]
			return copy
		})
	}

	async function handleShowQr(offerCode) {
		await showTextQr({
			text: offerCode,
			displayName: 'User Hosted Room',
			title: 'User Hosted Room',
			heading: 'Scan to Join Room',
		})
	}

	// JOIN MODE
	async function handleJoinRoom() {
		const raw = (remoteOfferInput || '').trim()
		if (!raw) return

		const pushOnly =
			window.confirm(
				'Join room in push-only mode?\n\n' +
				'OK = Push only (no download)\n' +
				'Cancel = Full sync (push + pull)'
			) === true

		setMode('join')

		await joinWithOffer(raw, { pushOnly })
	}

	return (
		<div className="page">
			<h2>User Hosted Room</h2>

			{/* MODE SELECTOR */}
			{!mode && (
				<>
					<button
						className="btn"
						onClick={() => setMode('host')}
					>
						Host Room
					</button>

					<hr />

					<textarea
						className="form-input"
						rows="4"
						placeholder="Paste host offer here..."
						value={remoteOfferInput}
						onChange={e => setRemoteOfferInput(e.target.value)}
					/>

					<button
						className="btn"
						onClick={handleJoinRoom}
					>
						Join Room
					</button>
				</>
			)}

			{/* HOST MODE */}
			{mode === 'host' && (
				<>
					<h3>Hosting Room</h3>

					<button
						className="btn"
						onClick={handleGenerateOffer}
					>
						Generate New Offer
					</button>

					<div style={{ marginTop: '1rem' }} />

					{hostOffers.map(offer => (
						<div
							key={offer.connId}
							style={{
								border: '1px solid #ccc',
								padding: '1rem',
								marginBottom: '1rem'
							}}
						>
							<strong>Connection ID:</strong> {offer.connId}

							<textarea
								className="form-input"
								rows="5"
								value={offer.offerCode}
								readOnly
							/>

							<button
								className="btn"
								onClick={() => handleShowQr(offer.offerCode)}
							>
								Show QR
							</button>

							<textarea
								className="form-input"
								rows="4"
								placeholder="Paste answer here..."
								value={answers[offer.connId] || ''}
								onChange={e =>
									setAnswers(prev => ({
										...prev,
										[offer.connId]: e.target.value
									}))
								}
							/>

							<button
								className="btn"
								onClick={() => handleApplyAnswer(offer.connId)}
							>
								Apply Answer
							</button>
						</div>
					))}

					{hostOffers.length === 0 && (
						<p>No pending offers yet.</p>
					)}
				</>
			)}

			{/* JOIN MODE */}
			{mode === 'join' && (
				<>
					<h3>Joined Room</h3>

					<p>Send this answer back to the host:</p>

					<textarea
						className="form-input"
						rows="6"
						value={answerCode}
						readOnly
					/>
				</>
			)}

			<hr />

			<div>
				<strong>Status:</strong> {status}
			</div>

			<div style={{ marginTop: '1rem' }}>
				<strong>Logs:</strong>
				<pre style={{
					maxHeight: '200px',
					overflow: 'auto',
					background: '#111',
					color: '#0f0',
					padding: '0.5rem'
				}}>
					{logLines.join('\n')}
				</pre>
			</div>
		</div>
	)
}
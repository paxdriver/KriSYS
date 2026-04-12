// krisys-frontend/components/WalletDashboard/UserHostedRoom.js
'use client'

import { useState } from 'react'
import { useP2P } from '@/contexts/P2PContext'
import { createWebRTCRoomCode, parseWebRTCRoomCode } from '@/services/webrtcRoomCode'
import { showTextQr } from '@/utils/qr'

export default function UserHostedRoom({ crisisId }) {
	const {
		status,
		reset,
		createHostOffer,
		joinWithOffer,
		hostApplyAnswer,
		offerCode,
		answerCode,
		setRemoteAnswerInput,
		remoteAnswerInput,
		setRemoteOfferInput,
		remoteOfferInput,
	} = useP2P()

	const [mode, setMode] = useState(null) // 'host' | 'join'

	async function handleStartHosting() {
		reset()
		setMode('host')
		await createHostOffer()
	}

	async function handleJoin() {
		reset()
		setMode('join')
		await joinWithOffer(remoteOfferInput)
	}

	async function handleShowQr() {
		if (!offerCode) return

		await showTextQr({
			text: offerCode,
			displayName: 'User Hosted Room',
			title: 'User Hosted Room',
			heading: 'Scan to Join Room',
		})
	}

	return (
		<div className="page">
			<h2>User Hosted Room</h2>

			{!mode && (
				<div>
					<button className="btn" onClick={handleStartHosting}>
						Start Hosting Room
					</button>

					<hr />

					<textarea
						className="form-input"
						rows="4"
						placeholder="Paste host offer here..."
						value={remoteOfferInput}
						onChange={(e) => setRemoteOfferInput(e.target.value)}
					/>

					<button className="btn" onClick={handleJoin}>
						Join Room
					</button>
				</div>
			)}

			{mode === 'host' && (
				<div>
					<h3>Hosting Room</h3>

					<textarea
						className="form-input"
						rows="6"
						value={offerCode}
						readOnly
					/>

					<button className="btn" onClick={handleShowQr}>
						Show QR
					</button>

					<hr />

					<textarea
						className="form-input"
						rows="4"
						placeholder="Paste peer answer here..."
						value={remoteAnswerInput}
						onChange={(e) => setRemoteAnswerInput(e.target.value)}
					/>

					<button
						className="btn"
						onClick={() => hostApplyAnswer(remoteAnswerInput)}
					>
						Apply Answer
					</button>
				</div>
			)}

			{mode === 'join' && (
				<div>
					<h3>Joined Room</h3>
					<textarea
						className="form-input"
						rows="6"
						value={answerCode}
						readOnly
					/>
					<p>Send this answer back to host.</p>
				</div>
			)}

			<div style={{ marginTop: '1rem' }}>
				<strong>Status:</strong> {status}
			</div>
		</div>
	)
}
// krisys-backend/device-offline-server/station-frontend/components/StationPool.js
'use client'

import { useState } from 'react'
import { useStation } from '../contexts/StationContext'

export default function StationPool() {
	const { offerCode, activePeers, applyAnswer } = useStation()
	const [answerInput, setAnswerInput] = useState('')

	return (
		<div style={{ marginTop: 40 }}>
			<h2>Active Offer</h2>

			<textarea
				value={offerCode}
				readOnly
				style={{ width: '100%', height: 200 }}
			/>

			<h3>Paste Wallet Answer</h3>

			<textarea
				value={answerInput}
				onChange={(e) => setAnswerInput(e.target.value)}
				style={{ width: '100%', height: 200 }}
			/>

			<button onClick={() => applyAnswer(answerInput)}>
				Apply Answer
			</button>

			<h3 style={{ marginTop: 30 }}>Active Connections (Dev Only)</h3>

			<ul>
				{activePeers.map(id => (
					<li key={id}>{id}</li>
				))}
			</ul>
		</div>
	)
}
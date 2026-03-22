// krisys-backend/device-offline-server/station-frontend/contexts/StationContext.js
'use client'

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { createWebRTCRoomCode, parseWebRTCRoomCode } from '../services/webrtcRoomCode'

const StationContext = createContext(null)

/* 
StationContext should store:
 - Station profile (station_id, fingerprint, etc.)
 - Active pool listings (from Flask /station/pools)
 - Active offer inventory metadata (NOT the full SDP)
 - Connection status summary (from Node /health)
 - Maybe peer count

 DEV NOTE: It is UI coordination state, not transport state 
 */

export function StationProvider({ profile, children }) {
	const currentPeerIdRef = useRef(null)

	const [offerCode, setOfferCode] = useState('')
	const [activePeers, setActivePeers] = useState([]) // dev only

	useEffect(() => {
		if (!profile) return
		// createOffer()
	}, [profile])

	async function createOffer() {
		const res = await fetch('http://localhost:7000/offer', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' }
		})
		const data = await res.json()

		const { peerId, offer } = data

		currentPeerIdRef.current = peerId

		const code = createWebRTCRoomCode({
			kind: 'offer',
			crisisId: profile.crisis_id,
			sdp: offer
		})

		setOfferCode(code)
	}

	async function applyAnswer(answerCode) {
		const peerId = currentPeerIdRef.current
		if (!peerId) throw new Error('No active offer')

		const parsed = parseWebRTCRoomCode(answerCode)

		if (parsed.kind !== 'answer') {
			throw new Error('Expected answer code')
		}

		await fetch('http://localhost:7000/answer', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				peerId,
				answer: parsed.sdp
			})
		})

		// For dev visibility only
		setActivePeers(prev => [...prev, peerId])

		// Immediately generate next offer
		await createOffer()
	}

	return (
		<StationContext.Provider value={{
			offerCode,
			activePeers,
			applyAnswer
		}}>
			{children}
		</StationContext.Provider>
	)
}

export function useStation() {
	const ctx = useContext(StationContext)
	if (!ctx) throw new Error('useStation must be used inside StationProvider')
	return ctx
}
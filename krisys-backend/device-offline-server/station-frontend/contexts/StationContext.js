// krisys-backend/device-offline-server/station-frontend/contexts/StationContext.js
'use client'

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { StationRTCHost } from '../services/stationRtcHost'
import { createWebRTCRoomCode } from '../services/webrtcRoomCode'

const StationContext = createContext(null)

export function StationProvider({ profile, children }) {
	const hostRef = useRef(null)

	const [offerCode, setOfferCode] = useState('')
	const [poolId, setPoolId] = useState(null)
	const [peers, setPeers] = useState([]) // dev visibility only

	// Initialize host once profile is available
	useEffect(() => {
		if (!profile) return

		const host = new StationRTCHost({
			crisisId: profile.crisis_id,
		})

		// Track connections for dev visibility
		host.onPeerConnected = (peerId) => {
			setPeers(prev => [...prev, peerId])
		}

		host.onPeerDisconnected = (peerId) => {
			setPeers(prev => prev.filter(id => id !== peerId))
		}

		hostRef.current = host

		createOffer()

	}, [profile])

	// Create a new offer and publish pool
	async function createOffer() {
		const host = hostRef.current
		if (!host) return

		const pc = new RTCPeerConnection({ iceServers: [] })
		const dc = pc.createDataChannel('krisys', { ordered: true })

		const peerId = crypto.randomUUID()

		host.peers.set(peerId, {
			pc,
			dc: null,
			sender: null,
			receiver: null,
			handshakeVerified: false,
			role: 'wallet',
		})

		host._attachDataChannel(peerId, pc, dc)

		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)

		await waitForIce(pc)

		const local = pc.localDescription

		const code = createWebRTCRoomCode({
			kind: 'offer',
			crisisId: profile.crisis_id,
			sdp: {
				type: local.type,
				sdp: local.sdp,
			},
		})

		setOfferCode(code)

		const id = crypto.randomUUID()
		setPoolId(id)

		await fetch(`${process.env.NEXT_PUBLIC_STATION_API}/station/pools`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				pool_id: id,
				host_device_id: 'station',
				label: 'Station Pool',
				ttl_seconds: 300,
			}),
		})
	}

	// Apply wallet answer and immediately generate next offer
	async function applyAnswer(answerCode) {
		const host = hostRef.current
		if (!host) return

		const openPeer = [...host.peers.entries()]
			.reverse()
			.find(([id, p]) => p.pc && !p.pc.remoteDescription)

		if (!openPeer) throw new Error('No pending offer found')

		const [peerId] = openPeer

		await host.applyAnswerFromPeer(peerId, answerCode)

		// Immediately create next offer
		await createOffer()
	}

	function waitForIce(pc) {
		return new Promise((resolve) => {
			if (pc.iceGatheringState === 'complete') return resolve()
			pc.addEventListener('icegatheringstatechange', () => {
				if (pc.iceGatheringState === 'complete') resolve()
			})
		})
	}

	return (
		<StationContext.Provider value={{
			offerCode,
			poolId,
			peers,
			applyAnswer,
			createOffer,
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
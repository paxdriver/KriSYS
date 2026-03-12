// krisys-backend/device-offline-server/station-frontend/app/page.js
'use client'

import { useEffect, useState, useRef } from 'react'
import { StationRTCHost } from '../services/stationRtcHost'
import { createWebRTCRoomCode } from '../services/webrtcRoomCode'

export default function StationPage() {
    const [profile, setProfile] = useState(null)
    const [offerCode, setOfferCode] = useState('')
    const [poolId, setPoolId] = useState(null)

    const hostRef = useRef(null)

    // Fetch station identity profile
    useEffect(() => {
        async function loadProfile() {
            const res = await fetch('/station/profile')
            const data = await res.json()
            setProfile(data)
        }

        loadProfile()
    }, [])

    // Initialize WebRTC host once profile is loaded
    useEffect(() => {
        if (!profile) return

        const host = new StationRTCHost({
            crisisId: profile.crisis_id,
        })

        hostRef.current = host

        createPersistentOffer(host)

    }, [profile])

    async function createPersistentOffer(host) {
        const pc = new RTCPeerConnection({ iceServers: [] })

        const dc = pc.createDataChannel('krisys', { ordered: true })

        host._attachDataChannel('persistent-host', pc, dc)

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

        registerPool(id)
        startPoolKeepAlive(id)
    }

    function waitForIce(pc) {
        return new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') return resolve()
            pc.addEventListener('icegatheringstatechange', () => {
                if (pc.iceGatheringState === 'complete') resolve()
            })
        })
    }

    async function registerPool(id) {
        await fetch('/station/pools', {
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

    function startPoolKeepAlive(id) {
        setInterval(() => {
            registerPool(id)
        }, 240000) // refresh every 4 minutes
    }

    if (!profile) return <div>Loading station...</div>

    return (
        <div style={{ padding: 40 }}>
            <h1>Station Host</h1>

            <h3>Station ID</h3>
            <p>{profile.station_id}</p>

            <h3>Fingerprint</h3>
            <p>{profile.fingerprint}</p>

            <h3>WebRTC Offer Code</h3>
            <textarea
                value={offerCode}
                readOnly
                style={{ width: '100%', height: 200 }}
            />
        </div>
    )
}
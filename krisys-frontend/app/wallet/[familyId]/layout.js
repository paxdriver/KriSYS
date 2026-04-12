// krisys-frontend/app/wallet/[familyId]/layout.js
// This is used to wrap the connections context provider around the wallet so established connections stay active while navigating the app from within a wallet, but are lost when changing wallets or closing the browser to ensure resources aren't running in the background wasting power unknowingly.
'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { P2PProvider } from '@/contexts/P2PContext'
import { UserHostedRoomProvider } from '@/components/WalletDashboard/UserHostedRoom'
import { api } from '@/services/api'
import { disasterStorage } from '@/services/localStorage'

export default function WalletLayout({ children }) {
	const params = useParams()

	const raw = params?.familyId
	const familyId = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : null

	const [crisisId, setCrisisId] = useState(null)
	const [ready, setReady] = useState(false)

	useEffect(() => {
		if (crisisId) return // should i wait and retry instead???

		let cancelled = false

		async function bootstrapCrisis() {

			const cached = disasterStorage.getCrisisMetadata()?.id || null
			// 1) try local cache first
			if (cached) {
				if (!cancelled) {
					setCrisisId(cached)
					setReady(true)
				}
				return
			}
			// 2) fetch from backend
			try {
				const res = await api.getCrisisInfo()
				const crisis = res?.data
				if (!crisis?.id) return

				disasterStorage.saveCrisisMetadata(crisis)

				if (!cancelled) {
					setCrisisId(crisis.id)
					setReady(true)
				}
			} catch {
				// ignore: offline / server down; P2P will remain disabled until pinned
			}
		}

		bootstrapCrisis()

		return () => {
			cancelled = true
		}
	}, [crisisId])

	// Do NOT render provider until crisisId is known
	if (!ready || !crisisId || !familyId) {
		return <div>Loading crisis…</div>
	}

	return (
		<P2PProvider crisisId={crisisId} familyId={familyId}>
			{children}
		</P2PProvider>
	)
}

// krisys-backend/device-offline-server/station-frontend/app/page.js
'use client'

import { useEffect, useState } from 'react'
import StationIdentity from '../components/StationIdentity'
import StationPool from '../components/StationPool'
import { StationProvider } from '../contexts/StationContext'

export default function StationPage() {
	const [profile, setProfile] = useState(null)

	useEffect(() => {
		async function loadProfile() {
			const res = await fetch(
				`${process.env.NEXT_PUBLIC_STATION_API}/station/profile`
			)
			const data = await res.json()
			setProfile(data)
		}

		loadProfile()
	}, [])

	if (!profile) return <div>Loading station...</div>

	return (
		<StationProvider profile={profile}>
			<div style={{ padding: 40 }}>
				<h1>Station Host</h1>
				<StationIdentity profile={profile} />
				<StationPool />
			</div>
		</StationProvider>
	)
}
// krisys-backend/device-offline-server/station-frontend/components/StationIdentity.js
'use client'

export default function StationIdentity({ profile }) {
	if (!profile) return null

	return (
		<div>
			<h2>Station Identity</h2>
			<div><strong>Station ID:</strong> {profile.station_id}</div>
			<div><strong>Fingerprint:</strong> {profile.fingerprint}</div>
		</div>
	)
}
// krisys-frontend/services/stationQr.js
// Station QR Parser - Format: krisys:station:v1:<base64url(JSON)>
function base64UrlToJson(base64url) {
	const padding = '='.repeat((4 - (base64url.length % 4)) % 4)
	const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + padding
	const binary = atob(base64)
	const bytes = new Uint8Array(binary.length)

	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

	const decoder = new TextDecoder()
	return JSON.parse(decoder.decode(bytes))
}

export function parseStationQr(text) {
	if (typeof text !== 'string') throw new Error('Invalid QR text')
	if (!text.startsWith('krisys:station:v1:')) throw new Error('Not a station QR code')
	const base64url = text.replace('krisys:station:v1:', '')
	const payload = base64UrlToJson(base64url)
	if (payload.type !== 'station') throw new Error('Invalid station QR payload')
	if (!payload.station_id || !payload.station_public_key || !payload.fingerprint) throw new Error('Malformed station QR ')
	return payload
}

// RET: {	station_id,
// 		crisis_id,
// 		base_url,
// 		station_public_key,
// 		fingerprint
// 	}
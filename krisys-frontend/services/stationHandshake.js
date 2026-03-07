// krisys-frontend/services/stationHandshake.js

/*
  Station Signed Handshake Verification

  This file performs:

	1. Generate client nonce
	2. Call /station/handshake
	3. Verify fingerprint matches stored station identity
	4. Verify Ed25519 signature
	5. Return trusted / rejected

  This is transport-agnostic and can later work with:
	- HTTP
	- WebRTC data channel
	- Bluetooth
*/

function normalizeBaseUrl(baseUrl) {
	if (typeof baseUrl !== 'string') return null
	const trimmed = baseUrl.trim()
	if (!trimmed) return null
	return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function randomNonceBase64() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return btoa(String.fromCharCode(...bytes))
}

async function hexSha256FromPem(pem) {
	const enc = new TextEncoder()
	const data = enc.encode(pem)
	const result = crypto.subtle.digest('SHA-256', data).then((buf) => {
		const bytes = new Uint8Array(buf)
		return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
	})
	return result
}

function pemToArrayBuffer(pem) {
	const b64 = pem
		.replace('-----BEGIN PUBLIC KEY-----', '')
		.replace('-----END PUBLIC KEY-----', '')
		.replace(/\s+/g, '')
	const binary = atob(b64)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes.buffer
}

async function importEd25519PublicKey(pem) {
	const keyData = pemToArrayBuffer(pem)

	return crypto.subtle.importKey(
		'spki',
		keyData,
		{ name: 'Ed25519', },
		false,
		['verify']
	)
}

async function verifySignature({
	publicKeyPem,
	messageString,
	signatureBase64,
}) {
	const key = await importEd25519PublicKey(publicKeyPem)

	const enc = new TextEncoder()
	const messageBytes = enc.encode(messageString)

	const signatureBytes = Uint8Array.from(
		atob(signatureBase64),
		(c) => c.charCodeAt(0)
	)

	return crypto.subtle.verify( { name: 'Ed25519', },
		key,
		signatureBytes,
		messageBytes
	)
}

// Main handshake function
// storedStation must contain:	{ station_id, crisis_id, station_public_key, fingerprint }
export async function performStationHandshake({
	baseUrl,
	storedStation,
}) {
	const base = normalizeBaseUrl(baseUrl)
	if (!base) throw new Error('Invalid baseUrl')

	if (!storedStation?.station_public_key) throw new Error('Missing stored station identity')

	const clientNonce = randomNonceBase64()

	const res = await fetch(`${base}/station/handshake`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_nonce: clientNonce }),
	})

	if (!res.ok) throw new Error(`Handshake HTTP ${res.status}`)
	const data = await res.json()

	// 1) Check station_id
	if (data.station_id !== storedStation.station_id) throw new Error('Station ID mismatch')
	// 2) Check crisis_id
	if (data.crisis_id !== storedStation.crisis_id) throw new Error('Crisis ID mismatch')
	// 3) Check fingerprint
	const computedFingerprint = await hexSha256FromPem(data.station_public_key)
	if (computedFingerprint !== storedStation.fingerprint) throw new Error('Station fingerprint mismatch')
	// 4) Check nonce round-trip
	if (data.client_nonce !== clientNonce) throw new Error('Client nonce mismatch')
	// 5) Verify signature
	const messageString = `${data.station_id}|${data.crisis_id}|${data.client_nonce}|${data.station_nonce}`

	const valid = await verifySignature({
		publicKeyPem: storedStation.station_public_key,
		messageString,
		signatureBase64: data.signature,
	})

	if (!valid) throw new Error('Invalid station signature')

	return {
		trusted: true,
		fingerprint: data.fingerprint,
	}
}
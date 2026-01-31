// /krissys-frontend/services/webrtcRoomCode.js

function base64UrlEncode(bytes) {
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i])
	}
	const b64 = btoa(binary)
	return b64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlDecodeToBytes(b64url) {
	const b64 = b64url.replaceAll('-', '+').replaceAll('_', '/')
	const padLen = (4 - (b64.length % 4)) % 4
	const padded = b64 + '='.repeat(padLen)
	const raw = atob(padded)

	const out = new Uint8Array(raw.length)
	for (let i = 0; i < raw.length; i++) {
		out[i] = raw.charCodeAt(i)
	}
	return out
}

function encodeJson(obj) {
	const json = JSON.stringify(obj)
	const bytes = new TextEncoder().encode(json)
	return base64UrlEncode(bytes)
}

function decodeJson(encoded) {
	const bytes = base64UrlDecodeToBytes(encoded)
	const json = new TextDecoder().decode(bytes)
	return JSON.parse(json)
}

/* Room code schema (v1):
    krisys:webrtc:v1:<base64url(JSON)>
    JSON payload:
    {
    v: 1,
    kind: "offer" | "answer",
    createdAt: ms,
    crisisId: string | null,
    sdp: { type: "offer"|"answer", sdp: string }
    }
    Notes:
    - This is only signaling. It does not convey trust.
    - We include crisisId for a helpful mismatch warning.
*/
export function createWebRTCRoomCode({ kind, crisisId, sdp }) {
	if (kind !== 'offer' && kind !== 'answer') {
		throw new Error('createWebRTCRoomCode: invalid kind')
	}

	if (!sdp || typeof sdp.type !== 'string' || typeof sdp.sdp !== 'string') {
		throw new Error('createWebRTCRoomCode: invalid sdp')
	}

	const payload = {
		v: 1,
		kind,
		createdAt: Date.now(),
		crisisId: typeof crisisId === 'string' ? crisisId : null,
		sdp: { type: sdp.type, sdp: sdp.sdp },
	}

	return `krisys:webrtc:v1:${encodeJson(payload)}`
}

export function parseWebRTCRoomCode(code) {
	if (typeof code !== 'string' || !code.trim()) {
		throw new Error('parseWebRTCRoomCode: missing code')
	}

	const trimmed = code.trim()
	const prefix = 'krisys:webrtc:v1:'
	if (!trimmed.startsWith(prefix)) {
		throw new Error('Invalid WebRTC code prefix')
	}

	const encoded = trimmed.slice(prefix.length)
	const payload = decodeJson(encoded)

	if (!payload || payload.v !== 1) {
		throw new Error('Unsupported WebRTC code version')
	}

	if (payload.kind !== 'offer' && payload.kind !== 'answer') {
		throw new Error('Invalid WebRTC code kind')
	}

	if ( !payload.sdp || typeof payload.sdp.type !== 'string' || typeof payload.sdp.sdp !== 'string' ) {
		throw new Error('Invalid WebRTC code SDP')
	}

	return {
		kind: payload.kind,
		createdAt: payload.createdAt || null,
		crisisId: typeof payload.crisisId === 'string' ? payload.crisisId : null,
		sdp: { type: payload.sdp.type, sdp: payload.sdp.sdp },
	}
}
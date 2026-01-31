// krisys-frontend/services/poolJoinCode.js
function base64UrlEncode(bytes) {
	const str = Array.from(bytes).map((b) => String.fromCharCode(b)).join('')
	const b64 = btoa(str)
	return b64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function base64UrlDecodeToBytes(b64url) {
	const b64 = b64url.replaceAll('-', '+').replaceAll('_', '/')
	const padLen = (4 - (b64.length % 4)) % 4
	const padded = b64 + '='.repeat(padLen)
	const raw = atob(padded)
	return new Uint8Array([...raw].map((c) => c.charCodeAt(0)))
}

async function sha256HexUtf8(text) {
	const enc = new TextEncoder()
	const bytes = enc.encode(text)

	const subtle = globalThis.crypto?.subtle
	if (!subtle) {
		// In-browser this should exist; if not, we fail loudly.
		throw new Error('WebCrypto subtle is not available')
	}

	const digest = await subtle.digest('SHA-256', bytes)
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

// Join code schema v1 (string): "krisys:join:v1:<base64url(JSON)>"
// This is *NOT* a trust mechanism, it is a convenience wrapper so people can join the right room quickly.

export async function createJoinCode({
	url,
	label,
	crisisId,
	blockPublicKeyArmored,
}) {
	if (typeof url !== 'string' || !url.trim()) throw new Error('createJoinCode: url is required')

	const safeLabel = typeof label === 'string' ? label.trim() : ''

	// Sanity-check fingerprint only; verification still relies on pinned key.
	const blockKeySha256 = typeof blockPublicKeyArmored === 'string' && 
    blockPublicKeyArmored ? await sha256HexUtf8(blockPublicKeyArmored) : null

	const payload = {
		v: 1,
		type: 'krisys_mesh_join',
		url: url.trim(),
		label: safeLabel || null,
		crisisId: typeof crisisId === 'string' && crisisId ? crisisId : null,
		blockKeySha256,
		createdAt: Date.now(),
	}

	const jsonBytes = new TextEncoder().encode(JSON.stringify(payload))
	const encoded = base64UrlEncode(jsonBytes)
	return `krisys:join:v1:${encoded}`
}

export function parseJoinCode(code) {
	if (typeof code !== 'string' || !code.trim()) throw new Error('parseJoinCode: missing code')
	const trimmed = code.trim()

	// Allow raw JSON paste for debugging
	if (trimmed.startsWith('{')) {
		const obj = JSON.parse(trimmed)
		return normalizeParsed(obj)
	}

	const prefix = 'krisys:join:v1:'
	if (!trimmed.startsWith(prefix)) throw new Error('Invalid join code prefix')

	const b64url = trimmed.slice(prefix.length)
	const bytes = base64UrlDecodeToBytes(b64url)
	const json = new TextDecoder().decode(bytes)
	const obj = JSON.parse(json)
	return normalizeParsed(obj)
}

function normalizeParsed(obj) {
	if (!obj || typeof obj !== 'object') throw new Error('Invalid join code payload')
	if (obj.v !== 1 || obj.type !== 'krisys_mesh_join') throw new Error('Unsupported join code version/type')
	if (typeof obj.url !== 'string' || !obj.url.trim()) throw new Error('Join code missing url')

	return {
		url: obj.url.trim(),
		label: typeof obj.label === 'string' ? obj.label.trim() : '',
		crisisId: typeof obj.crisisId === 'string' ? obj.crisisId : null,
		blockKeySha256: typeof obj.blockKeySha256 === 'string' ? 
            obj.blockKeySha256 : null,
		createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : null,
	}
}
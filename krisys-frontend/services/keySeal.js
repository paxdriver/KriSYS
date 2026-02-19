// services/keySeal.js
//
/* Purpose:
	- Persist a wallet private key locally WITHOUT storing it in plaintext
	- Allow offline unlock after refresh when HQ is unreachable
    
	Design:
	- Derive an AES-256-GCM key from the user's passphrase using PBKDF2-SHA256
	- Encrypt the private key string using AES-GCM (provides confidentiality + integrity; wrong passphrase fails authentication)
	- Store only { iterations, salt, iv, ciphertext } in localStorage
    
	Notes:
	- This is not automatic unlock. Passphrase is still required.
	- Cleanup is handled by disasterStorage via a global cleanup timestamp.
 */

const PBKDF2_ITERS = 150_000

function bytesToBase64(bytes) {
	let bin = ''
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
	return btoa(bin)
}

function base64ToBytes(b64) {
	const bin = atob(b64)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

// PBKDF2(passphrase, salt, iterations) -> AES-GCM key
async function deriveAesKeyFromPassphrase({ passphrase, salt, iterations }) {
	const subtle = globalThis.crypto?.subtle
	if (!subtle) throw new Error('WebCrypto subtle is not available')

	const enc = new TextEncoder()

	// Import passphrase bytes as a "base key" for PBKDF2
	const baseKey = await subtle.importKey(
		'raw',
		enc.encode(passphrase),
		{ name: 'PBKDF2' },
		false,
		['deriveKey']
	)

	// Derive a non-extractable AES-GCM key
	return subtle.deriveKey({
		name: 'PBKDF2',
		salt,
		iterations,
		hash: 'SHA-256',
	},
		baseKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	)
}

// Encrypt a UTF-8 string with passphrase-derived AES-GCM. Output is JSON-safe (base64 fields).
export async function sealStringWithPassphrase({ plaintext, passphrase }) {
	if (typeof plaintext !== 'string') {
		throw new Error('sealStringWithPassphrase: plaintext must be a string')
	}
	if (typeof passphrase !== 'string' || !passphrase.trim()) {
		throw new Error('sealStringWithPassphrase: passphrase is required')
	}

	const subtle = globalThis.crypto?.subtle
	if (!subtle) throw new Error('WebCrypto subtle is not available')

	// Salt prevents two users with the same passphrase from producing the same key
	const salt = crypto.getRandomValues(new Uint8Array(16))

	// AES-GCM requires a unique IV per encryption under the same key
	const iv = crypto.getRandomValues(new Uint8Array(12))
	
	const iterations = PBKDF2_ITERS
	const key = await deriveAesKeyFromPassphrase({ passphrase, salt, iterations })
	
	const enc = new TextEncoder()
	const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext))

	return {
		v: 1,
		iterations,
		saltB64: bytesToBase64(salt),
		ivB64: bytesToBase64(iv),
		ctB64: bytesToBase64(new Uint8Array(ct)),
	}
}

// Decrypt a sealed blob using the provided passphrase. Wrong passphrase throws a clean error (AES-GCM auth failure).
export async function unsealStringWithPassphrase({ sealed, passphrase }) {
	if (!sealed || typeof sealed !== 'object') {
		throw new Error('unsealStringWithPassphrase: sealed object required')
	}
	if (typeof passphrase !== 'string' || !passphrase.trim()) {
		throw new Error('unsealStringWithPassphrase: passphrase is required')
	}

	const subtle = globalThis.crypto?.subtle
	if (!subtle) throw new Error('WebCrypto subtle is not available')

	const salt = base64ToBytes(sealed.saltB64)
	const iv = base64ToBytes(sealed.ivB64)
	const ct = base64ToBytes(sealed.ctB64)

	const iterations = Number(sealed.iterations)
	if (!Number.isFinite(iterations) || iterations < 10_000) {
		throw new Error('unsealStringWithPassphrase: invalid iterations')
	}

	const key = await deriveAesKeyFromPassphrase({ passphrase, salt, iterations })

	let ptBytes
	try {
		ptBytes = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
	} catch {
		throw new Error('Invalid passphrase (or corrupted local key data)')
	}

	return new TextDecoder().decode(ptBytes)
}
// krisys-backend/device-offline-server/rtc-host/nodeRtcChunking.js
const crypto = require('crypto')
const CHUNK_RAW_BYTES = 9000

const ASSEMBLY_TTL_MS = 60 * 1000
const MAX_INFLIGHT_ASSEMBLIES = 12
const MAX_CHUNKS_PER_MESSAGE = 2048
const MAX_MESSAGE_BYTES_REASSEMBLED = 6 * 1024 * 1024
const MAX_ID_LENGTH = 128
const MAX_B64_CHARS_PER_CHUNK = 20000

function now() {
	return Date.now()
}

function base64UrlEncode(bytes) {
	const b64 = Buffer.from(bytes).toString('base64')
	return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(b64url) {
	const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
	const padLen = (4 - (b64.length % 4)) % 4
	const padded = b64 + '='.repeat(padLen)
	return new Uint8Array(Buffer.from(padded, 'base64'))
}

function concatBytes(chunks) {
	let total = 0
	for (const c of chunks) total += c.length

	const out = new Uint8Array(total)
	let offset = 0

	for (const c of chunks) {
		out.set(c, offset)
		offset += c.length
	}

	return out
}

function createChunkSender({ dc }) {
	if (!dc) throw new Error('Missing data channel')

	return {
		sendJson(obj) {
			if (dc.readyState !== 'open') {
				throw new Error('DataChannel not open')
			}

			const json = JSON.stringify(obj)
			const bytes = new TextEncoder().encode(json)

			if (bytes.length <= CHUNK_RAW_BYTES) {
				dc.send(json)
				return
			}

			const total = Math.ceil(bytes.length / CHUNK_RAW_BYTES)
			if (total > MAX_CHUNKS_PER_MESSAGE) {
				throw new Error('Payload too large to chunk safely')
			}

			const id = crypto.randomUUID()

			for (let seq = 0; seq < total; seq++) {
				const start = seq * CHUNK_RAW_BYTES
				const end = Math.min(start + CHUNK_RAW_BYTES, bytes.length)
				const slice = bytes.slice(start, end)

				dc.send(JSON.stringify({
					t: 'krisys_chunk_v1',
					id,
					seq,
					total,
					b64: base64UrlEncode(slice)
				}))
			}
		}
	}
}

function createChunkReceiver({ onJson }) {
	const assemblies = new Map()

	function cleanupExpired() {
		const current = now()
		for (const [id, a] of assemblies.entries()) {
			if (current - a.lastAt > ASSEMBLY_TTL_MS) {
				assemblies.delete(id)
			}
		}
	}

	function evictIfNeeded() {
		if (assemblies.size < MAX_INFLIGHT_ASSEMBLIES) return

		let oldestId = null
		let oldestTime = Infinity

		for (const [id, a] of assemblies.entries()) {
			if (a.lastAt < oldestTime) {
				oldestTime = a.lastAt
				oldestId = id
			}
		}

		if (oldestId) assemblies.delete(oldestId)
	}

	async function handleChunkFrame(obj) {
		const { id, seq, total, b64 } = obj

		if (
			typeof id !== 'string' ||
			id.length > MAX_ID_LENGTH ||
			typeof seq !== 'number' ||
			typeof total !== 'number' ||
			total <= 0 ||
			total > MAX_CHUNKS_PER_MESSAGE ||
			typeof b64 !== 'string' ||
			b64.length > MAX_B64_CHARS_PER_CHUNK
		) {
			return
		}

		if (seq < 0 || seq >= total) return

		evictIfNeeded()

		let assembly = assemblies.get(id)
		if (!assembly) {
			assembly = {
				total,
				parts: new Array(total).fill(null),
				received: 0,
				bytes: 0,
				lastAt: now()
			}
			assemblies.set(id, assembly)
		}

		if (assembly.total !== total) {
			assemblies.delete(id)
			return
		}

		if (assembly.parts[seq]) return

		let decoded
		try {
			decoded = base64UrlDecode(b64)
		} catch {
			assemblies.delete(id)
			return
		}

		if (decoded.length > CHUNK_RAW_BYTES) {
			assemblies.delete(id)
			return
		}

		assembly.parts[seq] = decoded
		assembly.received++
		assembly.bytes += decoded.length
		assembly.lastAt = now()

		if (assembly.bytes > MAX_MESSAGE_BYTES_REASSEMBLED) {
			assemblies.delete(id)
			return
		}

		if (assembly.received === assembly.total) {
			assemblies.delete(id)

			const bytes = concatBytes(assembly.parts.filter(Boolean))
			const text = new TextDecoder().decode(bytes)

			try {
				const json = JSON.parse(text)
				await onJson(json)
			} catch {
				return
			}
		}
	}

	return {
		async handleText(text) {
			cleanupExpired()

			let obj
			try {
				obj = JSON.parse(text)
			} catch {
				return
			}

			if (obj?.t === 'krisys_chunk_v1') {
				await handleChunkFrame(obj)
				return
			}

			await onJson(obj)
		}
	}
}

module.exports = {
	createChunkSender,
	createChunkReceiver
}
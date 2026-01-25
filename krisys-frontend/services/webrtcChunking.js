const CHUNK_RAW_BYTES = 9000
const ASSEMBLY_TTL_MS = 30 * 1000

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

function concatBytes(chunks) {
	let total = 0
	for (const b of chunks) total += b.length

	const out = new Uint8Array(total)
	let offset = 0
	for (const b of chunks) {
		out.set(b, offset)
		offset += b.length
	}
	return out
}

export function makeId() {
	try {
		if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
	} 
    catch { 
        // ignore
    }
	return `${Date.now()}_${Math.random().toString(36).slice(2)}`
}

export function createChunkSender({ dc, log }) {
	if (!dc) throw new Error('Missing data channel')

	const sendText = (text) => {
		dc.send(text)
	}

	const sendJson = (obj) => {
		const json = JSON.stringify(obj)
		const bytes = new TextEncoder().encode(json)

		// Small payload: send directly for simplicity.
		if (bytes.length <= CHUNK_RAW_BYTES) {
			sendText(json)
			if (typeof log === 'function') {
				log(`send direct t=${obj?.t || 'unknown'} bytes=${bytes.length}`)
			}
			console.log('[KriSYS P2P] send direct', {
				t: obj?.t,
				bytes: bytes.length,
			})
			return
		}

		// Large payload: chunk raw bytes, base64url each chunk.
		const id = makeId()
		const total = Math.ceil(bytes.length / CHUNK_RAW_BYTES)

		for (let seq = 0; seq < total; seq++) {
			const start = seq * CHUNK_RAW_BYTES
			const end = Math.min(start + CHUNK_RAW_BYTES, bytes.length)
			const slice = bytes.slice(start, end)

			const frame = {
				t: 'krisys_chunk_v1',
				id,
				kind: obj?.t || 'unknown',
				seq,
				total,
				b64: base64UrlEncode(slice),
				sentAt: Date.now(),
			}

			sendText(JSON.stringify(frame))
		}

		if (typeof log === 'function') {
			log(`send chunked kind=${obj?.t || 'unknown'} id=${id} total=${total} bytes=${bytes.length}`)
		}
		console.log('[KriSYS P2P] send chunked', {
			kind: obj?.t,
			id,
			total,
			bytes: bytes.length,
		})
	}

	return { sendJson }
}

export function createChunkReceiver({ onJson, log }) {
	const assemblies = new Map()

	const cleanupExpired = () => {
		const now = Date.now()
		for (const [id, a] of assemblies.entries()) {
			if (now - a.createdAt > ASSEMBLY_TTL_MS) assemblies.delete(id)
		}
	}

	const handleText = async (text) => {
		cleanupExpired()

		// Try parse as JSON. If it fails, ignore (or treat as debug text).
		let obj
		try { obj = JSON.parse(text) } 
        catch {
			if (typeof log === 'function') log('recv non-json')
			return
		}

		// Chunk frame handling
		if (obj?.t === 'krisys_chunk_v1') {
			const id = obj.id
			const seq = obj.seq
			const total = obj.total
			const kind = obj.kind || 'unknown'

			if (typeof id !== 'string' || typeof seq !== 'number' ||
				typeof total !== 'number' || typeof obj.b64 !== 'string') {

				if (typeof log === 'function') log('recv invalid chunk frame')
				return
			}

			let a = assemblies.get(id)
			if (!a) {
				a = {
					kind,
					total,
					createdAt: Date.now(),
					parts: new Array(total).fill(null),
					received: 0,
				}
				assemblies.set(id, a)
			}

			// If total mismatches, drop (corrupt stream)
			if (a.total !== total) {
				assemblies.delete(id)
				if (typeof log === 'function') log(`recv chunk id=${id} total mismatch`)
				return
			}

			if (seq < 0 || seq >= total) return
			if (a.parts[seq]) return

			try {
				a.parts[seq] = base64UrlDecodeToBytes(obj.b64)
				a.received += 1
			} 
            catch {
				assemblies.delete(id)
				if (typeof log === 'function') log(`recv chunk id=${id} decode failed`)
				return
			}

			if (typeof log === 'function') {
				log(`recv chunk kind=${kind} id=${id} ${a.received}/${a.total}`)
			}

			// Completed
			if (a.received === a.total) {
				assemblies.delete(id)
				const bytes = concatBytes(a.parts.filter(Boolean))
				const json = new TextDecoder().decode(bytes)

				let inner
				try { inner = JSON.parse(json) } 
                catch (e) {
					if (typeof log === 'function') log(`reassemble parse failed id=${id}`)
					return
				}

				console.log('[KriSYS P2P] recv complete', { kind, id, bytes: bytes.length, })

				if (typeof log === 'function') {
					log(`recv complete kind=${kind} id=${id} bytes=${bytes.length}`)
				}

				if (typeof onJson === 'function') {
					await onJson(inner)
				}
			}

			return
		}

		// Non-chunked message
		console.log('[KriSYS P2P] recv direct', { t: obj?.t, })

		if (typeof log === 'function') log(`recv direct t=${obj?.t || 'unknown'}`)
		if (typeof onJson === 'function') await onJson(obj)
	}

	return { handleText }
}
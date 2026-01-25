// krisys-frontend/services/webrtcChunking.js

const CHUNK_RAW_BYTES = 9000

// Receiver safety limits (untrusted peer can send nonsense)
const ASSEMBLY_TTL_MS = 60 * 1000						// time-based eviction
const MAX_INFLIGHT_ASSEMBLIES = 12						// how many messages assembling at once
const MAX_CHUNKS_PER_MESSAGE = 2048						// prevents fake "huge message" claims
const MAX_MESSAGE_BYTES_REASSEMBLED = 6 * 1024 * 1024	// absolute memory cap
// DataChannel backpressure + strict bounds on chunk reassembly to prevent memory blowups from a malicious/buggy peer

const MAX_B64_CHARS_PER_CHUNK = 20000
const MAX_ID_LENGTH = 128

// Sender backpressure limits
const SEND_BUFFER_HIGH_WATER = 2 * 1024 * 1024
const SEND_LOW_THRESHOLD = 512 * 1024
const STATS_EMIT_THROTTLE_MS = 250

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

function safeNow() {
	return Date.now()
}

function clampInt(n, fallback) {
	const v = Number(n)
	return Number.isFinite(v) ? v : fallback
}

export function makeId() {
	try {
		if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
	} catch {
		// ignore
	}
	return `${Date.now()}_${Math.random().toString(36).slice(2)}`
}

export function createChunkSender({ dc, log, onStats } = {}) {
	if (!dc) throw new Error('Missing data channel')

	let destroyed = false
	let pumping = false
	let scheduled = false

	const sendQueue = []

	const stats = {
		framesQueued: 0,
		framesSent: 0,
		bytesSent: 0,

		directMessages: 0,
		chunkedMessages: 0,

		lastSendAt: null,
		lastQueuedAt: null,
		lastError: null,
	}

	let lastStatsEmitAt = 0

	const emitStats = (force = false) => {
		const now = safeNow()
		if (!force && now - lastStatsEmitAt < STATS_EMIT_THROTTLE_MS) return
		lastStatsEmitAt = now

		if (typeof onStats === 'function') {
			try {
				onStats({
					...stats,
					readyState: dc.readyState,
					bufferedAmount: clampInt(dc.bufferedAmount, 0),
					queueDepth: sendQueue.length,
				})
			} catch {
				// ignore
			}
		}
	}

	const canSendMore = () => {
		const buffered = clampInt(dc.bufferedAmount, 0)
		return buffered < SEND_BUFFER_HIGH_WATER
	}

	const pump = () => {
		if (destroyed) return
		if (pumping) return
		pumping = true

		try {
			if (dc.readyState !== 'open') return

			while (sendQueue.length > 0 && canSendMore()) {
				const frameText = sendQueue.shift()
				if (typeof frameText !== 'string') continue

				dc.send(frameText)

				stats.framesSent += 1
				stats.bytesSent += frameText.length
				stats.lastSendAt = safeNow()
			}

			emitStats(false)

			if (sendQueue.length > 0) {
				// Wait for buffer to drain, then resume. Also schedule a poll
				// fallback (some environments can be flaky with events).
				schedulePump()
			} else {
				emitStats(true)
			}
		} catch (e) {
			stats.lastError = e?.message || String(e)
			emitStats(true)
			throw e
		} finally {
			pumping = false
		}
	}

	const onLow = () => {
		try {
			pump()
		} catch {
			// ignore
		}
	}

	const schedulePump = () => {
		if (destroyed) return
		if (scheduled) return
		scheduled = true

		setTimeout(() => {
			scheduled = false
			try {
				pump()
			} catch {
				// ignore
			}
		}, 25)
	}

	// Backpressure hook
	try {
		dc.bufferedAmountLowThreshold = SEND_LOW_THRESHOLD
	} catch {
		// ignore
	}

	try {
		dc.addEventListener('bufferedamountlow', onLow)
	} catch {
		// ignore
	}

	// Some browsers support the handler property too; harmless if overwritten.
	try {
		dc.onbufferedamountlow = onLow
	} catch {
		// ignore
	}

	const enqueueFrame = (text) => {
		sendQueue.push(text)
		stats.framesQueued += 1
		stats.lastQueuedAt = safeNow()
	}

	const sendJson = (obj) => {
		if (destroyed) throw new Error('Sender destroyed')
		if (dc.readyState !== 'open') throw new Error('DataChannel is not open')

		const json = JSON.stringify(obj)
		const bytes = new TextEncoder().encode(json)

		// Small payload: send directly
		if (bytes.length <= CHUNK_RAW_BYTES) {
			enqueueFrame(json)
			stats.directMessages += 1

			if (typeof log === 'function') {
				log(`send queued direct t=${obj?.t || 'unknown'} bytes=${bytes.length}`)
			}

			emitStats(true)
			schedulePump()
			return
		}

		// Large payload: chunk
		const id = makeId()
		const total = Math.ceil(bytes.length / CHUNK_RAW_BYTES)

		if (total > MAX_CHUNKS_PER_MESSAGE) {
			throw new Error(`Chunked payload too large: totalChunks=${total}`)
		}

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
				sentAt: safeNow(),
			}

			enqueueFrame(JSON.stringify(frame))
		}

		stats.chunkedMessages += 1

		if (typeof log === 'function') {
			log(
				`send queued chunked kind=${obj?.t || 'unknown'} ` +
					`id=${id} total=${total} bytes=${bytes.length}`
			)
		}

		emitStats(true)
		schedulePump()
	}

	const destroy = () => {
		destroyed = true
		sendQueue.length = 0
		try {
			dc.removeEventListener('bufferedamountlow', onLow)
		} catch {
			// ignore
		}
	}

	return { sendJson, destroy, getStats: () => ({ ...stats }) }
}

export function createChunkReceiver({ onJson, log, onStats } = {}) {
	const assemblies = new Map()

	const stats = {
		framesReceived: 0,
		bytesReceived: 0,

		chunkFramesReceived: 0,
		chunkMessagesCompleted: 0,

		lastRecvAt: null,
		lastCompleteAt: null,
		lastError: null,

		inflight: 0,
	}

	let lastStatsEmitAt = 0

	const emitStats = (force = false) => {
		const now = safeNow()
		if (!force && now - lastStatsEmitAt < STATS_EMIT_THROTTLE_MS) return
		lastStatsEmitAt = now

		if (typeof onStats === 'function') {
			try {
				onStats({ ...stats })
			} catch {
				// ignore
			}
		}
	}

	const cleanupExpired = () => {
		const now = safeNow()
		for (const [id, a] of assemblies.entries()) {
			if (now - a.lastAt > ASSEMBLY_TTL_MS) {
				assemblies.delete(id)
			}
		}
		stats.inflight = assemblies.size
	}

	const evictIfNeeded = () => {
		if (assemblies.size < MAX_INFLIGHT_ASSEMBLIES) return

		let oldestId = null
		let oldestAt = Infinity

		for (const [id, a] of assemblies.entries()) {
			if (a.lastAt < oldestAt) {
				oldestAt = a.lastAt
				oldestId = id
			}
		}

		if (oldestId) assemblies.delete(oldestId)
		stats.inflight = assemblies.size
	}

	const handleChunkFrame = async (obj) => {
		const id = obj.id
		const seq = obj.seq
		const total = obj.total
		const kind = obj.kind || 'unknown'

		if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) {
			if (typeof log === 'function') log('recv invalid chunk id')
			return
		}

		if (typeof obj.b64 !== 'string' || obj.b64.length > MAX_B64_CHARS_PER_CHUNK) {
			if (typeof log === 'function') log(`recv invalid b64 id=${id}`)
			return
		}

		if (typeof seq !== 'number' || typeof total !== 'number') {
			if (typeof log === 'function') log(`recv invalid seq/total id=${id}`)
			return
		}

		if (total <= 0 || total > MAX_CHUNKS_PER_MESSAGE) {
			if (typeof log === 'function') log(`recv chunk total out of bounds id=${id}`)
			return
		}

		if (seq < 0 || seq >= total) return

		evictIfNeeded()

		let a = assemblies.get(id)
		if (!a) {
			a = {
				kind,
				total,
				createdAt: safeNow(),
				lastAt: safeNow(),
				parts: new Array(total).fill(null),
				received: 0,
				bytes: 0,
			}
			assemblies.set(id, a)
			stats.inflight = assemblies.size
		}

		// If total mismatches, drop (corrupt stream)
		if (a.total !== total) {
			assemblies.delete(id)
			stats.inflight = assemblies.size
			if (typeof log === 'function') log(`recv chunk id=${id} total mismatch`)
			return
		}

		// Duplicate chunk => ignore
		if (a.parts[seq]) return

		let decoded
		try {
			decoded = base64UrlDecodeToBytes(obj.b64)
		} catch {
			assemblies.delete(id)
			stats.inflight = assemblies.size
			if (typeof log === 'function') log(`recv chunk id=${id} decode failed`)
			return
		}

		// Sanity: each decoded chunk should be at most our raw chunk size
		if (decoded.length > CHUNK_RAW_BYTES) {
			assemblies.delete(id)
			stats.inflight = assemblies.size
			if (typeof log === 'function') log(`recv chunk id=${id} too large`)
			return
		}

		a.parts[seq] = decoded
		a.received += 1
		a.bytes += decoded.length
		a.lastAt = safeNow() // slow but valid transfers survive; stalled / malicious ones expire

		stats.chunkFramesReceived += 1
		stats.lastRecvAt = safeNow()
		stats.inflight = assemblies.size

		if (a.bytes > MAX_MESSAGE_BYTES_REASSEMBLED) {
			assemblies.delete(id)
			stats.inflight = assemblies.size
			if (typeof log === 'function') log(`recv chunk id=${id} over size cap; dropped`)
			emitStats(true)
			return
		}

		if (typeof log === 'function') {
			log(`recv chunk kind=${kind} id=${id} ${a.received}/${a.total}`)
		}

		emitStats(false)

		// Completed
		if (a.received === a.total) {
			assemblies.delete(id)
			stats.inflight = assemblies.size

			const bytes = concatBytes(a.parts.filter(Boolean))
			const json = new TextDecoder().decode(bytes)

			let inner
			try {
				inner = JSON.parse(json)
			} catch (e) {
				if (typeof log === 'function') log(`reassemble parse failed id=${id}`)
				return
			}

			stats.chunkMessagesCompleted += 1
			stats.lastCompleteAt = safeNow()

			if (typeof log === 'function') {
				log(`recv complete kind=${kind} id=${id} bytes=${bytes.length}`)
			}

			emitStats(true)

			if (typeof onJson === 'function') {
				await onJson(inner)
			}
		}
	}

	const handleText = async (text) => {
		cleanupExpired()

		stats.framesReceived += 1
		stats.bytesReceived += typeof text === 'string' ? text.length : 0
		stats.lastRecvAt = safeNow()

		// Try parse as JSON. If it fails, ignore.
		let obj
		try {
			obj = JSON.parse(text)
		} catch {
			if (typeof log === 'function') log('recv non-json')
			emitStats(false)
			return
		}

		// Chunk frame handling
		if (obj?.t === 'krisys_chunk_v1') {
			await handleChunkFrame(obj)
			return
		}

		// Non-chunked message
		if (typeof log === 'function') log(`recv direct t=${obj?.t || 'unknown'}`)
		emitStats(false)

		if (typeof onJson === 'function') {
			await onJson(obj)
		}
	}

	const destroy = () => {
		assemblies.clear()
		stats.inflight = 0
	}

	return { handleText, destroy, getStats: () => ({ ...stats }) }
}
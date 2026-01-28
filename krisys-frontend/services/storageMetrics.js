// krisys-frontend/services/storageMetrics.js
const BYTES_PER_CHAR = 2

function sizeOfString(str) {
	return typeof str === 'string' ? str.length * BYTES_PER_CHAR : 0
}

export function getStorageBreakdown() {
	const buckets = {
		blocks: 0,
		queue: 0,
		confirmed: 0,
		wallets: 0,
		keys: 0,
		contacts: 0,
		other: 0,
	}

	let totalBytes = 0

	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i)
		const value = localStorage.getItem(key)
		if (!key) continue

		const bytes = sizeOfString(key) + sizeOfString(value)
		totalBytes += bytes

		// Only inspect KriSYS keys
		if (!key.startsWith('krisys:')) {
			buckets.other += bytes
			continue
		}

		// Split: krisys:<crisisId>:domain:<domainType>:<bucket>
		const parts = key.split(':')
		const bucket = parts[parts.length - 1]
		const domainType = parts.includes('domain')
			? parts[parts.indexOf('domain') + 1]
			: null

		if (bucket === 'blocks') buckets.blocks += bytes
		else if (bucket === 'queue') buckets.queue += bytes
		else if (bucket === 'confirmed_relays') buckets.confirmed += bytes
		else if (bucket === 'wallet_data') buckets.wallets += bytes
		else if (bucket === 'public_keys') buckets.keys += bytes
		else if (bucket === 'contacts') buckets.contacts += bytes
		else buckets.other += bytes
	}

	return { totalBytes, buckets }
}
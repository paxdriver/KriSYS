// krisys-frontend/components/services/storageMetrics.js
const BYTES_PER_CHAR = 2

function sizeOfString(str) {
	return typeof str === 'string' ? str.length * BYTES_PER_CHAR : 0
}

export function getStorageBreakdown() {
	const buckets = {
		blockchain: 0,
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

		const bytes = sizeOfString(key) + sizeOfString(value)
		totalBytes += bytes

		if (key.startsWith('krisys_blockchain')) buckets.blockchain += bytes
		else if (key.startsWith('krisys_message_queue')) buckets.queue += bytes
		else if (key.startsWith('krisys_confirmed_relays')) buckets.confirmed += bytes
		else if (key.startsWith('krisys_wallet_data')) buckets.wallets += bytes
		else if (key.startsWith('krisys_public_keys')) buckets.keys += bytes
		else if (key.startsWith('krisys_contacts')) buckets.contacts += bytes
		else buckets.other += bytes
	}

	return { totalBytes, buckets }
}
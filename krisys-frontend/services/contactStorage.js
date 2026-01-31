// krisys-frontend/services/contactStorage.js

/**
 * LOCAL CONTACT STORAGE — WALLET + CRISIS SCOPED
 *
 * Stores address -> name mappings ONLY locally.
 * Never synced to server or blockchain.
 * Private to a specific wallet within a specific crisis.
 */

class ContactStorage {
	_buildKey({ crisisId, familyId }) {
		if (typeof crisisId !== 'string' || !crisisId.trim()) {
			throw new Error('contactStorage requires crisisId')
		}
		if (typeof familyId !== 'string' || !familyId.trim()) {
			throw new Error('contactStorage requires familyId')
		}

		const cid = crisisId.trim()
		const fid = familyId.trim()

		// krisys:<crisisId>:domain:wallet:<familyId>:contacts
		return `krisys:${cid}:domain:wallet:${fid}:contacts`
	}

	_getJson(key, fallback) {
		if (typeof window === 'undefined') return fallback
		const raw = localStorage.getItem(key)
		if (!raw) return fallback
		try {
			return JSON.parse(raw)
		} catch {
			return fallback
		}
	}

	_setJson(key, value) {
		if (typeof window === 'undefined') return
		localStorage.setItem(key, JSON.stringify(value))
	}

	getContacts({ crisisId, familyId }) {
		const key = this._buildKey({ crisisId, familyId })
		return this._getJson(key, {})
	}

	setContact({ crisisId, familyId, address, name }) {
		if (typeof address !== 'string' || !address.trim()) return
		if (typeof name !== 'string' || !name.trim()) return

		const key = this._buildKey({ crisisId, familyId })
		const contacts = this.getContacts({ crisisId, familyId })

		contacts[address.trim()] = name.trim()
		this._setJson(key, contacts)
	}

	getDisplayName({ crisisId, familyId, address }) {
		if (typeof address !== 'string' || !address.trim()) return ''
		const contacts = this.getContacts({ crisisId, familyId })
		return contacts[address] || address
	}

	deleteContact({ crisisId, familyId, address }) {
		if (typeof address !== 'string' || !address.trim()) return

		const key = this._buildKey({ crisisId, familyId })
		const contacts = this.getContacts({ crisisId, familyId })

		delete contacts[address.trim()]
		this._setJson(key, contacts)
	}

	updateContacts({ crisisId, familyId, newContacts }) {
		if (!newContacts || typeof newContacts !== 'object') return

		const key = this._buildKey({ crisisId, familyId })
		const existing = this.getContacts({ crisisId, familyId })

		const merged = { ...existing, ...newContacts }
		this._setJson(key, merged)
	}

	clearAllContacts({ crisisId, familyId }) {
		if (typeof window === 'undefined') return
		const key = this._buildKey({ crisisId, familyId })
		localStorage.removeItem(key)
	}

	exportContacts({ crisisId, familyId }) {
		return this.getContacts({ crisisId, familyId })
	}
}

export const contactStorage = new ContactStorage()
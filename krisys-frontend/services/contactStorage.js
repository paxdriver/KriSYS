/**
 * LOCAL CONTACT STORAGE — WALLET + CRISIS SCOPED
 *
 * Stores address -> name mappings ONLY locally
 * Never synced to server or blockchain
 * Private to a specific wallet within a specific crisis
 */

import { disasterStorage } from './localStorage'

class ContactStorage {
	// Build wallet-domain contact key
	_buildKey({ crisisId, familyId }) {
		if (!crisisId || !familyId) {
			throw new Error('contactStorage requires crisisId and familyId')
		}
		return `krisys:${crisisId}:domain:wallet:${familyId}:contacts`
	}

	// GET ALL CONTACTS
	getContacts({ crisisId, familyId }) {
		const key = this._buildKey({ crisisId, familyId })
		const stored = localStorage.getItem(key)
		return stored ? JSON.parse(stored) : {}
	}

	// ADD OR UPDATE CONTACT
	setContact({ crisisId, familyId, address, name }) {
		const key = this._buildKey({ crisisId, familyId })
		const contacts = this.getContacts({ crisisId, familyId })

		contacts[address] = name.trim()
		localStorage.setItem(key, JSON.stringify(contacts))

		console.log(`📝 Saved contact (${familyId}): ${address} -> ${name}`)
	}

	// GET DISPLAY NAME
	getDisplayName({ crisisId, familyId, address }) {
		const contacts = this.getContacts({ crisisId, familyId })
		return contacts[address] || address
	}

	// DELETE CONTACT
	deleteContact({ crisisId, familyId, address }) {
		const key = this._buildKey({ crisisId, familyId })
		const contacts = this.getContacts({ crisisId, familyId })

		delete contacts[address]
		localStorage.setItem(key, JSON.stringify(contacts))

		console.log(`🗑️ Deleted contact (${familyId}): ${address}`)
	}

	// BULK UPDATE
	updateContacts({ crisisId, familyId, newContacts }) {
		const key = this._buildKey({ crisisId, familyId })
		const existing = this.getContacts({ crisisId, familyId })

		const merged = { ...existing, ...newContacts }
		localStorage.setItem(key, JSON.stringify(merged))

		console.log(`📦 Updated ${Object.keys(newContacts).length} contacts`)
	}

	// CLEAR ALL CONTACTS FOR THIS WALLET
	clearAllContacts({ crisisId, familyId }) {
		const key = this._buildKey({ crisisId, familyId })
		localStorage.removeItem(key)

		console.log(`🗑️ Cleared all contacts for wallet ${familyId}`)
	}

	// EXPORT CONTACTS
	exportContacts({ crisisId, familyId }) {
		return this.getContacts({ crisisId, familyId })
	}
}

export const contactStorage = new ContactStorage()
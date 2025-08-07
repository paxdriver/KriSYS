/**
 * LOCAL CONTACT STORAGE - PRIVACY FIRST
 * 
 * Stores address -> name mappings ONLY locally
 * Never synced to server or blockchain
 * Only accessible when wallet is unlocked
 * Protects identities in dangerous situations
 */

class ContactStorage {
    constructor() {
        this.STORAGE_KEY = 'krisys_contacts_private'
    }

    // GET ALL CONTACTS (address -> name mappings)
    getContacts() {
        const stored = localStorage.getItem(this.STORAGE_KEY)
        return stored ? JSON.parse(stored) : {}
    }

    // ADD OR UPDATE CONTACT
    setContact(address, name) {
        const contacts = this.getContacts()
        contacts[address] = name.trim()
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(contacts))
        console.log(`📝 Saved contact: ${address} -> ${name}`)
    }

    // GET DISPLAY NAME (name if known, address if not)
    getDisplayName(address) {
        const contacts = this.getContacts()
        return contacts[address] || address
    }

    // DELETE CONTACT
    deleteContact(address) {
        const contacts = this.getContacts()
        delete contacts[address]
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(contacts))
        console.log(`🗑️ Deleted contact: ${address}`)
    }

    // BULK UPDATE (useful for importing)
    updateContacts(newContacts) {
        const existing = this.getContacts()
        const merged = { ...existing, ...newContacts }
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(merged))
        console.log(`📦 Updated ${Object.keys(newContacts).length} contacts`)
    }

    // CLEAR ALL CONTACTS (for privacy/security)
    clearAllContacts() {
        localStorage.removeItem(this.STORAGE_KEY)
        console.log('🗑️ Cleared all contacts for privacy')
    }

    // EXPORT CONTACTS (for manual backup)
    exportContacts() {
        return this.getContacts()
    }
}

export const contactStorage = new ContactStorage()
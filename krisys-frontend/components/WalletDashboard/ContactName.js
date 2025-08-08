// components/WalletDashboard/ContactName.js
import { useState } from 'react'
import { contactStorage } from '@/services/contactStorage'

export default function ContactName({ address, isUnlocked, editable = false, className = "" }) {
    const [editing, setEditing] = useState(false)
    const [editName, setEditName] = useState('')
    
    // Only show names when wallet is unlocked (privacy protection)
    const displayName = isUnlocked ? contactStorage.getDisplayName(address) : address
    const isKnownContact = isUnlocked && contactStorage.getContacts()[address]

    const startEditing = () => {
        if (!editable || !isUnlocked) return
        
        setEditName(isKnownContact ? displayName : '')
        setEditing(true)
    }

    const saveContact = () => {
        if (editName.trim()) {
            contactStorage.setContact(address, editName.trim())
        }
        setEditing(false)
    }

    const deleteContact = () => {
        if (confirm(`Remove contact name for ${address}?`)) {
            contactStorage.deleteContact(address)
            setEditing(false)
        }
    }

    if (!isUnlocked) {
        // When locked, always show address (no names for privacy)
        return <span className={`contact-name locked ${className}`}>{address}</span>
    }

    if (editing && editable) {
        return (
            <div className="contact-edit">
                <input 
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="Enter name for this address"
                    className="contact-input"
                    autoFocus
                    onKeyPress={(e) => e.key === 'Enter' && saveContact()}
                />
                <div className="contact-edit-actions">
                    <button 
                        onClick={saveContact}
                        className="btn-icon save"
                        title="Save contact"
                    >
                        ✅
                    </button>
                    <button 
                        onClick={() => setEditing(false)}
                        className="btn-icon cancel"
                        title="Cancel"
                    >
                        ❌
                    </button>
                    {isKnownContact && (
                        <button 
                            onClick={deleteContact}
                            className="btn-icon delete"
                            title="Delete contact"
                        >
                            🗑️
                        </button>
                    )}
                </div>
            </div>
        )
    }

// THIS FAILS EVERY TIME!!! SPANS CAN'T BE IN THIS COMPONENT IF THIS COMPONENT IS A DROP-DOWN OPTION/SELECT LIST, STOOPID... This needs to be encapsulated or abstracted in a different way, using divs instead of an option list... should have a keyboard search feature eventually anyway so doesn't matter if it's not primitive HTML, in the end it'll have to be customized probably anyway.

// Question remains: how to edit contact names so address are always replaced with names in unlocked wallet contact lists. 

// NOTE: public contact lists should still exist, for food, medical, journalists, etc. the people should be able to post publicly to centres to document traffic, needs, and stories as they unfold.

    return (
        <span 
            className={`contact-name ${isKnownContact ? 'known' : 'unknown'} ${editable ? 'editable' : ''} ${className}`}
            onClick={editable ? startEditing : undefined}
            title={isKnownContact ? `Address: ${address}` : 'Click to add contact name'}
        >
            {displayName}
            {editable && isUnlocked && (
                <span className="edit-hint">✏️</span>
            )}
        </span>
    )
}
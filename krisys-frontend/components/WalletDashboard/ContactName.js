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
        return address
    }

    if (editing && editable) {
        return (
            <span className="contact-edit">
                <input 
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="Enter name for this address"
                    className="contact-input"
                    autoFocus
                    onKeyPress={(e) => e.key === 'Enter' && saveContact()}
                />
                <button onClick={saveContact} className="btn-icon save" title="Save contact">✅</button>
                <button onClick={() => setEditing(false)} className="btn-icon cancel" title="Cancel">❌</button>
                {isKnownContact && (
                    <button onClick={deleteContact} className="btn-icon delete" title="Delete contact">🗑️</button>
                )}
            </span>
        )
    }

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
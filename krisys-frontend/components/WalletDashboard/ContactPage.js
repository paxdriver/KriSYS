// components/WalletDashboard/ContactsPage.js
import { useState, useEffect } from 'react'
import { contactStorage } from '../../services/contactStorage'
import { useRouter } from 'next/navigation'

export default function ContactsPage({ walletData, transactions, privateKey }) {
    const [contacts, setContacts] = useState({})
    const [searchTerm, setSearchTerm] = useState('')
    const [editingContact, setEditingContact] = useState(null)
    const [editName, setEditName] = useState('')
    // add contact state values
    const [newName, setNewName] = useState('')
    const [newAddress, setNewAddress] = useState('')
    const [showAddForm, setShowAddForm] = useState(false)
    const router = useRouter()

    useEffect(() => {
        setContacts(contactStorage.getContacts())
    }, [])

    const refreshContacts = () => {
        setContacts(contactStorage.getContacts())
    }

    const filteredContacts = Object.entries(contacts).filter(([address, name]) => 
        name.toLowerCase().includes(searchTerm.toLowerCase()) || 
        address.includes(searchTerm)
    )

    const getMessageCount = (address) => {
        if (!transactions) return 0
        return transactions.filter(tx => 
            tx.type_field === 'message' && 
            (tx.station_address === address || tx.related_addresses?.includes(address))
        ).length
    }

    const getFamilyAddress = (memberAddress) => {
        // Extract family ID from member address (everything before last dash)
        return memberAddress.split('-').slice(0, -1).join('-')
    }

    const isIndividualAddress = (address) => {
        // Individual addresses have a suffix after the last dash
        return address.split('-').length > 2
    }

    const startEditing = (address) => {
        setEditingContact(address)
        setEditName(contacts[address] || '')
    }

    const saveContact = () => {
        if (editName.trim()) {
            contactStorage.setContact(editingContact, editName.trim())
            refreshContacts()
        }
        setEditingContact(null)
    }

    const deleteContact = (address) => {
        if (confirm(`Remove contact "${contacts[address]}"?`)) {
            contactStorage.deleteContact(address)
            refreshContacts()
        }
    }

    const copyToClipboard = async (address) => {
        try {
            await navigator.clipboard.writeText(address)
            alert('Address copied to clipboard!')
        } catch (error) {
            alert('Failed to copy address')
        }
    }

    const generateQRCode = async (address) => {
        try {
            const familyId = getFamilyAddress(address)
            const response = await fetch(`http://localhost:5000/wallet/${familyId}/qr/${address}`)
            const data = await response.json()
            
            const qrWindow = window.open('', '_blank', 'width=400,height=400')
            qrWindow.document.write(`
                <html>
                    <head><title>QR Code - ${contacts[address]}</title></head>
                    <body style="text-align:center; padding:20px;">
                        <h3>Contact QR Code</h3>
                        <p><strong>${contacts[address]}</strong></p>
                        <img src="${data.qr_code}" alt="QR Code" />
                        <p style="word-break:break-all; font-size:12px;">${address}</p>
                    </body>
                </html>
            `)
        } catch (error) {
            alert('Failed to generate QR code')
        }
    }

    // const messageContact = (address) => {
        // Navigate to messaging page with pre-selected recipient
        // const params = new URLSearchParams({ recipient: address })
        // router.push(`/wallet/${walletData.family_id}?page=messages&${params.toString()}`)
    // }
    const messageContact = (address) => {
        // Navigate to messaging page with recipient pre-filled
        router.push(`/wallet/${walletData.family_id}?page=messages&recipient=${address}`)
    }

    const viewMessages = (address) => {
        // Navigate to messages filtered by contact
        const params = new URLSearchParams({ contact: address })
        router.push(`/wallet/${walletData.family_id}?page=messages&${params.toString()}`)
    }

    const addNewContact = () => {
        if (!newAddress || !newName.trim()) {
            alert('Please enter both address and name')
            return
        }
        
        contactStorage.setContact(newAddress, newName.trim())
        setNewAddress('')
        setNewName('')
        setShowAddForm(false)
        refreshContacts()
        alert('Contact added!')
    }

    if (!privateKey) {
        return (
            <div className="page">
                <div className="unlock-prompt">
                    <h2>🔒 Wallet Locked</h2>
                    <p>Unlock your wallet to view and manage contacts</p>
                </div>
            </div>
        )
    }

    return (
        <div id="contacts-page" className="page">
            <div className="page-header">
                <h1 className="page-title">My Contacts ({Object.keys(contacts).length})</h1>
                <button 
                    className="btn"
                    onClick={() => setShowAddForm(!showAddForm)}
                >
                    {showAddForm ? 'Cancel' : '+ Add Contact'}
                </button>
            </div>

            {showAddForm && (
                <div className="card">
                    <div className="card-body">
                        <div className="form-group">
                            <label>Wallet Address:</label>
                            <input 
                                type="text"
                                value={newAddress}
                                onChange={(e) => setNewAddress(e.target.value)}
                                className="form-input"
                                placeholder="Paste wallet address"
                            />
                        </div>
                        <div className="form-group">
                            <label>Contact Name:</label>
                            <input 
                                type="text"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                className="form-input"
                                placeholder="Enter display name"
                            />
                        </div>
                        <button 
                            className="btn"
                            onClick={addNewContact}
                        >
                            Save Contact
                        </button>
                    </div>
                </div>
            )}

            <div className="contacts-controls">
                <div className="search-box">
                    <input 
                        type="text"
                        placeholder="Search contacts by name or address..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="search-input"
                    />
                    <span className="search-icon">🔍</span>
                </div>
            </div>

            <div className="card">
                <div className="card-body">
                    {filteredContacts.length === 0 ? (
                        <div className="empty-contacts">
                            {searchTerm ? (
                                <p>No contacts found matching &#34;{searchTerm}&#34;</p>
                            ) : (
                                <p>No contacts saved yet. Add names to addresses from the Members page.</p>
                            )}
                        </div>
                    ) : (
                        filteredContacts.map(([address, name]) => (
                            <div key={address} className="contact-item">
                                <div className="contact-avatar">
                                    {name.charAt(0).toUpperCase()}
                                </div>
                                
                                <div className="contact-info">
                                    {editingContact === address ? (
                                        <div className="contact-edit-form">
                                            <input 
                                                value={editName}
                                                onChange={(e) => setEditName(e.target.value)}
                                                className="contact-name-input"
                                                autoFocus
                                                onKeyPress={(e) => e.key === 'Enter' && saveContact()}
                                            />
                                            <div className="edit-actions">
                                                <button onClick={saveContact} className="btn-save">✅</button>
                                                <button onClick={() => setEditingContact(null)} className="btn-cancel">❌</button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="contact-name" onClick={() => startEditing(address)}>
                                                {name}
                                                <span className="edit-hint">✏️</span>
                                            </div>
                                            <div className="contact-address">{address}</div>
                                            <div className="contact-type">
                                                {isIndividualAddress(address) ? '👤 Individual' : '👨‍👩‍👧‍👦 Family'} • 
                                                {getMessageCount(address)} messages
                                            </div>
                                            <button 
                                                onClick={() => messageContact(address)}
                                                title="Send message to this contact"
                                            >💬 Message</button>
                                        </>
                                    )}
                                </div>

                                <div className="contact-actions">
                                    <button 
                                        className="btn-action message"
                                        onClick={() => messageContact(address)}
                                        title="Send message"
                                    >
                                        💬
                                    </button>
                                    
                                    <button 
                                        className="btn-action messages"
                                        onClick={() => viewMessages(address)}
                                        title="View message history"
                                    >
                                        📬 {getMessageCount(address) > 0 && <span className="message-badge">{getMessageCount(address)}</span>}
                                    </button>
                                    
                                    <button 
                                        className="btn-action qr"
                                        onClick={() => generateQRCode(address)}
                                        title="Generate QR code"
                                    >
                                        📇
                                    </button>
                                    
                                    <button 
                                        className="btn-action copy"
                                        onClick={() => copyToClipboard(address)}
                                        title="Copy address"
                                    >
                                        📋
                                    </button>
                                    
                                    <button 
                                        className="btn-action delete"
                                        onClick={() => deleteContact(address)}
                                        title="Delete contact"
                                    >
                                        🗑️
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}
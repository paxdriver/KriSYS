// components/WalletDashboard/MembersPage.js
import { useState } from "react"
import ContactName from "./ContactName"
import { contactStorage } from "../../services/contactStorage" // Add this import

export default function MembersPage({ walletData, transactions, privateKey }) {
    const isUnlocked = !!privateKey
    const [editingAddress, setEditingAddress] = useState(null)
    const [editName, setEditName] = useState('')

    const startEditing = (address) => {
        setEditingAddress(address)
        setEditName(contactStorage.getDisplayName(address) || '')
    }

    const saveContact = () => {
        if (editName.trim()) {
            contactStorage.setContact(editingAddress, editName.trim())
        }
        setEditingAddress(null)
        setEditName('')
    }

    const generateQRCode = async (address, familyId) => {
        try {
            const response = await fetch(`http://localhost:5000/wallet/${familyId}/qr/${address}`)
            const data = await response.json()
            
            const qrWindow = window.open('', '_blank', 'width=400,height=400')
            qrWindow.document.write(`
                <html>
                    <head><title>QR Code - ${address}</title></head>
                    <body style="text-align:center; padding:20px;">
                        <h3>Member QR Code</h3>
                        <img src="${data.qr_code}" alt="QR Code" />
                        <p style="word-break:break-all; font-size:12px;">${address}</p>
                    </body>
                </html>
            `)
        } catch (error) {
            alert('Failed to generate QR code')
        }
    }

    return (
        <div id="members-page" className="page">
            <div className="page-header">
                <h1 className="page-title">Family Members</h1>
                <div className="privacy-notice">
                    {isUnlocked ? (
                        <span>🔓 Names visible (wallet unlocked)</span>
                    ) : (
                        <span>🔒 Names hidden for privacy</span>
                    )}
                </div>
            </div>
            
            <div className="card">
                <div className="card-header">
                    <h3 className="card-title">Family Members ({walletData?.members?.length || 0})</h3>
                </div>
                <div className="card-body">
                    {walletData?.members?.map(member => (
                        <div key={member.address} className="member-item">
                            <div className="member-avatar">
                                {isUnlocked ? 
                                    (contactStorage.getDisplayName(member.address).charAt(0) || 'M') :
                                    'M'
                                }
                            </div>
                            
                            <div className="member-info">
                                {editingAddress === member.address ? (
                                    <div className="edit-form">
                                        <input 
                                            value={editName}
                                            onChange={(e) => setEditName(e.target.value)}
                                            className="form-input small"
                                            autoFocus
                                            onKeyPress={(e) => e.key === 'Enter' && saveContact()}
                                        />
                                        <div className="edit-actions">
                                            <button 
                                                onClick={saveContact}
                                                className="btn-icon save"
                                                title="Save contact"
                                            >
                                                ✅
                                            </button>
                                            <button 
                                                onClick={() => setEditingAddress(null)}
                                                className="btn-icon cancel"
                                                title="Cancel"
                                            >
                                                ❌
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div 
                                        className="member-name editable"
                                        onClick={() => isUnlocked && startEditing(member.address)}
                                        title={isUnlocked ? "Click to edit name" : "Unlock wallet to edit"}
                                    >
                                        <ContactName 
                                            address={member.address}
                                            isUnlocked={isUnlocked}
                                        />
                                        {isUnlocked && <span className="edit-hint">✏️</span>}
                                    </div>
                                )}
                            </div>
                            
                            <div className="member-actions">
                                <button 
                                    className="btn-icon" 
                                    title="Generate QR Code" 
                                    onClick={() => generateQRCode(member.address, walletData.family_id)}
                                >
                                    📇
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Contact Management */}
            {isUnlocked && (
                <ContactManagement />
            )}
        </div>
    )
}

// Simple contact management component
function ContactManagement() {
    const [contacts, setContacts] = useState(contactStorage.getContacts())
    
    const refreshContacts = () => {
        setContacts({...contactStorage.getContacts()})
    }

    return (
        <div className="card">
            <div className="card-header">
                <h3 className="card-title">📞 My Contacts ({Object.keys(contacts).length})</h3>
            </div>
            <div className="card-body">
                {Object.keys(contacts).length === 0 ? (
                    <p>No contacts saved. Click the edit icon next to addresses to add names.</p>
                ) : (
                    <div className="contact-list">
                        {Object.entries(contacts).map(([address, name]) => (
                            <div key={address} className="contact-item">
                                <ContactName 
                                    address={address}
                                    isUnlocked={true}
                                    editable={true}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
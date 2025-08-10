// components/WalletDashboard/MembersPage.js - CORRECTED VERSION
import { useState } from "react"
import { contactStorage } from "../../services/contactStorage"

export default function MembersPage({ walletData, transactions, privateKey }) {
    const isUnlocked = !!privateKey
    const [editingMember, setEditingMember] = useState(null)
    const [editName, setEditName] = useState('')

    const getDisplayName = (address) => {
        if (!isUnlocked) {
            return address // Show full address when locked
        }
        
        const savedName = contactStorage.getDisplayName(address)
        return savedName === address ? address : savedName // Return address if no name saved, otherwise return name
    }

    const hasCustomName = (address) => {
        if (!isUnlocked) return false
        return contactStorage.getContacts()[address] !== undefined
    }

    const startEditingMember = (member) => {
        setEditingMember(member.address)
        setEditName(hasCustomName(member.address) ? contactStorage.getDisplayName(member.address) : '')
    }

    const saveMemberName = () => {
        if (editName.trim()) {
            contactStorage.setContact(editingMember, editName.trim())
        } else {
            // If empty, remove the contact name
            contactStorage.deleteContact(editingMember)
        }
        setEditingMember(null)
        setEditName('')
    }

    const generateQRCode = async (address, familyId) => {
        try {
            const response = await fetch(`http://localhost:5000/wallet/${familyId}/qr/${address}`)
            const data = await response.json()
            
            const displayName = getDisplayName(address)
            const qrWindow = window.open('', '_blank', 'width=400,height=400')
            qrWindow.document.write(`
                <html>
                    <head><title>QR Code - ${displayName}</title></head>
                    <body style="text-align:center; padding:20px;">
                        <h3>Member QR Code</h3>
                        <p><strong>${displayName}</strong></p>
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
                        <span>🔓 Names visible - click to edit</span>
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
                                {hasCustomName(member.address) ? 
                                    contactStorage.getDisplayName(member.address).charAt(0).toUpperCase() :
                                    'M'
                                }
                            </div>
                            
                            <div className="member-info">
                                {editingMember === member.address ? (
                                    <div className="member-edit-form">
                                        <input 
                                            value={editName}
                                            onChange={(e) => setEditName(e.target.value)}
                                            className="member-name-input"
                                            placeholder="Enter member name"
                                            autoFocus
                                            onKeyPress={(e) => e.key === 'Enter' && saveMemberName()}
                                        />
                                        <div className="edit-actions">
                                            <button onClick={saveMemberName} className="btn-save">✅</button>
                                            <button onClick={() => setEditingMember(null)} className="btn-cancel">❌</button>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <div 
                                            className={`member-name ${isUnlocked ? 'editable' : ''}`}
                                            onClick={() => isUnlocked && startEditingMember(member)}
                                        >
                                            {getDisplayName(member.address)}
                                            {isUnlocked && <span className="edit-hint">✏️</span>}
                                        </div>
                                        <div className="member-address">
                                            {member.address}
                                        </div>
                                    </>
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
                                {isUnlocked && (
                                    <button 
                                        className="btn-icon"
                                        title="Copy address to clipboard"
                                        onClick={() => {
                                            navigator.clipboard.writeText(member.address)
                                            alert('Address copied to clipboard!')
                                        }}
                                    >
                                        📋
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    )
}
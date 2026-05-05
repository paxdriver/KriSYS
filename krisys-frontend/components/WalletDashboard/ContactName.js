// krisys-frontend/components/WalletDashboard/ContactName.js
'use client'
import { useMemo, useState } from 'react'
import { contactStorage } from '@/services/contactStorage'

export default function ContactName({
	address,
	isUnlocked,
	editable = false,
	className = '',
	crisisId = null,
	familyId = null,
}) {
	const [editing, setEditing] = useState(false)
	const [editName, setEditName] = useState('')
	const canUseContacts = !!isUnlocked && !!crisisId && !!familyId

	const displayName = useMemo(() => {
		if (!isUnlocked) return address
		if (!canUseContacts) return address

		return contactStorage.getDisplayName({ crisisId, familyId, address, })
	}, [address, canUseContacts, crisisId, familyId, isUnlocked])

	const isKnownContact = useMemo(() => {
		if (!canUseContacts) return false
		const contacts = contactStorage.getContacts({ crisisId, familyId })
		return !!contacts[address]
	}, [address, canUseContacts, crisisId, familyId])

	const startEditing = () => {
		if (!editable || !isUnlocked) return
		if (!canUseContacts) return

		setEditName(isKnownContact ? displayName : '')
		setEditing(true)
	}

	const saveContact = () => {
		if (!canUseContacts) return

		if (editName.trim()) {
			contactStorage.setContact({
				crisisId,
				familyId,
				address,
				name: editName.trim(),
			})
		}
		setEditing(false)
	}

	// Copy the raw wallet/member address, not the display name to send in a message to another user via krisys or email or whatever
	const copyAddress = async () => {
		try {
			await navigator.clipboard.writeText(address)
			alert('Address copied to clipboard')
		}
		catch {
			alert('Failed to copy address')
		}
	}

	if (!isUnlocked) return address

	if (editing && editable) {
		return (
			<span className="contact-edit">
				<input
					value={editName}
					onChange={(e) => setEditName(e.target.value)}
					placeholder="Enter name for this address"
					className="contact-input"
					autoFocus
					onKeyUp={(e) => e.key === 'Enter' && saveContact()}
				/>
				<button
					onClick={saveContact}
					className="btn-icon save"
					title="Save contact"
				>
					✅
				</button>
				
				<button
					onClick={copyAddress}
					className="btn-icon copy"
					title="Copy address"
					type="button"
				>
					📋
				</button>
			
				<button
					onClick={() => setEditing(false)}
					className="btn-icon cancel"
					title="Cancel"
				>
					❌
				</button>
			</span>
		)
	}

	return (
		<span
			className={`contact-name ${
				isKnownContact ? 'known' : 'unknown'
			} ${editable ? 'editable' : ''} ${className}`}
			onClick={editable ? startEditing : undefined}
			title={isKnownContact ? `Address: ${address}` : 'Click to add contact name'}
		>
			{displayName}
			{editable && isUnlocked && canUseContacts && (
				<span className="edit-hint">✏️</span>
			)}
		</span>
	)
}
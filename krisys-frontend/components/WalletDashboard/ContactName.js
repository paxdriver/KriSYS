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

	const deleteContact = () => {
		if (!canUseContacts) return

		if (confirm(`Remove contact name for ${address}?`)) {
			contactStorage.deleteContact({ crisisId, familyId, address })
			setEditing(false)
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
					onKeyPress={(e) => e.key === 'Enter' && saveContact()}
				/>
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
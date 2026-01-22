'use client'
import { useState } from 'react'
import { contactStorage } from '../../services/contactStorage'
import { showTextQr } from '@/utils/qr'
import { KeyManager } from '@/services/keyManager'
import { disasterStorage } from '@/services/localStorage'
import { createPublicKeyShareCode } from '@/services/walletPublicKeyShare'

export default function MembersPage({ walletData, transactions, privateKey }) {
	const isUnlocked = !!privateKey
	const [editingMember, setEditingMember] = useState(null)
	const [editName, setEditName] = useState('')

	const getDisplayName = (address) => {
		if (!isUnlocked) return address
		const savedName = contactStorage.getDisplayName(address)
		return savedName === address ? address : savedName
	}

	const hasCustomName = (address) => {
		if (!isUnlocked) return false
		return contactStorage.getContacts()[address] !== undefined
	}

	const startEditingMember = (member) => {
		setEditingMember(member.address)
		setEditName(
			hasCustomName(member.address)
				? contactStorage.getDisplayName(member.address)
				: ''
		)
	}

	const saveMemberName = () => {
		if (editName.trim()) {
			contactStorage.setContact(editingMember, editName.trim())
		} else {
			contactStorage.deleteContact(editingMember)
		}
		setEditingMember(null)
		setEditName('')
	}

	const generateMemberAddressQr = async (address) => {
		const displayName = getDisplayName(address)

		await showTextQr({
			text: address,
			displayName,
			title: 'Member Address',
			heading: 'Member Address (Share to connect)',
		})
	}

	const showFamilyPublicKey = async () => {
		const familyId = walletData?.family_id
		if (!familyId) return

		try {
			const publicKeyArmored = await KeyManager.getPublicKey(familyId)
			const crisisId = disasterStorage.getCrisisMetadata()?.id || null

			const code = createPublicKeyShareCode({
				familyId,
				publicKeyArmored,
				crisisId,
			})

			await showTextQr({
				text: code,
				displayName: 'Family Wallet Public Key',
				title: 'Family Public Key',
				heading: 'Family Public Key (Share for offline messaging)',
				qrOptions: {
					errorCorrectionLevel: 'L',
					scale: 6,
				},
			})
		} catch (e) {
			alert(
				`Could not load public key.\n\n` +
					`Error: ${e?.message || String(e)}`
			)
		}
	}

	return (
		<div id="members-page" className="page">
			<div className="page-header">
				<h1 className="page-title">Family Members</h1>

				<div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
					<button className="btn" onClick={showFamilyPublicKey} disabled={!isUnlocked}>
						Family Public Key
					</button>

					<div className="privacy-notice">
						{isUnlocked ? (
							<span>Names visible - click to edit</span>
						) : (
							<span>Names hidden for privacy</span>
						)}
					</div>
				</div>
			</div>

			<div className="card">
				<div className="card-header">
					<h3 className="card-title">
						Family Members ({walletData?.members?.length || 0})
					</h3>
				</div>
				<div className="card-body">
					{walletData?.members?.map((member) => (
						<div key={member.address} className="member-item">
							<div className="member-avatar">
								{hasCustomName(member.address)
									? contactStorage
											.getDisplayName(member.address)
											.charAt(0)
											.toUpperCase()
									: 'M'}
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
											onKeyPress={(e) =>
												e.key === 'Enter' && saveMemberName()
											}
										/>
										<div className="edit-actions">
											<button onClick={saveMemberName} className="btn-save">
												✅
											</button>
											<button
												onClick={() => setEditingMember(null)}
												className="btn-cancel"
											>
												❌
											</button>
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
										<div className="member-address">{member.address}</div>
									</>
								)}
							</div>

							<div className="member-actions">
								{isUnlocked && (
									<>
										<button
											className="btn-icon"
											title="Show address QR + text"
											onClick={() => generateMemberAddressQr(member.address)}
										>
											📇
										</button>

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
									</>
								)}
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	)
}
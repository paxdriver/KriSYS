// components/WalletDashboard/Overview.js
'use client'
import RecentActivity from './RecentActivity'
import MembersOverview from './MembersOverview'
import { showAddressQr, showTextQr } from '../../utils/qr'
import { KeyManager } from '@/services/keyManager'
import { disasterStorage } from '@/services/localStorage'
import { createPublicKeyShareCode } from '@/services/walletPublicKeyShare'

export default function Overview({ walletData, transactions, onRefresh }) {
	const handleShowFamilyQr = () => {
		if (!walletData?.family_id) return
		showAddressQr({
			familyId: walletData.family_id,
			address: walletData.family_id,
			displayName: 'Family Wallet',
			title: 'Family Wallet QR Code',
			heading: 'Family Wallet QR Code',
		})
	}

	const handleShowFamilyPublicKey = async () => {
		const familyId = walletData?.family_id
		const crisisId = disasterStorage.getCrisisMetadata()?.id || null
		if (!familyId || !crisisId) return

		try {
			// Prefer local cache; fetch from server only if needed and online.
			const publicKeyArmored = await KeyManager.getPublicKey({crisisId, familyId})

			const code = createPublicKeyShareCode({
				familyId,
				publicKeyArmored,
				crisisId,
			})

			// Public keys can be large; use low error correction to fit more data.
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
		} 
		catch (e) {
			alert(`Could not load public key.\n\n` +
				`If you have never been online with this wallet on this device, ` +
				`the public key may not be cached yet.\n\n` +
				`Error: ${e?.message || String(e)}`)
		}
	}

	return (
		<div id="overview-page" className="page">
			<div className="page-header">
				<h1 className="page-title">Family Overview</h1>

				<div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
					<button className="btn" onClick={handleShowFamilyQr}>
						<span>Family QR</span>
					</button>

					<button className="btn" onClick={handleShowFamilyPublicKey}>
						<span>Family Public Key</span>
					</button>

					<button className="btn"
						onClick={() => { if (typeof onRefresh === 'function') onRefresh() }}
					>
						<span>Refresh</span>
					</button>
				</div>
			</div>

			<div className="card-grid">
				<div className="card">
					<div className="card-header">
						<h3 className="card-title">Family Members</h3>
					</div>
					<div className="card-body">
						<MembersOverview members={walletData?.members || []} />
					</div>
				</div>

				<div className="card">
					<div className="card-header">
						<h3 className="card-title">Recent Activity</h3>
					</div>
					<div className="card-body">
						<RecentActivity
							transactions={transactions}
							walletData={walletData}
							limit={5}
						/>
					</div>
				</div>
			</div>

			<div className="card">
				<div className="card-header">
					<h3 className="card-title">All Notifications</h3>
				</div>
				<div className="card-body">
					<RecentActivity transactions={transactions} walletData={walletData} />
				</div>
			</div>
		</div>
	)
}
// components/WalletDashboard/RecentActivity.js
'use client'
import TransactionItem from './TransactionItem'

export default function RecentActivity({ transactions, walletData, limit }) {
	if (!transactions || transactions.length === 0) {
		return <p>No recent activity</p>
	}

	// Filter and sort transactions
	const memberAddresses = walletData?.members?.map(m => m.address) || []
	const familyId = walletData?.family_id

	const relevantTxs = transactions.filter(tx => {
		if (tx.type_field === 'alert') return true

		if (Array.isArray(tx.related_addresses)) {
			// Individual-scoped
			if (memberAddresses.some(addr => tx.related_addresses.includes(addr))) {
				return true
			}

			// Family-scoped
			if (familyId && tx.related_addresses.includes(familyId)) {
				return true
			}
		}

		return false
	})

	const sortedTxs = relevantTxs
		.sort((a, b) => b.timestamp_posted - a.timestamp_posted)
		.slice(0, limit)

	return (
		<div>
			{sortedTxs.map(tx => (
				<TransactionItem
					key={tx.transaction_id}
					transaction={tx}
					walletData={walletData}
				/>
			))}
		</div>
	)
}
// components/WalletDashboard/RecentActivity.js
import TransactionItem from './TransactionItem'

export default function RecentActivity({ transactions, walletData, limit }) {
  if (!transactions || transactions.length === 0) {
    return <p>No recent activity</p>
  }
  
  // Filter and sort transactions
  const memberAddresses = walletData?.members?.map(m => m.address) || []
  const relevantTxs = transactions.filter(tx => 
    tx.type_field === 'alert' || 
    memberAddresses.some(addr => tx.related_addresses?.includes(addr))
  )
  
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
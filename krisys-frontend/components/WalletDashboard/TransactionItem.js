// components/WalletDashboard/TransactionItem.js
export default function TransactionItem({ transaction, walletData }) {
  const formatDateTime = (timestamp) => {
    return new Date(timestamp * 1000).toLocaleString()
  }
  
  // Handle message decryption status
  let lockIcon = '🔒'
  let messageContent = transaction.message_data
  
  if (transaction.type_field === 'message') {
    if (transaction.decrypted_message) {
      messageContent = transaction.decrypted_message
      lockIcon = '🔓'
    } else if (transaction.decryption_error) {
      messageContent = "🔒 Error decrypting message"
      lockIcon = '❌'
    } else {
      lockIcon = '🔒'
    }
  }
  
  return (
    <div className="transaction">
      <div className="tx-header">
        <span className="tx-type">{transaction.type_field}</span>
        <span className="tx-lock">{lockIcon}</span>
        <span className="tx-time">{formatDateTime(transaction.timestamp_posted)}</span>
      </div>
      
      <div className="tx-message">{messageContent}</div>
    </div>
  )
}
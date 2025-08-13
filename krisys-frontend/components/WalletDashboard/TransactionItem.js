// components/WalletDashboard/TransactionItem.js
'use client'
import MessageDisplay from './MessageDisplay'
import ContactName from './ContactName'

export default function TransactionItem({ transaction, privateKey, familyId }) {
    return (
        <div className="message-item">  {/* Changed from "transaction" */}
            <div className="message-header">  {/* Changed from "tx-header" */}
                <span className="message-from">
                    From: <ContactName 
                        address={transaction.station_address}
                        isUnlocked={!!privateKey}
                        editable={true}
                    />
                </span>
                <span className="message-time">
                    {new Date(transaction.timestamp_posted * 1000).toLocaleString()}
                </span>
            </div>
        
            {transaction.type_field === 'message' ? (
                <MessageDisplay 
                    message={transaction.message_data}
                    privateKey={privateKey}
                    family_id={familyId}
                />
            ) : (
                <div className="tx-message">
                    {transaction.message_data}
                </div>
            )}
        </div>
    )
}
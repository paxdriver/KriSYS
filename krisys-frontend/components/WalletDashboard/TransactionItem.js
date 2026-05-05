// components/WalletDashboard/TransactionItem.js
'use client'
import MessageDisplay from './MessageDisplay'
import ContactName from './ContactName'

export default function TransactionItem({ transaction, privateKey, familyId, crisisId, isConfirmed=true, onReply }) {
	const itemClass = `message-item ${isConfirmed ? 'confirmed' : 'unconfirmed'}`  // checking block signature to see if message is canonical on chain, signed by the server, or a message relayed from another user


	return (
		<div className={itemClass}>
			<div className="message-header">
				<span className="message-from">
					From:{' '}
					<ContactName
						address={transaction.station_address}
						isUnlocked={!!privateKey}
						editable={true}
						crisisId={crisisId}
						familyId={familyId}
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
					isConfirmed={isConfirmed}
				/>
			) : (
				<div className="tx-message">
					{transaction.message_data}
				</div>
			)}

			{/* REPLY TO MESSAGE */}
			{transaction.station_address && typeof onReply === 'function' && (
				<div style={{ marginTop: '8px' }}>
					<button
						type="button"
						className="btn"
						onClick={() => onReply(transaction.station_address)}
					>
						Reply
					</button>
				</div>
			)}
		</div>
	)
}
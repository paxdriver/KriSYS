// components/BlockchainExplorer/BlockList.js
import React from "react"

export default function BlockList({ blocks, loading }) {
  if (loading) {
    return <div>Loading blockchain...</div>
  }

  return (
    <div>
        <h2>Latest Blocks</h2>
            <div id="blocks-container">
            {blocks.map(block => (
                <div key={block.block_index} className="block">
                    <h3>Block #{block.block_index}</h3>
                    <p><strong>Timestamp:</strong> {new Date(block.timestamp * 1000).toLocaleString()}</p>
                    <p><strong>Hash:</strong> <code>{block.hash}</code></p>
                    <p><strong>Transactions:</strong> {block.transactions.length}</p>
                    
                    {block.transactions.map(tx => (
                        <div key={tx.transaction_id} className="transaction">
                        <strong>TX ID:</strong> {tx.transaction_id}<br/>
                        <strong>From:</strong> {tx.station_address}<br/>
                        <strong>Type:</strong> {tx.type_field}<br/>
                        <strong>Message:</strong> {tx.message_data}
                        </div>
                    ))}
                </div>
            ))}
        </div>
    </div>
  )
}
// app/page.js
'use client'
import { useState, useEffect } from 'react'
import { api } from '../services/api'
import BlockList from '../components/BlockchainExplorer/BlockList'
import WalletCreator from '../components/BlockchainExplorer/WalletCreator'
import '../styles/blockchain.css'

export default function BlockchainExplorer() {
  const [blocks, setBlocks] = useState([])
  const [loading, setLoading] = useState(true)
  const [wallet, setWallet] = useState(null)

  const loadBlockchain = async () => {
    try {
      setLoading(true)
      const response = await api.getBlockchain()
      setBlocks(response.data)
    } catch (error) {
      console.error('Error loading blockchain:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadBlockchain();
    const interval = setInterval(loadBlockchain, 30000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div>
      <h1>KriSYS Blockchain Explorer</h1>
      
      <BlockList blocks={blocks} loading={loading} />
      
      <WalletCreator onWalletCreated={setWallet} />
      
      {wallet && (
        <div id="wallet-display">
          <h3>Your Family Wallet</h3>
          <p><strong>Family ID:</strong> {wallet.family_id}</p>
          <div id="member-qrs">
            {wallet.members.map(member => (
              <div key={member.address} className="qr-card">
                <p><strong>{member.name}</strong></p>
                <p style={{fontSize: '0.8em', wordBreak: 'break-all'}}>
                  {member.address}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
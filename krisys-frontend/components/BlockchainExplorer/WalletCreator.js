// components/BlockchainExplorer/WalletCreator.js
import { useState } from 'react'
import { api } from '../../services/api'

export default function WalletCreator({ onWalletCreated }) {
  const [numMembers, setNumMembers] = useState(3)
  const [creating, setCreating] = useState(false)

  const createWallet = async () => {
    try {
      setCreating(true)
      const response = await api.createWallet(numMembers)
      
      if (response.data.error) {
        alert(`Error: ${response.data.error}`)
        return
      }
      
      onWalletCreated(response.data)
    } catch (error) {
      console.error('Wallet creation error:', error)
      alert('Failed to create wallet')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div id="wallet-section">
      <h2>Family Wallet Management</h2>
      <div id="wallet-controls">
        <div>
          <label htmlFor="num-members">Number of family members:</label>
          <input 
            type="number" 
            id="num-members" 
            min="1" 
            max="20" 
            value={numMembers}
            onChange={(e) => setNumMembers(e.target.value)}
          />
          <button onClick={createWallet} disabled={creating}>
            {creating ? 'Creating...' : 'Create New Family Wallet'}
          </button>
        </div>
      </div>
    </div>
  )
}
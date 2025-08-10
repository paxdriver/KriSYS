// app/wallet/[familyId]/page.js
'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { api } from '../../../services/api'
import WalletDashboard from '../../../components/WalletDashboard'
import '../../../styles/wallet_dashboard.css'

export default function WalletDashboardPage() {
  const params = useParams()
  const familyId = params.familyId
  
  const [walletData, setWalletData] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)

  const loadWalletData = useCallback (async () => {
    try {
        setLoading(true)
        
        // Load wallet info
        const walletResponse = await api.getWallet(familyId)
        setWalletData(walletResponse.data)
        
        // Load transactions
        const txResponse = await api.getWalletTransactions(familyId)
        setTransactions(txResponse.data)
      
    } 
    catch (error) {
        console.error('Error loading wallet data:', error)
    } 
    finally {
        setLoading(false)
    }
  }, [familyId])

  useEffect(() => {
    if (familyId) {
      loadWalletData()
    }
  }, [familyId])

  if (loading) {
    return <div>Loading wallet...</div>
  }

  if (!walletData) {
    return <div>Wallet not found</div>
  }

  return (
    <WalletDashboard 
      walletData={walletData}
      transactions={transactions}
      familyId={familyId}
      onRefresh={loadWalletData}
    />
  )
}
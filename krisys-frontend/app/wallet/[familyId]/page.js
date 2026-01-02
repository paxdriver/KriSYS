// app/wallet/[familyId]/page.js
'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { api } from '../../../services/api'
import { disasterStorage } from '../../../services/localStorage'
import WalletDashboard from '../../../components/WalletDashboard'
import '../../../styles/wallet_dashboard.css'

export default function WalletDashboardPage() {
  const params = useParams()
  const familyId = params.familyId

  const [walletData, setWalletData] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)

  const loadWalletData = useCallback(async () => {
    setLoading(true)

    try {
      // --- ONLINE PATH: fetch from backend ---
      // Load wallet info
      const walletResponse = await api.getWallet(familyId)
      const wallet = walletResponse.data
      setWalletData(wallet)

      // Cache wallet metadata for offline use
      disasterStorage.saveWalletData(familyId, wallet)

      // Load transactions from backend
      const txResponse = await api.getWalletTransactions(familyId)
      const txs = txResponse.data || []
      setTransactions(txs)

      // Update local confirmed-relay list and prune queue of offline messages
      disasterStorage.syncConfirmedFromTransactions(txs)
    } 
    catch (error) {
      console.error('Error loading wallet data (online path failed):', error)

      // --- OFFLINE / ERROR FALLBACK ---
      // 1) Try cached wallet metadata
      const cachedWallet = disasterStorage.getWalletData(familyId)
      if (!cachedWallet) {
        console.warn(
          'No cached wallet data available for offline access'
        )
        setWalletData(null)
        setTransactions([])
        return
      }

      console.log(
        'Using cached wallet data from localStorage for offline access'
      )
      setWalletData(cachedWallet)

      // 2) Derive wallet-related transactions from cached blockchain
      const cachedBlocks = disasterStorage.getBlockchain() || []
      const memberAddresses =
        cachedWallet.members?.map((m) => m.address) || []

      const derivedTxs = []
      for (const block of cachedBlocks) {
        const txList = block.transactions || []
        for (const tx of txList) {
          const fromMe =
            tx.station_address &&
            memberAddresses.includes(tx.station_address)
          const toMe =
            Array.isArray(tx.related_addresses) &&
            tx.related_addresses.some((addr) =>
              memberAddresses.includes(addr)
            )

          if (fromMe || toMe) {
            derivedTxs.push(tx)
          }
        }
      }

      console.log(
        `Derived ${derivedTxs.length} wallet transactions from cached blockchain`
      )
      setTransactions(derivedTxs)

      // Even offline, we can update relay confirmations based on cached blocks
      disasterStorage.syncConfirmedFromTransactions(derivedTxs)
    } finally {
      setLoading(false)
    }
  }, [familyId])

  useEffect(() => {
    loadWalletData()
  }, [loadWalletData])

  if (loading) {
    return <div className="loading-page">Loading wallet data...</div>
  }

  if (!walletData) {
    return (
      <div className="error-page">
        Wallet not found (and no cached data available)
      </div>
    )
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
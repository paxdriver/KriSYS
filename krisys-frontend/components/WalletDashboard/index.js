// components/WalletDashboard/index.js
import { useState } from 'react'
import Sidebar from './Sidebar'
import Overview from './Overview'
import MembersPage from './MembersPage'
import UnlockForm from './UnlockForm'

export default function WalletDashboard({ walletData, transactions, familyId, onRefresh }) {
  const [currentPage, setCurrentPage] = useState('overview')
  const [isUnlocked, setIsUnlocked] = useState(false)

  return (
    <div className="dashboard-container">
      <Sidebar 
        walletData={walletData}
        currentPage={currentPage}
        onPageChange={setCurrentPage}
      />
      
      <main className="main-content">
        {!isUnlocked && (
          <UnlockForm 
            familyId={familyId}
            onUnlock={() => setIsUnlocked(true)}
          />
        )}
        
        {currentPage === 'overview' && (
          <Overview 
            walletData={walletData}
            transactions={transactions}
            onRefresh={onRefresh}
          />
        )}
        
        {currentPage === 'members' && (
          <MembersPage 
            walletData={walletData}
            transactions={transactions}
          />
        )}
        
        {/* Add other pages as needed */}
      </main>
    </div>
  )
}
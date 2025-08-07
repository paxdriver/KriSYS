// components/WalletDashboard/index.js
import { useState } from 'react'
import Sidebar from './Sidebar'
import Overview from './Overview'
import MembersPage from './MembersPage'
import UnlockForm from './UnlockForm'
import MessagingPage from './MessagingPage'
import DevTools from '../DevTools'


export default function WalletDashboard({ walletData, transactions, familyId, onRefresh }) {
    const [currentPage, setCurrentPage] = useState('overview')
    const [privateKey, setPrivateKey] = useState(null)
    const [isUnlocked, setIsUnlocked] = useState(false)

    const handleUnlock = key => {
        setPrivateKey(key)
        setIsUnlocked(true)
    }


    return (<>
            {/* DEV TOOLS ONLY, NOT FOR PROD */}
            {process.env.NODE_ENV === 'development' && (
                <DevTools onRefresh={onRefresh} />
            )}
    
        <div className="dashboard-container">
            <Sidebar 
                walletData={walletData}
                currentPage={currentPage}
                onPageChange={setCurrentPage}
            />
            
            <main className="main-content">
                {!privateKey ? (
                    <UnlockForm 
                        familyId={familyId}
                        onUnlock={handleUnlock}
                    />) : (<>
                    
                    <div className="unlock-status">🔓 Wallet unlocked</div>
                        {currentPage === 'overview' && (
                            <Overview 
                                walletData={walletData}
                                transactions={transactions}
                                privateKey={privateKey} // Pass to child components
                            />
                        )}
                                
                        {currentPage === 'members' && (
                            <MembersPage 
                                walletData={walletData}
                                transactions={transactions}
                            />
                        )}

                        {currentPage === 'messages' && (
                            <MessagingPage 
                                walletData={walletData}
                                transactions={transactions}
                                privateKey={privateKey}
                            />
                        )}
                    
                    {/* other pages */}
                    
                    </>)
                }
            </main>
        </div>
    </>)
}
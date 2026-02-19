// components/WalletDashboard/index.js
'use client'
import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { disasterStorage } from '@/services/localStorage'
import Sidebar from './Sidebar'
import Overview from './Overview'
import MembersPage from './MembersPage'
import ContactsPage from './ContactPage'
import MessagingPage from './MessagingPage'
import ConnectionsPage from './ConnectionsPage'
import UserSettings from './UserSettings'
import UnlockForm from './UnlockForm'
import '../../styles/wallet_dashboard.css'
import DevTools from '../DevTools'  // DEV NOTE: DEVELOPMENT ONLY

export default function WalletDashboard({ walletData, transactions = [], familyId, onRefresh }) {
    const [currentPage, setCurrentPage] = useState('overview')
    const [privateKey, setPrivateKey] = useState(null)
    const [isUnlocked, setIsUnlocked] = useState(false) 
    const searchParams = useSearchParams()
    const safeTransactions = Array.isArray(transactions) ? transactions : [] // used to prevent runtime error in components receiving transactions as props

    const crisisId = disasterStorage.getCrisisMetadata()?.id || null    

    useEffect(() => {
        if (!crisisId || !familyId) return
        const key = disasterStorage.getCachedPrivateKey({ crisisId, familyId })
        // Attempt session rehydration on refresh to keep wallet unlocked
        if (key && !privateKey) setPrivateKey(key)
        if (!key) {
            disasterStorage.clearSession()
        }
    }, [crisisId, familyId, privateKey])

    // Listen for URL changes from any component Page and update currentPage to perform the route
    useEffect(() => {
        const urlPage = searchParams.get('page')

        // SEND MESSAGE BUTTON FROM OUTSIDE OF THE MESSAGE PAGE (ie: quick launch from contacts list)
        if (urlPage && urlPage === 'messages') {
            // url will look like this:
                // http://localhost:3000/wallet/851c525350bc2a4c47ec7a54?page=messages&recipient=3e591eb7e9cf56dea7a9f11c, 
            // ... having both recipient address and message
            setCurrentPage(urlPage)
        }
    }, [searchParams])

    useEffect(() => {
        if (privateKey) setIsUnlocked(true)
        else setIsUnlocked(false)
    }, [privateKey])

    const handleUnlock = key => setPrivateKey(key)
    const handleLockWallet = () => {
        const crisisId = disasterStorage.getCrisisMetadata()?.id || null
        if (!crisisId || !familyId) return

        // Remove private key from session storage
        disasterStorage.clearSession() 

        // Remove sealed private key blob (prevents offline unlock later)
	    disasterStorage.deleteSealedPrivateKey({ crisisId, familyId })
        
        // Clear in-memory key from client
        setPrivateKey(null)
        
        // UX feedback
        alert('Wallet locked')
    }

    return (<>
            {/* DEV TOOLS ONLY, NOT FOR PROD */}
            {process.env.NODE_ENV === 'development' && (
                <DevTools onRefresh={onRefresh} familyId={familyId}/>
            )}
    <br />
    <br />
        <div className="dashboard-container">
            <Sidebar 
                walletData={walletData}
                currentPage={currentPage}
                onPageChange={setCurrentPage}
            />
            
            <main className="main-content">
                {!isUnlocked ? (    // <--- HERE change to isUnlocked and make isUnlocked check privateKey and set itself so that we can check for session storage if the page refreshes to keep us in the wallet dashboard?
                    <UnlockForm 
                        familyId={familyId}
                        onUnlock={handleUnlock}
                    />) : (<>
                        <div className="unlock-controls">
                            <button
                                className="btn danger"
                                onClick={handleLockWallet}
                                title="Lock wallet and clear session key"
                            >
                                🔒 Lock Wallet
                            </button>
                        </div>
                    
                    <div className="unlock-status">🔓 Wallet unlocked</div>
                        {currentPage === 'overview' && (
                            <Overview 
                                walletData={walletData}
                                transactions={safeTransactions}
                                privateKey={privateKey} // Pass to child components
                            />
                        )}
                                
                        {currentPage === 'members' && (
                            <MembersPage 
                                walletData={walletData}
                                transactions={safeTransactions}
                                privateKey={privateKey}
                            />
                        )}

                        {currentPage === 'messages' && (
                            <MessagingPage 
                                walletData={walletData}
                                transactions={safeTransactions}
                                privateKey={privateKey}
                            />
                        )}

                        {currentPage === 'contacts' && (
                            <ContactsPage 
                                walletData={walletData}
                                transactions={safeTransactions}
                                privateKey={privateKey}
                            />
                        )}
                    
                        {currentPage === 'connections' && (
                            <ConnectionsPage onRefresh={onRefresh} walletData={walletData} />
                        )}

                        {currentPage === 'settings' && <UserSettings />}
                    
                    </>)
                }
            </main>
        </div>
    </>)
}
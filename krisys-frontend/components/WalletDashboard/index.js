// components/WalletDashboard/index.js
'use client'
import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import Sidebar from './Sidebar'
import Overview from './Overview'
import MembersPage from './MembersPage'
import ContactsPage from './ContactPage'
import UnlockForm from './UnlockForm'
import MessagingPage from './MessagingPage'
import DevTools from '../DevTools'
import '../../styles/wallet_dashboard.css'


export default function WalletDashboard({ walletData, transactions, familyId, onRefresh }) {
    const [currentPage, setCurrentPage] = useState('overview')
    const [privateKey, setPrivateKey] = useState(null)
    const [isUnlocked, setIsUnlocked] = useState(false) 
    const searchParams = useSearchParams()


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
        if (privateKey) {
            setIsUnlocked(true)
        } else {
            setIsUnlocked(false)
        }
    }, [privateKey])

    const handleUnlock = key => {
        setPrivateKey(key)
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
                                privateKey={privateKey}
                            />
                        )}

                        {currentPage === 'messages' && (
                            <MessagingPage 
                                walletData={walletData}
                                transactions={transactions}
                                privateKey={privateKey}
                            />
                        )}

                        {currentPage === 'contacts' && (
                            <ContactsPage 
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
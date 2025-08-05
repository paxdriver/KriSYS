import { useState } from "react"

// hooks/useWallet
const useWallet = (walletData, txs, familyId) => {

    const [wallet, setWallet] = useState(null)
    const [isUnlocked, setIsUnlocked] = useState(false)

    console.log("RenderWalletData function")
    console.log(walletData)
    console.log(txs)
    console.log(familyId)

    // TEMPORARY DEBUG OUTPUT   
    const debugOutput = document.getElementById('debug-output')
    debugOutput.textContent = JSON.stringify({
        wallet: walletData,
        transactions: txs
    }, null, 2)
    
    // Update wallet ID display
    if (walletData.family_id) {
        document.getElementById('wallet-id-display').textContent = walletData.family_id
    }
    
    // Render members overview
    if (walletData.members) {
        renderMembersOverview(walletData.members)
    }
    
    // Render members list
    if (walletData.members) {
        renderMembersList(walletData.members)
    }
    
    // Render recent activity
    if (txs) {
        renderRecentActivity(txs)
    }
    
    // Show unlock form if wallet is locked
    if (walletData && !walletData.private_key) {
        document.getElementById('unlock-form').style.display = 'block'
    }

    // DEV NOTE: DEBUGGING
    renderDebugInfo(walletData, txs)
}
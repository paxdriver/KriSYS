import { useState } from "react"
import { api } from "@/services/api"
import { disasterStorage } from "@/services/localStorage"
import './devtools.css'


export default function DevTools({ onRefresh }) {
    const [mining, setMining] = useState(false)
    const [isOnline, setIsOnline] = useState(true)
    const [queuedMessages, setQueuedMessages] = useState(0)

    // Update queued message count
    useState(() => {
        const queue = disasterStorage.getMessageQueue()
        setQueuedMessages(queue.filter(msg => msg.status === 'pending').length)
    }, [])

    const mineBlock = async () => {
        setMining(true)
        try {
            await api.adminMine()
            alert('✅ Block mined!')
            if (onRefresh) onRefresh()
        } catch (error) {
            alert(`❌ Mining failed: ${error.message}`)
        } finally {
            setMining(false)
        }
    }

    const toggleNetworkStatus = () => {
        setIsOnline(!isOnline)
        // You can use this state to disable network calls
        window.KRISYS_OFFLINE_MODE = !isOnline
        alert(isOnline ? '📱 Simulating OFFLINE mode' : '📡 Simulating ONLINE mode')
    }

    const processQueue = async () => {
        const queue = disasterStorage.getMessageQueue()
        const pending = queue.filter(msg => msg.status === 'pending')
        
        if (pending.length === 0) {
            alert('📭 No messages in queue')
            return
        }

        try {
            for (const msg of pending) {
                await api.addTransaction(msg)
                msg.status = 'sent'
                msg.sentAt = Date.now()
            }
            
            // Update queue in storage
            localStorage.setItem('krisys_message_queue', JSON.stringify(queue))
            setQueuedMessages(0)
            alert(`📤 Sent ${pending.length} queued messages!`)
            
        } catch (error) {
            alert(`❌ Failed to send queue: ${error.message}`)
        }
    }

    const clearStorage = () => {
        if (confirm('🗑️ Clear all local storage? This will log you out.')) {
            disasterStorage.clearAll()
            window.location.reload()
        }
    }

    return (
        <div className="dev-tools">
            <div className="dev-tools-inner">
                <span className="dev-label">🔧 DEV TOOLS</span>
                
                <button 
                    className="dev-btn" 
                    onClick={mineBlock}
                    disabled={mining}
                    title="Force mine pending transactions"
                >
                    {mining ? '⏳' : '⛏️'} Mine Block
                </button>

                <button 
                    className="dev-btn"
                    onClick={onRefresh}
                    title="Refresh all data"
                >
                    🔄 Refresh
                </button>

                <button 
                    className={`dev-btn ${isOnline ? 'online' : 'offline'}`}
                    onClick={toggleNetworkStatus}
                    title="Toggle online/offline simulation"
                >
                    {isOnline ? '📡 Online' : '📱 Offline'}
                </button>

                <button 
                    className="dev-btn"
                    onClick={processQueue}
                    disabled={queuedMessages === 0}
                    title="Send all queued messages"
                >
                    📤 Queue ({queuedMessages})
                </button>

                <button 
                    className="dev-btn danger"
                    onClick={clearStorage}
                    title="Clear all local data"
                >
                    🗑️ Clear Storage
                </button>
            </div>
        </div>
    )
}
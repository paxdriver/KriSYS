// components/DevTools/index.js
'use client'
import { useState, useEffect } from 'react'
import { api } from '@/services/api'
import { syncWithMeshHost } from '@/services/meshSync'
import { disasterStorage } from '@/services/localStorage'
import { KeyManager } from '@/services/keyManager'
import './devtools.css'

// Station URL for mesh sync and flush (local station backend)
const STATION_URL = process.env.NEXT_PUBLIC_STATION_URL || 'http://localhost:6001'

// Relay/Pool URL for dumb rendezvous cache sync (untrusted relay backend)
const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL || 'http://localhost:6002'

export default function DevTools({ onRefresh }) {
    const [mining, setMining] = useState(false)
    const [isOnline, setIsOnline] = useState(true)
    const [queuedMessages, setQueuedMessages] = useState(0)
    const [rateLimitOverride, setRateLimitOverride] = useState(false)
    const [meshInfo, setMeshInfo] = useState(null)
    
    const [syncingStation, setSyncingStation] = useState(false)
    const [flushingStation, setFlushingStation] = useState(false)

    const [syncingRelay, setSyncingRelay] = useState(false)

    const [p2pStatus, setP2pStatus] = useState(null)    // p2p connection visual indicator
    useEffect(() => {
		const onP2P = (evt) => {
			setP2pStatus(evt?.detail || null)
		}

		window.addEventListener('krisys:p2p_status', onP2P)

		// Initialize from global if present
		if (window.KRISYS_P2P_STATUS) {
			setP2pStatus(window.KRISYS_P2P_STATUS)
		}

		return () => {
			window.removeEventListener('krisys:p2p_status', onP2P)
		}
	}, [])


    // Update queued message count periodically
    useEffect(() => {
        const updateQueueCount = () => {
            const queue = disasterStorage.getMessageQueue()
            setQueuedMessages(queue.filter((msg) => msg.status === 'pending').length)
        }

        updateQueueCount()
        const interval = setInterval(updateQueueCount, 2000)
        return () => clearInterval(interval)
    }, [])

    // Check for existing rate limit override setting
    useEffect(() => {
        const override =
            localStorage.getItem('dev_rate_limit_override') === 'true'
        setRateLimitOverride(override)
    }, [])

    // Periodically derive mesh/offline status from local storage
    useEffect(() => {
        const updateMeshInfo = () => {
            try {
                const crisis = disasterStorage.getCrisisMetadata()
                const blocks = disasterStorage.getBlockchain() || []
                const blockCount = Array.isArray(blocks)
                    ? blocks.length
                    : 0

                let firstIndex = null
                let lastIndex = null
                if (blockCount > 0) {
                    firstIndex = blocks[0].block_index
                    lastIndex =
                        blocks[blockCount - 1].block_index
                }

                const hasPrivateKey =
                    !!localStorage.getItem('krisys_private_key')

                setMeshInfo({
                    crisisId: crisis?.id || null,
                    hasBlockKey: !!crisis?.block_public_key,
                    blockCount,
                    firstIndex,
                    lastIndex,
                    hasPrivateKey
                })
            }   
            catch (e) { console.error('Failed to derive mesh status:', e) }
        }

        updateMeshInfo()
        const interval = setInterval(updateMeshInfo, 3000)
        return () => clearInterval(interval)
    }, [])

    const adminProxy = async (endpoint, method = 'POST', body = null) => {
        try {
            const response = await fetch(`/api/admin?endpoint=${endpoint}`, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined
            })
            return await response.json()
        }   
        catch (error) {
            throw new Error(`Admin request failed: ${error.message}`)
        }
    }

    // For testing loads of transactions without having to manually generate them all... use this function
    const generateTestMessages = ({
		count = 100,
		priority = 5,
		prefix = 'TEST',
	}) => {
		const deviceId = disasterStorage.getDeviceId()
		const familyId = disasterStorage.getCrisisMetadata()?.id || 'unknown'

		let created = 0

		for (let i = 0; i < count; i++) {
			const relayHash =
				(globalThis.crypto?.randomUUID?.() ??
					`${Date.now()}_${Math.random().toString(36).slice(2)}`)

			const msg = {
				timestamp_created: Math.floor(Date.now() / 1000),
				station_address: `${familyId}-dev`,
				message_data: `${prefix} message ${i + 1}/${count}`,
				related_addresses: [],
				type_field: 'message',
				priority_level: priority,
				relay_hash: relayHash,
				origin_device: deviceId,
				status: 'pending',
				queuedAt: Date.now(),
			}

			disasterStorage.queueMessage(msg)
			created++
		}

		alert(`Queued ${created} test messages (priority ${priority})`)
	}
    const generateEncryptedTestMessages = async ({
        count = 50,
        priority = 5,
        prefix = 'ENCRYPTED_TEST',
    }) => {
        const deviceId = disasterStorage.getDeviceId()

        // ✅ Identify active wallet via cached private key
        const privateKeyEntry = localStorage.getItem('krisys_private_key')
        if (!privateKeyEntry) {
            alert('No unlocked wallet found')
            return
        }

        let familyId
        try {
            familyId = JSON.parse(privateKeyEntry).familyId
        } catch {
            alert('Invalid cached private key data')
            return
        }

        let publicKey
        try {
            // Must already be cached; offline-safe
            publicKey = await KeyManager.getPublicKey(familyId)
        } catch {
            alert(
                'Public key not cached.\n\n' +
                'Unlock the wallet once while online first.'
            )
            return
        }

        let created = 0

        for (let i = 0; i < count; i++) {
            const relayHash =
                globalThis.crypto?.randomUUID?.() ??
                `${Date.now()}_${Math.random().toString(36).slice(2)}`

            const plaintext = `${prefix} message ${i + 1}/${count}`

            let encrypted
            try {
                // ✅ Encrypt only to self
                encrypted = await KeyManager.encryptMessage(
                    plaintext,
                    familyId,
                    familyId
                )
            } catch (e) {
                alert(`Encryption failed: ${e?.message || String(e)}`)
                return
            }

            disasterStorage.queueMessage({
                timestamp_created: Math.floor(Date.now() / 1000),
                station_address: `${familyId}-dev`,
                message_data: encrypted,
                related_addresses: [familyId],
                type_field: 'message',
                priority_level: priority,
                relay_hash: relayHash,
                origin_device: deviceId,
                status: 'pending',
                queuedAt: Date.now(),
            })

            created++
        }

        alert(`Queued ${created} encrypted messages (priority ${priority})`)
    }

    const mineBlock = async () => {
        setMining(true)
        try {
            const result = await adminProxy('mine')
            if (result.message) alert(`${result.message}`)
            else alert(`${result.error}`)
            if (onRefresh) onRefresh()
        } 
        catch (error) { alert(`Mining failed: ${error.message}`) } 
        finally { setMining(false) }
    }

    const createAlert = async () => {
        const mode = prompt(
            'Select action:\n1 = Broadcast emergency alert\n2 = Test station check-in',
            '1'
        )
        if (!mode) return

        // MODE 2: station check-in test (DEVELOPMENT)
        if (mode === '2') {
            const address = prompt('Enter wallet address to check in:')
            if (!address) return

            const stationChoice = prompt(
                'Select station:\n1 = STATION_001\n2 = HOSPITAL_SE_001',
                '1'
            )
            if (!stationChoice) return

            let stationId
            if (stationChoice === '1') { stationId = 'STATION_001' } 
            else if (stationChoice === '2') { stationId = 'HOSPITAL_SE_001' } 
            else {
                alert('Unknown station selection')
                return
            }

            // DEV NOTE:
            // Stations are verified API key from provider instead of unlocking wallet by password like normal wallets. 
            // This key is generated only once and stored on device so the station gets one when the blockchain is created while in development mode.
            let apiKey = null
            const res = await fetch(`${STATION_URL}/dev/station-identity?station_id=${encodeURIComponent(stationId)}`)
            if (res.ok) {
                const identity = await res.json()
                console.log("****************")
                console.log(identity)
                console.log(res)
                console.log("****************")
                apiKey = identity?.api_key || null
            }

            if (!apiKey) apiKey = prompt(`Enter API key for ${stationId} (DEV ONLY, fallback):`)
            if (!apiKey) return

            try {
                const result = await api.checkin(
                    address,
                    stationId,
                    apiKey
                )
                const data = result.data || result

                if (data.status === 'success') {
                    alert(`Check-in OK:\n${data.message}\ntransaction_id: ${data.transaction_id}`)
                    if (onRefresh) onRefresh()
                } 
                else alert(`Check-in failed: ${data.error || JSON.stringify(data)}`)
            } 
            catch (error) { alert(`Check-in failed: ${error.message}`) }

            return
        }

        // DEFAULT: broadcast emergency alert
        const message = prompt('Enter emergency alert message:')
        if (!message) return

        const priority = prompt(
            'Enter priority (1=highest, 5=lowest):',
            '1'
        )
        if (!priority) return

        try {
            const result = await adminProxy('alert', 'POST', {
                message,
                priority: parseInt(priority, 10)
            })

            if (result.status === 'success') {
                alert('Emergency alert sent!')
                if (onRefresh) onRefresh()
            } 
            else {
                alert(`Failed to send alert: ${result.error}`)
            }
        } 
        catch (error) {
            alert(`Failed to send alert: ${error.message}`)
        }
    }

    // DEV ONLY - network status shim for testing in dev environment
    const toggleNetworkStatus = () => {
        const newOnlineStatus = !isOnline
        setIsOnline(newOnlineStatus)

        if (newOnlineStatus) {
            // Going online - restore normal fetch
            if (window.originalFetch) {
                window.fetch = window.originalFetch
                delete window.originalFetch
            }
            delete window.KRISYS_OFFLINE_MODE
            alert('Network RESTORED - API calls will work normally')
        } else {
            // Going offline - intercept fetch calls (only override if not already overridden)
            if (!window.originalFetch) window.originalFetch = window.fetch
            window.KRISYS_OFFLINE_MODE = true

            window.fetch = (url, options) => {
                const u = typeof url === 'string' ? url : String(url)
                // Allow internal Next.js API routes to work
                if (u.startsWith('/api/') ||
                    u.startsWith(window.location.origin) ||
                    u.startsWith(STATION_URL) || 
                    u.startsWith(RELAY_URL)
                ) {
                    return window.originalFetch(url, options)
                }

                // Simulate failure for external API calls (central, internet)
                return Promise.reject(
                    new Error('Simulated offline mode')
                )
            }
        }
    }

    const toggleRateLimitOverride = () => {
        const newOverride = !rateLimitOverride
        setRateLimitOverride(newOverride)
        localStorage.setItem(
            'dev_rate_limit_override',
            newOverride.toString()
        )

        if (newOverride) {
            localStorage.setItem('dev_bypass_rate_limit', 'true')
            alert('Rate limiting DISABLED for rapid testing')
        } 
        else {
            localStorage.removeItem('dev_bypass_rate_limit')
            alert('Rate limiting ENABLED (normal 10min intervals)')
        }
    }

    const processQueue = async () => {
        const queue = disasterStorage.getMessageQueue()

        // Only pending meaning sent but not already in a block (messages in blocks are "confirmed")
        const pending = queue.filter( msg =>
            (msg.status || 'pending') === 'pending' &&
            !disasterStorage.isMessageConfirmed(msg.relay_hash)
        )
        setQueuedMessages(pending.length)

        if (pending.length <= 0) {
            alert('No messages in queue')
            return
        }

        let sent = 0
        for (const msg of pending) {
            try {
                await api.addTransaction(msg)
                msg.status = 'sent'
                msg.sentAt = Date.now()
                sent++
            } 
            catch (error) {
                console.error('Failed to send queued message:', error)
            }
        }

        // Persist new queue state
        localStorage.setItem( 'krisys_message_queue', JSON.stringify(queue) )

        alert(`Posted ${sent}/${pending.length} messages from process queue.`)

        if (onRefresh) onRefresh()
    }

    // Station sync: send our payload to the station, merge its response back
    const handleStationSync = async () => {
        setSyncingStation(true)
        console.log(`Station sync STATION_URL: ${STATION_URL}`)
        try {
            await syncWithMeshHost({
                baseUrl: STATION_URL,
                label: 'Station',
            })
            alert('Station sync completed')
            if (onRefresh) onRefresh()
        } 
        catch (error) {
            console.error('Station sync error:', error)
            alert(`Station sync failed: ${error.message}`)
        } 
        finally {
            setSyncingStation(false)
        }
    }

	// Relay sync
	const handleRelaySync = async () => {
		setSyncingRelay(true)
        console.log(`Station sync RELAY_URL: ${RELAY_URL}`)
		try {
			await syncWithMeshHost({ 
                baseUrl: RELAY_URL, 
                label: 'Relay'}
            )
			alert('Relay sync completed.')
			if (onRefresh) onRefresh()
		} 
        catch (error) {
			console.error('Relay sync error:', error)
			alert(`Relay sync failed: ${error.message}`)
		} 
        finally {
			setSyncingRelay(false)
		}
	}

    // Station flush: ask station to push its queued messages to central
    const handleStationFlush = async () => {
        setFlushingStation(true)
        try {
            const res = await fetch(
                `${STATION_URL}/station/flush`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                }
            )

            if (!res.ok) {
                const text = await res.text()
                throw new Error(
                    `Flush failed: ${res.status} ${text}`
                )
            }

            const data = await res.json()
            console.log('Station flush result:', data)

            alert(
                `Station flush: attempted ${data.attempted}, ` +
                    `success ${data.success}, failed ${data.failed}`
            )
        } 
        catch (error) {
            console.error('Station flush error:', error)
            alert(`Station flush failed: ${error.message}`)
        } 
        finally {
            setFlushingStation(false)
        }
    }

    const handleExportSync = () => {
        try {
            const payload = disasterStorage.exportSyncPayload()
            console.log('KriSYS sync payload (object):', payload)
            console.log(
                'KriSYS sync payload (JSON):',
                JSON.stringify(payload, null, 2)
            )
            alert('Sync payload exported to console (see DevTools).')
        } 
        catch (error) {
            console.error(
                'Failed to export sync payload:',
                error
            )
            alert(
                `Failed to export sync payload: ${error.message}`
            )
        }
    }

    const handleImportSync = async () => {
        const input = window.prompt('Paste sync payload JSON:')
        if (!input) return

        try {
            const payload = JSON.parse(input)
            console.log(
                'Importing KriSYS sync payload:',
                payload
            )
            // disasterStorage.importSyncPayload(payload)
            await disasterStorage.importSyncPayloadAsync(payload)
            alert(
                'Sync payload imported. Local queue, confirmations, and blocks updated.'
            )
            if (onRefresh) onRefresh()
        } 
        catch (error) {
            console.error(
                'Failed to import sync payload:',
                error
            )
            alert(
                'Invalid JSON or import failed. See console for details.'
            )
        }
    }

    const sendTestAlert = async () => {
        try {
            const result = await adminProxy('alert', 'POST', {
                message: 'TEST ALERT: Development emergency broadcast test',
                priority: 1,
            })

            if (result?.status === 'success') {
                alert('Test emergency alert queued (mine a block to confirm).')
                if (onRefresh) onRefresh()
                return
            }

            throw new Error(result?.error || 'Admin alert failed')
        } 
        catch (error) {
            alert(`Test alert failed: ${error.message}`)
        }
    }

    const clearStorage = () => {
        if ( confirm('Clear all local storage? This will log you out and clear all offline data.') ) {
            disasterStorage.clearAll()
            localStorage.clear()
            window.location.reload()
        }
    }

    return (
        <div className="dev-tools">
            <div className="dev-tools-inner">
                <span className="dev-label">DEV TOOLS</span>

                <span
                    className={`network-status ${
                        isOnline ? 'online' : 'offline'
                    }`}
                >
                    {isOnline ? 'ONLINE' : 'OFFLINE'}
                </span>

                <button
                    className="dev-btn"
                    onClick={mineBlock}
                    disabled={mining}
                    title="Force mine pending transactions into a new block"
                >
                    {mining ? '⏳' : '⛏️'} Mine Block
                </button>

                <button
                    className={`dev-btn ${
                        isOnline ? 'online' : 'offline'
                    }`}
                    onClick={toggleNetworkStatus}
                    title="Simulate network connection/disconnection"
                >
                    {isOnline ? 'Go Offline' : 'Go Online'}
                </button>

                <button
                    className={`dev-btn ${
                        rateLimitOverride ? 'active' : ''
                    }`}
                    onClick={toggleRateLimitOverride}
                    title="Override 10-minute rate limiting for rapid testing"
                >
                    {rateLimitOverride
                        ? 'Rate Override ON'
                        : 'Rate Limit ON'}
                </button>

                <button
                    className="dev-btn"
                    onClick={() => generateTestMessages({ count: 50, priority: 5 })}
                    title="Generate 50 low-priority test messages"
                >
                    +50 Msgs (p5)
                </button>

                <button
                    className="dev-btn"
                    onClick={() => generateEncryptedTestMessages({ count: 50 })}
                    title="Generate 50 encrypted priority-5 messages (realistic payload size)"
                >
                    +50 Msgs (p5, encrypted)
                </button>

                <button
                    className="dev-btn"
                    onClick={processQueue}
                    disabled={queuedMessages === 0}
                    title="Send all queued messages (when back online)"
                >
                    Queue ({queuedMessages})
                </button>

                <button
                    className="dev-btn"
                    onClick={handleExportSync}
                    title="Log sync payload (queued + confirmed + blocks) to console"
                >
                    Export Sync
                </button>

                <button
                    className="dev-btn"
                    onClick={handleStationSync}
                    disabled={syncingStation}
                    title={`Sync queued/confirmed state with station at ${STATION_URL}`}
                >
                    {syncingStation ? 'Syncing...' : 'Sync Station'}
                </button>

                <button
					className="dev-btn"
					onClick={handleRelaySync}
					disabled={syncingRelay}
					title={`Sync queued/confirmed state with relay at ${RELAY_URL}`}
				>
					{syncingRelay ? 'Syncing...' : 'Sync Relay'}
				</button>

                <button
                    className="dev-btn"
                    onClick={handleStationFlush}
                    disabled={flushingStation}
                    title="Ask station to flush its queued messages to central backend"
                >
                    {flushingStation ? 'Flushing...' : 'Flush Station'}
                </button>

                <button
                    className="dev-btn"
                    onClick={handleImportSync}
                    title="Import sync payload from pasted JSON"
                >
                    Import Sync
                </button>

                <button
                    className="dev-btn test"
                    onClick={sendTestAlert}
                    title="Send test emergency alert to all wallets"
                >
                    Test Alert
                </button>

                <button
                    className="dev-btn alert"
                    onClick={createAlert}
                    title="Create emergency alert or test station check-in"
                >
                    Check-in
                </button>

                <br />
                <span style={{ margin: 'auto' }}>
                    <button
                        className="dev-btn"
                        onClick={onRefresh}
                        title="Refresh all wallet data and transactions"
                    >
                        Refresh
                    </button>

                    <button
                        className="dev-btn danger"
                        onClick={clearStorage}
                        title="Clear all local data and reload page"
                    >
                        Reset All
                    </button>
                </span>

                {meshInfo && (
                    <div className="mesh-status">
                        <span>
                            Crisis:{' '}
                            {meshInfo.crisisId || 'unknown'}
                        </span>
                        <span>
                            Blocks:{' '}
                            {meshInfo.blockCount} (
                            {meshInfo.firstIndex ?? '-'} →{' '}
                            {meshInfo.lastIndex ?? '-'})
                        </span>
                        <span>
                            Block key:{' '}
                            {meshInfo.hasBlockKey ? 'yes' : 'no'}
                        </span>
                        <span>
                            Cached private key:{' '}
                            {meshInfo.hasPrivateKey ? 'yes' : 'no'}
                        </span>

                        {/* webRTC connection status & stats */}
                        {p2pStatus && (
                            <div className="mesh-status">
                                <div>
                                    P2P: {p2pStatus.active ? 'active' : 'inactive'} (
                                    {p2pStatus.status}, {p2pStatus.role})
                                </div>

                                {p2pStatus.metrics && (
                                    <div style={{ fontSize: '0.85em', opacity: 0.85 }}>
                                        <div>
                                            Sent: {p2pStatus.metrics.send?.bytesSent ?? 0} bytes
                                        </div>
                                        <div>
                                            Recv: {p2pStatus.metrics.recv?.bytesReceived ?? 0} bytes
                                        </div>
                                        <div>
                                            Send queue: {p2pStatus.metrics.send?.queueDepth ?? 0}
                                        </div>
                                        <div>
                                            Inflight assemblies: {p2pStatus.metrics.recv?.inflight ?? 0}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
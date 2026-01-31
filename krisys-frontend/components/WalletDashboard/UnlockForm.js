// krisys-frontend/components/WalletDashboard/UnlockForm.js
'use client'
import { useState, useEffect } from 'react'
import { KeyManager } from '../../services/keyManager'
import { disasterStorage } from '@/services/localStorage'
import {useRouter} from 'next/navigation'

export default function UnlockForm({ familyId, onUnlock }) {
	const [passphrase, setPassphrase] = useState('')
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)
	const [validating, setValidating] = useState(true)
	const [isFirstTime, setIsFirstTime] = useState(false)
	const [crisisId, setCrisisId] = useState(null)
	
	const router = useRouter()

	// resolve crisisId (retry briefly) so UnlockForm works even if crisis bootstrap completes slightly after this mounts.
    useEffect(() => {
        let cancelled = false
        let attempts = 0

        const tryResolve = () => {
            if (cancelled) return

            const cid = disasterStorage.getCrisisMetadata()?.id || null
            if (cid) {
                setCrisisId(cid)
                return
            }

            // Retry a few times to allow bootstrap to populate local storage.
            attempts += 1
            if (attempts <= 10) {
                setTimeout(tryResolve, 250)
            } else {
                setCrisisId(null)
            }
        }

        tryResolve()

        return () => {
            cancelled = true
        }
    }, [])

	// CHECK FOR EXISTING LOCAL KEY ON COMPONENT LOAD (OFFLINE-SAFE)
	useEffect(() => {
		const checkExistingKey = async () => {
			setValidating(true)
			setError('')

			try {

				if (!crisisId) {
                    // We can’t locate namespaced keys without a crisisId
                    setIsFirstTime(true)
                    return
                }
				
				// derive crisisId from pinned crisis metadata / active pointer
				const crisisId = disasterStorage.getCrisisMetadata()?.id || null

				// If we don't know the crisis, we cannot locate namespaced keys.
				if (!crisisId) {
					setIsFirstTime(true)
					return
				}

				// look up cached private key using namespaced storage
				const cached = disasterStorage.getCachedPrivateKey({
					crisisId,
					familyId,
				})

				if (cached) {
					setTimeout(() => onUnlock(cached), 0)
					return
				}

				setIsFirstTime(true)
			} catch {
				setIsFirstTime(true)
			} finally {
				setValidating(false)
			}
		}

		checkExistingKey()
	}, [crisisId, familyId, onUnlock])

	const handleGoHome = () => {
		disasterStorage.clearSession()
		// Do NOT attempt unlock, do NOT keep wallet context
		router.push('/')
	}

	const handleUnlock = async (e) => {
		e.preventDefault()
		setLoading(true)
		setError('')

		// Online unlock / first-time unlock on this device.
		// NOTE: KeyManager is responsible for caching the private key into
		// namespaced storage after successful validation.
		try {
			if (!crisisId) {
				throw new Error('Crisis not bootstrapped yet (missing crisisId). ' + 'Go back online once to pin the crisis.')
            }

            // CHANGED: crisisId is now in scope (state), so this call is valid.
            // Note: KeyManager must be updated to accept this signature.
			const privateKey = await KeyManager.getOrUnlockPrivateKey({ crisisId, familyId, passphrase })

			if (privateKey) {
				setTimeout(() => onUnlock(privateKey), 0)
			} else {
				setError('Unlock failed - no private key returned')
			}
		} catch (error) {
			const msg = error?.message || String(error)

			if (msg.includes('Invalid passphrase')) {
				setError('Incorrect passphrase. Please try again.')
			} else if (msg.includes('No internet')) {
				setError('Cannot unlock: No internet connection and no local key found')
			} else if (msg.includes('does not match')) {
				setError('Key validation failed - this may not be your wallet')
			} else {
				setError(msg || 'Unlock failed')
			}
		} finally {
			setLoading(false)
		}
	}

	if (validating) {
		return (
			<div className="unlock-form">
				<h3>Loading Wallet</h3>
				<div className="loading-spinner">Checking for existing keys...</div>
			</div>
		)
	}
	return (<>
		<br />
		<button
			type="button"
			className="btn secondary"
			onClick={handleGoHome}
			disabled={loading}
			style={{ marginTop: '12px' }}
		>
			<h1>← Back to Home</h1>
		</button>
		<br />
		
		<br />
		<form onSubmit={handleUnlock} className="unlock-form">
			<h3>Unlock Wallet</h3>

			{isFirstTime && (
				<p className="first-time-hint">
					Enter the passphrase you used when creating this wallet
				</p>
			)}

			<p className="unlock-hint">
				Your validated key will be stored locally for offline message access
			</p>

			<label>Enter Passphrase:</label>
			<input
				type="password"
				value={passphrase}
				onChange={(e) => setPassphrase(e.target.value)}
				className="form-input"
				disabled={loading}
				placeholder={
					isFirstTime ? 'Enter your wallet passphrase' : 'Development: leave empty'
				}
			/>

			<button type="submit" className="btn" disabled={loading}>
				{loading ? 'Unlocking...' : 'Unlock Wallet'}
			</button>

			{error && <p className="error">{error}</p>}
		</form>
	</>)
}
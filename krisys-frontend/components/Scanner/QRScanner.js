// /krisys-frontend/components/Scanner/QRScanner.js

'use client'
import { useEffect, useRef, useState } from 'react'
import { BrowserQRCodeReader } from '@zxing/browser'

export default function QRScanner({
	onScan,
	onClose,
	title = 'Scan QR Code',
}) {
	const videoRef = useRef(null)
	const controlsRef = useRef(null)
	const [error, setError] = useState(null)

	useEffect(() => {
		let cancelled = false

		async function start() {
			setError(null)

			try {
				const videoEl = videoRef.current
				if (!videoEl) throw new Error('Missing video element')

				const reader = new BrowserQRCodeReader()

				// decodeFromVideoDevice(null, ...) picks the default camera. For mobile, this typically selects a back camera but it’s not guaranteed. We can add a camera picker later.
				const controls = await reader.decodeFromVideoDevice(
					null,
					videoEl,
					(result, err) => {
						if (cancelled) return

						// Ignore "not found" errors while scanning frames.
						if (err) return

						if (result) {
							const text = result.getText()

							// Stop immediately once we have a decode.
							try {
								controls.stop()
							} catch {
								// ignore
							}

							if (typeof onScan === 'function') onScan(text)
						}
					}
				)

				controlsRef.current = controls
			} 
            catch (e) {
				if (cancelled) return
				setError(e?.message || String(e))
			}
		}

		start()

		return () => {
			cancelled = true
			if (controlsRef.current) {
				try {
					controlsRef.current.stop()
				} 
                catch {
					// ignore
				}
				controlsRef.current = null
			}
		}
	}, [onScan])

	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				background: 'rgba(0,0,0,0.75)',
				zIndex: 9999,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				padding: '16px',
			}}
		>
			<div
				style={{
					width: 'min(560px, 96vw)',
					background: '#fff',
					borderRadius: '12px',
					overflow: 'hidden',
				}}
			>
				<div
					style={{
						padding: '12px 16px',
						borderBottom: '1px solid #e5e7eb',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
					}}
				>
					<div style={{ fontWeight: 700 }}>{title}</div>
					<button
						type="button"
						onClick={() => {
							if (controlsRef.current) {
								try {
									controlsRef.current.stop()
								} catch {
									// ignore
								}
								controlsRef.current = null
							}
							if (typeof onClose === 'function') onClose()
						}}
					>
						Close
					</button>
				</div>

				<div style={{ padding: '16px' }}>
					<video
						ref={videoRef}
						style={{
							width: '100%',
							borderRadius: '8px',
							background: '#111',
						}}
					/>

					<div style={{ marginTop: '12px', fontSize: '0.9rem' }}>
						Point your camera at the QR code.
					</div>

					{error && (
						<div
							style={{
								marginTop: '12px',
								padding: '10px',
								background: '#fef2f2',
								borderLeft: '3px solid #dc2626',
								borderRadius: '6px',
								color: '#991b1b',
							}}
						>
							Scanner error: {error}
						</div>
					)}
				</div>
			</div>
		</div>
	)
}
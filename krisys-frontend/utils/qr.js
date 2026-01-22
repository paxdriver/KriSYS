import * as QRCode from 'qrcode'

function escapeHtml(value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
}

async function generateQrDataUrl(text, opts = {}) {
	// QR generation can fail if the payload is too large/dense.
	// In that case we still show the raw text so manual entry/copy works.
	return QRCode.toDataURL(text, {
		errorCorrectionLevel: opts.errorCorrectionLevel || 'M',
		margin: typeof opts.margin === 'number' ? opts.margin : 1,
		scale: typeof opts.scale === 'number' ? opts.scale : 8,
	})
}

/**
 * Show a QR popup for an arbitrary value (join codes, addresses, public keys).
 *
 * Disaster-friendly rules:
 * - Always show the raw text (manual entry / copy-paste fallback).
 * - QR is a convenience; if QR generation fails, still show the text.
 * - No server calls (works offline).
 */
export async function showTextQr({
	text,
	displayName = '',
	title = 'QR Code',
	heading = 'QR Code',
	qrOptions = undefined,
}) {
	if (typeof window === 'undefined') return

	const raw = typeof text === 'string' ? text.trim() : ''
	if (!raw) {
		alert('Nothing to show (empty value)')
		return
	}

	let qrDataUrl = null
	let qrError = null

	try {
		// For large payloads (like armored PGP keys), may need a smaller scale or lower error correction. We keep defaults conservative.
		qrDataUrl = await generateQrDataUrl(raw, qrOptions)
	} 
    catch (e) {
		qrError = e?.message || String(e)
	}

	const safeTitle = escapeHtml(title)
	const safeHeading = escapeHtml(heading)
	const safeName = escapeHtml(displayName || '')
	const safeValue = escapeHtml(raw)
	const safeQrError = escapeHtml(qrError || '')

	const features = [
		'width=450',
		'height=600',
		'resizable=yes',
		'scrollbars=yes',
		'toolbar=no',
		'menubar=no',
		'location=no',
		'status=no',
	].join(',')

	const qrWindow = window.open('', 'krisys_qr_popup', features)
	if (!qrWindow) {
		alert('Popup blocked. Please allow popups to view the QR code.')
		return
	}

	const qrHtml = qrDataUrl ? 
        `<img class="qr" src="${qrDataUrl}" alt="QR Code" />`: `
            <div class="qr-fallback"> generation failed (still usable via text copy/paste).
				${qrError ? `<div class="qr-error">${safeQrError}</div>` : ''}
			</div>
		`

	qrWindow.document.write(`
		<!DOCTYPE html>
		<html>
			<head>
				<meta charset="utf-8" />
				<title>${safeTitle}${safeName ? ` - ${safeName}` : ''}</title>
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<style>
					html, body {
						margin: 0;
						padding: 0;
						height: 100%;
						background: #111;
						color: #f5f5f5;
						font-family: system-ui, -apple-system, BlinkMacSystemFont,
							"Segoe UI", sans-serif;
					}
					.container {
						height: 100%;
						width: 100%;
						display: flex;
						flex-direction: column;
						box-sizing: border-box;
						padding: 14px;
						gap: 10px;
					}
					.header {
						text-align: center;
					}
					h3 {
						margin: 0 0 4px 0;
						font-size: 1.1rem;
					}
					.name {
						margin: 0;
						font-weight: 700;
						word-break: break-word;
						font-size: 0.9rem;
						opacity: 0.95;
					}
					.qr-wrapper {
						display: flex;
						align-items: center;
						justify-content: center;
						background: #0b0b0b;
						border-radius: 10px;
						padding: 10px;
						min-height: 260px;
					}
					img.qr {
						max-width: 92%;
						max-height: 320px;
						width: auto;
						height: auto;
						background: #fff;
						border-radius: 6px;
						box-shadow: 0 0 16px rgba(0, 0, 0, 0.7);
					}
					.qr-fallback {
						color: #fbbf24;
						font-size: 0.9rem;
						text-align: center;
						padding: 10px;
					}
					.qr-error {
						margin-top: 8px;
						color: #fca5a5;
						font-size: 0.8rem;
						word-break: break-word;
					}
					.value-label {
						font-size: 0.85rem;
						opacity: 0.85;
					}
					textarea.value {
						width: 100%;
						min-height: 160px;
						resize: vertical;
						border-radius: 10px;
						border: 1px solid rgba(255,255,255,0.15);
						background: #0b0b0b;
						color: #f5f5f5;
						padding: 10px;
						font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
							"Liberation Mono", "Courier New", monospace;
						font-size: 0.8rem;
						line-height: 1.25rem;
						box-sizing: border-box;
					}
					.actions {
						display: flex;
						gap: 8px;
						flex-wrap: wrap;
						justify-content: center;
					}
					button.btn {
						padding: 8px 14px;
						font-size: 0.85rem;
						border-radius: 8px;
						border: none;
						cursor: pointer;
						background: #2d8cff;
						color: #fff;
					}
					button.btn:hover {
						background: #1f6ad1;
					}
					.hint {
						font-size: 0.75rem;
						opacity: 0.8;
						text-align: center;
					}
				</style>
			</head>
			<body>
				<div class="container">
					<div class="header">
						<h3>${safeHeading}</h3>
						${safeName ? `<p class="name">${safeName}</p>` : ''}
					</div>

					<div class="qr-wrapper">
						${qrHtml}
					</div>

					<textarea
						id="qr-value"
						class="value"
						readonly
						spellcheck="false"
					>${safeValue}</textarea>

					<div class="actions">
						<button class="btn" type="button" onclick="copyValue()">
							Copy
						</button>
						<button class="btn" type="button" onclick="selectAll()">
							Select All
						</button>
					</div>

					<div class="hint">
						If scanning fails, copy/paste the text above into Connections.
					</div>
				</div>

				<script>
					function copyValue() {
						var el = document.getElementById('qr-value');
						if (!el) return;
						var val = el.value || '';
						if (!navigator.clipboard) {
							alert('Clipboard API not available');
							return;
						}
						navigator.clipboard.writeText(val)
							.then(function () { alert('Copied'); })
							.catch(function () { alert('Failed to copy'); });
					}

					function selectAll() {
						var el = document.getElementById('qr-value');
						if (!el) return;
						el.focus();
						el.select();
					}
				</script>
			</body>
		</html>
	`)
}

//  Backwards-compatible helper used by Members/Overview UI
export async function showAddressQr({
	familyId, // kept for compatibility; unused now
	address,
	displayName,
	title = 'QR Code',
	heading = 'Wallet QR Code',
}) {
	await showTextQr({
		text: address,
		displayName,
		title,
		heading,
	})
}

/*
Future use: sharing public keys offline

NOTE: armored PGP keys may be too large for QR; this still helps because the text is always shown and copy/paste works.

Later we can add:
- chunking (multi-QR sequence),
- compression,
- or a short “key bundle” format.

*/
export async function showPublicKeyQr({
	publicKeyArmored,
	displayName = 'Public Key',
	title = 'Public Key',
	heading = 'Public Key (Offline Share)',
}) {
	await showTextQr({
		text: publicKeyArmored,
		displayName,
		title,
		heading,
		// For large keys, you may need to tune these:
		// qrOptions: { errorCorrectionLevel: 'L', scale: 4 }
	})
}
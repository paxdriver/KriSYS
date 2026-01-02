// utils/qr.js
// Reusable helper for showing QR codes for any wallet address.
// Uses backend /wallet/<family_id>/qr/<address> via the api service.

import { api } from '../services/api'

export async function showAddressQr({
    familyId,
    address,
    displayName,
    title = 'QR Code',
    heading = 'Wallet QR Code',
}) {
    try {
        const response = await api.getWalletQR(familyId, address)
        const data = response.data || response

        // Open a popup window with reasonable default size
        const features = [
            'width=450',
            'height=500',
            'resizable=yes',
            'scrollbars=no',
            'toolbar=no',
            'menubar=no',
            'location=no',
            'status=no',
        ].join(',')

        const qrWindow = window.open('', 'krisys_qr_popup', features)
        if (!qrWindow) {
            alert('Popup blocked. Please allow popups to view QR code.')
            return
        }

        qrWindow.document.write(`
            <!DOCTYPE html>
            <html>
                <head>
                    <meta charset="utf-8" />
                    <title>${title} - ${displayName}</title>
                    <meta
                        name="viewport"
                        content="width=device-width, initial-scale=1"
                    />
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
                            align-items: center;
                            justify-content: center;
                            box-sizing: border-box;
                            padding: 12px;
                            text-align: center;
                        }
                        h3 {
                            margin: 0 0 4px 0;
                            font-size: 1.1rem;
                        }
                        .name {
                            margin: 0 0 12px 0;
                            font-weight: 600;
                            word-break: break-word;
                            font-size: 0.9rem;
                        }
                        .qr-wrapper {
                            flex: 1 1 auto;
                            width: 100%;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        }
                        img.qr {
                            /* Fill as much of the popup as possible, but
                               preserve aspect ratio and keep it square. */
                            max-width: 90vmin;
                            max-height: 90vmin;
                            width: auto;
                            height: auto;
                            background: #fff;
                            box-shadow: 0 0 16px rgba(0, 0, 0, 0.7);
                        }
                        .address {
                            font-size: 0.8rem;
                            word-break: break-all;
                            margin-top: 8px;
                        }
                        .actions {
                            margin-top: 8px;
                            display: flex;
                            gap: 8px;
                            justify-content: center;
                            flex-wrap: wrap;
                        }
                        button.copy-btn {
                            padding: 6px 12px;
                            font-size: 0.8rem;
                            border-radius: 4px;
                            border: none;
                            cursor: pointer;
                            background: #2d8cff;
                            color: #fff;
                        }
                        button.copy-btn:hover {
                            background: #1f6ad1;
                        }
                        .hint {
                            margin-top: 4px;
                            font-size: 0.75rem;
                            opacity: 0.8;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h3>${heading}</h3>
                        <p class="name">${displayName}</p>
                        <div class="qr-wrapper">
                            <img
                                class="qr"
                                src="${data.qr_code}"
                                alt="QR Code"
                            />
                        </div>
                        <div class="address" id="qr-address">
                            ${address}
                        </div>
                        <div class="actions">
                            <button
                                class="copy-btn"
                                type="button"
                                onclick="copyAddress()"
                            >
                                Copy address
                            </button>
                        </div>
                        <p class="hint">
                            Right-click or long-press the QR code to save it.
                        </p>
                    </div>
                    <script>
                        function copyAddress() {
                            var el = document.getElementById('qr-address');
                            if (!el) return;
                            var addr = el.textContent.trim();
                            if (!navigator.clipboard) {
                                alert('Clipboard API not available');
                                return;
                            }
                            navigator.clipboard.writeText(addr)
                                .then(function () {
                                    alert('Address copied to clipboard');
                                })
                                .catch(function (err) {
                                    console.error('Copy failed:', err);
                                    alert('Failed to copy address');
                                });
                        }
                    </script>
                </body>
            </html>
        `)
    } catch (error) {
        console.error('Failed to generate QR code:', error)
        alert('Failed to generate QR code')
    }
}
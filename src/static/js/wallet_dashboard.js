// /static/js/wallet_dashboard.js

function renderDebugInfo(walletData, transactions) {
    const container = document.getElementById('debug-output');
    if (!container) return;
    
    container.textContent = JSON.stringify({
        wallet: walletData,
        transactions: transactions
    }, null, 2);
}

// MAIN ENTRY POINT IN HTML
function initializeDashboard(walletData, txs, familyId) {
    console.log('initializeDashboard function')

    // Navigation setup
    const navLinks = document.querySelectorAll('.nav-link');
    const pages = document.querySelectorAll('.page');
    
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            
            const targetPage = link.dataset.page;
            pages.forEach(page => {
                page.style.display = page.id === `${targetPage}-page` ? 'block' : 'none';
            });
        });
    });
    
    // Render wallet data
    renderWalletData(walletData, txs, familyId);
    
    // Event listeners
    document.getElementById('refresh-btn')?.addEventListener('click', refreshWalletData);
    document.getElementById('add-member-btn')?.addEventListener('click', showAddMemberForm);
    document.getElementById('unlock-wallet-btn')?.addEventListener('click', unlockWallet);
};

function renderWalletData(walletData, txs, familyId) {
    console.log("RenderWalletData function")
    console.log(walletData)
    console.log(txs)
    console.log(familyId)

    // TEMPORARY DEBUG OUTPUT   
    const debugOutput = document.getElementById('debug-output');
    debugOutput.textContent = JSON.stringify({
        wallet: walletData,
        transactions: txs
    }, null, 2);
    


    // Update wallet ID display
    if (walletData.family_id) {
        document.getElementById('wallet-id-display').textContent = walletData.family_id;
    }
    
    // Render members overview
    if (walletData.members) {
        renderMembersOverview(walletData.members);
    }
    
    // Render members list
    if (walletData.members) {
        renderMembersList(walletData.members);
    }
    
    // Render recent activity
    if (txs) {
        renderRecentActivity(txs);
    }
    
    // Show unlock form if wallet is locked
    if (walletData && !walletData.private_key) {
        document.getElementById('unlock-form').style.display = 'block';
    }

    // DEV NOTE: DEBUGGING
    renderDebugInfo(walletData, txs)
}

function renderMembersOverview(members) {
    const container = document.getElementById('members-overview');
    if (!container) return;
    
    container.innerHTML = '';
    
    members.slice(0, 3).forEach(member => {
        const memberEl = document.createElement('div');
        memberEl.className = 'member-item';
        memberEl.innerHTML = `
            <div class="member-avatar">${member.name.charAt(0)}</div>
            <div class="member-info">
                <div class="member-name">${member.name}</div>
                <div class="member-address">${member.address}</div>
            </div>
        `;
        container.appendChild(memberEl);
    });
    
    if (members.length > 3) {
        const moreEl = document.createElement('div');
        moreEl.className = 'member-item';
        moreEl.innerHTML = `
            <div class="member-avatar">+${members.length - 3}</div>
            <div class="member-info">
                <div class="member-name">${members.length - 3} more members</div>
                <div>View all in Members section</div>
            </div>
        `;
        container.appendChild(moreEl);
    }
}

function renderMembersList(members) {
    const container = document.getElementById('members-list');
    if (!container) return;
    
    container.innerHTML = '';
    
    members.forEach(member => {
        const memberEl = document.createElement('div');
        memberEl.className = 'member-item';
        memberEl.innerHTML = `
            <div class="member-avatar">${member.name.charAt(0)}</div>
            <div class="member-info">
                <div class="member-name">${member.name}</div>
                <div class="member-address">${member.address}</div>
            </div>
            <div class="member-actions">
                <button class="btn-icon" title="Generate QR" data-address="${member.address}">📇</button>
            </div>
        `;
        container.appendChild(memberEl);
    });
    
    // Add QR code generation
    document.querySelectorAll('.btn-icon[data-address]').forEach(btn => {
        btn.addEventListener('click', () => {
            const address = btn.getAttribute('data-address');
            generateQRCode(address);
        });
    });
}

function renderRecentActivity(transactions) {
    const container = document.getElementById('recent-activity');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (transactions.length === 0) {
        container.innerHTML = '<p>No recent activity</p>';
        return;
    }
    
    transactions.forEach(tx => {
        const txEl = document.createElement('div');
        txEl.className = 'transaction';
        
        // Add decryption indicator
        const lockIcon = tx.decrypted ? '🔓' : '🔒';
        
        txEl.innerHTML = `
            <div class="tx-header">
                <span class="tx-type">${tx.type_field}</span>
                <span class="tx-lock">${lockIcon}</span>
                <span class="tx-time">${formatDateTime(tx.timestamp_posted)}</span>
            </div>
            <div class="tx-message">${tx.message_data}</div>
        `;
        container.appendChild(txEl);
    });
}

function formatDateTime(timestamp) {
    return new Date(timestamp * 1000).toLocaleString();
}

function generateQRCode(address) {
    alert(`Generating QR code for address: ${address}`);
    // In production: fetch QR code from /wallet/<family_id>/qr/<address>
}

function refreshWalletData() {
    // Get wallet ID from URL
    const pathParts = window.location.pathname.split('/');
    const familyId = pathParts[pathParts.length - 1];       // what is this for? it doesn't do anything
    
    // Reload page to refresh data
    window.location.reload();
}

function showAddMemberForm() {
    alert('Add member functionality will be implemented');
}

async function unlockWallet() {
    const passphrase = document.getElementById('wallet-passphrase').value;
    const familyId = walletData.family_id;
    const errorElement = document.getElementById('unlock-error');
    
    if (!passphrase) {
        errorElement.textContent = "Please enter a passphrase";
        errorElement.style.display = 'block';
        return;
    }
    
    try {
        const response = await fetch('/auth/unlock', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                family_id: familyId,
                passphrase: passphrase
            })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            // Success - reload wallet data
            walletData.private_key = true; // Simplified for frontend
            document.getElementById('unlock-form').style.display = 'none';
            refreshWalletData();
        } else {
            errorElement.textContent = result.error || "Unlock failed";
            errorElement.style.display = 'block';
        }
    } catch (error) {
        console.error('Unlock error:', error);
        errorElement.textContent = "Network error. Please try again.";
        errorElement.style.display = 'block';
    }
}


// // /src/static/js/wallet_dashboard.js
// // async function authenticateWithPGP() {
// //     try {
// //         // Step 1: Get challenge
// //         const challengeRes = await fetch('/auth/challenge');
// //         const { challenge } = await challengeRes.json();
        
// //         // Step 2: Sign challenge with private key
// //         const signature = await signMessage(challenge); // Implement this with OpenPGP.js
        
// //         // Step 3: Send signature to server
// //         const loginRes = await fetch('/auth/login', {
// //             method: 'POST',
// //             headers: { 'Content-Type': 'application/json' },
// //             body: JSON.stringify({
// //                 signature: signature,
// //                 fingerprint: 'your-public-key-fingerprint'
// //             })
// //         });
        
// //         if (loginRes.ok) {
// //             // Authentication successful
// //             loadWalletData();
// //         } else {
// //             const error = await loginRes.json();
// //             alert(`Authentication failed: ${error.error}`);
// //         }
// //     } catch (error) {
// //         console.error('Authentication error:', error);
// //         alert('Authentication process failed');
// //     }
// // }

// // // Implement this using OpenPGP.js in the browser
// // async function signMessage(message) {
// //     // This would use the user's private key stored in secure storage
// //     // For example: 
// //     // const { data: signature } = await openpgp.sign({
// //     //     message: await openpgp.createMessage({ text: message }),
// //     //     signingKeys: privateKey,
// //     //     detached: true
// //     // });
// //     // return signature;
// //     return "mock-signature-for-development";
// // }

// // async function loadWalletData() {
// //     try {
// //         const familyId = "fam_12345"; // Should come from user session
// //         const response = await fetch(`/wallet/${familyId}`);
// //         const walletData = await response.json();
        
// //         if (walletData.error) {
// //             showError(walletData.error);
// //             return;
// //         }
        
// //         // Update UI with wallet data
// //         renderMembers(walletData.members);
// //         renderDevices(walletData.devices);
// //         renderNotifications(walletData.notifications);
        
// //     } catch (error) {
// //         console.error('Failed to load wallet data:', error);
// //         showError("Couldn't load wallet information");
// //     }
// // }

// // document.addEventListener('DOMContentLoaded', () => {
// //     initAuthentication();
// //     loadWalletData();
// // });




















//  // Authentication Flow
// async function initAuthentication(walletId) {
//     // Check if device ID exists
//     const deviceId = localStorage.getItem('krisys_device_id') || generateDeviceId();
    
//     const response = await fetch('/auth/init', {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify({
//             wallet_id: walletId,
//             device_id: deviceId
//         })
//     });
    
//     const data = await response.json();
    
//     if (data.device_registered) {
//         // Sign challenge with device key
//         const signature = await signChallenge(data.challenge);
//         verifyAuthentication(signature, deviceId);
//     } else {
//         // Show password or registration options
//         document.getElementById('password-auth').style.display = 'block';
//         document.getElementById('device-registration').style.display = 'block';
//     }
// }

// async function verifyAuthentication(signature, deviceId) {
//     const response = await fetch('/auth/verify', {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify({
//             signature: signature,
//             device_id: deviceId
//         })
//     });
    
//     const result = await response.json();
//     if (result.status === 'authenticated') {
//         localStorage.setItem('wallet_session', result.token);
//         loadDashboard();
//     } else {
//         showError("Authentication failed. Please try again.");
//     }
// }

// async function registerDevice(walletId, publicKey) {
//     const response = await fetch('/wallet/register-device', {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify({
//             wallet_id: walletId,
//             public_key: publicKey,
//             device_id: localStorage.getItem('krisys_device_id')
//         })
//     });
    
//     const result = await response.json();
//     if (result.status === 'registered') {
//         initAuthentication(walletId);
//     }
// }

// // Generate device ID on first use
// function generateDeviceId() {
//     const deviceId = 'device_' + Math.random().toString(36).substr(2, 9);
//     localStorage.setItem('krisys_device_id', deviceId);
//     return deviceId;
// }

// function formatDateTime(timestamp) {
//     return new Date(timestamp * 1000).toLocaleString();
// }

// // Wallet Dashboard JavaScript
// document.addEventListener('DOMContentLoaded', () => {
//     // Navigation
//     const navLinks = document.querySelectorAll('.nav-link');
//     const pages = document.querySelectorAll('.page');
    
//     navLinks.forEach(link => {
//         link.addEventListener('click', (e) => {
//             e.preventDefault();
            
//             // Update active link
//             navLinks.forEach(l => l.classList.remove('active'));
//             link.classList.add('active');
            
//             // Show corresponding page
//             const targetPage = link.dataset.page;
//             pages.forEach(page => {
//                 page.style.display = page.id === `${targetPage}-page` ? 'block' : 'none';
//             });
//         });
//     });
    
//     // Load wallet data
//     async function loadWalletData() {
//         try {
//             // Get wallet ID from URL
//             const pathParts = window.location.pathname.split('/');
//             const familyId = pathParts[pathParts.length - 1];
            
//             // Fetch wallet data
//             const walletResponse = await fetch(`/wallet/${familyId}/data`);
//             if (!walletResponse.ok) throw new Error('Wallet not found');
//             const walletData = await walletResponse.json();
            
//             // Fetch transactions
//             const txResponse = await fetch(`/wallet/${familyId}/transactions`);
//             const transactions = txResponse.ok ? await txResponse.json() : [];
            
//             // Update UI
//             document.getElementById('wallet-id-display').textContent = walletData.family_id;
//             renderMembersOverview(walletData.members);
//             renderMembersList(walletData.members);
//             renderRecentActivity(transactions.slice(0, 5));
//             renderNotifications(walletData.notifications);
            
//         } catch (error) {
//             console.error('Failed to load wallet data:', error);
//             showError('Error loading wallet data. Please try again.');
//         }
//     }
    
//     async function loadRecentTransactions(familyId) {
//         try {
//             const response = await fetch(`/address/${familyId}`);
//             if (!response.ok) return;
            
//             const transactions = await response.json();
//             renderRecentActivity(transactions.slice(0, 5)); // Show last 5
//         } catch (error) {
//             console.error('Error loading transactions:', error);
//         }
//     }
    
//     function renderMembersOverview(members) {
//         const container = document.getElementById('members-overview');
//         if (!container) return;
        
//         container.innerHTML = '';
        
//         members.slice(0, 3).forEach(member => {
//             const memberEl = document.createElement('div');
//             memberEl.className = 'member-item';
//             memberEl.innerHTML = `
//                 <div class="member-avatar">${member.name.charAt(0)}</div>
//                 <div class="member-info">
//                     <div class="member-name">${member.name}</div>
//                     <div class="member-address">${member.address}</div>
//                 </div>
//             `;
//             container.appendChild(memberEl);
//         });
        
//         if (members.length > 3) {
//             const moreEl = document.createElement('div');
//             moreEl.className = 'member-item';
//             moreEl.innerHTML = `
//                 <div class="member-avatar">+${members.length - 3}</div>
//                 <div class="member-info">
//                     <div class="member-name">${members.length - 3} more members</div>
//                     <div>View all in Members section</div>
//                 </div>
//             `;
//             container.appendChild(moreEl);
//         }
//     }
    
//     function renderMembersList(members) {
//         const container = document.getElementById('members-list');
//         if (!container) return;
        
//         container.innerHTML = '';
        
//         members.forEach(member => {
//             const memberEl = document.createElement('div');
//             memberEl.className = 'member-item';
//             memberEl.innerHTML = `
//                 <div class="member-avatar">${member.name.charAt(0)}</div>
//                 <div class="member-info">
//                     <div class="member-name">${member.name}</div>
//                     <div class="member-address">${member.address}</div>
//                 </div>
//                 <div class="member-actions">
//                     <button class="btn-icon" title="Generate QR" data-address="${member.address}">📇</button>
//                 </div>
//             `;
//             container.appendChild(memberEl);
//         });
        
//         // Add QR code generation
//         document.querySelectorAll('.btn-icon[data-address]').forEach(btn => {
//             btn.addEventListener('click', () => {
//                 const address = btn.getAttribute('data-address');
//                 generateQRCode(address);
//             });
//         });
//     }
    
//     function renderRecentActivity(transactions) {
//         const container = document.getElementById('recent-activity');
//         if (!container) return;
        
//         container.innerHTML = '';
        
//         if (transactions.length === 0) {
//             container.innerHTML = '<p>No recent activity</p>';
//             return;
//         }
        
//         transactions.forEach(tx => {
//             const txEl = document.createElement('div');
//             txEl.className = 'transaction';
//             txEl.innerHTML = `
//                 <div class="tx-type">${tx.type_field}</div>
//                 <div class="tx-message">${tx.message_data}</div>
//                 <div class="tx-time">${formatDateTime(tx.timestamp_posted)}</div>
//             `;
//             container.appendChild(txEl);
//         });
//     }
    
//     function renderNotifications(notifications) {
//         const container = document.getElementById('all-notifications');
//         if (!container) return;
        
//         container.innerHTML = '';
        
//         notifications.forEach(notif => {
//             const notifEl = document.createElement('div');
//             notifEl.className = 'notification-item';
//             notifEl.innerHTML = `
//                 <div class="notification-header">
//                     <div class="notification-title">${notif.title}</div>
//                     <div class="notification-time">${notif.time}</div>
//                 </div>
//                 <div class="notification-content">${notif.content}</div>
//             `;
//             container.appendChild(notifEl);
//         });
//     }
    
//     function generateQRCode(address) {
//         alert(`Generating QR code for address: ${address}`);
//         // In a real implementation, this would use the /wallet/<family_id>/qr/<address> endpoint
//     }
    
//     function showAuthModal() {
//         document.getElementById('auth-modal').style.display = 'block';
//     }
    
//     function showError(message) {
//         alert(`Error: ${message}`);
//     }
    





// function renderRecentActivity(transactions) {
//     const container = document.getElementById('recent-activity');
//     if (!container) return;
    
//     container.innerHTML = '';
    
//     if (transactions.length === 0) {
//         container.innerHTML = '<p>No recent activity</p>';
//         return;
//     }
    
//     transactions.forEach(tx => {
//         const txEl = document.createElement('div');
//         txEl.className = 'transaction';
        
//         // Add decryption indicator
//         const lockIcon = tx.decrypted ? '🔓' : '🔒';
        
//         txEl.innerHTML = `
//             <div class="tx-header">
//                 <span class="tx-type">${tx.type_field}</span>
//                 <span class="tx-lock">${lockIcon}</span>
//                 <span class="tx-time">${formatDateTime(tx.timestamp_posted)}</span>
//             </div>
//             <div class="tx-message">${tx.message_data}</div>
//         `;
//         container.appendChild(txEl);
//     });
// }

// document.addEventListener('DOMContentLoaded', () => {
//     // Render data passed from Flask
//     document.getElementById('wallet-id-display').textContent = walletData.family_id;
//     renderMembersOverview(walletData.members);
//     renderMembersList(walletData.members);
//     renderRecentActivity(transactions);
    
//     // ... event listeners ...
//     // Event listeners
//     document.getElementById('refresh-btn')?.addEventListener('click', loadWalletData);
//     document.getElementById('add-member-btn')?.addEventListener('click', () => {
//         alert('Add member functionality will be implemented');
//     });
    
//     // Initialize
//     loadWalletData();
    
//     // Show unlock form if wallet is locked
//     if (!walletData.private_key) {
//         document.getElementById('unlock-form').style.display = 'block';
//     }
// });
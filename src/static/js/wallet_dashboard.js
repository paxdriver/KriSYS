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

    // Filter messages for specific member of the group wallet
    document.getElementById('member-filter').addEventListener('change', (e) => {
        const address = e.target.value;
        filterTransactions(address);
    });
    function filterTransactions(memberAddress) {
        const transactions = [...txs];
        
        const filtered = memberAddress === 'all' 
            ? transactions
            : transactions.filter(tx => 
                tx.related_addresses.includes(memberAddress) ||
                tx.type_field === 'alert'
            );
        
        renderRecentActivity(filtered);
    } // END member message filter

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
        const lockIcon = (walletData.unlocked && tx.type_field === 'message') ? '🔓' : '🔒';
        // Always show lock icon for messages?
        // const lockIcon = tx.type_field === 'message' ? '🔒' : '';

        if (tx.type_field === 'message') {
            if (tx.decrypted_message) {
                // Show decrypted message
                messageContent = tx.decrypted_message;
                lockIcon = '🔓';
            } 
            else if (tx.decryption_error) {
                // Show decryption error
                messageContent = "🔒 Error decrypting message";
                lockIcon = '❌';
            } 
            else {
                // Show encrypted message
                lockIcon = '🔒';
            }
        }
        
        txEl.innerHTML = `
            <div class="tx-header">
                <span class="tx-type">${tx.type_field}</span>
                <span class="tx-lock">${lockIcon}</span>
                <span class="tx-time">${formatDateTime(tx.timestamp_posted)}</span>
            </div>
            <div class="tx-message">${messageContent}</div>
            <div class="tx-message">***************</div>
            <div class="tx-message">${tx.message_data}</div>
            <div class="tx-message">***************</div>
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
    
    try {
        const response = await fetch('/auth/unlock', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                family_id: familyId,
                passphrase: passphrase
            })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            // Set unlocked state in frontend
            walletData.unlocked = true;
            
            // Update UI
            document.getElementById('unlock-status').textContent = "🔓 Wallet unlocked";
            document.getElementById('unlock-status').style.display = 'block';
            document.getElementById('unlock-form').style.display = 'none';
            
            // Re-render transactions to show decrypted messages
            renderRecentActivity(transactions);
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


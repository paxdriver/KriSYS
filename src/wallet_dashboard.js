async function authenticateWithPGP() {
    try {
        // Step 1: Get challenge
        const challengeRes = await fetch('/auth/challenge');
        const { challenge } = await challengeRes.json();
        
        // Step 2: Sign challenge with private key
        const signature = await signMessage(challenge); // Implement this with OpenPGP.js
        
        // Step 3: Send signature to server
        const loginRes = await fetch('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                signature: signature,
                fingerprint: 'your-public-key-fingerprint'
            })
        });
        
        if (loginRes.ok) {
            // Authentication successful
            loadWalletData();
        } else {
            const error = await loginRes.json();
            alert(`Authentication failed: ${error.error}`);
        }
    } catch (error) {
        console.error('Authentication error:', error);
        alert('Authentication process failed');
    }
}

// Implement this using OpenPGP.js in the browser
async function signMessage(message) {
    // This would use the user's private key stored in secure storage
    // For example: 
    // const { data: signature } = await openpgp.sign({
    //     message: await openpgp.createMessage({ text: message }),
    //     signingKeys: privateKey,
    //     detached: true
    // });
    // return signature;
    return "mock-signature-for-development";
}

async function loadWalletData() {
    try {
        const familyId = "fam_12345"; // Should come from user session
        const response = await fetch(`/wallet/${familyId}`);
        const walletData = await response.json();
        
        if (walletData.error) {
            showError(walletData.error);
            return;
        }
        
        // Update UI with wallet data
        renderMembers(walletData.members);
        renderDevices(walletData.devices);
        renderNotifications(walletData.notifications);
        
    } catch (error) {
        console.error('Failed to load wallet data:', error);
        showError("Couldn't load wallet information");
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initAuthentication();
    loadWalletData();
});
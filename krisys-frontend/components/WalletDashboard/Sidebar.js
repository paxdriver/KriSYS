// components/WalletDashboard/Sidebar.js
'use client'
export default function Sidebar({ walletData, currentPage, onPageChange }) {
  const navItems = [
    { id: 'overview', icon: '📊', label: 'Overview' },
    { id: 'members', icon: '👨‍👩‍👧‍👦', label: 'Family Members' },
    { id: 'contacts', icon: '📞', label: 'My Contacts' },
    { id: 'messages', icon: '💬', label: 'Messages' },
    { id: 'notifications', icon: '🔔', label: 'Notifications' },
    { id: 'security', icon: '🔒', label: 'Security' },
    { id: 'devices', icon: '📱', label: 'Registered Devices' }
  ]

  return (
    <aside className="sidebar">
      <div className="wallet-header">
        <div className="wallet-icon">F</div>
        <div className="wallet-info">
          <h2>Family Wallet</h2>
          <div className="wallet-id" id="wallet-id-display">
            {walletData?.family_id || 'Loading...'}
          </div>
        </div>
      </div>
      
      <ul className="nav-menu">
        {navItems.map(item => (
          <li key={item.id} className="nav-item">
            <a 
              href="#" 
              className={`nav-link ${currentPage === item.id ? 'active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                onPageChange(item.id)
              }}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </aside>
  )
}
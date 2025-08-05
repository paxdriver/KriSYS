// components/WalletDashboard/MembersPage.js
export default function MembersPage({ walletData, transactions }) {
  const handleAddMember = () => {
    alert('Add member functionality will be implemented')
  }
  
  const generateQRCode = (address) => {
    alert(`Generating QR code for address: ${address}`)
  }
  
  return (
    <div id="members-page" className="page">
      <div className="page-header">
        <h1 className="page-title">Family Members</h1>
        <button className="btn" onClick={handleAddMember}>
          <span>➕</span> Add Member
        </button>
      </div>
      
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Current Members</h3>
        </div>
        <div className="card-body">
          {walletData?.members?.map(member => (
            <div key={member.address} className="member-item">
              <div className="member-avatar">{member.name?.charAt(0) || 'M'}</div>
              <div className="member-info">
                <div className="member-name">{member.name}</div>
                <div className="member-address">{member.address}</div>
              </div>
              <div className="member-actions">
                <button 
                  className="btn-icon" 
                  title="Generate QR" 
                  onClick={() => generateQRCode(member.address)}
                >
                  📇
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
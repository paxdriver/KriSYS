// components/WalletDashboard/MembersOverview.js
export default function MembersOverview({ members }) {
  if (!members || members.length === 0) {
    return <p>No members found</p>
  }
  
  return (
    <div>
      {members.slice(0, 3).map(member => (
        <div key={member.address} className="member-item">
          <div className="member-avatar">{member.name?.charAt(0) || 'M'}</div>
          <div className="member-info">
            <div className="member-name">{member.name}</div>
            <div className="member-address">{member.address}</div>
          </div>
        </div>
      ))}
      
      {members.length > 3 && (
        <div className="member-item">
          <div className="member-avatar">+{members.length - 3}</div>
          <div className="member-info">
            <div className="member-name">{members.length - 3} more members</div>
            <div>View all in Members section</div>
          </div>
        </div>
      )}
    </div>
  )
}
// components/WalletDashboard/Overview.js
'use client'
import RecentActivity from './RecentActivity'
import MembersOverview from './MembersOverview'
import { showAddressQr } from '../../utils/qr'

export default function Overview({ walletData, transactions, onRefresh }) {
  const handleShowFamilyQr = () => {
    if (!walletData?.family_id) return
    showAddressQr({
      familyId: walletData.family_id,
      address: walletData.family_id,
      displayName: 'Family Wallet',
      title: 'Family Wallet QR Code',
      heading: 'Family Wallet QR Code',
    })
  }

  return (
    <div id="overview-page" className="page">
      <div className="page-header">
        <h1 className="page-title">Family Overview</h1>
        <button
          className="btn"
          onClick={handleShowFamilyQr}
        >
          <span>📇</span> Family QR
        </button>
        <button className="btn" onClick={onRefresh}>
          <span>🔄</span> Refresh
        </button>
      </div>

      <div className="card-grid">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Family Members</h3>
          </div>
          <div className="card-body">
            <MembersOverview
              members={walletData?.members || []}
            />
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Recent Activity</h3>
          </div>
          <div className="card-body">
            <RecentActivity
              transactions={transactions}
              walletData={walletData}
              limit={5}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">All Notifications</h3>
        </div>
        <div className="card-body">
          <RecentActivity
            transactions={transactions}
            walletData={walletData}
          />
        </div>
      </div>
    </div>
  )
}
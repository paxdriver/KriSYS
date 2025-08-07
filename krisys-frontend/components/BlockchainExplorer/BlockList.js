export default function BlockList({ blocks, loading }) {
    if (loading) {
        return <div className="loading">Loading blockchain...</div>
    }

    if (!blocks || blocks.length === 0) {
        return <div>No blocks found</div>
    }

    return (
        <div className="card">
            <div className="card-header">
                <h3>Blockchain ({blocks.length} blocks)</h3>
            </div>
            <div className="card-body">
                {blocks.slice().reverse().map(block => (
                    <div key={block.block_index} className="block-item">
                        <div className="block-header">
                            <span className="block-index">Block #{block.block_index}</span>
                            <span className="block-time">
                                {new Date(block.timestamp * 1000).toLocaleString()}
                            </span>
                        </div>
                        <div className="block-hash">{block.hash}</div>
                        <div className="block-transactions">
                            {block.transactions.length} transaction(s)
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}
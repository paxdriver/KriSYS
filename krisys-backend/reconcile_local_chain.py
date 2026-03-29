# krisys-backend/reconcile_local_chain.py
"""
Local Blockchain Reconciliation Utilities

This module provides deterministic, backend-only, reconciliation helper functions.

It is designed to be reused by:
	- HQ backend
	- Station server
	- Relay server

It does NOT:
	- Perform HTTP requests
	- Assume a specific DB schema
	- Mutate anything unless explicitly instructed via injected callbacks

Core Principles:
	- Validation is read-only.
	- Repair is explicit and minimal.
	- No trust of transport source.
	- Signature + hash(body) are authoritative.
"""
from typing import Callable, Optional, Dict, Any, List

# TYPE CONTRACTS (Injected Functions)

# Required injected callables:
# get_block_by_index(index: int) -> Optional[dict]
#     Returns block dict or None if not present.

# get_local_tip_index() -> int
#     Returns highest locally stored block index.

# recompute_block_hash(block: dict) -> Optional[str]
#     Deterministic SHA256 over canonical JSON body.

# verify_block_signature(block: dict) -> bool
#     Verifies detached PGP signature over canonical header.

# delete_blocks_from_index(index: int) -> None
#     Deletes blocks >= index.

# fetch_blocks_from_source(start_index: int, count: int) -> List[dict]
#     Returns sequential blocks from external source (station or HQ).

# store_block(block: dict) -> None
#     Persists a verified block.

from canonical_block import canonical_block_hash 		# shared canonical hash function for utility, relay, station and HQ

def validate_local_chain_segment(  # validate local chain from start to tip
	get_block_by_index: Callable[[int], Optional[Dict[str, Any]]],  # block fetcher
	get_local_tip_index: Callable[[], int],  # tip index fetcher
	verify_block_signature: Callable[[Dict[str, Any]], bool],  # signature verifier
	start_index: int = 0,  # optional start index
) -> Dict[str, Any]:
	"""
	Sequentially validates local chain from start_index to tip.  # behavior summary

	Returns:  # return shape description
		{
			"valid": bool,  # overall validity
			"first_invalid_index": Optional[int],  # first invalid index or None
			"local_tip": int,  # local tip index
			"no_chain": bool,  # whether no chain exists
		}
	"""

	local_tip = get_local_tip_index()  # read local tip index

	if local_tip < 0:  # handle empty DB (no genesis)
		return {  # return explicit no-chain state
			"valid": False,  # not valid because chain missing
			"first_invalid_index": None,  # no invalid index (no chain)
			"local_tip": -1,  # explicit empty tip
			"no_chain": True,  # no-chain flag
		}

	previous_hash: Optional[str] = None  # track previous hash for linkage checks

	for index in range(start_index, local_tip + 1):  # iterate through chain
		block = get_block_by_index(index)  # fetch block by index

		if block is None:  # missing block means invalid chain
			return {  # return invalid state
				"valid": False,  # invalid
				"first_invalid_index": index,  # missing index is invalid
				"local_tip": local_tip,  # report tip
				"no_chain": False,  # chain exists but invalid
			}

		expected_hash = canonical_block_hash(block)  # recompute canonical hash
		if not expected_hash or expected_hash != block.get("hash"):  # hash mismatch
			return {  # return invalid state
				"valid": False,  # invalid
				"first_invalid_index": index,  # first mismatch index
				"local_tip": local_tip,  # report tip
				"no_chain": False,  # chain exists but invalid
			}

		if not verify_block_signature(block):  # signature must verify
			return {  # return invalid state
				"valid": False,  # invalid
				"first_invalid_index": index,  # first signature failure index
				"local_tip": local_tip,  # report tip
				"no_chain": False,  # chain exists but invalid
			}

		if index > start_index:  # linkage check for non-genesis blocks
			if block.get("previous_hash") != previous_hash:  # linkage mismatch
				return {  # return invalid state
					"valid": False,  # invalid
					"first_invalid_index": index,  # first linkage failure
					"local_tip": local_tip,  # report tip
					"no_chain": False,  # chain exists but invalid
				}

		previous_hash = block.get("hash")  # update previous hash

	return {  # all checks passed
		"valid": True,  # chain valid
		"first_invalid_index": None,  # no invalid index
		"local_tip": local_tip,  # report tip
		"no_chain": False,  # chain exists
	}


def repair_local_chain_from(  # repair local chain from a given index
	first_invalid_index: int,  # index where corruption begins
	get_block_by_index: Callable[[int], Optional[Dict[str, Any]]],  # block fetcher
	get_local_tip_index: Callable[[], int],  # tip index fetcher
	anchor_floor: int,  # NEW: lowest stored index (pruned floor)
	verify_block_signature: Callable[[Dict[str, Any]], bool],  # signature verifier
	delete_blocks_from_index: Callable[[int], None],  # delete blocks >= index
	fetch_blocks_from_source: Callable[[int, int], List[Dict[str, Any]]],  # fetch blocks
	store_block: Callable[[Dict[str, Any]], None],  # store verified block
	safety_depth: int = 2,  # anchor depth before invalid index
	fetch_window: int = 50,  # max blocks to fetch for repair
) -> Dict[str, Any]:
	"""
	Repairs local chain starting at first_invalid_index.  # behavior summary
	"""

	if first_invalid_index is None:  # guard against invalid input
		return {  # fail fast without mutation
			"repaired": False,  # no repair performed
			"rolled_back_from": -1,  # no rollback
			"new_tip": get_local_tip_index(),  # report current tip
		}

	local_tip = get_local_tip_index()  # record current local tip

	# NEW: clamp anchor_start above the pruned floor
	anchor_start = max(anchor_floor, first_invalid_index - safety_depth)  # safe anchor start

	previous_hash: Optional[str] = None  # track hash for anchor validation

	# NEW: validate only the contiguous stored window
	for index in range(anchor_start, first_invalid_index):  # validate anchor region
		block = get_block_by_index(index)  # fetch block by index

		if block is None:  # missing anchor block => fail
			return {  # return failure
				"repaired": False,  # repair failed
				"rolled_back_from": first_invalid_index,  # rollback index
				"new_tip": local_tip,  # unchanged tip
			}

		expected_hash = canonical_block_hash(block)  # recompute hash
		if not expected_hash or expected_hash != block.get("hash"):  # hash mismatch
			return {  # return failure
				"repaired": False,  # repair failed
				"rolled_back_from": first_invalid_index,  # rollback index
				"new_tip": local_tip,  # unchanged tip
			}

		if not verify_block_signature(block):  # signature check
			return {  # return failure
				"repaired": False,  # repair failed
				"rolled_back_from": first_invalid_index,  # rollback index
				"new_tip": local_tip,  # unchanged tip
			}

		if index > anchor_start:  # linkage validation (skip anchor root)
			if block.get("previous_hash") != previous_hash:  # linkage mismatch
				return {  # return failure
					"repaired": False,  # repair failed
					"rolled_back_from": first_invalid_index,  # rollback index
					"new_tip": local_tip,  # unchanged tip
				}

		previous_hash = block.get("hash")  # update previous hash
		
	delete_blocks_from_index(first_invalid_index)  # roll back invalid suffix

	fetched_blocks = fetch_blocks_from_source(anchor_start, fetch_window)  # pull suffix

	if not fetched_blocks:  # if fetch failed
		return {  # return failure
			"repaired": False,  # repair failed
			"rolled_back_from": first_invalid_index,  # rollback index
			"new_tip": get_local_tip_index(),  # report tip after rollback
		}

	fetched_blocks = sorted(  # ensure deterministic order by index
		fetched_blocks,
		key=lambda b: b.get("block_index", -1),
	)

	first_fetched = fetched_blocks[0]  # inspect first fetched block
	if first_fetched.get("block_index") != anchor_start:  # enforce anchor start match
		return {  # return failure
			"repaired": False,  # repair failed
			"rolled_back_from": first_invalid_index,  # rollback index
			"new_tip": get_local_tip_index(),  # report tip after rollback
		}

	local_anchor = get_block_by_index(anchor_start)  # fetch local anchor block
	if local_anchor is None:  # missing local anchor
		return {  # return failure
			"repaired": False,  # repair failed
			"rolled_back_from": first_invalid_index,  # rollback index
			"new_tip": get_local_tip_index(),  # report tip after rollback
		}

	if local_anchor.get("hash") != first_fetched.get("hash"):  # anchor hash mismatch
		return {  # return failure
			"repaired": False,  # repair failed
			"rolled_back_from": first_invalid_index,  # rollback index
			"new_tip": get_local_tip_index(),  # report tip after rollback
		}

	previous_hash = None  # reset linkage tracking for fetched validation

	for block in fetched_blocks:  # validate fetched chain
		index = block.get("block_index")  # read index

		if index is None:  # malformed block
			return {  # return failure
				"repaired": False,  # repair failed
				"rolled_back_from": first_invalid_index,  # rollback index
				"new_tip": get_local_tip_index(),  # report tip
			}

		expected_hash = canonical_block_hash(block)  # recompute hash
		if not expected_hash or expected_hash != block.get("hash"):  # hash mismatch
			return {  # return failure
				"repaired": False,  # repair failed
				"rolled_back_from": first_invalid_index,  # rollback index
				"new_tip": get_local_tip_index(),  # report tip
			}

		if not verify_block_signature(block):  # signature mismatch
			return {  # return failure
				"repaired": False,  # repair failed
				"rolled_back_from": first_invalid_index,  # rollback index
				"new_tip": get_local_tip_index(),  # report tip
			}

		if previous_hash is not None:  # linkage check
			if block.get("previous_hash") != previous_hash:  # linkage mismatch
				return {  # return failure
					"repaired": False,  # repair failed
					"rolled_back_from": first_invalid_index,  # rollback index
					"new_tip": get_local_tip_index(),  # report tip
				}

		previous_hash = block.get("hash")  # update previous hash

	for block in fetched_blocks:  # store validated suffix
		if block.get("block_index") >= first_invalid_index:  # store only needed blocks
			store_block(block)  # persist verified block

	return {  # repair succeeded
		"repaired": True,  # success
		"rolled_back_from": first_invalid_index,  # rollback index
		"new_tip": get_local_tip_index(),  # report new tip
	}

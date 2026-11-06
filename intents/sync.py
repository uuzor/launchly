"""Chain → SQLite mirror for products, milestones, and posts.

Polls main-contract views over RPC, upserts `products_cache`, and binds
finalized drafts to product_ids by (founder, metadata_hash, rules_hash).
Chain is the source of truth: on mismatch the chain value wins and the
row is flagged. Stdlib only.
"""

import json
from datetime import datetime, timedelta, timezone

import chain as chainmod

SNAPSHOT_SPARK_N = 32
DAY_COVERAGE_MIN_HOURS = 23.0


def sync_products(store, contract_id, rpc_url=chainmod.TESTNET_RPC,
                  page=50):
    """Mirror all products. Returns (cached_count, newly_bound_drafts)."""
    cached, bound = 0, 0
    index = 0
    while True:
        batch = chainmod.rpc_view(rpc_url, contract_id, "list_products",
                                  {"from_index": index, "limit": page})
        if not batch:
            break
        # list_products returns bare Product objects (no id field) in key
        # order with dense 1-based keys, so ids are index + offset + 1.
        for offset, p in enumerate(batch):
            pid = index + offset + 1
            store.upsert_product_cache(
                pid, founder_account=p.get("founder", ""),
                token_account=(p.get("token_account")),
                metadata_hash=p.get("metadata_hash"),
                rules_hash=p.get("rules_hash"),
                chain_state_json=json.dumps(p))
            cached += 1
            if p.get("metadata_hash"):
                d = store.find_draft_by_hashes(
                    p.get("founder", ""), p.get("metadata_hash"),
                    p.get("rules_hash"))
                if d and not d["product_id"]:
                    store.upsert_draft(
                        d["draft_id"], d["edit_token_hash"],
                        founder_hint=d["founder_hint"], status="registered",
                        product_id=pid,
                        metadata_json=d["metadata_json"],
                        rules_json=d["rules_json"],
                        metadata_hash=d["metadata_hash"],
                        rules_hash=d["rules_hash"])
                    store.upsert_product_cache(
                        pid, founder_account=p.get("founder", ""),
                        token_account=p.get("token_account"),
                        metadata_hash=p.get("metadata_hash"),
                        rules_hash=p.get("rules_hash"), draft_id=d["draft_id"],
                        chain_state_json=json.dumps(p))
                    bound += 1
        index += len(batch)
        if len(batch) < page:
            break
    return cached, bound


def snapshot_stats(store, token_account, fee_bps=0):
    """Dashboard figures derived from keeper price snapshots (local reads).

    Returns {"change_24h_pct", "spark_tpu", "volume_24h_base",
    "fees_24h_base"}. Volume/fees are ESTIMATES: |reserve delta| summed over
    5-minute snapshot intervals. Single-trade intervals are exact; opposing
    trades inside one interval net out and undercount. change_24h_pct needs
    ~24h of snapshots, else None. All values None/[] when history is empty.
    """
    out = {"change_24h_pct": None, "spark_tpu": [],
           "volume_24h_base": None, "fees_24h_base": None}
    if not token_account:
        return out
    snaps = store.list_snapshots(token_account, limit=1000)
    if not snaps:
        return out
    try:
        tpus = [int(s["tokens_per_unit"]) for s in snaps]
        reserves = [int(s["reserve"]) for s in snaps]
        times = [datetime.fromisoformat(s["taken_at"].replace("Z", "+00:00"))
                 for s in snaps]
    except (KeyError, ValueError):
        return out
    out["spark_tpu"] = [str(t) for t in tpus[-SNAPSHOT_SPARK_N:]]
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=24)
    # change: latest vs closest snapshot at/before 24h ago
    eligible = [i for i, t in enumerate(times) if t <= cutoff]
    if eligible and tpus[-1] > 0 and tpus[eligible[-1]] > 0:
        aged_h = (now - times[eligible[-1]]).total_seconds() / 3600.0
        if aged_h >= DAY_COVERAGE_MIN_HOURS:
            out["change_24h_pct"] = round(
                (tpus[eligible[-1]] / tpus[-1] - 1.0) * 100.0, 2)
    # volume: |reserve delta| over intervals fully inside the last 24h
    vol = 0
    any_interval = False
    for i in range(1, len(snaps)):
        if times[i - 1] >= cutoff:
            vol += abs(reserves[i] - reserves[i - 1])
            any_interval = True
    if any_interval:
        out["volume_24h_base"] = str(vol)
        out["fees_24h_base"] = str(vol * int(fee_bps or 0) // 10000)
    return out


def product_feed(store):
    """Merged on-chain + off-chain feed for the dashboard."""
    out = []
    for row in store.list_cached_products():
        chain_state = json.loads(row["chain_state_json"] or "{}")
        item = {
            "product_id": row["product_id"],
            "founder": row["founder_account"],
            "token_account": row["token_account"],
            "status": chain_state.get("status"),
            "chain": chain_state,
            "stats": snapshot_stats(
                store, row["token_account"],
                chain_state.get("fee_bps", 0)),
            "metadata_hash": row["metadata_hash"],
            "rules_hash": row["rules_hash"],
            "metadata_state": "on-chain, no metadata"
            if not row["draft_id"] else "registered",
            "metadata": None,
        }
        cached_stats = store.get_stats(row["product_id"]) or {}
        item["stats"]["posts_count"] = cached_stats.get("posts_total")
        item["stats"]["creators_count"] = cached_stats.get("creators_total")
        if row["draft_id"]:
            d = store.get_draft(row["draft_id"])
            if d:
                match = (d["metadata_hash"] == row["metadata_hash"]
                         and d["rules_hash"] == row["rules_hash"])
                item["metadata_state"] = "registered" if match else "mismatch"
                item["metadata"] = json.loads(d["metadata_json"] or "{}")
        out.append(item)
    return out

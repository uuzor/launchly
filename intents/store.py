"""SQLite persistence for the Launchly backend. Stdlib only.

Tables cover the product registry (§4.5: drafts, assets, cache, milestones,
creator profiles, social links, post checks, content hashes, operator flags)
and the Intents flows (§4.2: quotes, swaps), plus a kv table for the cached
1Click token list and sync cursors.

Usage:
    from store import Store
    db = Store("intents.db")  # or Store(":memory:") in tests
    db.upsert_draft(...)
    db.close()
"""

import hashlib
import json
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS drafts (
    draft_id TEXT PRIMARY KEY,
    edit_token_hash TEXT NOT NULL,
    founder_hint TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    product_id INTEGER NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    rules_json TEXT NOT NULL DEFAULT '{}',
    metadata_hash TEXT NULL,
    rules_hash TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
    sha256 TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES drafts(draft_id),
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products_cache (
    product_id INTEGER PRIMARY KEY,
    founder_account TEXT NOT NULL DEFAULT '',
    token_account TEXT NULL,
    metadata_hash TEXT NULL,
    rules_hash TEXT NULL,
    draft_id TEXT NULL,
    chain_state_json TEXT NOT NULL DEFAULT '{}',
    synced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    milestone_index INTEGER NULL,
    content_json TEXT NOT NULL DEFAULT '{}',
    evidence_hash TEXT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS creator_profiles (
    account TEXT PRIMARY KEY,
    payout_asset TEXT NULL,
    payout_chain TEXT NULL,
    payout_address TEXT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS social_links (
    account TEXT NOT NULL,
    platform TEXT NOT NULL,
    handle TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    simulated INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account, platform)
);
CREATE TABLE IF NOT EXISTS post_checks (
    post_id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL,
    cycle_id INTEGER NOT NULL,
    creator TEXT NOT NULL,
    post_hash TEXT NOT NULL,
    valid INTEGER NOT NULL,
    score INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    simulated INTEGER NOT NULL DEFAULT 1,
    checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS content_hashes (
    product_id INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    post_id INTEGER NOT NULL,
    PRIMARY KEY (product_id, content_hash)
);
CREATE TABLE IF NOT EXISTS operator_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    params_json TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS swaps (
    deposit_address TEXT PRIMARY KEY,
    quote_id INTEGER NULL REFERENCES quotes(id),
    status TEXT NOT NULL DEFAULT 'PENDING_DEPOSIT',
    receipt_json TEXT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_quota (
    sender TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (sender, day)
);
CREATE TABLE IF NOT EXISTS product_stats (
    product_id INTEGER PRIMARY KEY,
    posts_total INTEGER NOT NULL DEFAULT 0,
    creators_total INTEGER NOT NULL DEFAULT 0,
    cycles_seen INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    token_account TEXT NOT NULL DEFAULT '',
    tokens_per_unit TEXT NOT NULL DEFAULT '0',
    reserve TEXT NOT NULL DEFAULT '0',
    sold TEXT NOT NULL DEFAULT '0',
    supply TEXT NOT NULL DEFAULT '0',
    taken_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relay_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL DEFAULT '',
    receiver TEXT NOT NULL DEFAULT '',
    methods TEXT NOT NULL DEFAULT '',
    nonce INTEGER NOT NULL DEFAULT 0,
    max_block_height INTEGER NOT NULL DEFAULT 0,
    key_prefix TEXT NOT NULL DEFAULT '',
    decision TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
-- Finalized cycles are immutable on-chain, so pool + posts + per-creator
-- payouts for them are cached forever. Open cycles always hit RPC.
CREATE TABLE IF NOT EXISTS cycle_cache (
    product_id INTEGER NOT NULL,
    cycle_id INTEGER NOT NULL,
    pool_json TEXT NOT NULL,
    posts_json TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (product_id, cycle_id)
);
CREATE TABLE IF NOT EXISTS payout_cache (
    product_id INTEGER NOT NULL,
    cycle_id INTEGER NOT NULL,
    creator TEXT NOT NULL,
    payout TEXT NOT NULL,
    PRIMARY KEY (product_id, cycle_id, creator)
);
-- Claims the backend verified via tx_status (the contract exposes no
-- claimed view). First verified receipt wins.
CREATE TABLE IF NOT EXISTS claims (
    product_id INTEGER NOT NULL,
    cycle_id INTEGER NOT NULL,
    creator TEXT NOT NULL,
    amount TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (product_id, cycle_id, creator)
);
"""


def utcnow():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Store:
    def __init__(self, path=":memory:"):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def close(self):
        self.db.close()

    def _one(self, sql, args=()):
        row = self.db.execute(sql, args).fetchone()
        return dict(row) if row else None

    def _all(self, sql, args=()):
        return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    # ---- drafts ----
    def upsert_draft(self, draft_id, edit_token_hash, founder_hint="",
                     status="draft", product_id=None, metadata_json="{}",
                     rules_json="{}", metadata_hash=None, rules_hash=None):
        now = utcnow()
        self.db.execute(
            """INSERT INTO drafts (draft_id, edit_token_hash, founder_hint, status,
               product_id, metadata_json, rules_json, metadata_hash, rules_hash,
               created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(draft_id) DO UPDATE SET
                 status=excluded.status, product_id=excluded.product_id,
                 metadata_json=excluded.metadata_json, rules_json=excluded.rules_json,
                 metadata_hash=excluded.metadata_hash, rules_hash=excluded.rules_hash,
                 updated_at=excluded.updated_at""",
            (draft_id, edit_token_hash, founder_hint, status, product_id,
             metadata_json, rules_json, metadata_hash, rules_hash, now, now),
        )
        self.db.commit()

    def get_draft(self, draft_id):
        return self._one("SELECT * FROM drafts WHERE draft_id = ?", (draft_id,))

    def find_draft_by_hashes(self, founder_hint, metadata_hash, rules_hash):
        return self._one(
            """SELECT * FROM drafts WHERE founder_hint = ? AND metadata_hash = ?
               AND rules_hash = ?""",
            (founder_hint, metadata_hash, rules_hash),
        )

    # ---- assets ----
    def add_asset(self, sha256, draft_id, kind, mime, size):
        self.db.execute(
            "INSERT OR REPLACE INTO assets (sha256, draft_id, kind, mime, size,"
            " created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (sha256, draft_id, kind, mime, size, utcnow()),
        )
        self.db.commit()

    def get_asset(self, sha256):
        return self._one("SELECT * FROM assets WHERE sha256 = ?", (sha256,))

    def count_draft_assets(self, draft_id):
        row = self._one("SELECT COUNT(*) AS n FROM assets WHERE draft_id = ?",
                        (draft_id,))
        return row["n"]

    # ---- products cache ----
    def upsert_product_cache(self, product_id, founder_account="",
                             token_account=None, metadata_hash=None,
                             rules_hash=None, draft_id=None,
                             chain_state_json="{}"):
        self.db.execute(
            """INSERT INTO products_cache (product_id, founder_account, token_account,
               metadata_hash, rules_hash, draft_id, chain_state_json, synced_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(product_id) DO UPDATE SET
                 founder_account=excluded.founder_account,
                 token_account=excluded.token_account,
                 metadata_hash=excluded.metadata_hash,
                 rules_hash=excluded.rules_hash, draft_id=excluded.draft_id,
                 chain_state_json=excluded.chain_state_json,
                 synced_at=excluded.synced_at""",
            (product_id, founder_account, token_account, metadata_hash,
             rules_hash, draft_id, chain_state_json, utcnow()),
        )
        self.db.commit()

    def get_cached_product(self, product_id):
        return self._one("SELECT * FROM products_cache WHERE product_id = ?",
                         (product_id,))

    def list_cached_products(self):
        return self._all("SELECT * FROM products_cache ORDER BY product_id")

    # ---- milestones ----
    def add_milestone(self, product_id, content_json="{}",
                      evidence_hash=None, milestone_index=None,
                      status="draft"):
        cur = self.db.execute(
            """INSERT INTO milestones (product_id, milestone_index, content_json,
               evidence_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)""",
            (product_id, milestone_index, content_json, evidence_hash,
             status, utcnow()),
        )
        self.db.commit()
        return cur.lastrowid

    def list_milestones(self, product_id):
        return self._all(
            "SELECT * FROM milestones WHERE product_id = ? ORDER BY id",
            (product_id,))

    # ---- creator profiles / social ----
    def set_payout_preference(self, account, asset, chain, address):
        self.db.execute(
            """INSERT INTO creator_profiles (account, payout_asset, payout_chain,
               payout_address, updated_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(account) DO UPDATE SET payout_asset=excluded.payout_asset,
               payout_chain=excluded.payout_chain, payout_address=excluded.payout_address,
               updated_at=excluded.updated_at""",
            (account, asset, chain, address, utcnow()),
        )
        self.db.commit()

    def get_creator_profile(self, account):
        return self._one("SELECT * FROM creator_profiles WHERE account = ?",
                         (account,))

    def link_social(self, account, platform, handle, verified=False,
                    simulated=True):
        self.db.execute(
            """INSERT INTO social_links (account, platform, handle, verified,
               simulated) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(account, platform) DO UPDATE SET handle=excluded.handle,
               verified=excluded.verified, simulated=excluded.simulated""",
            (account, platform, handle, int(verified), int(simulated)),
        )
        self.db.commit()

    def get_social_link(self, account, platform):
        return self._one(
            "SELECT * FROM social_links WHERE account = ? AND platform = ?",
            (account, platform))

    # ---- post checks / content hashes ----
    def record_post_check(self, post_id, product_id, cycle_id, creator,
                          post_hash, valid, score, reason="",
                          simulated=True):
        self.db.execute(
            """INSERT OR REPLACE INTO post_checks (post_id, product_id, cycle_id,
               creator, post_hash, valid, score, reason, simulated, checked_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (post_id, product_id, cycle_id, creator, post_hash, int(valid),
             score, reason, int(simulated), utcnow()),
        )
        self.db.commit()

    def get_post_check(self, post_id):
        return self._one("SELECT * FROM post_checks WHERE post_id = ?",
                         (post_id,))

    def seen_content_hash(self, product_id, content_hash):
        return self._one(
            "SELECT * FROM content_hashes WHERE product_id = ? AND content_hash = ?",
            (product_id, content_hash)) is not None

    def seen_content_hash_other(self, product_id, content_hash, post_id):
        """True when a DIFFERENT post already claimed this content hash."""
        return self._one(
            """SELECT * FROM content_hashes WHERE product_id = ?
               AND content_hash = ? AND post_id != ?""",
            (product_id, content_hash, post_id)) is not None

    def add_content_hash(self, product_id, content_hash, post_id):
        self.db.execute(
            "INSERT OR IGNORE INTO content_hashes (product_id, content_hash,"
            " post_id) VALUES (?, ?, ?)",
            (product_id, content_hash, post_id),
        )
        self.db.commit()

    # ---- operator flags ----
    def flag_product(self, product_id, reason):
        cur = self.db.execute(
            "INSERT INTO operator_flags (product_id, reason, created_at)"
            " VALUES (?, ?, ?)",
            (product_id, reason, utcnow()),
        )
        self.db.commit()
        return cur.lastrowid

    # ---- quotes / swaps ----
    def add_quote(self, kind, params, response):
        cur = self.db.execute(
            "INSERT INTO quotes (kind, params_json, response_json, created_at)"
            " VALUES (?, ?, ?, ?)",
            (kind, json.dumps(params), json.dumps(response), utcnow()),
        )
        self.db.commit()
        return cur.lastrowid

    def get_quote(self, quote_id):
        return self._one("SELECT * FROM quotes WHERE id = ?", (quote_id,))

    def upsert_swap(self, deposit_address, status, quote_id=None,
                    receipt=None):
        self.db.execute(
            """INSERT INTO swaps (deposit_address, quote_id, status, receipt_json,
               updated_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(deposit_address) DO UPDATE SET status=excluded.status,
               receipt_json=COALESCE(excluded.receipt_json, receipt_json),
               updated_at=excluded.updated_at""",
            (deposit_address, quote_id, status,
             json.dumps(receipt) if receipt is not None else None, utcnow()),
        )
        self.db.commit()

    def get_swap(self, deposit_address):
        return self._one("SELECT * FROM swaps WHERE deposit_address = ?",
                         (deposit_address,))

    # ---- kv ----
    def kv_get(self, key):
        row = self._one("SELECT value FROM kv WHERE key = ?", (key,))
        return row["value"] if row else None

    def kv_set(self, key, value):
        self.db.execute(
            "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value,"
            " updated_at=excluded.updated_at",
            (key, value, utcnow()),
        )
        self.db.commit()

    # ---- relay ----
    def relay_quota_use(self, sender, limit, today=None):
        """Bump the sender's daily accept-count. Returns (allowed, used)."""
        day = today or time.strftime("%Y-%m-%d", time.gmtime())
        row = self._one(
            "SELECT count FROM relay_quota WHERE sender = ? AND day = ?",
            (sender, day))
        used = (row["count"] if row else 0) + 1
        if used > limit:
            return False, used - 1
        self.db.execute(
            "INSERT INTO relay_quota (sender, day, count)"
            " VALUES (?, ?, ?)"
            " ON CONFLICT(sender, day) DO UPDATE SET count=excluded.count",
            (sender, day, used),
        )
        self.db.commit()
        return True, used

    def record_relay(self, sender, receiver, methods, nonce,
                     max_block_height, key_prefix, decision, reason=""):
        self.db.execute(
            "INSERT INTO relay_log (sender, receiver, methods, nonce,"
            " max_block_height, key_prefix, decision, reason, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (sender, receiver, methods, nonce, max_block_height,
             key_prefix, decision, reason, utcnow()),
        )
        self.db.commit()

    def list_relay_log(self, limit=20):
        return self._all(
            "SELECT * FROM relay_log ORDER BY id DESC LIMIT ?",
            (max(1, min(100, limit)),))

    # ---- product stats (keeper-cached, from chain views) ----
    def upsert_stats(self, product_id, posts_total, creators_total,
                     cycles_seen):
        self.db.execute(
            "INSERT INTO product_stats (product_id, posts_total,"
            " creators_total, cycles_seen, updated_at)"
            " VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(product_id) DO UPDATE SET posts_total=excluded.posts_total,"
            " creators_total=excluded.creators_total, cycles_seen=excluded.cycles_seen,"
            " updated_at=excluded.updated_at",
            (product_id, posts_total, creators_total, cycles_seen,
             utcnow()),
        )
        self.db.commit()

    def get_stats(self, product_id):
        return self._one("SELECT * FROM product_stats WHERE product_id = ?",
                         (product_id,))

    # ---- price snapshots ----
    def add_snapshot(self, product_id, token_account, tokens_per_unit,
                     reserve, sold, supply):
        self.db.execute(
            "INSERT INTO price_snapshots (product_id, token_account,"
            " tokens_per_unit, reserve, sold, supply, taken_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (product_id, token_account, str(tokens_per_unit),
             str(reserve), str(sold), str(supply), utcnow()),
        )
        self.db.commit()

    def list_snapshots(self, token_account, since=None, until=None,
                       limit=500):
        sql = ("SELECT * FROM price_snapshots WHERE token_account = ?")
        args = [token_account]
        if since:
            sql += " AND taken_at >= ?"
            args.append(since)
        if until:
            sql += " AND taken_at <= ?"
            args.append(until)
        sql += " ORDER BY taken_at ASC LIMIT ?"
        args.append(max(1, min(1000, limit)))
        return self._all(sql, tuple(args))

    # ---- finalized cycle cache + verified claims ----
    def get_cycle_cache(self, product_id, cycle_id):
        return self._one(
            "SELECT * FROM cycle_cache WHERE product_id = ?"
            " AND cycle_id = ?",
            (product_id, cycle_id))

    def put_cycle_cache(self, product_id, cycle_id, pool_json,
                        posts_json):
        self.db.execute(
            "INSERT INTO cycle_cache (product_id, cycle_id, pool_json,"
            " posts_json, synced_at) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(product_id, cycle_id) DO UPDATE SET"
            " pool_json=excluded.pool_json,"
            " posts_json=excluded.posts_json,"
            " synced_at=excluded.synced_at",
            (product_id, cycle_id, pool_json, posts_json, utcnow()),
        )
        self.db.commit()

    def get_payout_cache(self, product_id, cycle_id, creator):
        row = self._one(
            "SELECT payout FROM payout_cache WHERE product_id = ?"
            " AND cycle_id = ? AND creator = ?",
            (product_id, cycle_id, creator))
        return row["payout"] if row else None

    def put_payout_cache(self, product_id, cycle_id, creator, payout):
        self.db.execute(
            "INSERT INTO payout_cache (product_id, cycle_id, creator,"
            " payout) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(product_id, cycle_id, creator) DO UPDATE SET"
            " payout=excluded.payout",
            (product_id, cycle_id, creator, str(payout)),
        )
        self.db.commit()

    def record_claim(self, product_id, cycle_id, creator, amount,
                     tx_hash):
        """First verified receipt wins; later reports are ignored."""
        self.db.execute(
            "INSERT INTO claims (product_id, cycle_id, creator, amount,"
            " tx_hash, claimed_at) VALUES (?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(product_id, cycle_id, creator) DO NOTHING",
            (product_id, cycle_id, creator, str(amount), tx_hash,
             utcnow()),
        )
        self.db.commit()

    def get_claim(self, product_id, cycle_id, creator):
        return self._one(
            "SELECT * FROM claims WHERE product_id = ? AND cycle_id = ?"
            " AND creator = ?",
            (product_id, cycle_id, creator))

    def list_claims(self, creator):
        return self._all(
            "SELECT * FROM claims WHERE creator = ?"
            " ORDER BY claimed_at DESC",
            (creator,))

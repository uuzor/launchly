"""Product registry: drafts, canonical JSON + hashing, uploads, creators.

Implements backend.md §4.5. The chain holds identity + anchors
(product_id, founder, metadata_hash, rules_hash); this module holds the
content and the draft → product binding inputs. Stdlib only.
"""

import hashlib
import hmac
import json
import os
import secrets
import uuid

# ---- canonical JSON ----

CANON_SEP = (",", ":")


def canonical_bytes(obj) -> bytes:
    """Canonical form: UTF-8, sorted keys, no insignificant whitespace,
    trailing newline. sha256 over these bytes is the on-chain anchor."""
    return (json.dumps(obj, sort_keys=True, separators=CANON_SEP,
                       ensure_ascii=False) + "\n").encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def is_hex64(s) -> bool:
    return (isinstance(s, str) and len(s) == 64
            and all(c in "0123456789abcdef" for c in s))


# ---- validation (backend limits are stricter than chain limits) ----

NAME_LEN = (2, 60)
SYMBOL_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
SYMBOL_LEN = (2, 10)
TAGLINE_LEN = 120
DESCRIPTION_LEN = 2000
PROBLEM_LEN = 500
DEMO_URL_LEN = 300
BANNED_NOTES_LEN = 500
MAX_TAGS = 5
LOGO_MAX = 512 * 1024
SCREENSHOT_MAX = 1024 * 1024
MAX_SCREENSHOTS = 4
ASSET_KINDS = {"logo": LOGO_MAX}
for _i in range(MAX_SCREENSHOTS):
    ASSET_KINDS[f"screenshot-{_i}"] = SCREENSHOT_MAX

MIME_BY_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"RIFF", "image/webp"),  # + b"WEBP" at offset 8, checked below
)


def sniff_mime(data: bytes):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) > 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_metadata(m) -> list:
    errs = []
    name = m.get("name", "")
    if not (NAME_LEN[0] <= len(name) <= NAME_LEN[1]):
        errs.append("name must be 2-60 chars")
    sym = m.get("symbol", "")
    if not (SYMBOL_LEN[0] <= len(sym) <= SYMBOL_LEN[1]
            and all(c in SYMBOL_CHARS for c in sym)):
        errs.append("symbol must be 2-10 chars A-Z0-9")
    if len(m.get("tagline", "")) > TAGLINE_LEN or not m.get("tagline"):
        errs.append("tagline required, max 120 chars")
    if not (0 < len(m.get("description", "")) <= DESCRIPTION_LEN):
        errs.append("description required, max 2000 chars")
    if not (0 < len(m.get("problem", "")) <= PROBLEM_LEN):
        errs.append("problem required, max 500 chars")
    if not m.get("category"):
        errs.append("category required")
    if len(m.get("tags", [])) > MAX_TAGS:
        errs.append("max 5 tags")
    demo = m.get("demo_url", "")
    if not (demo.startswith("https://") and len(demo) <= DEMO_URL_LEN):
        errs.append("demo_url must be https, max 300 chars")
    for field in ("website_url", "repo_url"):
        if m.get(field) and not m[field].startswith("https://"):
            errs.append(f"{field} must be https")
    if not m.get("logo"):
        errs.append("logo asset ref required")
    if len(m.get("screenshots", [])) > MAX_SCREENSHOTS:
        errs.append("max 4 screenshots")
    return errs


def validate_rules(r, chain_max_posts=None) -> list:
    errs = []
    if not r.get("required_link", "").startswith("https://"):
        errs.append("required_link must be https")
    if not r.get("required_tag", "").startswith("#"):
        errs.append("required_tag must start with #")
    if int(r.get("min_account_age_days", 7)) < 0:
        errs.append("min_account_age_days must be >= 0")
    if len(r.get("banned_content_notes", "")) > BANNED_NOTES_LEN:
        errs.append("banned_content_notes max 500 chars")
    cap = r.get("max_counted_posts_per_creator")
    if chain_max_posts is not None and cap != chain_max_posts:
        errs.append("max_counted_posts_per_creator must match chain value")
    return errs


# ---- drafts ----

def new_edit_token() -> str:
    return secrets.token_bytes(32).hex()


def hash_token(token: str) -> str:
    return sha256_hex(token.encode())


class DraftError(Exception):
    pass


class Products:
    def __init__(self, store, upload_dir="./uploads"):
        self.store = store
        self.upload_dir = upload_dir

    def _authed(self, draft_id, edit_token):
        d = self.store.get_draft(draft_id)
        if not d:
            raise DraftError("unknown draft")
        if not hmac.compare_digest(d["edit_token_hash"],
                                   hash_token(edit_token)):
            raise DraftError("bad edit token")
        return d

    def create_draft(self, founder_hint=""):
        draft_id = uuid.uuid4().hex
        token = new_edit_token()
        self.store.upsert_draft(draft_id, hash_token(token),
                                founder_hint=founder_hint)
        return {"draft_id": draft_id, "edit_token": token}

    def get_draft(self, draft_id, edit_token):
        d = self._authed(draft_id, edit_token)
        return {
            "draft_id": d["draft_id"], "status": d["status"],
            "product_id": d["product_id"],
            "metadata": json.loads(d["metadata_json"] or "{}"),
            "rules": json.loads(d["rules_json"] or "{}"),
            "metadata_hash": d["metadata_hash"],
            "rules_hash": d["rules_hash"],
        }

    def update_draft(self, draft_id, edit_token, metadata=None, rules=None):
        d = self._authed(draft_id, edit_token)
        if d["status"] not in ("draft",):
            raise DraftError("draft is frozen")
        self.store.upsert_draft(
            draft_id, d["edit_token_hash"], founder_hint=d["founder_hint"],
            metadata_json=json.dumps(metadata) if metadata is not None
            else d["metadata_json"],
            rules_json=json.dumps(rules) if rules is not None
            else d["rules_json"])

    def finalize(self, draft_id, edit_token, chain_max_posts=None):
        """Validate, freeze, hash. Returns hashes + exact create_product args."""
        d = self._authed(draft_id, edit_token)
        if d["status"] not in ("draft",):
            raise DraftError("already finalized")
        metadata = json.loads(d["metadata_json"] or "{}")
        rules = json.loads(d["rules_json"] or "{}")
        errs = validate_metadata(metadata) + validate_rules(
            rules, chain_max_posts)
        if errs:
            raise DraftError("; ".join(errs))
        m_hash = sha256_hex(canonical_bytes(metadata))
        r_hash = sha256_hex(canonical_bytes(rules))
        self.store.upsert_draft(
            draft_id, d["edit_token_hash"], founder_hint=d["founder_hint"],
            status="finalized", metadata_json=d["metadata_json"],
            rules_json=d["rules_json"], metadata_hash=m_hash,
            rules_hash=r_hash)
        return {
            "metadata_hash": m_hash,
            "rules_hash": r_hash,
            "create_args": {
                "name": metadata["name"], "symbol": metadata["symbol"],
                "description": metadata["tagline"],
                "demo_url": metadata["demo_url"],
                "metadata_hash": m_hash, "rules_hash": r_hash,
            },
        }

    def draft_status(self, draft_id, edit_token):
        d = self._authed(draft_id, edit_token)
        if d["product_id"]:
            return "live"
        if d["status"] == "finalized":
            return "launching"
        return "draft"

    # ---- uploads ----
    def put_asset(self, draft_id, edit_token, kind, data: bytes):
        d = self._authed(draft_id, edit_token)
        if d["status"] not in ("draft",):
            raise DraftError("draft is frozen")
        if kind not in ASSET_KINDS:
            raise DraftError(f"bad kind (want one of {sorted(ASSET_KINDS)})")
        if len(data) > ASSET_KINDS[kind] or not data:
            raise DraftError("bad size")
        mime = sniff_mime(data)
        if not mime:
            raise DraftError("only PNG/JPEG/WebP by magic bytes (no SVG)")
        digest = sha256_hex(data)
        subdir = os.path.join(self.upload_dir, digest[:2])
        os.makedirs(subdir, exist_ok=True)
        with open(os.path.join(subdir, digest), "wb") as f:
            f.write(data)
        self.store.add_asset(digest, draft_id, kind, mime, len(data))
        return {"sha256": digest, "mime": mime, "size": len(data)}

    def get_asset_path(self, digest):
        if not is_hex64(digest):
            return None
        row = self.store.get_asset(digest)
        if not row:
            return None
        path = os.path.join(self.upload_dir, digest[:2], digest)
        return (path, row["mime"]) if os.path.exists(path) else None

    # ---- milestones ----
    def draft_milestone(self, product_id, content):
        if not content.get("title") or not content.get("summary"):
            raise DraftError("title and summary required")
        for url in content.get("evidence_urls", [])[:5]:
            if not url.startswith("https://"):
                raise DraftError("evidence urls must be https")
        h = sha256_hex(canonical_bytes(content))
        mid = self.store.add_milestone(product_id,
                                       content_json=json.dumps(content),
                                       evidence_hash=h)
        return {"id": mid, "evidence_hash": h}

    # ---- creators ----
    def set_payout_preference(self, account, asset, chain, address):
        if not asset or not chain or not address:
            raise DraftError("asset, chain, address all required")
        self.store.set_payout_preference(account, asset, chain, address)

    def get_creator(self, account, reserve_symbol="USDT", reserve_chain="near"):
        prof = self.store.get_creator_profile(account) or {}
        return {
            "account": account,
            "payout_asset": prof.get("payout_asset") or reserve_symbol,
            "payout_chain": prof.get("payout_chain") or reserve_chain,
            "payout_address": prof.get("payout_address"),
            "payout_defaulted": not bool(prof.get("payout_asset")),
        }

    def link_social(self, account, platform, handle):
        # MOCK in demo: no ownership proof. Real design: creator posts a
        # code from the linked account; see backend.md §4.5.
        self.store.link_social(account, platform, handle, verified=False,
                               simulated=True)
        return {"account": account, "platform": platform, "handle": handle,
                "verified": False, "simulated": True}

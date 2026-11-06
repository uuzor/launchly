"""Unit tests for relay.py. Decode vectors come from Rust
(relay_vectors.json, signed by near-primitives); policy tests mutate
copies. RPC height is patched; nothing touches the network."""

import base64
import json
import os
import unittest
from unittest.mock import patch

from store import Store
import relay
from relay import (RelayError, check_and_record, decode_signed_delegate,
                   rpc_height)


def _vectors():
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "relay_vectors.json")) as f:
        data = json.load(f)
    return {v["name"]: v for v in data["vectors"]}


V = _vectors()


class DecodeTests(unittest.TestCase):
    def test_rust_create_vector_decodes_exactly(self):
        v = V["create"]
        d = decode_signed_delegate(bytes.fromhex(v["borsh_hex"]))
        self.assertEqual(d["sender"], "alice.testnet")
        self.assertEqual(d["receiver"], "launchly.testnet")
        self.assertEqual(len(d["actions"]), 1)
        a = d["actions"][0]
        self.assertEqual(a["method_name"], "create_product")
        self.assertEqual(a["args_hex"], v["args_hex"])
        self.assertEqual(bytes.fromhex(a["args_hex"]),
                         b'{"name":"Widget"}')
        self.assertEqual(a["gas"], 100_000_000_000_000)
        self.assertEqual(a["deposit"], str(10 ** 24))
        self.assertEqual(d["nonce"], 7)
        self.assertEqual(d["max_block_height"], 19_000_000)
        self.assertEqual(d["public_key"]["curve"], "ed25519")
        self.assertEqual(len(d["public_key"]["key_hex"]), 64)
        self.assertEqual(len(d["signature"]["sig_hex"]), 128)

    def test_same_seed_same_key_both_vectors(self):
        a = decode_signed_delegate(bytes.fromhex(V["create"]["borsh_hex"]))
        b = decode_signed_delegate(bytes.fromhex(V["launch"]["borsh_hex"]))
        self.assertEqual(a["public_key"], b["public_key"])
        self.assertNotEqual(a["signature"], b["signature"])

    def test_multi_action_vector(self):
        d = decode_signed_delegate(bytes.fromhex(V["multi"]["borsh_hex"]))
        self.assertEqual([a["method_name"] for a in d["actions"]],
                         ["submit_post", "launch_coin"])
        self.assertEqual(d["nonce"], 9)

    def test_truncated_rejected(self):
        raw = bytes.fromhex(V["create"]["borsh_hex"])
        with self.assertRaises(RelayError):
            decode_signed_delegate(raw[:len(raw) // 2])

    def test_trailing_byte_rejected(self):
        raw = bytes.fromhex(V["create"]["borsh_hex"]) + b"\x00"
        with self.assertRaises(RelayError):
            decode_signed_delegate(raw)

    def test_non_functioncall_action_rejected(self):
        raw = bytearray(bytes.fromhex(V["create"]["borsh_hex"]))
        # sender(4+13) + receiver(4+16) = 37; count at 37, tag at 41.
        self.assertEqual(raw[37:41], b"\x01\x00\x00\x00")
        self.assertEqual(raw[41], 2)
        raw[41] = 8  # Delegate: nested meta-tx must never relay
        with self.assertRaises(RelayError):
            decode_signed_delegate(bytes(raw))

    def test_empty_and_oversize_rejected(self):
        with self.assertRaises(RelayError):
            decode_signed_delegate(b"")
        with self.assertRaises(RelayError):
            decode_signed_delegate(b"\x00" * (relay.MAX_DELEGATE_BYTES + 1))


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.db = Store(":memory:")

    def tearDown(self):
        self.db.close()

    def _raw(self, name="create"):
        return bytes.fromhex(V[name]["borsh_hex"])

    def test_accept_and_audit(self):
        out = check_and_record(
            self.db, "launchly.testnet", self._raw(),
            check_height=False, today="2026-11-06")
        self.assertTrue(out["accepted"])
        self.assertEqual(out["methods"], ["create_product"])
        self.assertEqual(out["broadcast"], "pending-signer")
        self.assertEqual((out["quota_used"], out["quota_limit"]), (1, 5))
        rows = self.db.list_relay_log(10)
        self.assertEqual(rows[0]["decision"], "accepted")
        self.assertEqual(rows[0]["sender"], "alice.testnet")

    def test_wrong_receiver_rejected(self):
        out = check_and_record(self.db, "other.testnet", self._raw(),
                               check_height=False)
        self.assertFalse(out["accepted"])
        self.assertIn("receiver", out["reason"])

    def test_disallowed_method_rejected(self):
        raw = bytearray(self._raw())
        old = b"create_product"
        i = bytes(raw).find(old)
        self.assertNotEqual(i, -1)
        raw[i:i + len(old)] = b"evil_method_01"  # same length
        out = check_and_record(self.db, "launchly.testnet", bytes(raw),
                               check_height=False)
        self.assertFalse(out["accepted"])
        self.assertIn("not allowlisted", out["reason"])

    def test_gas_over_cap_rejected(self):
        raw = bytearray(self._raw())
        i = bytes(raw).find(b"create_product")
        gas_at = i + 14 + 4 + 17  # method content + args vec
        self.assertEqual(int.from_bytes(raw[gas_at:gas_at + 8], "little"),
                         100_000_000_000_000)
        raw[gas_at:gas_at + 8] = (400 * 10 ** 12).to_bytes(8, "little")
        out = check_and_record(self.db, "launchly.testnet", bytes(raw),
                               check_height=False)
        self.assertFalse(out["accepted"])
        self.assertIn("gas", out["reason"])

    def test_too_many_actions_rejected(self):
        out = check_and_record(self.db, "launchly.testnet",
                               self._raw("multi"), check_height=False,
                               max_actions=1)
        self.assertFalse(out["accepted"])
        self.assertIn("too many actions", out["reason"])

    def test_fresh_and_expired_height(self):
        with patch("relay.rpc_height", return_value=18_000_000):
            out = check_and_record(
                self.db, "launchly.testnet", self._raw(),
                rpc_url="http://rpc", today="2026-11-06")
        self.assertTrue(out["accepted"])
        with patch("relay.rpc_height", return_value=20_000_000):
            out = check_and_record(
                self.db, "launchly.testnet", self._raw(),
                rpc_url="http://rpc", today="2026-11-06")
        self.assertFalse(out["accepted"])
        self.assertIn("expired", out["reason"])

    def test_height_unavailable_rejects_with_sender(self):
        with patch("relay.rpc_height",
                   side_effect=RelayError("height unavailable: down")):
            out = check_and_record(
                self.db, "launchly.testnet", self._raw(),
                rpc_url="http://rpc")
        self.assertFalse(out["accepted"])
        self.assertEqual(out["sender"], "alice.testnet")

    def test_quota_enforced_per_day(self):
        for _ in range(2):
            out = check_and_record(
                self.db, "launchly.testnet", self._raw(),
                check_height=False, max_per_day=2, today="2026-11-06")
            self.assertTrue(out["accepted"])
        out = check_and_record(
            self.db, "launchly.testnet", self._raw(),
            check_height=False, max_per_day=2, today="2026-11-06")
        self.assertFalse(out["accepted"])
        self.assertIn("quota", out["reason"])
        # Next day resets.
        out = check_and_record(
            self.db, "launchly.testnet", self._raw(),
            check_height=False, max_per_day=2, today="2026-11-07")
        self.assertTrue(out["accepted"])

    def test_garbage_audited_not_raised(self):
        out = check_and_record(self.db, "launchly.testnet", b"\x01\x02",
                               check_height=False)
        self.assertFalse(out["accepted"])
        rows = self.db.list_relay_log(10)
        self.assertEqual(rows[0]["decision"], "rejected")


class HeightTests(unittest.TestCase):
    def test_rpc_height_parses_status(self):
        import io

        class Resp:
            def read(self):
                return json.dumps(
                    {"result": {"sync_info":
                               {"latest_block_height": 123}}}).encode()

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        with patch("relay.urllib.request.urlopen", return_value=Resp()):
            self.assertEqual(rpc_height("http://rpc"), 123)

    def test_rpc_height_failure_is_relay_error(self):
        with patch("relay.urllib.request.urlopen",
                   side_effect=TimeoutError("slow")):
            with self.assertRaises(RelayError):
                rpc_height("http://rpc")


if __name__ == "__main__":
    unittest.main()

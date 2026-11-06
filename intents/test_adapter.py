"""Unit tests for the 1Click adapter. All HTTP is mocked: no network."""

import io
import json
import unittest
from unittest.mock import patch

import adapter
from adapter import OneClickClient, OneClickError, payin_quote, payout_quote


def _resp(payload):
    body = json.dumps(payload).encode()
    m = unittest.mock.MagicMock()
    m.__enter__.side_effect = lambda *a: io.BytesIO(body)
    m.__exit__.return_value = False
    return m


class TokensTests(unittest.TestCase):
    @patch("adapter.urllib.request.urlopen")
    def test_tokens_list(self, mock_open):
        mock_open.return_value = _resp(
            [{"assetId": "nep141:wrap.near", "symbol": "wNEAR", "blockchain": "near"}]
        )
        toks = OneClickClient().tokens()
        self.assertEqual(toks[0]["assetId"], "nep141:wrap.near")
        called_url = mock_open.call_args[0][0].full_url
        self.assertTrue(called_url.endswith("/v0/tokens"))

    @patch("adapter.urllib.request.urlopen")
    def test_find_asset_never_hand_builds_ids(self, mock_open):
        mock_open.return_value = _resp(
            [
                {"assetId": "nep141:wrap.near", "symbol": "wNEAR",
                 "blockchain": "near", "contractAddress": "wrap.near"},
                {"assetId": "nep141:eth.omft.near", "symbol": "ETH",
                 "blockchain": "eth", "contractAddress": None},
            ]
        )
        c = OneClickClient()
        eth = c.find_asset(symbol="eth", blockchain="eth")
        self.assertEqual(eth["assetId"], "nep141:eth.omft.near")
        with self.assertRaises(OneClickError):
            c.find_asset(symbol="NOPE")


class QuoteTests(unittest.TestCase):
    @patch("adapter.urllib.request.urlopen")
    def test_dry_quote_body(self, mock_open):
        mock_open.return_value = _resp({"quote": {"amountOut": "99"}})
        c = OneClickClient()
        res, addr = payin_quote(
            c, "nep141:eth.omft.near", "1000000000000000",
            "launchly.testnet", "nep141:usdt.tether-token.near",
        )
        self.assertIsNone(addr)  # dry: no deposit address
        sent = json.loads(mock_open.call_args[0][0].data.decode())
        self.assertTrue(sent["dry"])
        self.assertEqual(sent["swapType"], "EXACT_INPUT")
        self.assertEqual(sent["originAsset"], "nep141:eth.omft.near")
        self.assertEqual(sent["recipient"], "launchly.testnet")
        self.assertIn("deadline", sent)

    def test_live_quote_requires_explicit_opt_in(self):
        c = OneClickClient()
        with self.assertRaisesRegex(OneClickError, "allow_live"):
            c.quote("a", "b", "1", "r", "f", dry=False)
        # dry=False + flag would hit network: only assert the guard passes
        # construction by checking dry=True never raises (covered above).

    @patch("adapter.urllib.request.urlopen")
    def test_payout_quote_body(self, mock_open):
        mock_open.return_value = _resp({"quote": {}})
        _, _ = payout_quote(
            OneClickClient(), "nep141:usdt.tether-token.near", "5000",
            "nep141:usdc.omft.near", "0xcreator", "launchly.testnet",
        )
        sent = json.loads(mock_open.call_args[0][0].data.decode())
        self.assertEqual(sent["destinationAsset"], "nep141:usdc.omft.near")
        self.assertEqual(sent["refundTo"], "launchly.testnet")

    def test_deposit_address_extraction(self):
        self.assertEqual(
            OneClickClient.deposit_address({"quote": {"depositAddress": "abc"}}), "abc"
        )
        with self.assertRaises(OneClickError):
            OneClickClient.deposit_address({"quote": {}})


class StatusTests(unittest.TestCase):
    @patch("adapter.urllib.request.urlopen")
    def test_status_url(self, mock_open):
        mock_open.return_value = _resp({"status": "SUCCESS"})
        res = OneClickClient().status("addr 1")
        self.assertEqual(res["status"], "SUCCESS")
        called_url = mock_open.call_args[0][0].full_url
        self.assertIn("depositAddress=addr%201", called_url)

    @patch("adapter.time.sleep", return_value=None)
    @patch("adapter.urllib.request.urlopen")
    def test_wait_until_terminal(self, mock_open, _sleep):
        mock_open.side_effect = [
            _resp({"status": "PROCESSING"}),
            _resp({"status": "SUCCESS"}),
        ]
        res = OneClickClient().wait_for_status("addr", timeout_s=60, interval_s=0)
        self.assertEqual(res["status"], "SUCCESS")

    @patch("adapter.time.sleep", return_value=None)
    @patch("adapter.urllib.request.urlopen")
    def test_wait_timeout(self, mock_open, _sleep):
        mock_open.return_value = _resp({"status": "PROCESSING"})
        with self.assertRaisesRegex(OneClickError, "timed out"):
            OneClickClient().wait_for_status("addr", timeout_s=0.01, interval_s=0)


class ErrorTests(unittest.TestCase):
    @patch("adapter.urllib.request.urlopen")
    def test_http_error_wrapped(self, mock_open):
        import urllib.error

        mock_open.side_effect = urllib.error.HTTPError(
            "http://x", 400, "bad", {}, io.BytesIO(b"nope")
        )
        with self.assertRaisesRegex(OneClickError, "HTTP 400"):
            OneClickClient().tokens()


if __name__ == "__main__":
    unittest.main()

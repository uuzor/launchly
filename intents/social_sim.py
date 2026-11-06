"""Simulated social layer for the demo verifier. Stdlib only.

Maps (platform, handle, url) to fixture content. Every response carries
simulated: True. Real platform fetchers plug in behind fetch_post()
without touching the verifier.
"""

import json
import os

FIXTURE_PATH = os.path.join(os.path.dirname(__file__),
                            "social_fixtures.json")


class SocialSim:
    def __init__(self, fixtures=None):
        if fixtures is None:
            try:
                with open(FIXTURE_PATH) as f:
                    fixtures = json.load(f)
            except FileNotFoundError:
                fixtures = {}
        # key: "platform|handle|url" -> record
        self.fixtures = fixtures

    @staticmethod
    def key(platform, handle, url):
        return f"{platform}|{handle}|{url}"

    def fetch_post(self, platform, handle, url):
        rec = self.fixtures.get(self.key(platform, handle, url))
        if not rec:
            return None
        return {
            "content": rec.get("content", ""),
            "posted_at": rec.get("posted_at", ""),
            "account_age_days": rec.get("account_age_days", 0),
            "alive": bool(rec.get("alive", False)),
            "simulated": True,
        }

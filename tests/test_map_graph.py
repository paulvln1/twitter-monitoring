"""Tests du moteur de la map : python3 -m unittest discover tests"""
import json
import os
import sys
import tempfile
import unittest
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import map_graph as mg  # noqa: E402

DAY = date(2026, 11, 17)
WL = ["alice", "bob", "carol"]


def it(frm, to, tweet, d="2026-11-10", kind="rt", src=None):
    return {"date": d, "from": frm, "to": to, "type": kind, "target_tweet_id": str(tweet),
            "target_tweet_url": f"https://x.com/{to}/status/{tweet}",
            "source_tweet_url": src or f"https://x.com/{frm}/status/{frm}{tweet}{kind}"}


class Rules(unittest.TestCase):
    def kept(self, items, wl=WL):
        return set(mg.compute_map(wl, items, DAY))

    def test_one_viral_tweet_is_not_enough(self):
        # 1 tweet relayé par 3 comptes de la whitelist -> compte pour 1 tweet
        self.assertEqual(self.kept([it("alice", "x", 1), it("bob", "x", 1), it("carol", "x", 1)]), set())

    def test_single_fan_is_not_enough(self):
        # 4 tweets différents mais relayés par un seul compte de la whitelist
        self.assertEqual(self.kept([it("alice", "x", n) for n in range(4)]), set())

    def test_two_tweets_two_accounts(self):
        self.assertEqual(self.kept([it("alice", "x", 1), it("bob", "x", 2)]), {"x"})

    def test_window_30_days(self):
        old = it("alice", "x", 1, d="2026-10-18")  # 30 jours avant le 17/11 -> hors fenêtre
        edge = it("alice", "x", 1, d="2026-10-19")  # 29 jours avant -> dans la fenêtre
        self.assertEqual(self.kept([old, it("bob", "x", 2)]), set())
        self.assertEqual(self.kept([edge, it("bob", "x", 2)]), {"x"})

    def test_qualified_since(self):
        its = [it("alice", "x", 1, d="2026-11-03"), it("alice", "x", 2, d="2026-11-05"), it("bob", "x", 2, d="2026-11-09")]
        self.assertEqual(mg.qualified_since(its), "2026-11-09")

    def test_removed_from_whitelist_source_no_longer_counts(self):
        items = [it("alice", "x", 1), it("bob", "x", 2)]
        self.assertEqual(self.kept(items, wl=["alice", "carol"]), set())

    def test_promoted_account_loses_its_links(self):
        items = [it("alice", "x", 1), it("bob", "x", 2)]
        self.assertEqual(self.kept(items, wl=WL + ["x"]), set())

    def test_removed_account_becomes_candidate_again(self):
        items = [it("alice", "carol", 1), it("bob", "carol", 2)]
        self.assertEqual(self.kept(items, wl=["alice", "bob"]), {"carol"})


class Extraction(unittest.TestCase):
    base = {"account": "alice", "tweetUrl": "https://x.com/alice/status/100", "postedDate": "2026-11-16T10:00:00Z",
            "tweetText": "hello"}

    def test_retweet(self):
        out = mg.interactions_from_tweet({**self.base, "retweetedTweetUrl": "https://x.com/Bob_2/status/42"})
        self.assertEqual([(o["type"], o["to"], o["target_tweet_id"]) for o in out], [("rt", "bob_2", "42")])

    def test_quote_and_reply_in_one_tweet(self):
        out = mg.interactions_from_tweet({**self.base, "quotedTweetUrl": "https://x.com/q/status/1",
                                          "isReply": True, "replyToHandle": "r",
                                          "replyToTweetUrl": "https://x.com/i/status/2"})
        self.assertEqual(sorted((o["type"], o["to"]) for o in out), [("quote", "q"), ("reply", "r")])
        self.assertEqual([o["target_tweet_url"] for o in out if o["type"] == "reply"], ["https://x.com/r/status/2"])

    def test_self_reply_ignored(self):
        out = mg.interactions_from_tweet({**self.base, "isReply": True, "replyToHandle": "Alice",
                                          "replyToTweetUrl": "https://x.com/i/status/2"})
        self.assertEqual(out, [])

    def test_plain_tweet_and_bad_handle(self):
        self.assertEqual(mg.interactions_from_tweet(self.base), [])
        out = mg.interactions_from_tweet({**self.base, "quotedTweetUrl": "https://x.com/i/status/5"})
        self.assertEqual(out, [])


class Storage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        mg.GRAPH_DIR = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_dedup(self):
        items = [it("alice", "x", 1), it("bob", "x", 2)]
        self.assertEqual(mg.append_interactions(items), 2)
        self.assertEqual(mg.append_interactions(items), 0)
        self.assertEqual(len(mg.load_interactions()), 2)

    def test_build_and_oneliner_todo(self):
        mg.append_interactions([it("alice", "x", 1, d="2026-11-10"), it("bob", "x", 2, d="2026-11-12")])
        accounts = os.path.join(self.tmp.name, "accounts.txt")
        with open(accounts, "w") as f:
            f.write("# commentaire\n@Alice\nbob\ncarol\n")
        os.environ.update(ACCOUNTS_FILE=accounts, MAP_TODAY="2026-11-17")
        try:
            mg.cmd_build([])
            g = mg.load_json("graph.json", {})
            todo = mg.load_json("oneliners_todo.json", [])
            self.assertEqual(g["whitelist"], WL)
            cand = [n for n in g["nodes"] if n["kind"] == "candidate"]
            self.assertEqual([(n["id"], n["tweets"], n["latest"]["tweet_url"]) for n in cand],
                             [("x", 2, "https://x.com/x/status/2")])
            self.assertEqual([t["handle"] for t in todo], ["x"])
            # Claude écrit le one-liner -> il disparaît de la todo
            mg.save_json("oneliners.json", {"x": {"text": "Great thread.", "tweet_id": "2"}})
            mg.cmd_build([])
            self.assertEqual(mg.load_json("oneliners_todo.json", None), [])
            self.assertEqual(mg.load_json("graph.json", {})["nodes"][-1]["oneliner"], "Great thread.")
            # un nouveau tweet relayé -> le one-liner est à réécrire
            mg.append_interactions([it("carol", "x", 3, d="2026-11-15")])
            mg.cmd_build([])
            self.assertEqual([t["tweet_id"] for t in mg.load_json("oneliners_todo.json", [])], ["3"])
        finally:
            os.environ.pop("ACCOUNTS_FILE")
            os.environ.pop("MAP_TODAY")


if __name__ == "__main__":
    unittest.main()

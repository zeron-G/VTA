import tempfile
import unittest
from pathlib import Path

from scripts.check_docs import check


class DocumentationCheckTests(unittest.TestCase):
    def test_accepts_existing_relative_and_external_links(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "docs").mkdir()
            (root / "docs" / "guide.md").write_text("# Guide\n", encoding="utf-8")
            (root / "README.md").write_text(
                "[Guide](docs/guide.md) [Section](#section) "
                "[External](https://example.com)\n",
                encoding="utf-8",
            )

            self.assertEqual(check(root), [])

    def test_reports_missing_and_escaping_links(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "README.md").write_text(
                "[Missing](docs/missing.md) [Escape](../outside.md)\n",
                encoding="utf-8",
            )

            errors = check(root)

        self.assertEqual(len(errors), 2)
        self.assertTrue(any("missing target" in error for error in errors))
        self.assertTrue(any("escapes repository" in error for error in errors))


if __name__ == "__main__":
    unittest.main()

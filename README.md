# disney-store-watch

Tracks what's new on **disneystore.com**. Every 3 hours a GitHub Action fetches the New Arrivals grid, the Featured/Coming Soon page and the full product sitemap, diffs them against the previous snapshot in `data/`, commits the new snapshot, and (only when something changed) posts the report as a comment on the open issue labelled `log`.

- `scan.mjs`: the whole scanner, no dependencies, Node 20+. `node scan.mjs`
- `data/new.csv`: every item on /new/ (rank, id, name, price, category, character, stock, badge, url)
- `data/featured.csv`: items on the Featured / Coming Soon page
- `data/sitemap.txt`: every product URL in the catalog sitemap (~4,800)
- `data/report.md`: the latest diff report; first line is a `CHANGES:` summary
- `data/last-run.json`: counts from the latest run

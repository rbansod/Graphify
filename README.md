# Doc Atlas

Paste a URL or drop a document, get back two views of it:

1. **Table of contents** — the heading hierarchy (H1–H6, or inferred levels for PDFs), copyable as Markdown.
2. **Topic map** — an interactive force-directed graph of the terms the document keeps returning to. Node size and the `× N` label show mention counts; edges connect topics that co-occur in the same sections, weighted by how many sections they share. Click a node for its connections and the sections it appears in; click a TOC entry to spotlight that section's topics on the map.

Supported inputs: any URL, plus **PDF, DOCX, HTML, Markdown, and TXT** uploads. Everything runs client-side in the browser — no backend, no data leaves the user's machine (except the page fetch itself).

## Run locally

No build step. Any static server works:

```bash
git clone https://github.com/<you>/doc-atlas.git
cd doc-atlas
python3 -m http.server 8080
# open http://localhost:8080
```

(Opening `index.html` directly via `file://` mostly works, but `fetch` and the PDF worker behave better over HTTP.)

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (files at the repo root: `index.html`, `styles.css`, `app.js`).
2. In the repo: **Settings → Pages → Build and deployment**.
3. Source: **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. The site goes live at `https://<you>.github.io/<repo>/` within a minute or two.

No Actions workflow is needed since there is no build step.

## How it works

```
input (URL | file)
   └─ loader          fetch w/ CORS-proxy fallback · pdf.js · mammoth · DOMParser
        └─ extractor  → { title, headings[], sections[] }   (section = text between headings)
             ├─ TOC renderer  (nested outline + Markdown export)
             └─ topic analyzer
                  ├─ tokenize, stopword filter, singular/plural merge
                  ├─ score unigrams + recurring bigrams → top ~26 topics
                  ├─ co-occurrence: +1 edge weight per shared section
                  └─ prune to each node's strongest edges
                       └─ D3 force layout (drag, zoom, hover-highlight, detail card)
```

Per-format extraction:

| Format | Headings from | Notes |
|---|---|---|
| URL / HTML | `<h1>`–`<h6>` **plus heuristic detection** for headings living in divs/spans/bold text | see "Heading detection" below |
| PDF | font-size heuristics via pdf.js | largest recurring sizes → levels 1–4; scanned PDFs (images only) yield no text |
| DOCX | mammoth → HTML → same path as HTML | heading styles map to `<h1>`–`<h6>` |
| Markdown | `#` prefixes | fenced code blocks ignored |
| TXT | none | paragraphs grouped into windows for co-occurrence |

### Heading detection in unstructured HTML

Real pages often skip `<h1>`–`<h6>` entirely, so the HTML extractor doesn't rely on them. It linearizes the DOM into text blocks (runs of inline content inside any container — divs, spans, whatever), then scores every block for "headingness":

- **Definite:** `h1`–`h6`, `role="heading"` (level from `aria-level`)
- **Class/id hints:** `title`, `heading`, `headline`, `subtitle`, `section-title`, … (+); `nav`, `footer`, `btn`, `breadcrumb`, `meta`, … (−)
- **Inline styling:** `font-size` ≥ 17px, `font-weight` ≥ 600, or the whole block wrapped in a single `<b>`/`<strong>`
- **Text shape:** short (≤ 90 chars), few words, no terminal punctuation, Title Case / ALL CAPS
- **Position:** followed by a longer block of body text

Blocks above a threshold become headings. On pages that *do* have real `h1`–`h6` structure, the threshold rises so only strongly-signaled extras are added; on structureless pages it relaxes. Levels come from inline font size where available (largest = level 1); unsized detections share a peer level. External stylesheets can't be resolved through `DOMParser`, so styling signals are inline-only — class hints and text shape carry pages styled purely via CSS files.

## Known limitations

- **CORS.** Direct cross-origin fetches usually fail. Out of the box the app falls back to public proxies (`allorigins.win`, `corsproxy.io`), which are best-effort third-party services. For reliability, deploy the included Cloudflare Worker (below) — it becomes the first fallback and removes the third-party dependency.
- **JavaScript-rendered pages.** The fetch returns raw HTML; SPAs that render client-side will look empty. Print-to-PDF or save the rendered page as HTML and upload.
- **English stopwords only.** Other languages still work, but common function words will show up as topics unless you extend `STOPWORDS` in `app.js`.
- **PDF outline quality** depends on the document using consistent font sizes for headings.

## Optional: deploy your own fetch proxy (Cloudflare Worker)

The `worker/` directory contains a hardened CORS proxy so URL fetching doesn't depend on public proxy services. Free-tier Workers (100k requests/day) is more than enough.

```bash
cd worker
npx wrangler login      # once — opens browser auth
npx wrangler deploy
# → https://doc-atlas-proxy.<your-account>.workers.dev
```

Then point the frontend at it — one line in `app.js`:

```js
const OWN_PROXY = "https://doc-atlas-proxy.<your-account>.workers.dev";
```

The fetch order becomes: direct → your worker → public fallbacks.

Before sharing the site publicly, lock the worker down in `worker/worker.js`:

```js
const ALLOWED_ORIGINS = ["https://<you>.github.io"];  // replace the "*"
```

What the worker enforces:

- **SSRF guardrails** — only `http(s)` targets; loopback, RFC-1918 ranges, link-local (169.254.x — cloud metadata), and `.internal`/`.local` hosts are rejected.
- **8 MB response cap** and a 15 s upstream timeout.
- **5-minute edge caching** of fetched pages, which also keeps you well under the free-tier request limit.
- Origin allowlist via CORS, so other sites can't quietly use your proxy.

## Stack

Vanilla JS + [D3 v7](https://d3js.org/) (graph), [pdf.js](https://mozilla.github.io/pdf.js/) (PDF text), [mammoth](https://github.com/mwilliamson/mammoth.js) (DOCX), all loaded from CDN. IBM Plex type via Google Fonts.

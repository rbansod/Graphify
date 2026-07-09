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
| URL / HTML | `<h1>`–`<h6>` inside `main`/`article`/`body` | nav, footer, scripts, forms stripped first |
| PDF | font-size heuristics via pdf.js | largest recurring sizes → levels 1–4; scanned PDFs (images only) yield no text |
| DOCX | mammoth → HTML → same path as HTML | heading styles map to `<h1>`–`<h6>` |
| Markdown | `#` prefixes | fenced code blocks ignored |
| TXT | none | paragraphs grouped into windows for co-occurrence |

## Known limitations

- **CORS.** Direct cross-origin fetches usually fail, so the app falls back to public proxies (`allorigins.win`, `corsproxy.io`). Some sites block these too, and proxies are best-effort third-party services — for anything sensitive or internal, save the page and upload it instead.
- **JavaScript-rendered pages.** The fetch returns raw HTML; SPAs that render client-side will look empty. Print-to-PDF or save the rendered page as HTML and upload.
- **English stopwords only.** Other languages still work, but common function words will show up as topics unless you extend `STOPWORDS` in `app.js`.
- **PDF outline quality** depends on the document using consistent font sizes for headings.

## Stack

Vanilla JS + [D3 v7](https://d3js.org/) (graph), [pdf.js](https://mozilla.github.io/pdf.js/) (PDF text), [mammoth](https://github.com/mwilliamson/mammoth.js) (DOCX), all loaded from CDN. IBM Plex type via Google Fonts.

/* ===================================================================
   Doc Atlas — app.js
   Pipeline:  input (URL | file)
           →  extract { title, headings[], sections[], linkCount }
           →  render TOC
           →  analyze topics (frequency + co-occurrence)
           →  render force-directed graph (D3)
   Everything runs client-side so the site can be hosted on GitHub Pages.
=================================================================== */

"use strict";

/* ------------------------------------------------------------------
   0. Config
------------------------------------------------------------------ */

// Your own Cloudflare Worker proxy (see worker/ directory).
// Set this after deploying — e.g. "https://doc-atlas-proxy.you.workers.dev"
// Leave as "" to rely on the public fallbacks below.
const OWN_PROXY = "";

// Public CORS proxies, tried after the direct fetch and OWN_PROXY fail.
const CORS_PROXIES = [
  ...(OWN_PROXY ? [(u) => `${OWN_PROXY}/?url=${encodeURIComponent(u)}`] : []),
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

const FETCH_TIMEOUT_MS = 20000;
const MAX_FILE_MB = 25;
const MAX_TOPICS = 26;          // nodes in the graph
const MAX_EDGES_PER_NODE = 8;   // keeps dense documents readable
const MIN_TOPIC_COUNT = 2;

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

/* ------------------------------------------------------------------
   1. DOM handles + input wiring
------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const els = {
  urlInput: $("url-input"),
  analyzeBtn: $("analyze-url"),
  fileInput: $("file-input"),
  dropZone: $("drop-zone"),
  readout: $("readout"),
  status: $("status"),
  statusText: $("status-text"),
  error: $("error"),
  workspace: $("workspace"),
  landing: $("landing"),
  toc: $("toc"),
  tocEmpty: $("toc-empty"),
  copyToc: $("copy-toc"),
  graphSvg: $("graph"),
  graphWrap: $("graph-wrap"),
  topicDetail: $("topic-detail"),
  resetView: $("reset-view"),
};

let currentModel = null;   // extracted document model
let currentGraph = null;   // { nodes, links }
let zoomBehavior = null;
let svgRoot = null;

els.analyzeBtn.addEventListener("click", () => {
  const url = els.urlInput.value.trim();
  if (url) analyzeUrl(url);
});

els.urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const url = els.urlInput.value.trim();
    if (url) analyzeUrl(url);
  }
});

els.fileInput.addEventListener("change", () => {
  if (els.fileInput.files.length) analyzeFile(els.fileInput.files[0]);
});

["dragover", "dragenter"].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("dragover");
  })
);
els.dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) analyzeFile(file);
});
els.dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});

els.copyToc.addEventListener("click", copyTocAsMarkdown);
els.resetView.addEventListener("click", resetGraphView);
window.addEventListener("resize", debounce(() => {
  if (currentGraph) drawGraph(currentGraph);
}, 250));

/* ------------------------------------------------------------------
   2. UI state helpers
------------------------------------------------------------------ */

function setStatus(msg) {
  els.status.hidden = false;
  els.statusText.textContent = msg;
  els.error.hidden = true;
}

function clearStatus() {
  els.status.hidden = true;
}

function showError(msg) {
  clearStatus();
  els.error.hidden = false;
  els.error.textContent = msg;
}

function showWorkspace(model) {
  els.landing.hidden = true;
  els.workspace.hidden = false;
  els.readout.hidden = false;
  $("stat-source").textContent = model.sourceLabel;
  $("stat-source").title = model.sourceLabel;
  $("stat-words").textContent = model.wordCount.toLocaleString();
  $("stat-headings").textContent = String(model.headings.length);
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/* ------------------------------------------------------------------
   3. Loaders
------------------------------------------------------------------ */

async function analyzeUrl(rawUrl) {
  let url = rawUrl;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  try {
    new URL(url);
  } catch {
    showError("That doesn't look like a valid URL. Check it and try again.");
    return;
  }

  setStatus(`Fetching ${url} …`);
  try {
    const html = await fetchWithProxies(url);
    setStatus("Parsing page structure…");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const model = extractFromHtmlDoc(doc, url);
    finishAnalysis(model);
  } catch (err) {
    showError(
      `Couldn't fetch that page: ${err.message}. ` +
      `Some sites block cross-origin access and CORS proxies — try saving the page as HTML or PDF and uploading it instead.`
    );
  }
}

async function fetchWithProxies(url) {
  const attempts = [url, ...CORS_PROXIES.map((p) => p(url))];
  let lastErr = new Error("no attempts made");

  for (const target of attempts) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(target, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text || text.length < 40) throw new Error("empty response");
      return text;
    } catch (err) {
      lastErr = err.name === "AbortError" ? new Error("request timed out") : err;
    }
  }
  throw lastErr;
}

async function analyzeFile(file) {
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    showError(`That file is larger than ${MAX_FILE_MB} MB. Split it or try a smaller export.`);
    return;
  }

  const name = file.name.toLowerCase();
  setStatus(`Reading ${file.name} …`);

  try {
    let model;
    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      model = await extractFromPdf(file);
    } else if (name.endsWith(".docx")) {
      model = await extractFromDocx(file);
    } else if (name.endsWith(".html") || name.endsWith(".htm") || file.type === "text/html") {
      const text = await file.text();
      const doc = new DOMParser().parseFromString(text, "text/html");
      model = extractFromHtmlDoc(doc, file.name);
    } else if (name.endsWith(".md") || name.endsWith(".markdown")) {
      model = extractFromMarkdown(await file.text(), file.name);
    } else if (name.endsWith(".txt") || file.type.startsWith("text/")) {
      model = extractFromPlainText(await file.text(), file.name);
    } else {
      showError("Unsupported file type. Doc Atlas reads PDF, DOCX, HTML, Markdown, and TXT.");
      return;
    }
    finishAnalysis(model);
  } catch (err) {
    console.error(err);
    showError(`Couldn't read that file: ${err.message}`);
  } finally {
    els.fileInput.value = "";
  }
}

function finishAnalysis(model) {
  if (model.wordCount < 30) {
    showError(
      "Almost no readable text was found. If this is a JavaScript-rendered page, " +
      "save the rendered page as HTML or print it to PDF and upload that."
    );
    return;
  }
  currentModel = model;
  clearStatus();
  showWorkspace(model);
  renderToc(model);

  setStatus("Building topic map…");
  // Yield to the browser so the TOC paints before graph work starts.
  setTimeout(() => {
    const graph = analyzeTopics(model);
    currentGraph = graph;
    $("stat-topics").textContent = String(graph.nodes.length);
    $("stat-links").textContent = String(graph.links.length);
    drawGraph(graph);
    clearStatus();
  }, 30);
}

/* ------------------------------------------------------------------
   4. Extractors → normalized model
   model = {
     sourceLabel, title,
     headings: [{ level, text }],
     sections: [{ title, level, text }],   // text between headings
     wordCount
   }
------------------------------------------------------------------ */

const NOISE_TAGS = "script,style,noscript,svg,iframe,nav,footer,form,button,template,select,option,aside";

// Tags treated as inline: their text belongs to the surrounding block.
const INLINE_TAGS = new Set([
  "A", "SPAN", "B", "STRONG", "EM", "I", "CODE", "SMALL", "SUP", "SUB",
  "U", "MARK", "ABBR", "TIME", "BR", "WBR", "IMG", "LABEL", "Q", "S",
  "CITE", "KBD", "SAMP", "VAR", "DATA", "BDI", "BDO", "PICTURE", "SOURCE",
]);

const CLASS_HINT_POSITIVE =
  /(^|[\s_-])(title|heading|header|headline|subtitle|subheading|subhead|section[-_]?(title|head)|hd\d?|h[1-6])([\s_-]|$)/i;
const CLASS_HINT_NEGATIVE =
  /(^|[\s_-])(nav|menu|footer|btn|button|breadcrumb|crumb|tag|badge|label|meta|byline|date|share|social|ad|banner|cookie|toolbar|pagination)([\s_-]|$)/i;

function extractFromHtmlDoc(doc, sourceLabel) {
  doc.querySelectorAll(NOISE_TAGS).forEach((n) => n.remove());
  // <header> is noise at page level but legitimate inside articles/sections.
  doc.querySelectorAll("body > header, body > * > header:first-child")
    .forEach((n) => { if (!n.closest("main,article")) n.remove(); });

  const root =
    doc.querySelector("main") ||
    doc.querySelector("article") ||
    doc.body ||
    doc.documentElement;

  // 1. Segment the DOM into linear text blocks (document order).
  //    A block is either a leaf block element or a run of inline
  //    content inside a container — so text living in bare divs and
  //    spans is captured, not just semantic tags.
  const blocks = [];
  segmentBlocks(root, blocks);

  // 2. Score every block for "headingness".
  //    Semantic h1–h6 are definite; everything else is judged on
  //    class hints, inline styling, bold wrapping, and text shape.
  const semanticCount = blocks.filter((b) => b.hLevel).length;
  // On well-structured pages, demand stronger evidence before
  // promoting a div to a heading; on structureless pages, relax.
  const threshold = semanticCount >= 3 ? 4.5 : 3;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.hLevel) { b.isHeading = true; continue; }
    b.score = headingScore(b, blocks[i + 1]);
    b.isHeading = b.score >= threshold;
  }

  // 3. Assign outline levels to heuristic headings.
  assignHeuristicLevels(blocks);

  // 4. Fold blocks into headings + sections.
  const headings = [];
  const sections = [];
  let current = { title: "(introduction)", level: 0, text: "" };
  for (const b of blocks) {
    if (b.isHeading) {
      headings.push({ level: b.level, text: b.text });
      if (current.text.trim()) sections.push(current);
      current = { title: b.text, level: b.level, text: "" };
    } else {
      current.text += b.text + "\n";
    }
  }
  if (current.text.trim()) sections.push(current);

  // 5. Structureless page: window the blocks so co-occurrence still
  //    has segments to work with instead of one giant blob.
  if (!headings.length && sections.length <= 1) {
    const paras = blocks.map((b) => b.text).filter(Boolean);
    sections.length = 0;
    for (let i = 0; i < paras.length; i += 12) {
      sections.push({
        title: `Part ${Math.floor(i / 12) + 1}`,
        level: 0,
        text: paras.slice(i, i + 12).join("\n"),
      });
    }
  }

  const title =
    cleanText(doc.querySelector("title")?.textContent) ||
    headings[0]?.text ||
    sourceLabel;

  return buildModel(sourceLabel, title, headings, sections);
}

/* Walk the tree, emitting blocks in document order. Runs of inline
   nodes inside any container become one block; block-level children
   recurse. This captures text no matter what tag it lives in. */
function segmentBlocks(el, out) {
  let runText = "";
  let runEls = [];

  const flush = () => {
    const text = cleanText(runText);
    if (text) {
      const firstEl = runEls.find((n) => n.nodeType === 1) || null;
      out.push(makeBlock(text, el, firstEl, runEls));
    }
    runText = "";
    runEls = [];
  };

  for (const child of el.childNodes) {
    if (child.nodeType === 3) {           // text node
      runText += child.textContent;
      runEls.push(child);
    } else if (child.nodeType === 1) {    // element
      if (INLINE_TAGS.has(child.tagName)) {
        runText += " " + child.textContent + " ";
        runEls.push(child);
      } else {
        flush();
        segmentBlocks(child, out);
      }
    }
  }
  flush();
}

function makeBlock(text, container, firstEl, runEls) {
  const b = { text, container, firstEl, level: 0, score: 0, isHeading: false };

  const tag = container.tagName || "";
  const hMatch = tag.match(/^H([1-6])$/);
  if (hMatch) {
    b.hLevel = Number(hMatch[1]);
    b.level = b.hLevel;
  } else if (container.getAttribute?.("role") === "heading") {
    b.hLevel = Number(container.getAttribute("aria-level")) || 2;
    b.level = b.hLevel;
  }

  // Font size / weight from inline styles (external CSS is not
  // resolvable through DOMParser, so this is best-effort).
  b.fontSize = readFontSize(container) || (firstEl && readFontSize(firstEl)) || 0;
  b.bold =
    isBoldStyle(container) || (firstEl && isBoldStyle(firstEl)) ||
    isFullyWrapped(text, runEls, ["B", "STRONG"]);

  b.classHint = classHint(container) + (firstEl ? classHint(firstEl) : 0);
  return b;
}

function readFontSize(el) {
  const raw = el.style?.fontSize;
  if (!raw) return 0;
  const v = parseFloat(raw);
  if (Number.isNaN(v)) return 0;
  if (raw.endsWith("pt")) return v * 1.333;
  if (raw.endsWith("em") || raw.endsWith("rem")) return v * 16;
  return v; // px or unitless
}

function isBoldStyle(el) {
  const w = el.style?.fontWeight;
  return w === "bold" || w === "bolder" || Number(w) >= 600;
}

// True when a single <b>/<strong> element carries essentially the
// whole run — the classic hand-rolled heading.
function isFullyWrapped(text, runEls, tags) {
  const els = runEls.filter((n) => n.nodeType === 1 && cleanText(n.textContent));
  return (
    els.length === 1 &&
    tags.includes(els[0].tagName) &&
    cleanText(els[0].textContent).length >= text.length * 0.9
  );
}

function classHint(el) {
  const hint = `${el.className || ""} ${el.id || ""}`;
  let score = 0;
  if (CLASS_HINT_POSITIVE.test(hint)) score += 2.5;
  if (CLASS_HINT_NEGATIVE.test(hint)) score -= 2.5;
  return score;
}

function headingScore(b, next) {
  const len = b.text.length;
  if (len < 3 || len > 110) return -Infinity;
  if (!/[a-zA-Z]/.test(b.text)) return -Infinity;

  let score = b.classHint;

  if (b.fontSize >= 20) score += 2;
  else if (b.fontSize >= 17) score += 1;
  if (b.bold) score += 1.5;

  // Text shape: short, no terminal punctuation, few words.
  if (len <= 90 && !/[.!?;:,]$/.test(b.text)) score += 1;
  const words = b.text.split(/\s+/);
  if (words.length <= 12) score += 0.5;

  // ALL CAPS or Title Case reads as a header.
  const letters = b.text.replace(/[^a-zA-Z]/g, "");
  if (letters.length >= 3 && letters === letters.toUpperCase()) score += 0.75;
  else {
    const capped = words.filter((w) => /^[A-Z]/.test(w)).length;
    if (words.length >= 2 && capped / words.length >= 0.7) score += 0.5;
  }

  // A heading is usually followed by something longer than itself.
  if (next && next.text.length > len * 1.5) score += 1;

  return score;
}

/* Heuristic headings get levels from inline font size when available
   (largest = highest level). Headings with no size signal are peers:
   they all share one level below the sized ones. */
function assignHeuristicLevels(blocks) {
  const heuristic = blocks.filter((b) => b.isHeading && !b.hLevel);
  if (!heuristic.length) return;

  const sizes = [...new Set(
    heuristic.filter((b) => b.fontSize > 0).map((b) => Math.round(b.fontSize))
  )].sort((a, b) => b - a).slice(0, 3);

  const semanticLevels = blocks.filter((b) => b.hLevel).map((b) => b.hLevel);
  // With semantic headings present, heuristic ones nest below the
  // deepest semantic level; otherwise they start at level 1.
  const base = semanticLevels.length
    ? Math.min(5, Math.max(...semanticLevels) + 1)
    : 1;

  for (const b of heuristic) {
    if (b.fontSize > 0) {
      const rank = Math.max(0, sizes.indexOf(Math.round(b.fontSize)));
      b.level = Math.min(6, base + rank);
    } else {
      b.level = Math.min(6, base + sizes.length); // shared peer level
    }
  }
}

async function extractFromPdf(file) {
  if (!window.pdfjsLib) throw new Error("PDF library failed to load");
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  // Collect lines with their dominant font size.
  const lines = []; // { text, size }
  for (let p = 1; p <= pdf.numPages; p++) {
    setStatus(`Reading PDF — page ${p} of ${pdf.numPages} …`);
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    const byY = new Map(); // rounded y → { parts, size }
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      const size = Math.hypot(item.transform[0], item.transform[1]) || item.height || 0;
      const key = `${y}`;
      if (!byY.has(key)) byY.set(key, { parts: [], size: 0, y });
      const line = byY.get(key);
      line.parts.push(item.str);
      line.size = Math.max(line.size, size);
    }
    [...byY.values()]
      .sort((a, b) => b.y - a.y) // PDF y grows upward → top of page first
      .forEach((l) => lines.push({ text: cleanText(l.parts.join(" ")), size: l.size }));
  }

  // Body size = size carrying the most characters.
  const sizeWeight = new Map();
  for (const l of lines) {
    const s = Math.round(l.size * 2) / 2;
    sizeWeight.set(s, (sizeWeight.get(s) || 0) + l.text.length);
  }
  let bodySize = 10;
  let best = -1;
  for (const [s, w] of sizeWeight) {
    if (w > best) { best = w; bodySize = s; }
  }

  const isHeading = (l) =>
    l.size > bodySize * 1.18 &&
    l.text.length > 2 &&
    l.text.length < 120 &&
    /[a-zA-Z]/.test(l.text);

  // Map distinct heading sizes to outline levels (largest = level 1).
  const headingSizes = [...new Set(
    lines.filter(isHeading).map((l) => Math.round(l.size * 2) / 2)
  )].sort((a, b) => b - a).slice(0, 4);

  const levelOf = (size) => {
    const s = Math.round(size * 2) / 2;
    const idx = headingSizes.indexOf(s);
    return idx === -1 ? headingSizes.length : idx + 1;
  };

  const headings = [];
  const sections = [];
  let current = { title: "(introduction)", level: 0, text: "" };
  for (const l of lines) {
    if (!l.text) continue;
    if (isHeading(l)) {
      const level = levelOf(l.size);
      headings.push({ level, text: l.text });
      if (current.text.trim()) sections.push(current);
      current = { title: l.text, level, text: "" };
    } else {
      current.text += l.text + "\n";
    }
  }
  if (current.text.trim()) sections.push(current);

  const title = headings[0]?.text || file.name;
  return buildModel(file.name, title, headings, sections);
}

async function extractFromDocx(file) {
  if (!window.mammoth) throw new Error("DOCX library failed to load");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });
  const doc = new DOMParser().parseFromString(result.value, "text/html");
  return extractFromHtmlDoc(doc, file.name);
}

function extractFromMarkdown(text, sourceLabel) {
  const headings = [];
  const sections = [];
  let current = { title: "(introduction)", level: 0, text: "" };
  let inFence = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (/^(```|~~~)/.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;

    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const level = m[1].length;
      const title = cleanText(m[2].replace(/#+\s*$/, ""));
      if (title) {
        headings.push({ level, text: title });
        if (current.text.trim()) sections.push(current);
        current = { title, level, text: "" };
      }
    } else {
      const stripped = line
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`>|]/g, " ");
      if (stripped.trim()) current.text += stripped + "\n";
    }
  }
  if (current.text.trim()) sections.push(current);

  const title = headings[0]?.text || sourceLabel;
  return buildModel(sourceLabel, title, headings, sections);
}

function extractFromPlainText(text, sourceLabel) {
  // No structure to mine: treat blank-line paragraphs as segments,
  // grouping ~10 paragraphs into pseudo-sections for co-occurrence.
  const paras = text.split(/\n\s*\n/).map(cleanText).filter(Boolean);
  const sections = [];
  for (let i = 0; i < paras.length; i += 10) {
    sections.push({
      title: `Part ${Math.floor(i / 10) + 1}`,
      level: 0,
      text: paras.slice(i, i + 10).join("\n"),
    });
  }
  return buildModel(sourceLabel, sourceLabel, [], sections);
}

function buildModel(sourceLabel, title, headings, sections) {
  const fullText = sections.map((s) => s.title + "\n" + s.text).join("\n");
  const wordCount = (fullText.match(/\S+/g) || []).length;
  return { sourceLabel, title, headings, sections, wordCount };
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------
   5. Table of contents
------------------------------------------------------------------ */

function renderToc(model) {
  els.toc.innerHTML = "";
  const has = model.headings.length > 0;
  els.tocEmpty.hidden = has;
  els.copyToc.disabled = !has;
  if (!has) return;

  const frag = document.createDocumentFragment();
  for (const h of model.headings) {
    const level = Math.min(Math.max(h.level, 1), 6);
    const item = document.createElement("a");
    item.className = "toc-item";
    item.dataset.level = String(level);
    item.href = "#";
    item.addEventListener("click", (e) => {
      e.preventDefault();
      highlightSectionTopics(h.text);
    });

    const tag = document.createElement("span");
    tag.className = "toc-h-tag";
    tag.textContent = "H" + level;

    const label = document.createElement("span");
    label.textContent = h.text;

    item.append(tag, label);
    frag.appendChild(item);
  }
  els.toc.appendChild(frag);
}

function copyTocAsMarkdown() {
  if (!currentModel || !currentModel.headings.length) return;
  const md = currentModel.headings
    .map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}- ${h.text}`)
    .join("\n");
  navigator.clipboard.writeText(md).then(() => {
    els.copyToc.textContent = "Copied";
    setTimeout(() => (els.copyToc.textContent = "Copy as Markdown"), 1400);
  });
}

// Clicking a TOC entry pulses the topics that occur in that section.
function highlightSectionTopics(sectionTitle) {
  if (!currentGraph || !currentModel) return;
  const section = currentModel.sections.find((s) => s.title === sectionTitle);
  if (!section) return;
  const inSection = new Set(
    currentGraph.nodes
      .filter((n) => n.regex.test(section.title + " " + section.text))
      .map((n) => n.id)
  );
  d3.select(els.graphSvg)
    .selectAll("g.node")
    .transition()
    .duration(250)
    .style("opacity", (d) => (inSection.size === 0 || inSection.has(d.id) ? 1 : 0.15));
  d3.select(els.graphSvg)
    .selectAll("line.link")
    .transition()
    .duration(250)
    .style("opacity", (d) =>
      inSection.has(d.source.id) && inSection.has(d.target.id) ? 0.5 : 0.06
    );
  setTimeout(clearGraphHighlight, 2600);
}

/* ------------------------------------------------------------------
   6. Topic analysis
------------------------------------------------------------------ */

const STOPWORDS = new Set(("a,about,above,after,again,against,all,also,am,an,and,any,are,aren't,as,at,be,because,been," +
  "before,being,below,between,both,but,by,can,can't,cannot,could,couldn't,did,didn't,do,does,doesn't,doing,don't,down," +
  "during,each,few,for,from,further,get,got,had,hadn't,has,hasn't,have,haven't,having,he,he'd,he'll,he's,her,here," +
  "here's,hers,herself,him,himself,his,how,how's,however,i,i'd,i'll,i'm,i've,if,in,into,is,isn't,it,it's,its,itself," +
  "just,let's,like,made,make,many,may,me,might,more,most,much,must,mustn't,my,myself,new,no,nor,not,now,of,off,on," +
  "once,one,only,or,other,ought,our,ours,ourselves,out,over,own,per,same,shan't,she,she'd,she'll,she's,should," +
  "shouldn't,since,so,some,such,than,that,that's,the,their,theirs,them,themselves,then,there,there's,these,they," +
  "they'd,they'll,they're,they've,this,those,through,to,too,under,until,up,upon,us,use,used,using,very,was,wasn't," +
  "we,we'd,we'll,we're,we've,were,weren't,what,what's,when,when's,where,where's,which,while,who,who's,whom,why,why's," +
  "will,with,within,without,won't,would,wouldn't,you,you'd,you'll,you're,you've,your,yours,yourself,yourselves," +
  "also,among,around,back,become,becomes,came,come,comes,e.g,etc,even,every,first,go,going,i.e,include,includes," +
  "including,know,last,later,less,lot,need,needs,next,often,really,said,say,says,see,seen,several,still,take,takes," +
  "thing,things,think,three,time,two,via,want,way,well,whether,yet").split(","));

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z][a-z'’\-]{2,}/g) || [])
    .map((w) => w.replace(/^['’\-]+|['’\-]+$/g, ""))
    .filter((w) => w.length >= 3);
}

function analyzeTopics(model) {
  const unigrams = new Map();
  const bigrams = new Map();

  // Segments for co-occurrence: sections if headings exist, else
  // fixed-size paragraph windows.
  const segments = model.sections.map((s) => ({
    title: s.title,
    text: (s.title + " " + s.text).toLowerCase(),
  }));

  for (const seg of segments) {
    const words = tokenize(seg.text);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const ok = !STOPWORDS.has(w) && !/^\d+$/.test(w);
      if (ok) unigrams.set(w, (unigrams.get(w) || 0) + 1);
      if (ok && i + 1 < words.length) {
        const n = words[i + 1];
        if (!STOPWORDS.has(n) && !/^\d+$/.test(n)) {
          const bg = `${w} ${n}`;
          bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
        }
      }
    }
  }

  // Fold plural/singular variants ("embedding" + "embeddings") into
  // one topic, keeping the more frequent spelling as the label.
  const plural = new Map(); // canonical label → regex stem
  for (const [w, count] of [...unigrams.entries()]) {
    if (!w.endsWith("s")) continue;
    const singular = w.slice(0, -1);
    if (!unigrams.has(singular)) continue;
    const sCount = unigrams.get(singular);
    const label = count >= sCount ? w : singular;
    unigrams.set(label, count + sCount);
    unigrams.delete(label === w ? singular : w);
    plural.set(label, singular);
  }

  // Candidate scoring: bigrams that recur are stronger topics than
  // either of their parts.
  const candidates = [];
  for (const [term, count] of bigrams) {
    if (count >= 3) candidates.push({ term, count, score: count * 2, isBigram: true });
  }
  for (const [term, count] of unigrams) {
    if (count >= MIN_TOPIC_COUNT) candidates.push({ term, count, score: count, isBigram: false });
  }
  candidates.sort((a, b) => b.score - a.score);

  const chosen = [];
  const chosenBigramParts = new Set();
  for (const c of candidates) {
    if (chosen.length >= MAX_TOPICS) break;
    if (c.isBigram) {
      const [a, b] = c.term.split(" ");
      chosen.push(c);
      // Absorb parts whose counts are mostly explained by this bigram.
      if ((unigrams.get(a) || 0) <= c.count * 1.6) chosenBigramParts.add(a);
      if ((unigrams.get(b) || 0) <= c.count * 1.6) chosenBigramParts.add(b);
    } else {
      if (chosenBigramParts.has(c.term)) continue;
      if (chosen.some((x) => x.isBigram && x.term.split(" ").includes(c.term))) {
        // Part of a chosen bigram but still frequent on its own → keep
        // only if clearly independent.
        if (c.count < 6) continue;
      }
      chosen.push(c);
    }
  }

  const nodes = chosen.map((c, i) => ({
    id: c.term,
    count: c.count,
    index: i,
    regex: plural.has(c.term)
      ? new RegExp(`\\b${escapeRegex(plural.get(c.term))}s?\\b`, "i")
      : new RegExp(`\\b${escapeRegex(c.term)}\\b`, "i"),
  }));

  // Co-occurrence edges: +1 per segment where both topics appear.
  const linkMap = new Map();
  const nodeSections = new Map(nodes.map((n) => [n.id, []]));

  for (const seg of segments) {
    const present = nodes.filter((n) => n.regex.test(seg.text));
    for (const n of present) nodeSections.get(n.id).push(seg.title);
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const key = present[i].id + "||" + present[j].id;
        linkMap.set(key, (linkMap.get(key) || 0) + 1);
      }
    }
  }

  let links = [...linkMap.entries()].map(([key, weight]) => {
    const [source, target] = key.split("||");
    return { source, target, weight };
  });

  // Prune to keep the map legible: each node keeps its strongest edges.
  const minWeight = links.length > nodes.length * 3 ? 2 : 1;
  links = links.filter((l) => l.weight >= minWeight);
  const kept = new Set();
  const byNode = new Map(nodes.map((n) => [n.id, []]));
  for (const l of links) {
    byNode.get(l.source).push(l);
    byNode.get(l.target).push(l);
  }
  for (const [, ls] of byNode) {
    ls.sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_EDGES_PER_NODE)
      .forEach((l) => kept.add(l));
  }
  links = links.filter((l) => kept.has(l));

  return { nodes, links, nodeSections };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------
   7. Graph rendering (D3 force layout)
------------------------------------------------------------------ */

function drawGraph(graph) {
  const svg = d3.select(els.graphSvg);
  svg.selectAll("*").remove();
  hideTopicDetail();

  const { width, height } = els.graphWrap.getBoundingClientRect();
  svg.attr("viewBox", [0, 0, width, height]);

  if (!graph.nodes.length) {
    svg.append("text")
      .attr("x", width / 2).attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", "#46586E")
      .attr("font-size", 14)
      .text("Not enough repeated terms to build a topic map.");
    return;
  }

  const g = svg.append("g");
  svgRoot = g;

  zoomBehavior = d3.zoom()
    .scaleExtent([0.35, 4])
    .on("zoom", (e) => g.attr("transform", e.transform));
  svg.call(zoomBehavior).on("dblclick.zoom", null);

  const maxCount = d3.max(graph.nodes, (d) => d.count);
  const rScale = d3.scaleSqrt().domain([1, maxCount]).range([7, 32]);
  const wScale = d3.scaleLinear()
    .domain([1, d3.max(graph.links, (d) => d.weight) || 1])
    .range([1, 5]);
  const color = d3.scaleLinear()
    .domain([1, Math.max(2, maxCount)])
    .range(["#7E97D8", "#2853C4"]);

  // Deep-copy links since d3 mutates source/target into node refs.
  const links = graph.links.map((l) => ({ ...l }));
  const nodes = graph.nodes;

  const simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id)
      .distance((d) => 130 - Math.min(60, d.weight * 8))
      .strength((d) => Math.min(1, 0.2 + d.weight * 0.08)))
    .force("charge", d3.forceManyBody().strength(-240))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collide", d3.forceCollide().radius((d) => rScale(d.count) + 26));

  const link = g.append("g")
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("class", "link")
    .attr("stroke", "#46586E")
    .attr("stroke-opacity", 0.28)
    .attr("stroke-width", (d) => wScale(d.weight));

  const node = g.append("g")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", "node")
    .style("cursor", "pointer")
    .call(d3.drag()
      .on("start", (e, d) => {
        if (!e.active) simulation.alphaTarget(0.25).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => {
        if (!e.active) simulation.alphaTarget(0);
        d.fx = null; d.fy = null;
      }));

  node.append("circle")
    .attr("r", (d) => rScale(d.count))
    .attr("fill", (d) => color(d.count))
    .attr("fill-opacity", 0.9)
    .attr("stroke", "#FCFDFE")
    .attr("stroke-width", 1.5);

  node.append("text")
    .attr("text-anchor", "middle")
    .attr("y", (d) => rScale(d.count) + 14)
    .attr("font-size", 12)
    .attr("font-weight", 500)
    .attr("fill", "#17263B")
    .attr("paint-order", "stroke")
    .attr("stroke", "#F2F5F7")
    .attr("stroke-width", 3)
    .text((d) => d.id);

  node.append("text")
    .attr("class", "count-label")
    .attr("text-anchor", "middle")
    .attr("y", (d) => rScale(d.count) + 28)
    .attr("font-size", 10.5)
    .attr("fill", "#B76A12")
    .attr("paint-order", "stroke")
    .attr("stroke", "#F2F5F7")
    .attr("stroke-width", 3)
    .text((d) => `× ${d.count}`);

  const neighbors = new Map(nodes.map((n) => [n.id, new Set([n.id])]));
  for (const l of links) {
    neighbors.get(l.source.id ?? l.source).add(l.target.id ?? l.target);
    neighbors.get(l.target.id ?? l.target).add(l.source.id ?? l.source);
  }

  node
    .on("mouseenter", (e, d) => {
      const near = neighbors.get(d.id);
      node.style("opacity", (o) => (near.has(o.id) ? 1 : 0.15));
      link.style("opacity", (l) =>
        l.source.id === d.id || l.target.id === d.id ? 0.6 : 0.05);
    })
    .on("mouseleave", clearGraphHighlight)
    .on("click", (e, d) => {
      e.stopPropagation();
      showTopicDetail(d, links);
    });

  svg.on("click", hideTopicDetail);

  simulation.on("tick", () => {
    link
      .attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });
}

function clearGraphHighlight() {
  d3.select(els.graphSvg).selectAll("g.node").style("opacity", 1);
  d3.select(els.graphSvg).selectAll("line.link").style("opacity", 0.28);
}

function resetGraphView() {
  if (!zoomBehavior) return;
  d3.select(els.graphSvg)
    .transition().duration(400)
    .call(zoomBehavior.transform, d3.zoomIdentity);
  clearGraphHighlight();
}

function showTopicDetail(d, links) {
  const related = links
    .filter((l) => l.source.id === d.id || l.target.id === d.id)
    .map((l) => ({
      other: l.source.id === d.id ? l.target.id : l.source.id,
      weight: l.weight,
    }))
    .sort((a, b) => b.weight - a.weight);

  const sections = [...new Set(currentGraph.nodeSections.get(d.id) || [])].slice(0, 8);

  const relatedHtml = related.length
    ? `<ul>${related.map((r) =>
        `<li>${escapeHtml(r.other)} <span class="rel-count">· shares ${r.weight} section${r.weight > 1 ? "s" : ""}</span></li>`
      ).join("")}</ul>`
    : `<p>No strong co-occurrences with other mapped topics.</p>`;

  const sectionsHtml = sections.length
    ? `<ul>${sections.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`
    : `<p>Appears outside any headed section.</p>`;

  els.topicDetail.innerHTML = `
    <button class="detail-close" type="button" aria-label="Close details">×</button>
    <h3>${escapeHtml(d.id)}</h3>
    <span class="detail-count">${d.count} mention${d.count > 1 ? "s" : ""}</span>
    <h4>Connected topics</h4>
    ${relatedHtml}
    <h4>Appears in</h4>
    ${sectionsHtml}
  `;
  els.topicDetail.hidden = false;
  els.topicDetail.querySelector(".detail-close")
    .addEventListener("click", hideTopicDetail);
}

function hideTopicDetail() {
  els.topicDetail.hidden = true;
  els.topicDetail.innerHTML = "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Seijaku built-in PDF viewer with annotation.
 *
 * Vendored libraries (no network at runtime — everything below is
 * loaded from chrome://seijaku/content/vendor/):
 *   - pdf.js 4.2.67, Apache-2.0 (Mozilla Foundation)
 *       https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.mjs
 *       https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.worker.mjs
 *   - pdf-lib 1.17.1, MIT (Hopding)
 *       https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js
 *
 * Routing (wired by the shell, not this page): navigations to
 * http(s)/file URLs ending in .pdf open seijaku:pdf#url=<encoded
 * original URL>. This page only reads that hash.
 *
 * Shell methods used, exactly as provided by the parent shell:
 *   - shell.fetchPdfBytes(url) -> Promise<Uint8Array>
 *   - shell.downloadPdfBytes(filename, bytes) -> Promise<void>
 *   - shell.showMessage(text, level?) (optional)
 * The PDF itself is never fetched directly from this page.
 *
 * Annotation data model — ALL coordinates are in PDF points
 * (origin top-left, y down), so strokes survive zoom changes:
 *   strokes per page: { color, width, points: [[x, y], ...] }
 *   notes per page:   { x, y, text }
 * Display coords convert with scale = displayWidth / pdfPageWidth:
 *   recording: pdf = display / scale; rendering: display = pdf * scale.
 */

"use strict";

const WORKER_SRC = "chrome://seijaku/content/vendor/pdfjs/pdf.worker.mjs";
const PDFJS_SRC = "chrome://seijaku/content/vendor/pdfjs/pdf.mjs";
const COLORS = ["#d8442a", "#d9a441", "#6a9a5b", "#5b8ab5", "#ece4d3"];

const $ = (id) => document.getElementById(id);
const statusEl = () => $("status");
const errorEl = () => $("error");

function showStatus(text) {
  try {
    statusEl().textContent = text;
    statusEl().hidden = false;
    errorEl().hidden = true;
  } catch (e) { /* page tearing down; nothing to show in */ }
}

function showError(text) {
  try {
    errorEl().textContent = text;
    errorEl().hidden = false;
    statusEl().hidden = true;
  } catch (e) { /* ignore */ }
}

function getShell() {
  try {
    return window.browsingContext.topChromeWindow.Seijaku;
  } catch (e) {
    return undefined;
  }
}

function showMessage(text, level) {
  try {
    getShell()?.showMessage?.(text, level);
  } catch (e) { /* status messages are best-effort */ }
}

function parseHashUrl() {
  try {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const url = params.get("url");
    if (!url) return null;
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "file:") return null;
    return url;
  } catch (e) {
    return null;
  }
}

function filenameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const raw = path.slice(path.lastIndexOf("/") + 1);
    const name = decodeURIComponent(raw);
    return name || "document.pdf";
  } catch (e) {
    return "document.pdf";
  }
}

function annotatedFilename(name) {
  const match = name.match(/^(.*)(\.pdf)$/i);
  if (match) return match[1] + "-annotated" + match[2];
  return name + "-annotated.pdf";
}

function hexToRgb01(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* ---- state ---- */
let pdfjsLib = null;
let pdfDoc = null;
let originalBytes = null;
let originalUrl = "";
let originalFilename = "document.pdf";
let pageInfos = []; // { num, pdfPage, width, height, wrap, canvas, overlay }
let annotations = new Map(); // num -> { strokes: [], notes: [] }
let currentTool = "ink";
let currentColor = COLORS[0];
let currentWidth = 3;
let fitMode = true;
let customScale = 1;
let currentPage = 1;
let resizeTimer = 0;

function pageAnnotations(num) {
  let entry = annotations.get(num);
  if (!entry) {
    entry = { strokes: [], notes: [] };
    annotations.set(num, entry);
  }
  return entry;
}

function dpr() {
  return Math.max(1, window.devicePixelRatio || 1);
}

/* Scale (CSS px per PDF point) for one page in the current zoom mode. */
function scaleFor(info) {
  if (!fitMode) return customScale;
  const avail = Math.max(200, document.documentElement.clientWidth - 32);
  return avail / info.width;
}

function updateIndicator() {
  try {
    $("indicator").textContent = pdfDoc
      ? "Page " + currentPage + " of " + pdfDoc.numPages
      : "Page — of —";
    $("zoom-label").textContent = fitMode
      ? "Fit width"
      : Math.round(currentScalePercent()) + "%";
  } catch (e) { /* ignore */ }
}

function currentScalePercent() {
  const info = pageInfos[0];
  if (!info) return 100;
  return customScale * 100;
}

function trackCurrentPage() {
  try {
    const mid = window.scrollY + window.innerHeight / 2;
    let best = pageInfos[0];
    for (const info of pageInfos) {
      if (info.wrap.offsetTop <= mid) best = info;
      else break;
    }
    if (best && best.num !== currentPage) {
      currentPage = best.num;
      updateIndicator();
    }
  } catch (e) { /* ignore */ }
}

function scrollToPage(num) {
  const info = pageInfos.find((p) => p.num === num);
  if (!info) return;
  info.wrap.scrollIntoView({ block: "start" });
  currentPage = num;
  updateIndicator();
}

/* ---- overlay rendering (display coords = pdf coords * scale) ---- */
function redrawOverlay(info) {
  try {
    const overlay = info.overlay;
    const ctx = overlay.getContext("2d");
    const scale = scaleFor(info);
    const cssW = info.width * scale;
    const cssH = info.height * scale;
    overlay.width = Math.round(cssW * dpr());
    overlay.height = Math.round(cssH * dpr());
    overlay.style.width = cssW + "px";
    overlay.style.height = cssH + "px";
    ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const entry = annotations.get(info.num) || { strokes: [], notes: [] };
    for (const stroke of entry.strokes) {
      if (stroke.points.length === 0) continue;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = Math.max(0.5, stroke.width * scale);
      ctx.beginPath();
      ctx.moveTo(stroke.points[0][0] * scale, stroke.points[0][1] * scale);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i][0] * scale, stroke.points[i][1] * scale);
      }
      if (stroke.points.length === 1) {
        ctx.lineTo(stroke.points[0][0] * scale + 0.01, stroke.points[0][1] * scale + 0.01);
      }
      ctx.stroke();
    }
    ctx.font = "12px sans-serif";
    for (const note of entry.notes) {
      const x = note.x * scale;
      const y = note.y * scale;
      ctx.fillStyle = "#d8442a";
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ece4d3";
      ctx.fillText(note.text, x + 10, y + 4);
    }
  } catch (e) {
    showError("Could not redraw annotations: " + (e && e.message ? e.message : e));
  }
}

/* ---- page rendering ---- */
async function renderPage(info) {
  const scale = scaleFor(info);
  const cssW = info.width * scale;
  const cssH = info.height * scale;
  const renderScale = scale * dpr();
  const viewport = info.pdfPage.getViewport({ scale: renderScale });
  info.canvas.width = Math.round(cssW * dpr());
  info.canvas.height = Math.round(cssH * dpr());
  info.canvas.style.width = cssW + "px";
  info.canvas.style.height = cssH + "px";
  info.wrap.style.width = cssW + "px";
  info.wrap.style.height = cssH + "px";
  const ctx = info.canvas.getContext("2d");
  await info.pdfPage.render({ canvasContext: ctx, viewport }).promise;
  redrawOverlay(info);
}

async function renderAll() {
  try {
    for (const info of pageInfos) {
      await renderPage(info);
    }
    updateIndicator();
  } catch (e) {
    showError("Could not render pages: " + (e && e.message ? e.message : e));
  }
}

async function setZoom(fit, scale) {
  fitMode = fit;
  if (scale !== undefined) customScale = scale;
  showStatus("Rendering…");
  await renderAll();
  statusEl().hidden = true;
}

/* ---- annotation input ---- */
function pointerToPdf(info, event) {
  const rect = info.overlay.getBoundingClientRect();
  const scale = scaleFor(info);
  return [(event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale];
}

function attachOverlayInput(info) {
  let activeStroke = null;
  info.overlay.addEventListener("pointerdown", (event) => {
    try {
      if (currentTool === "eraser") {
        // Eraser removes the last stroke, or the last note if the
        // current page has no strokes. One click = one removal.
        const entry = pageAnnotations(info.num);
        if (entry.strokes.length > 0) entry.strokes.pop();
        else if (entry.notes.length > 0) entry.notes.pop();
        else {
          showMessage("Nothing to erase on this page.");
          return;
        }
        redrawOverlay(info);
        return;
      }
      if (currentTool === "note") {
        const text = window.prompt("Note text:");
        if (text === null || text.trim() === "") return;
        const [x, y] = pointerToPdf(info, event);
        pageAnnotations(info.num).notes.push({ x, y, text: text.trim() });
        redrawOverlay(info);
        return;
      }
      // Ink: freehand stroke.
      const [x, y] = pointerToPdf(info, event);
      activeStroke = { color: currentColor, width: currentWidth, points: [[x, y]] };
      pageAnnotations(info.num).strokes.push(activeStroke);
      info.overlay.setPointerCapture(event.pointerId);
    } catch (e) {
      showError("Annotation failed: " + (e && e.message ? e.message : e));
    }
  });
  info.overlay.addEventListener("pointermove", (event) => {
    try {
      if (!activeStroke) return;
      activeStroke.points.push(pointerToPdf(info, event));
      redrawOverlay(info);
    } catch (e) { /* a dropped move must not break the stroke */ }
  });
  const endStroke = () => { activeStroke = null; };
  info.overlay.addEventListener("pointerup", endStroke);
  info.overlay.addEventListener("pointercancel", endStroke);
}

/* ---- save ---- */
async function saveAnnotated() {
  try {
    const shell = getShell();
    if (!shell || typeof shell.downloadPdfBytes !== "function") {
      showError("Saving is unavailable: the shell download method is missing.");
      return;
    }
    if (!window.PDFLib) {
      showError("Saving is unavailable: pdf-lib did not load.");
      return;
    }
    if (!originalBytes) {
      showError("Saving is unavailable: the original PDF bytes are gone.");
      return;
    }
    showStatus("Preparing annotated copy…");
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.load(originalBytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < doc.getPageCount(); i++) {
      const page = doc.getPage(i);
      const height = page.getHeight();
      const entry = annotations.get(i + 1) || { strokes: [], notes: [] };
      for (const stroke of entry.strokes) {
        const [r, g, b] = hexToRgb01(stroke.color);
        for (let j = 1; j < stroke.points.length; j++) {
          const [x1, y1] = stroke.points[j - 1];
          const [x2, y2] = stroke.points[j];
          page.drawLine({
            start: { x: x1, y: height - y1 },
            end: { x: x2, y: height - y2 },
            thickness: stroke.width,
            color: rgb(r, g, b),
            opacity: 0.9,
          });
        }
        if (stroke.points.length === 1) {
          const [x, y] = stroke.points[0];
          page.drawCircle({
            x,
            y: height - y,
            size: Math.max(0.75, stroke.width / 2),
            color: rgb(r, g, b),
            opacity: 0.9,
          });
        }
      }
      for (const note of entry.notes) {
        page.drawText(note.text, {
          x: note.x,
          y: height - note.y,
          size: 12,
          font,
          color: rgb(0.847, 0.267, 0.165),
        });
      }
    }
    const bytes = await doc.save();
    await shell.downloadPdfBytes(annotatedFilename(originalFilename), bytes);
    statusEl().hidden = true;
    showMessage("Annotated copy saved to Downloads.");
  } catch (e) {
    showError("Could not save the annotated copy: " + (e && e.message ? e.message : e));
  }
}

/* ---- toolbar wiring ---- */
function wireToolbar() {
  const tools = { ink: $("tool-ink"), note: $("tool-note"), eraser: $("tool-eraser") };
  for (const [name, button] of Object.entries(tools)) {
    button.addEventListener("click", () => {
      currentTool = name;
      for (const [other, otherButton] of Object.entries(tools)) {
        otherButton.classList.toggle("active", other === name);
      }
    });
  }
  document.querySelectorAll("#colors .swatch").forEach((swatch) => {
    swatch.addEventListener("click", () => {
      currentColor = swatch.dataset.color;
      document.querySelectorAll("#colors .swatch").forEach((s) => {
        s.classList.toggle("active", s === swatch);
      });
    });
  });
  $("width").addEventListener("change", () => {
    currentWidth = parseFloat($("width").value) || 3;
  });
  $("prev").addEventListener("click", () => scrollToPage(Math.max(1, currentPage - 1)));
  $("next").addEventListener("click", () => {
    scrollToPage(Math.min(pdfDoc ? pdfDoc.numPages : 1, currentPage + 1));
  });
  $("zoom-in").addEventListener("click", async () => {
    const base = fitMode ? scaleFor(pageInfos[0] || { width: 1 }) : customScale;
    await setZoom(false, base * 1.25);
  });
  $("zoom-out").addEventListener("click", async () => {
    const base = fitMode ? scaleFor(pageInfos[0] || { width: 1 }) : customScale;
    await setZoom(false, Math.max(0.1, base / 1.25));
  });
  $("zoom-fit").addEventListener("click", async () => setZoom(true));
  $("save").addEventListener("click", saveAnnotated);
  window.addEventListener("scroll", trackCurrentPage, { passive: true });
  window.addEventListener("resize", () => {
    if (!fitMode || pageInfos.length === 0) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { renderAll(); }, 200);
  });
}

/* ---- boot ---- */
async function init() {
  try {
    wireToolbar();
    originalUrl = parseHashUrl();
    if (!originalUrl) {
      showError("No PDF to show: the page URL has no valid url parameter. " +
        "Open a .pdf link and the browser will route it here.");
      return;
    }
    originalFilename = filenameFromUrl(originalUrl);
    $("filename").textContent = originalFilename;
    $("filename").title = originalUrl;
    const shell = getShell();
    if (!shell || typeof shell.fetchPdfBytes !== "function") {
      showError("Cannot load this PDF: the shell fetch method is missing. " +
        "This page must run inside Seijaku.");
      return;
    }
    showStatus("Loading PDF…");
    // Normalize into this page's compartment: bytes arriving from
    // the shell fail pdf.js's instanceof checks if passed through
    // unwrapped, so they are copied into a page-compartment array.
    // This also makes the pdf-lib load below see a local array.
    originalBytes = new Uint8Array(await shell.fetchPdfBytes(originalUrl));
    if (!originalBytes || originalBytes.length === 0) {
      showError("The PDF came back empty.");
      return;
    }
    try {
      pdfjsLib = await import(PDFJS_SRC);
    } catch (e) {
      showError("The PDF engine failed to load: " + (e && e.message ? e.message : e));
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC;
    let loadingTask;
    try {
      loadingTask = pdfjsLib.getDocument({
        data: originalBytes,
        onPassword: () => {
          // Password-protected: surface it, never crash.
          throw new Error("This PDF is password-protected and cannot be opened here.");
        },
      });
      pdfDoc = await loadingTask.promise;
    } catch (e) {
      if (e && e.name === "PasswordException") {
        showError("This PDF is password-protected and cannot be opened here.");
      } else {
        showError("Could not open this PDF: " + (e && e.message ? e.message : e));
      }
      return;
    }
    const container = $("pages");
    container.replaceChildren();
    pageInfos = [];
    for (let num = 1; num <= pdfDoc.numPages; num++) {
      const pdfPage = await pdfDoc.getPage(num);
      const viewport = pdfPage.getViewport({ scale: 1 });
      const wrap = document.createElement("div");
      wrap.className = "page-wrap";
      const canvas = document.createElement("canvas");
      canvas.className = "page-canvas";
      const overlay = document.createElement("canvas");
      overlay.className = "annot-canvas";
      overlay.title = "Page " + num + " — draw with the Ink tool, click with Note, or erase the last stroke/note";
      wrap.append(canvas, overlay);
      container.append(wrap);
      const info = { num, pdfPage, width: viewport.width, height: viewport.height, wrap, canvas, overlay };
      pageInfos.push(info);
      attachOverlayInput(info);
    }
    container.hidden = false;
    showStatus("Rendering…");
    await renderAll();
    statusEl().hidden = true;
    currentPage = 1;
    updateIndicator();
  } catch (e) {
    showError("Something went wrong: " + (e && e.message ? e.message : e));
  }
}

init();

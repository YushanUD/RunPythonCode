/**
 * auto-submit.js
 * ------------------------------------------------------------------
 * Adds a floating "Submit Assignment" button to your JupyterLite page.
 * When a student clicks it, this script:
 *   1. Asks for their name + student/Canvas ID (once per browser tab).
 *   2. Reads the current notebook's cells straight out of the page
 *      (source code, markdown text, and outputs including inline
 *      images), since JupyterLite itself never talks to a server.
 *   3. Reconstructs a real, openable .ipynb file in memory.
 *   4. Sends it to a Google Apps Script endpoint you control, which
 *      logs a row in a Google Sheet and (optionally) saves the .ipynb
 *      file to a Drive folder.
 *
 * You MUST also deploy the companion Apps Script
 * (google-sheet-backend.gs) and paste its Web App URL into
 * APPS_SCRIPT_URL below before this will work. See
 * SETUP-INSTRUCTIONS.md for the full walkthrough.
 *
 * Installation: same as paste-blocker.js — put this file next to your
 * built index.html and add:
 *     <script src="./auto-submit.js"></script>
 * ------------------------------------------------------------------
 */
(function () {
  "use strict";

  // ============================ CONFIGURE ============================
  // Paste the URL you get from Apps Script "Deploy > New deployment".
  // It looks like: https://script.google.com/macros/s/AKfycb.../exec
  var APPS_SCRIPT_URL = "PASTE_YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE";

  // Shown to students and recorded in the Sheet so you can tell
  // assignments apart if you reuse this script for multiple labs.
  var ASSIGNMENT_NAME = "BANA409 - Assignment Name Here";
  // =====================================================================

  var STORAGE_KEY = "bana409_submitter_identity";

  // ---------------------------------------------------------------
  // Identity: JupyterLite has no login, so we ask once per tab and
  // cache in sessionStorage (cleared when the tab/browser closes —
  // deliberately NOT localStorage, so identities don't linger and
  // leak between students on a shared lab computer).
  // ---------------------------------------------------------------
  function getCachedIdentity() {
    try {
      var cached = sessionStorage.getItem(STORAGE_KEY);
      if (cached) return JSON.parse(cached);
    } catch (e) {
      /* sessionStorage unavailable (e.g. private browsing) — ignore */
    }
    return null;
  }

  function askIdentity() {
    var name = "";
    var studentId = "";
    while (!name || !studentId) {
      name = window.prompt("Enter your full name (for grading):", name || "");
      if (name === null) return null; // student hit Cancel
      studentId = window.prompt("Enter your student/Canvas ID:", studentId || "");
      if (studentId === null) return null;
    }
    var identity = { name: name.trim(), studentId: studentId.trim() };
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
    } catch (e) {}
    return identity;
  }

  function ensureIdentity() {
    return getCachedIdentity() || askIdentity();
  }

  // ---------------------------------------------------------------
  // Scrape the notebook straight out of the DOM.
  //
  // Why the DOM instead of JupyterLite's internal storage? JupyterLite
  // keeps files in the browser's IndexedDB using an internal schema
  // that varies between versions and isn't meant to be read by outside
  // scripts. The rendered DOM (`.jp-Cell`, `.cm-content`, etc.) is far
  // more stable across JupyterLab/JupyterLite versions, so we read the
  // cells the same way a human looking at the screen would.
  //
  // Caveat: for a cell with an unusually large number of lines (100+),
  // CodeMirror can virtualize rendering so only visible lines exist in
  // the DOM. This is not a concern for normal assignment-sized cells.
  // ---------------------------------------------------------------
  function scrapeNotebookCells() {
    var cells = [];
    var cellEls = document.querySelectorAll(".jp-Notebook .jp-Cell");

    cellEls.forEach(function (cellEl) {
      var cellType = cellEl.classList.contains("jp-CodeCell")
        ? "code"
        : cellEl.classList.contains("jp-MarkdownCell")
        ? "markdown"
        : cellEl.classList.contains("jp-RawCell")
        ? "raw"
        : "raw";

      // --- source text ---
      var source = "";
      var cmContent = cellEl.querySelector(".cm-content");
      if (cmContent) {
        var lineEls = cmContent.querySelectorAll(".cm-line");
        source = lineEls.length
          ? Array.prototype.map.call(lineEls, function (l) { return l.textContent; }).join("\n")
          : cmContent.textContent || "";
      } else {
        // Markdown cell currently rendered (not in edit mode) — fall
        // back to the rendered text. Exact markdown syntax (e.g. `**`)
        // is lost here, but the content is still gradable.
        var rendered = cellEl.querySelector(".jp-RenderedMarkdown, .jp-RenderedHTMLCommon");
        if (rendered) source = rendered.innerText || rendered.textContent || "";
      }

      // --- execution count, e.g. the "3" in "[3]:" ---
      var executionCount = null;
      var promptEl = cellEl.querySelector(".jp-InputArea-prompt");
      if (promptEl) {
        var match = /\[(\d+)\]/.exec(promptEl.textContent || "");
        if (match) executionCount = parseInt(match[1], 10);
      }

      // --- outputs (code cells only) ---
      var outputs = [];
      if (cellType === "code") {
        cellEl.querySelectorAll(".jp-OutputArea-output").forEach(function (outEl) {
          var img = outEl.querySelector("img[src^='data:image']");
          if (img) {
            var imgMatch = /^data:(image\/[a-zA-Z+.-]+);base64,(.*)$/.exec(img.src);
            if (imgMatch) {
              var data = {};
              data[imgMatch[1]] = imgMatch[2];
              outputs.push({ output_type: "display_data", data: data, metadata: {} });
            }
            return;
          }
          var pre = outEl.querySelector("pre");
          var text = (pre ? pre.textContent : outEl.textContent) || "";
          if (text.trim() !== "") {
            outputs.push({ output_type: "stream", name: "stdout", text: text });
          }
        });
      }

      cells.push({
        cell_type: cellType,
        source: source,
        execution_count: executionCount,
        outputs: outputs
      });
    });

    return cells;
  }

  // Turn the scraped cells into a real, openable .ipynb (nbformat v4).
  function buildNotebookJSON(cells) {
    var nbCells = cells.map(function (c) {
      var sourceLines = c.source.length
        ? c.source.split("\n").map(function (line, i, arr) {
            return i < arr.length - 1 ? line + "\n" : line;
          })
        : [""];

      var cell = {
        cell_type: c.cell_type,
        metadata: {},
        source: sourceLines
      };

      if (c.cell_type === "code") {
        cell.execution_count = c.execution_count;
        cell.outputs = c.outputs;
      }

      return cell;
    });

    return {
      cells: nbCells,
      metadata: {
        kernelspec: { name: "python", display_name: "Python (Pyodide)" },
        language_info: { name: "python" }
      },
      nbformat: 4,
      nbformat_minor: 5
    };
  }

  // ---------------------------------------------------------------
  // UI: a small fixed button, independent of JupyterLite's own menus
  // so it survives across JupyterLite versions/updates.
  // ---------------------------------------------------------------
  function buildButton() {
    var btn = document.createElement("button");
    btn.id = "assignment-submit-btn";
    btn.textContent = "Submit Assignment";
    btn.setAttribute(
      "style",
      [
        "position: fixed",
        "bottom: 20px",
        "right: 20px",
        "z-index: 999999",
        "background: #15803d",
        "color: #fff",
        "border: none",
        "border-radius: 8px",
        "padding: 12px 20px",
        "font: 600 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        "box-shadow: 0 4px 14px rgba(0,0,0,0.3)",
        "cursor: pointer"
      ].join(";")
    );
    document.body.appendChild(btn);
    return btn;
  }

  function setButtonState(btn, text, color, disabled) {
    btn.textContent = text;
    btn.style.background = color;
    btn.disabled = !!disabled;
  }

  function submit(btn) {
    if (APPS_SCRIPT_URL.indexOf("PASTE_YOUR_GOOGLE_APPS_SCRIPT") === 0) {
      window.alert(
        "auto-submit.js is not configured yet: set APPS_SCRIPT_URL at the top of the file to your deployed Apps Script Web App URL."
      );
      return;
    }

    var identity = ensureIdentity();
    if (!identity) return; // student cancelled

    var confirmed = window.confirm(
      "Submit your current notebook now?\n\nMake sure you've run all cells first (Run → Run All Cells) so your output is captured."
    );
    if (!confirmed) return;

    setButtonState(btn, "Submitting…", "#a16207", true);

    var notebook = buildNotebookJSON(scrapeNotebookCells());
    var payload = {
      assignment: ASSIGNMENT_NAME,
      name: identity.name,
      studentId: identity.studentId,
      submittedAt: new Date().toISOString(),
      pageUrl: window.location.href,
      notebook: notebook
    };

    fetch(APPS_SCRIPT_URL, {
      method: "POST",
      // "text/plain" keeps this a CORS "simple request" so the browser
      // doesn't send a preflight OPTIONS request (which Apps Script
      // Web Apps don't handle). doPost() reads the raw JSON body itself.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().catch(function () {
          return { status: "ok" }; // tolerate a non-JSON response
        });
      })
      .then(function (result) {
        if (result && result.status === "error") {
          throw new Error(result.message || "Server reported an error.");
        }
        setButtonState(btn, "Submitted ✓ " + new Date().toLocaleTimeString(), "#15803d", false);
      })
      .catch(function (err) {
        console.error("[auto-submit] submission failed:", err);
        setButtonState(btn, "Submit failed — click to retry", "#b91c1c", false);
      });
  }

  function init() {
    var btn = buildButton();
    btn.addEventListener("click", function () {
      submit(btn);
    });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(init, 0);
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();

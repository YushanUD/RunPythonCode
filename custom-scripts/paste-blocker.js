/**
 * paste-blocker.js
 * ------------------------------------------------------------------
 * Blocks pasting text into JupyterLite notebook cells (code + markdown)
 * so students have to type their code themselves.
 *
 * How it works:
 *  - JupyterLite's cell editors are CodeMirror 6 instances rendered as
 *    a `.cm-content` element inside each `.jp-Cell`.
 *  - Instead of attaching a listener to every cell (cells are created
 *    and destroyed constantly as students work), we attach ONE listener
 *    on `document` in the "capture" phase. Capture-phase listeners see
 *    the event before it reaches the target, and because the listener
 *    lives on `document` it automatically covers cells that don't exist
 *    yet when the page first loads (no MutationObserver needed).
 *  - We block the browser's native `paste` event, which fires for:
 *      - Ctrl+V / Cmd+V
 *      - Right-click -> Paste
 *      - Edit menu -> Paste (if any)
 *    We also block `drop` (dragging text/files into a cell) as a
 *    second path that bypasses the paste event.
 *
 * Limitations (be upfront with students/administrators about these):
 *  - This stops one-click paste. It does not stop a determined student
 *    from re-typing AI-generated code character by character while
 *    reading it off a second screen. No client-side script can prevent
 *    that; this is a friction/deterrence measure, not a proctoring tool.
 *  - It only blocks paste *into the notebook cell editors*. Other UI
 *    elements in JupyterLite (like the "Rename file" dialog) are left
 *    alone on purpose so normal use of the app isn't broken.
 *
 * Installation:
 *  Add this file next to your built `index.html` (e.g. in the same
 *  `lab/` folder as https://yushanud.github.io/RunPythonCode/lab/index.html)
 *  and include it with a <script> tag just before </body>:
 *
 *    <script src="./paste-blocker.js"></script>
 *
 *  See SETUP-INSTRUCTIONS.md for the full walkthrough.
 * ------------------------------------------------------------------
 */
(function () {
  "use strict";

  // Selector matching the editable surface of a Jupyter(Lite) cell editor.
  // ".cm-content" = CodeMirror 6 editable area (current JupyterLab/JupyterLite).
  // ".CodeMirror" is included as a fallback for older CodeMirror 5 builds.
  var EDITOR_SELECTOR = ".cm-content, .CodeMirror";

  // Only block inside actual notebook cells, not elsewhere in the app UI
  // (e.g. leave the file-rename box, search box, settings dialogs alone).
  var CELL_SELECTOR = ".jp-Cell";

  function isInsideCellEditor(target) {
    if (!(target instanceof Element)) return false;
    var editor = target.closest(EDITOR_SELECTOR);
    if (!editor) return false;
    return !!editor.closest(CELL_SELECTOR);
  }

  function showBlockedToast() {
    var existing = document.getElementById("paste-blocked-toast");
    if (existing) {
      existing.remove();
    }
    var toast = document.createElement("div");
    toast.id = "paste-blocked-toast";
    toast.textContent = "Pasting is disabled for this assignment — please type your code.";
    toast.setAttribute("style", [
      "position: fixed",
      "top: 16px",
      "left: 50%",
      "transform: translateX(-50%)",
      "background: #b91c1c",
      "color: #fff",
      "padding: 10px 18px",
      "border-radius: 8px",
      "font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      "box-shadow: 0 4px 14px rgba(0,0,0,0.25)",
      "z-index: 999999",
      "pointer-events: none",
      "opacity: 0",
      "transition: opacity 150ms ease-in-out"
    ].join(";"));
    document.body.appendChild(toast);
    // Fade in, then fade out and remove.
    requestAnimationFrame(function () {
      toast.style.opacity = "1";
    });
    setTimeout(function () {
      toast.style.opacity = "0";
      setTimeout(function () {
        toast.remove();
      }, 200);
    }, 2200);
  }

  function blockIfInEditor(event) {
    if (isInsideCellEditor(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      showBlockedToast();
    }
  }

  // `true` = capture phase, so we see the event before CodeMirror does.
  document.addEventListener("paste", blockIfInEditor, true);
  document.addEventListener("drop", blockIfInEditor, true);

  // Belt-and-suspenders: also block the "Paste" entry in the browser's
  // native right-click context menu from doing anything useful by
  // preventing the underlying paste event above (contextmenu itself
  // can't be reliably intercepted per-item, but the paste it triggers
  // is already handled).

  // Optional: block Ctrl/Cmd+Shift+V (paste without formatting) the
  // same way, since it also fires a normal "paste" event in Chromium
  // browsers, so no extra handling is actually required here.

  console.log("[paste-blocker] Paste blocking active for notebook cells.");
})();

(function initLogViewer() {
  "use strict";
  document.getElementById("popup-refresh-logs")?.addEventListener("click", () => window.opener?.loadLogs?.());
  document.getElementById("popup-close-window")?.addEventListener("click", () => window.close());
  document.getElementById("popup-auto-refresh")?.addEventListener("change", (event) => {
    const parentCheckbox = window.opener?.document?.getElementById("auto-refresh-logs");
    if (!parentCheckbox) return;
    parentCheckbox.checked = event.target.checked;
    parentCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
  });
  window.opener?.syncLogPopup?.();
})();

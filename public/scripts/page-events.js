(function bindPageEvents() {
  "use strict";

  const clickInput = (buttonId, inputId) => {
    document.getElementById(buttonId)?.addEventListener("click", () => document.getElementById(inputId)?.click());
  };
  clickInput("capture-button", document.getElementById("edit-photo-live") ? "edit-photo-live" : "live-photo");
  clickInput("add-capture-button", "add-photo-live");

  const bindEnter = (inputId, buttonId) => {
    document.getElementById(inputId)?.addEventListener("keyup", (event) => {
      if (event.key === "Enter") document.getElementById(buttonId)?.click();
    });
  };
  bindEnter("admin-password", "login-button");
  bindEnter("maintenance-password", "login-button");

  document.getElementById("close-history-modal")?.addEventListener("click", () => window.closeHistoryModal?.());
  document.getElementById("open-config-editor")?.addEventListener("click", () => window.showConfigEditor?.());
  document.getElementById("config-select")?.addEventListener("change", () => window.showConfigEditor?.());
  document.getElementById("cancel-config-editor")?.addEventListener("click", () => {
    const editor = document.getElementById("config-editor");
    if (editor) editor.style.display = "none";
  });
})();

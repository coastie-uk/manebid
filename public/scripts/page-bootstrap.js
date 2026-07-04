(function bootstrapPage(global) {
  "use strict";

  const root = document.documentElement;
  const getBrowserTheme = () => global.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  let mode = "light";
  try {
    if (root.dataset.themeSource === "public") {
      mode = sessionStorage.getItem("publicEntryTheme") === "dark" ? "dark" : "light";
    } else {
      const session = JSON.parse(localStorage.getItem("operatorSession") || "null");
      const savedMode = String(session?.user?.preferences?.theme?.mode || "").toLowerCase();
      mode = ["dark", "light"].includes(savedMode) ? savedMode : getBrowserTheme();
    }
  } catch (_error) {
    mode = root.dataset.themeSource === "public" ? "light" : getBrowserTheme();
  }
  root.dataset.theme = mode;
  root.style.colorScheme = mode;

  const viewKey = root.dataset.viewKey;
  if (viewKey) {
    const access = {};
    if (root.dataset.accessRole) access.role = root.dataset.accessRole;
    if (root.dataset.accessPermission) access.permission = root.dataset.accessPermission;
    global.__APP_PAGE_AUTH__ = {
      viewKey,
      access,
      allowKiosk: root.dataset.allowKiosk === "true"
    };
  }

  if (root.dataset.messagePollMs) {
    global.AppMessagingConfig = {
      closedPollMs: Number(root.dataset.messagePollMs),
      ...(root.dataset.messageAuctionSelect ? { auctionSelectId: root.dataset.messageAuctionSelect } : {}),
      ...(root.dataset.messageItemReferences === "false" ? { enableItemReferences: false } : {})
    };
  }
  if (root.dataset.assetVersion) {
    global.__CASHIER_ASSET_VERSION__ = root.dataset.assetVersion;
  }
})(window);

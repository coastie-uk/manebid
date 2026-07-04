(function initBuyerDisplay() {
  "use strict";
  const content = document.getElementById("buyer-display-content");
  const auction = document.getElementById("buyer-display-auction");
  const money = (value) => `${localStorage.getItem("currencySymbol") || "£"}${Number(value || 0).toFixed(2)}`;
  let lastState = "";

  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };

  function getState() {
    try {
      return window.opener?.__getCashierBuyerDisplayState__?.()
        || JSON.parse(localStorage.getItem("cashierBuyerDisplayState") || "null");
    } catch (_error) {
      return null;
    }
  }

  function section(title) {
    const node = element("section", undefined, "buyer-display-section");
    node.appendChild(element("h3", title, "detail-heading"));
    return node;
  }

  function render(state) {
    const theme = state?.theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    auction.textContent = state?.auctionName || "Buyer Display";
    content.replaceChildren();
    const bidder = state?.selectedBidder;
    if (!bidder) {
      content.appendChild(element("div", "Select a paddle on the cashier screen to show the buyer review here.", "buyer-display-empty"));
      return;
    }

    const identity = section("Buyer");
    identity.appendChild(element("h2", bidder.bidder_label || `Paddle #${bidder.paddle_number}`, "buyer-display-paddle"));
    content.appendChild(identity);

    const lotsSection = section("Lots won");
    const table = document.createElement("table");
    const header = document.createElement("tr");
    ["Lot", "Title", "Price"].forEach((label) => header.appendChild(element("th", label)));
    const thead = document.createElement("thead");
    thead.appendChild(header);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    const lots = Array.isArray(bidder.lots) ? bidder.lots : [];
    (lots.length ? lots : [{ item_number: "", description: "No lots won", hammer_price: 0 }]).forEach((lot) => {
      const row = document.createElement("tr");
      [lot.item_number, lot.description, money(lot.hammer_price)].forEach((value) => row.appendChild(element("td", value)));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    lotsSection.appendChild(table);
    lotsSection.appendChild(element("div", `Total lots: ${money(bidder.lots_total)}`, "section-total"));
    content.appendChild(lotsSection);

    if (state.showPictures) {
      const pictures = lots.filter((lot) => lot.photo_url).slice(0, 6);
      if (pictures.length) {
        const previews = section("Item previews");
        const strip = element("div", undefined, "buyer-display-thumbnails");
        pictures.forEach((lot) => {
          const figure = element("figure", undefined, "buyer-display-thumb");
          const image = document.createElement("img");
          image.src = `/api/uploads/preview_${encodeURIComponent(lot.photo_url)}`;
          image.alt = `Lot ${lot.item_number} preview`;
          figure.append(image, element("figcaption", `Lot ${lot.item_number}`));
          strip.appendChild(figure);
        });
        previews.appendChild(strip);
        content.appendChild(previews);
      }
    }

    const summary = section("Summary");
    const cards = element("div", undefined, "buyer-display-summary");
    [["Paid", bidder.payments_total], ["Donations", bidder.donations_total], ["Balance", bidder.balance]].forEach(([label, value]) => {
      const card = element("div", undefined, "summary-card");
      card.append(element("span", label, "summary-card-label"), element("span", money(value), "summary-card-value"));
      cards.appendChild(card);
    });
    summary.appendChild(cards);
    content.appendChild(summary);
  }

  function sync() {
    const state = getState();
    const serialized = JSON.stringify(state);
    if (serialized === lastState) return;
    lastState = serialized;
    render(state);
  }
  window.__renderBuyerDisplayState__ = render;
  sync();
  window.setInterval(sync, 3000);
})();

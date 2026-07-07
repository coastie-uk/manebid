(function initialiseSumupResult() {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const title = document.getElementById("sumup-result-title");
  const message = document.getElementById("sumup-result-message");
  const guidance = document.getElementById("sumup-result-guidance");
  const closeButton = document.getElementById("sumup-close-button");
  const fallback = document.getElementById("sumup-close-fallback");
  const mode = params.get("mode") === "test" ? "test" : "result";
  const callbackType = params.get("type") === "web" ? "web" : "app";
  const rawStatus = params.get("status");
  const status = new Set(["success", "failed", "invalidstate", "unknown"]).has(rawStatus)
    ? rawStatus
    : "unknown";

  const resultMessages = {
    success: ["Payment confirmed", "SumUp confirmed this payment successfully."],
    failed: ["Payment not completed", "SumUp confirmed that this payment did not complete."],
    invalidstate: ["Payment state unavailable", "The callback state was invalid. Check the payment from ManeBid."],
    unknown: ["Payment awaiting verification", "ManeBid has not received authoritative confirmation from SumUp. The payment remains pending."]
  };

  if (mode === "test") {
    title.textContent = `SumUp ${callbackType === "web" ? "web" : "app"} callback test`;
    message.textContent = "The callback endpoint is reachable.";
    guidance.textContent = "This confirms routing only. Complete a test payment to verify the full integration.";
    closeButton.hidden = true;
    return;
  }

  title.textContent = resultMessages[status][0];
  message.textContent = resultMessages[status][1];
  guidance.textContent = "Return to ManeBid to see the current payment status.";

  function attemptClose() {
    window.close();
    window.setTimeout(() => {
      fallback.hidden = false;
      closeButton.disabled = true;
    }, 500);
  }

  closeButton.addEventListener("click", attemptClose);
  if (status === "success" || status === "failed") {
    window.setTimeout(attemptClose, 3000);
  }
})();

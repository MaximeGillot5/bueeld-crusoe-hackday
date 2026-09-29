"use strict";

const params = new URLSearchParams(window.location.search);
const connector = params.get("connector");
const status = params.get("status");
const valid = ["gmail", "google_drive", "google_calendar", "notion"].includes(connector) && ["connected", "error"].includes(status);
document.getElementById("connection-title").textContent = status === "connected" && valid ? "Account connected" : "Connection not completed";
document.getElementById("connection-message").textContent = status === "connected" && valid
  ? "Lab is updating your sources. You can close this tab."
  : "Return to Lab to retry. You can close this tab.";

if (valid && typeof BroadcastChannel === "function") {
  const channel = new BroadcastChannel("bueeld-lab-connector-oauth");
  channel.postMessage({ connector, status });
  setTimeout(() => channel.close(), 1000);
}
if (valid) setTimeout(() => window.close(), 600);

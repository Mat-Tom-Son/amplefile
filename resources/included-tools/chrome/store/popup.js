(() => {
  const labels = { not_connected: "Not connected", connecting: "Connecting…", connected: "Connected", app_not_running: "Open AmpleFile", native_host_missing: "Open AmpleFile", update_app: "Update AmpleFile", update_extension: "Update Chrome extension", profile_conflict: "Another profile is connected", busy: "Chrome is in use", store_unavailable: "Chrome connection unavailable", connection_error: "Couldn’t connect" };
  const status = document.querySelector("#status"), detail = document.querySelector("#detail"), actions = document.querySelector("#actions");
  let busy = false, revision = 0;
  function button(label, action, primary = false) {
    const node = document.createElement("button"); node.type = "button"; node.textContent = label; node.disabled = busy;
    if (primary) node.className = "primary";
    node.addEventListener("click", () => void request(action)); actions.append(node);
  }
  function show(value) {
    status.textContent = labels[value.state] ?? labels.connection_error;
    detail.textContent = value.state === "profile_conflict" ? "Change profile in AmpleFile." : value.state === "busy" ? "Finish or stop the current Chat, then try again." : value.state === "native_host_missing" ? "Choose Connect Chrome in AmpleFile." : "";
    detail.hidden = !detail.textContent; actions.replaceChildren();
    if (value.state === "connected") button("Disconnect", "disconnect");
    else if (["app_not_running", "native_host_missing", "update_app"].includes(value.state)) { button("Open AmpleFile", "open-app", true); button("Retry", "status"); }
    else if (value.state === "update_extension") {
      const id = globalThis.AMPLEFILE_CHROME_CONFIG.storeId;
      if (/^[a-p]{32}$/.test(id ?? "")) { const link = document.createElement("a"); link.href = `https://chromewebstore.google.com/detail/${id}`; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "Open Chrome Web Store"; actions.append(link); }
    } else if (value.state === "profile_conflict") button("Open AmpleFile", "open-app", true);
    else if (value.state !== "store_unavailable" && value.state !== "connecting") button("Connect", "connect", true);
    if (value.hasSelection && !["connected", "connecting", "profile_conflict"].includes(value.state)) button("Disconnect", "disconnect");
  }
  async function request(action) {
    if (busy && action !== "status") return;
    const current = ++revision;
    if (action !== "status") { busy = true; for (const node of actions.querySelectorAll("button")) node.disabled = true; }
    try {
      const result = await chrome.runtime.sendMessage({ type: "amplefile.connection", action });
      if (current === revision) { busy = false; show(result ?? { state: "connection_error" }); }
    } catch { if (current === revision) { busy = false; show({ state: "connection_error" }); } }
  }
  void request("status");
  const timer = setInterval(() => { if (!busy) void request("status"); }, 2_000);
  window.addEventListener("pagehide", () => { clearInterval(timer); revision++; });
})();

// The package repository proof's hands on the real installed app (README.md
// beside this file): calls `window.ampleFileDesktop.updates` in a file
// manager window over the Chrome DevTools Protocol, as Settings → About and
// the sidebar's update indicator do.
//
//   node app-driver.mjs PORT status|check|install [TIMEOUT_SECONDS]
//
// status and check print the update status as JSON. install starts the
// restart and returns without waiting, since the process it talks to quits.
const [port, action, timeoutSeconds = "60"] = process.argv.slice(2);
const deadline = Date.now() + Number(timeoutSeconds) * 1000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One DevTools session: sends Runtime.evaluate and returns the value. */
async function evaluate(webSocketDebuggerUrl, expression, awaitPromise) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error("DevTools connection failed")); });
  try {
    const reply = new Promise((resolve, reject) => {
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        if (message.error) reject(new Error(message.error.message));
        else if (message.result.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description ?? "evaluation failed"));
        else resolve(message.result.result.value);
      };
      socket.onclose = () => reject(new Error("DevTools connection closed"));
    });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise, returnByValue: true } }));
    return await reply;
  } finally {
    socket.onclose = null;
    socket.close();
  }
}

/** The first page whose window carries the desktop bridge's update calls. */
async function fileManagerWindow() {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      for (const page of pages.filter((item) => item.type === "page" && item.webSocketDebuggerUrl)) {
        if (await evaluate(page.webSocketDebuggerUrl, "typeof window.ampleFileDesktop?.updates?.getStatus === 'function'", false)) return page;
      }
      lastError = new Error("no file manager window yet");
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`No AmpleFile window answered on port ${port}: ${lastError?.message}`);
}

const page = await fileManagerWindow();
if (action === "status" || action === "check") {
  const call = action === "status" ? "getStatus" : "check";
  console.log(JSON.stringify(await evaluate(page.webSocketDebuggerUrl, `window.ampleFileDesktop.updates.${call}()`, true)));
} else if (action === "install") {
  // The renderer's own click runs runDesktopUpdateAction, which asks first;
  // this is the call that follows the person's confirmation.
  await evaluate(page.webSocketDebuggerUrl, "void window.ampleFileDesktop.updates.install(), 'started'", false);
  console.log(JSON.stringify({ install: "started" }));
} else {
  throw new Error("Usage: node app-driver.mjs PORT status|check|install [TIMEOUT_SECONDS]");
}

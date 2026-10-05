// Niri's IPC socket (NIRI_SOCKET), shared by niriWindowRule.cjs and activeWindow.cjs.

const net = require("net");

const REQUEST_TIMEOUT_MS = 1000;

// One request on Niri's IPC socket: a line of JSON each way (niri-ipc's socket.rs). Replies are
// Result-shaped, {"Ok": {...}} or {"Err": "..."}.
function request(req, socketPath = process.env.NIRI_SOCKET, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    const fail = (err) => { sock.destroy(); reject(err); };
    sock.setTimeout(timeoutMs, () => fail(new Error("niri IPC timed out")));
    sock.on("error", fail);
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      sock.destroy();
      try {
        const reply = JSON.parse(buf.slice(0, nl));
        if ("Ok" in reply) resolve(reply.Ok);
        else reject(new Error(`niri IPC error: ${reply.Err}`));
      } catch (e) {
        reject(e);
      }
    });
  });
}

module.exports = { request };

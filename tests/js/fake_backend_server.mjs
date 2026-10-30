// The fake Apps Script backend (fake_apps_script.mjs) as an HTTP server, for browser
// tests: tests/test_scanner_e2e.py routes the page's calls to script.google.com here.
//
// usage: node fake_backend_server.mjs '<create_tournament request as JSON, without token>'
// prints "READY <port>". A request with token "ADMIN" runs with the admin token.
import http from "node:http";
import { loadBackend } from "./fake_apps_script.mjs";

const b = loadBackend();
b.setup();
const admin = b.$.props.get("ADMIN_TOKEN");
const created = b.post({ action: "create_tournament", token: admin, ...JSON.parse(process.argv[2]) });
if (!created.ok) {
  console.error(created.error);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let text;
    if (req.method === "POST") {
      const request = JSON.parse(body);
      if (request.token === "ADMIN") request.token = admin;
      text = b.doPost({ postData: { contents: JSON.stringify(request) } }).text;
    } else {
      text = b.doGet().text;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(text);
  });
});
server.listen(0, "127.0.0.1", () => console.log(`READY ${server.address().port}`));

// The fake Apps Script backend (fake_apps_script.mjs: the real apps_script/ code on fake
// Google services) as an HTTP server: the browser tests route the page's calls to
// script.google.com here, and the Python CLI tests route the CLI's (tests/node_backend.py).
//
// usage: node fake_backend_server.mjs ['<create_tournament request as JSON, without token>']
//   env CHGK_FAKE_ACCOUNT: the Google account it runs as (default me@gmail.com)
// prints "READY <port> <admin token>". A request with token "ADMIN" runs with the admin token.
// Test-only endpoints, never in the real backend:
//   GET  /__photos       the card photos saved in the tournament's Photos folder
//   POST /__options      {allScopes?, sheetsApi?}: a missing permission, the Sheets API service off/on
//   POST /__set_cell     {tid, tab, row, col, value}: a person typing in the Sheet (no trigger)
import http from 'node:http';
import {loadBackend} from './fake_apps_script.mjs';

const b = loadBackend({account: process.env.CHGK_FAKE_ACCOUNT || 'me@gmail.com'});
b.setup();
const admin = b.$.props.get('ADMIN_TOKEN');
if (process.argv[2]) {
  const created = b.post({action: 'create_tournament', token: admin, ...JSON.parse(process.argv[2])});
  if (!created.ok) {
    console.error(created.error);
    process.exit(1);
  }
}

const sheetOf = (tid, tab) =>
  b.$.spreadsheets.get(JSON.parse(b.$.props.get(`t:${tid}`)).spreadsheet_id).getSheetByName(tab);

const routes = {
  'GET /__photos': () => {
    const folder = b.$.root.children[0].children[0].children.find((f) => f.name === 'Photos');
    return folder.files.map((f) => ({name: f.name, size: f.size, base64: Buffer.from(f.bytes).toString('base64')}));
  },
  'POST /__options': ({allScopes, sheetsApi}) => {
    if (allScopes !== undefined) {
      b.$.options.allScopes = allScopes;
    }
    if (sheetsApi !== undefined) {
      b.$.setSheetsApi(sheetsApi);
    }
    return {ok: true};
  },
  'POST /__set_cell': ({tid, tab, row, col, value}) => {
    sheetOf(tid, tab).set(row, col, value);
    return {ok: true};
  },
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    let text;
    const route = routes[`${req.method} ${req.url}`];
    if (route) {
      text = JSON.stringify(route(body ? JSON.parse(body) : {}));
    } else if (req.method === 'POST') {
      const request = JSON.parse(body);
      if (request.token === 'ADMIN') {
        request.token = admin;
      }
      text = b.doPost({postData: {contents: JSON.stringify(request)}}).text;
    } else {
      text = b.doGet().text;
    }
    res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
    res.end(text);
  });
});
server.listen(0, '127.0.0.1', () => console.log(`READY ${server.address().port} ${admin}`));

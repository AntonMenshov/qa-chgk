// Spike 1: can a static page (GitHub Pages / localhost) POST JSON + a ~200 KB photo
// to an Apps Script web app and read the response?
// Deploy: script.google.com → New project → paste this → Deploy → New deployment →
// type "Web app", Execute as "Me", Who has access "Anyone" → copy the /exec URL.

function doGet(e) {
  return json_({ ok: true, method: "GET", params: e.parameter });
}

function doPost(e) {
  const started = Date.now();
  const body = JSON.parse(e.postData.contents);
  let photoBytes = 0;
  let fileUrl = null;
  if (body.photo) {
    const blob = Utilities.newBlob(Utilities.base64Decode(body.photo), "image/jpeg", "spike.jpg");
    photoBytes = blob.getBytes().length;
    if (body.saveToDrive) {
      fileUrl = DriveApp.createFile(blob).getUrl();
    }
  }
  return json_({
    ok: true,
    echo: body.msg,
    requestChars: e.postData.contents.length,
    photoBytes: photoBytes,
    fileUrl: fileUrl,
    serverMs: Date.now() - started,
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

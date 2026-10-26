/**
 * Skein mailbox  -  runs free on Google Apps Script, stores in your own Google Drive.
 *
 * What it does: holds ENCRYPTED messages for devices that are offline, until they come
 * to collect them. It cannot read anything: the messages are locked on the sender's
 * device with keys only the recipient's devices have. It sees who a message is for
 * (a random device id), roughly how big it is, and when it arrived.
 *
 * Setup is in README.txt next to this file. You never need to edit anything below.
 */
var VERSION = 1;
var KEEP_DAYS = 14;                          // undelivered messages are thrown away after this
var MAX_BODY_CHARS = 7000000;                // about 5 MB of photo or video per message
var MAX_PER_DEVICE = 300;                    // messages waiting for one device
var MAX_RECIPIENTS = 8;                      // devices one message can be addressed to
var MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // total mailbox size cap (2 GB of your Drive)
var MAX_ENTRIES = 3000;                      // keeps the index inside Apps Script's property limits
var ID_RE = /^[A-Za-z0-9_-]{3,48}$/;

function doGet() { return reply_({ ok: true, skein: 'mailbox', v: VERSION }); }

function doPost(e) {
  var out;
  try {
    var r = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = handle_(r || {});
  } catch (err) {
    out = { ok: false, err: 'bad request' };
  }
  return reply_(out);
}

function reply_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(r) {
  if (r.a === 'ping') return { ok: true, v: VERSION };
  if (r.a === 'has') {   // which of these devices have opened their mailbox yet (lets the app skip useless uploads)
    var p = props_(), have = [];
    (Array.isArray(r.devs) ? r.devs.slice(0, 16) : []).forEach(function (d) { if (ID_RE.test(String(d)) && p.getProperty('t:' + d)) have.push(String(d)); });
    return { ok: true, have: have };
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    if (r.a === 'put') return put_(r);
    if (r.a === 'list') return list_(r);
    if (r.a === 'get') return get_(r);
    if (r.a === 'del') return del_(r);
  } finally { lock.releaseLock(); }
  return { ok: false, err: 'unknown action' };
}

function props_() { return PropertiesService.getScriptProperties(); }

function hash_(s) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return d.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function folder_() {
  var p = props_(), id = p.getProperty('root');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreated below */ } }
  var f = DriveApp.createFolder('SkeinMailbox');
  p.setProperty('root', f.getId());
  return f;
}

/* A device proves it owns its mailbox with a secret derived from its account key.
   The first device to ask for a mailbox claims it; after that the secret is required. */
function auth_(dev, tok, claim) {
  if (!ID_RE.test(String(dev || '')) || !tok || String(tok).length < 20 || String(tok).length > 200) return false;
  var p = props_(), have = p.getProperty('t:' + dev), h = hash_(tok);
  if (!have) { if (!claim) return false; p.setProperty('t:' + dev, h); return true; }
  return have === h;
}

function entries_(dev) {
  var all = props_().getProperties(), pre = 'e:' + dev + ':', out = [];
  for (var k in all) {
    if (k.indexOf(pre) === 0) {
      var v = String(all[k]).split(',');
      out.push({ id: k.slice(pre.length), ts: +v[0] || 0, n: +v[1] || 0 });
    }
  }
  out.sort(function (a, b) { return a.ts - b.ts; });
  return out;
}

function dropRef_(id) {
  var p = props_(), raw = p.getProperty('b:' + id);
  if (!raw) return;
  var b = JSON.parse(raw);
  b.r--;
  if (b.r > 0) { p.setProperty('b:' + id, JSON.stringify(b)); return; }
  try { var f = DriveApp.getFileById(b.f); f.setContent(''); f.setTrashed(true); } catch (e) { /* already gone */ }
  p.deleteProperty('b:' + id);
  p.setProperty('tot', String(Math.max(0, (+p.getProperty('tot') || 0) - (b.n || 0))));
}

function put_(r) {
  var id = String(r.id || ''), body = r.body;
  if (!ID_RE.test(id) || typeof body !== 'string' || !body.length || body.length > MAX_BODY_CHARS) return { ok: false, err: 'bad message' };
  var to = [];
  (Array.isArray(r.to) ? r.to : []).forEach(function (d) { if (ID_RE.test(String(d)) && to.indexOf(String(d)) < 0) to.push(String(d)); });
  if (!to.length || to.length > MAX_RECIPIENTS) return { ok: false, err: 'bad recipients' };
  var p = props_();
  if (p.getProperty('b:' + id)) return { ok: true, dup: true };
  if (p.getKeys().length > MAX_ENTRIES) return { ok: false, err: 'mailbox busy' };
  if ((+p.getProperty('tot') || 0) + body.length > MAX_TOTAL_BYTES) return { ok: false, err: 'mailbox full' };
  // Only devices that have already opened their mailbox can receive. This stops strangers
  // from filling the mailbox with messages for made-up device ids.
  var targets = [], miss = [];
  to.forEach(function (d) { if (!p.getProperty('t:' + d) || entries_(d).length >= MAX_PER_DEVICE) miss.push(d); else targets.push(d); });
  if (!targets.length) return { ok: true, miss: miss };
  var file = folder_().createFile(id, body, MimeType.PLAIN_TEXT), now = Date.now();
  p.setProperty('b:' + id, JSON.stringify({ f: file.getId(), r: targets.length, n: body.length }));
  targets.forEach(function (d) { p.setProperty('e:' + d + ':' + id, now + ',' + body.length); });
  p.setProperty('tot', String((+p.getProperty('tot') || 0) + body.length));
  return { ok: true, miss: miss };
}

function list_(r) {
  if (!auth_(r.dev, r.tok, true)) return { ok: false, err: 'denied' };
  var p = props_(), cut = Date.now() - KEEP_DAYS * 864e5, out = [];
  entries_(r.dev).forEach(function (e) {
    if (e.ts < cut) { p.deleteProperty('e:' + r.dev + ':' + e.id); dropRef_(e.id); } else out.push({ id: e.id, n: e.n });
  });
  return { ok: true, items: out.slice(0, 50), more: out.length > 50 };
}

function get_(r) {
  if (!auth_(r.dev, r.tok, false)) return { ok: false, err: 'denied' };
  var id = String(r.id || ''), p = props_();
  if (!p.getProperty('e:' + r.dev + ':' + id)) return { ok: false, err: 'gone' };
  var raw = p.getProperty('b:' + id);
  if (!raw) return { ok: false, err: 'gone' };
  try { return { ok: true, body: DriveApp.getFileById(JSON.parse(raw).f).getBlob().getDataAsString() }; }
  catch (e) { return { ok: false, err: 'gone' }; }
}

function del_(r) {
  if (!auth_(r.dev, r.tok, false)) return { ok: false, err: 'denied' };
  var id = String(r.id || ''), p = props_(), k = 'e:' + r.dev + ':' + id;
  if (p.getProperty(k)) { p.deleteProperty(k); dropRef_(id); }
  return { ok: true };
}

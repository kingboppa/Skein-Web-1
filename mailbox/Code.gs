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
var VERSION = 2;                             // 2 adds the push relay
var KEEP_DAYS = 14;                          // undelivered messages are thrown away after this
var MAX_BODY_CHARS = 7000000;                // about 5 MB of photo or video per message
var MAX_PER_DEVICE = 300;                    // messages waiting for one device
var MAX_RECIPIENTS = 8;                      // devices one message can be addressed to
var MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // total mailbox size cap (2 GB of your Drive)
var MAX_ENTRIES = 3000;                      // keeps the index inside Apps Script's property limits
var ID_RE = /^[A-Za-z0-9_-]{3,48}$/;
// Notifications: the script only forwards finished, encrypted pushes to these push services.
var PUSH_HOST_RE = /^https:\/\/(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com)\/[\x21-\x7e]{1,600}$/;
var PUSH_MAX_BYTES = 4096;
var PUSH_PER_MINUTE = 120;                    // per device, stops runaway use

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
  if (r.a === 'ping') return { ok: true, v: VERSION, relay: true };
  if (r.a === 'relay') return relay_(r);   // no lock: it only makes one outside request
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

/* Forwards one already-signed, already-encrypted web push. The script never sees the message. */
function relay_(r) {
  if (!auth_(r.dev, r.tok, false)) return { ok: false, err: 'denied' };
  var url = String(r.url || '');
  if (!PUSH_HOST_RE.test(url)) return { ok: false, err: 'address not allowed' };
  var cache = CacheService.getScriptCache(), key = 'rl:' + r.dev + ':' + Math.floor(Date.now() / 60000);
  var n = (+cache.get(key) || 0) + 1;
  if (n > PUSH_PER_MINUTE) return { ok: false, err: 'slow down' };
  cache.put(key, String(n), 120);
  var h = r.headers || {}, headers = {};
  if (typeof h.Authorization !== 'string' || h.Authorization.indexOf('vapid ') !== 0 || h.Authorization.length > 1200) return { ok: false, err: 'bad headers' };
  headers.Authorization = h.Authorization;
  headers.TTL = String(Math.max(0, Math.min(86400 * 4, parseInt(h.TTL, 10) || 86400)));
  if (h.Urgency && /^(very-low|low|normal|high)$/.test(h.Urgency)) headers.Urgency = h.Urgency;
  if (h.Topic && /^[A-Za-z0-9_-]{1,32}$/.test(h.Topic)) headers.Topic = h.Topic;
  headers['Content-Encoding'] = 'aes128gcm';
  var bytes;
  try { bytes = Utilities.base64Decode(String(r.body || '')); } catch (e) { return { ok: false, err: 'bad body' }; }
  if (!bytes.length || bytes.length > PUSH_MAX_BYTES) return { ok: false, err: 'bad body' };
  try {
    var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/octet-stream', payload: bytes, headers: headers, muteHttpExceptions: true, followRedirects: false });
    return { ok: true, status: res.getResponseCode(), text: String(res.getContentText() || '').slice(0, 200) };
  } catch (e) { return { ok: false, err: String(e && e.message || e).slice(0, 120) }; }
}

/* Run this once from the editor (select "authorize", press Run) so Google asks you to allow sending notifications. */
function authorize() {
  UrlFetchApp.fetch('https://web.push.apple.com/', { muteHttpExceptions: true, followRedirects: false });
  DriveApp.getRootFolder();
  return 'ok';
}

// Telegram approval poller for Demo 1 (Invoice & PO Auditor).
// Polls Telegram getUpdates (long polling, outbound only - no public URL needed)
// and forwards approval replies from the reviewer to the n8n responder webhook.
// The bot token is decrypted in-memory from n8n's own credential store at
// startup; it is never written to a file, never logged, and never printed.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const os = require('os');

const HOME = process.env.HOME || os.homedir();
const N8N_DIR = process.env.N8N_DIR || process.env.N8N_USER_FOLDER || path.join(HOME, '.n8n');
const CONFIG_PATH = path.join(N8N_DIR, 'config');
const DB_PATH = path.join(N8N_DIR, 'database.sqlite');
const POLLER_DIR = process.env.POLLER_DIR || __dirname;
const OFFSET_FILE = path.join(POLLER_DIR, 'offset.txt');
const CRED_ID = process.env.TELEGRAM_CRED_ID || 'YOUR_TELEGRAM_CREDENTIAL_ID';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'YOUR_TELEGRAM_CHAT_ID';
const RESPONDER_WEBHOOK = 'http://127.0.0.1:5678/webhook/telegram-approval-reply';
const POLL_TIMEOUT_S = 30;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function evpBytesToKey(password, salt, keyLen, ivLen) {
  const pass = Buffer.from(password, 'utf8');
  let derived = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (derived.length < keyLen + ivLen) {
    const md5 = crypto.createHash('md5');
    md5.update(prev);
    md5.update(pass);
    md5.update(salt);
    prev = md5.digest();
    derived = Buffer.concat([derived, prev]);
  }
  return { key: derived.subarray(0, keyLen), iv: derived.subarray(keyLen, keyLen + ivLen) };
}

function loadBotToken() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const passphrase = config.encryptionKey;
  const b64 = execSync(`sqlite3 "${DB_PATH}" "SELECT data FROM credentials_entity WHERE id='${CRED_ID}';"`, { encoding: 'utf8' }).trim();
  const raw = Buffer.from(b64, 'base64');
  if (raw.subarray(0, 8).toString('latin1') !== 'Salted__') throw new Error('credential is not Salted__ format');
  const salt = raw.subarray(8, 16);
  const ciphertext = raw.subarray(16);
  const { key, iv } = evpBytesToKey(passphrase, salt, 32, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const cred = JSON.parse(plain.toString('utf8'));
  if (!cred.accessToken || !cred.baseUrl) throw new Error('credential missing accessToken/baseUrl');
  return { token: cred.accessToken, baseUrl: cred.baseUrl.replace(/\/$/, '') };
}

function readOffset() {
  try {
    const v = parseInt(fs.readFileSync(OFFSET_FILE, 'utf8').trim(), 10);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function writeOffset(offset) {
  const tmp = OFFSET_FILE + '.tmp';
  fs.writeFileSync(tmp, String(offset));
  fs.renameSync(tmp, OFFSET_FILE);
}

async function botApi(baseUrl, token, method, body) {
  const res = await fetch(`${baseUrl}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(data).slice(0, 200)}`);
  return data.result;
}

function isApprovalReply(update) {
  const msg = update.message;
  if (!msg || typeof msg.text !== 'string') return false;
  if (String(msg.chat && msg.chat.id) !== CHAT_ID) return false;
  return /\b(approve|reject|disapprove|deny)\b/i.test(msg.text);
}

async function forwardToResponder(update) {
  const res = await fetch(RESPONDER_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`responder webhook HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function main() {
  const { token, baseUrl } = loadBotToken();
  log('bot token loaded from n8n credential store (in-memory only)');
  // Clear any webhook left by sendAndWait so getUpdates works. Do not drop
  // pending updates - a reply sent before this started must still be seen.
  try {
    await botApi(baseUrl, token, 'deleteWebhook', {});
    log('deleteWebhook called (any stale webhook cleared)');
  } catch (err) {
    log(`deleteWebhook warning: ${err.message}`);
  }
  try {
    const info = await botApi(baseUrl, token, 'getWebhookInfo', {});
    log(`webhook info: url=${info.url || '(none)'} pending=${info.pending_update_count}`);
  } catch (err) {
    log(`getWebhookInfo warning: ${err.message}`);
  }
  let offset = readOffset();
  log(`starting long-poll loop from offset ${offset}`);
  for (;;) {
    let updates;
    try {
      updates = await botApi(baseUrl, token, 'getUpdates', { offset, timeout: POLL_TIMEOUT_S });
    } catch (err) {
      log(`getUpdates error: ${err.message} - retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!Array.isArray(updates) || updates.length === 0) continue;
    let nextOffset = offset;
    for (const update of updates) {
      const updateId = update.update_id;
      if (typeof updateId === 'number' && updateId >= nextOffset) nextOffset = updateId + 1;
      if (!isApprovalReply(update)) continue;
      const text = (update.message.text || '').replace(/\s+/g, ' ').slice(0, 80);
      log(`approval reply seen (update ${updateId}): "${text}" - forwarding to responder`);
      try {
        await forwardToResponder(update);
        log(`forwarded update ${updateId} to responder`);
      } catch (err) {
        log(`forward FAILED for update ${updateId}: ${err.message} - will retry (offset held)`);
        // Hold the offset at this update so it is retried next round.
        nextOffset = updateId;
        break;
      }
    }
    if (nextOffset !== offset) {
      offset = nextOffset;
      writeOffset(offset);
    }
  }
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});

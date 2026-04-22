import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import express from 'express';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import pino from 'pino';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } from '@whiskeysockets/baileys';

function sanitizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function normalizeJid(jid) {
  return String(jid || '').replace(/:\d+@/, '@');
}

const PORT = Number(process.env.PORT) || 21226;
const SESSION_PREFIX = process.env.SESSION_PREFIX || 'TECHKING~';
const PAIR_TIMEOUT_MS = Number(process.env.PAIR_TIMEOUT_MS || 180000);
const MAX_RECONNECTS = Number(process.env.MAX_RECONNECTS || 10);
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function getAuthDir(id) {
  return path.join(SESSIONS_DIR, id);
}

function getCredsPath(id) {
  return path.join(getAuthDir(id), 'creds.json');
}

function getSessionPath(id) {
  return path.join(getAuthDir(id), 'session.txt');
}

function buildSessionFromCredsFile(id) {
  const credsPath = getCredsPath(id);
  if (!fs.existsSync(credsPath)) return null;

  try {
    const content = fs.readFileSync(credsPath, 'utf8').trim();
    if (!content) return null;
    const creds = JSON.parse(content);
    return SESSION_PREFIX + Buffer.from(JSON.stringify(creds)).toString('base64');
  } catch (error) {
    console.error('Error parsing creds file:', error.message);
    return null;
  }
}

function saveSessionToDisk(id, session) {
  fs.writeFileSync(getSessionPath(id), session, 'utf8');
}

function loadSessionFromDisk(id) {
  const sessionPath = getSessionPath(id);

  if (fs.existsSync(sessionPath)) {
    return fs.readFileSync(sessionPath, 'utf8');
  }

  const rebuilt = buildSessionFromCredsFile(id);
  if (rebuilt) {
    saveSessionToDisk(id, rebuilt);
    return rebuilt;
  }

  return null;
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pairRequests = new Map();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/pair/request', async (req, res) => {
  try {
    const phone = sanitizePhone(req.body?.phone);

    if (!/^\d{7,15}$/.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone format' });
    }

    const id = randomUUID();
    const authDir = getAuthDir(id);
    fs.mkdirSync(authDir, { recursive: true });

    const entry = {
      id,
      phone,
      authDir,
      status: 'starting',
      pairCode: null,
      sessionString: null,
      reconnects: 0,
      pairingDone: false,
      notified: false,
      error: null,
      sock: null,
      startedAt: Date.now()
    };

    pairRequests.set(id, entry);

    startPairingFlow(id).catch((error) => {
      entry.status = 'error';
      entry.error = error.message || 'Pairing flow failed';
      console.error('Pairing flow error:', error);
    });

    const started = Date.now();

    while (!entry.pairCode && entry.status !== 'error' && Date.now() - started < PAIR_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (entry.status === 'error') {
      return res.status(500).json({ error: entry.error || 'Failed to generate code' });
    }

    if (!entry.pairCode) {
      return res.status(504).json({ error: 'Timed out while generating code' });
    }

    return res.json({
      id: entry.id,
      phone: entry.phone,
      pairCode: entry.pairCode,
      status: entry.status
    });
  } catch (error) {
    console.error('Request error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.get('/api/pair/status/:id', (req, res) => {
  const id = req.params.id;
  const entry = pairRequests.get(id);

  if (entry) {
    if (!entry.sessionString) {
      const diskSession = loadSessionFromDisk(id);
      if (diskSession) {
        entry.sessionString = diskSession;
      }
    }

    return res.json({
      id: entry.id,
      status: entry.sessionString ? 'session_ready' : entry.status,
      pairCode: entry.pairCode,
      hasSession: Boolean(entry.sessionString),
      notified: entry.notified,
      error: entry.error
    });
  }

  const authDir = getAuthDir(id);
  if (fs.existsSync(authDir)) {
    const diskSession = loadSessionFromDisk(id);
    return res.json({
      id,
      status: diskSession ? 'session_ready' : 'unknown',
      pairCode: null,
      hasSession: Boolean(diskSession),
      notified: false,
      error: null
    });
  }

  return res.status(404).json({ error: 'Not found' });
});

app.get('/api/session/:id', (req, res) => {
  const id = req.params.id;
  const entry = pairRequests.get(id);

  if (entry?.sessionString) {
    return res.json({
      session: entry.sessionString,
      notified: entry.notified,
      status: entry.status
    });
  }

  const diskSession = loadSessionFromDisk(id);
  if (diskSession) {
    return res.json({
      session: diskSession,
      notified: false,
      status: entry?.status || 'session_ready'
    });
  }

  return res.status(404).json({ error: 'Session not ready yet' });
});

async function startPairingFlow(id) {
  const entry = pairRequests.get(id);
  if (!entry) return;

  const { state, saveCreds } = await useMultiFileAuthState(entry.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    version,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldIgnoreJid: () => false,
    shouldSyncHistoryMessage: () => true,
    emitOwnEventsFlag: true
  });

  entry.sock = sock;
  let pairingCodeRequested = false;

  sock.ev.on('creds.update', async () => {
    try {
      console.log(`[${entry.phone}] 🔄 Credentials updating...`);
      await saveCreds();

      const sessionString = buildSessionFromCredsFile(id);
      if (sessionString && sessionString.length > 50) {
        entry.sessionString = sessionString;
        saveSessionToDisk(id, sessionString);
        console.log(`[${entry.phone}] ✓ Credentials saved successfully!`);
      } else {
        console.log(`[${entry.phone}] ⚠ Credentials updated but incomplete`);
      }
    } catch (error) {
      console.error(`[${entry.phone}] Error saving creds:`, error.message);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'connecting') {
      entry.status = 'connecting';
      console.log(`[${entry.phone}] Connecting...`);
    }

    if (connection === 'open') {
      entry.pairingDone = true;
      entry.status = 'connected';
      console.log(`[${entry.phone}] ✓ Connection OPEN - waiting for credentials...`);

      try {
        let sessionString = buildSessionFromCredsFile(id);

        if (!sessionString) {
          console.log(`[${entry.phone}] No session yet, waiting 3 seconds...`);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          sessionString = buildSessionFromCredsFile(id);
        }

        if (sessionString) {
          entry.sessionString = sessionString;
          saveSessionToDisk(id, sessionString);
          console.log(`[${entry.phone}] ✓ Session saved!`);

          const selfJid = normalizeJid(sock.user?.id);

          if (selfJid) {
            try {
              await sock.sendMessage(selfJid, {
                text: `*TECHKING CONNECTED*\n\nSESSION:\n${sessionString}`
              });
              entry.notified = true;
              console.log(`[${entry.phone}] ✓ Session sent to WhatsApp!`);
            } catch (sendError) {
              entry.notified = false;
              console.error(`[${entry.phone}] Failed to send session:`, sendError.message);
            }
          }

          entry.status = 'session_ready';
        } else {
          console.log(`[${entry.phone}] Still waiting for credentials...`);
          entry.status = 'waiting_credentials';
        }
      } catch (error) {
        entry.error = error.message || 'Session generation error';
        entry.status = 'error';
        console.error(`[${entry.phone}] Error:`, error.message);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${entry.phone}] Connection closed. Status code: ${statusCode}`);

      if (entry.sessionString) {
        entry.status = 'session_ready';
        console.log(`[${entry.phone}] ✓ Session already ready!`);
        return;
      }

      // CRITICAL FIX: If pairing code was sent, MUST reconnect to receive credentials from phone
      if (pairingCodeRequested && !entry.sessionString) {
        console.log(`[${entry.phone}] ⚠️ Pairing code sent but connection closed. Reconnecting to receive credentials...`);
        
        entry.reconnects = (entry.reconnects || 0) + 1;
        if (entry.reconnects > 8) {
          entry.status = 'error';
          entry.error = 'Failed to receive credentials after multiple reconnects';
          console.error(`[${entry.phone}] ✗ Max reconnect attempts reached (${entry.reconnects})`);
          return;
        }
        
        entry.status = 'reconnecting';
        console.log(`[${entry.phone}] Reconnect attempt ${entry.reconnects}/8...`);
        
        setTimeout(() => {
          console.log(`[${entry.phone}] Starting new connection to receive credentials...`);
          startPairingFlow(id).catch((error) => {
            entry.status = 'error';
            entry.error = error.message || 'Reconnect failed';
            console.error(`[${entry.phone}] Reconnect error:`, error.message);
          });
        }, 2000);
        
        return;
      }

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && !entry.pairingDone;

      if (shouldReconnect && entry.reconnects < MAX_RECONNECTS) {
        entry.reconnects = (entry.reconnects || 0) + 1;
        entry.status = 'reconnecting';
        console.log(`[${entry.phone}] Reconnecting (attempt ${entry.reconnects}/${MAX_RECONNECTS})...`);

        setTimeout(() => {
          startPairingFlow(id).catch((error) => {
            entry.status = 'error';
            entry.error = error.message || 'Reconnect failed';
            console.error(`[${entry.phone}] Reconnect error:`, error.message);
          });
        }, 2000);
      } else if (!shouldReconnect) {
        entry.status = 'logged_out';
        console.log(`[${entry.phone}] User logged out`);
      }
    }
  });

  if (!state.creds.registered) {
    let attemptCount = 0;
    const maxAttempts = 25;
    let credsCheckTimeout;

    const attemptPairingCode = async () => {
      if (pairingCodeRequested || attemptCount >= maxAttempts) return;
      attemptCount++;

      try {
        entry.status = 'requesting_code';
        console.log(`[${entry.phone}] Requesting pairing code (attempt ${attemptCount}/${maxAttempts})...`);

        const code = await sock.requestPairingCode(entry.phone);
        if (code) {
          entry.pairCode = String(code)
            .replace(/\s+/g, '')
            .replace(/-/g, '')
            .toUpperCase();
          entry.status = 'waiting_for_link';
          pairingCodeRequested = true;
          console.log(`[${entry.phone}] ✓ Pair code: ${entry.pairCode} - Keep WhatsApp open, waiting for credentials...`);

          credsCheckTimeout = setTimeout(() => {
            if (entry.sessionString) {
              console.log(`[${entry.phone}] ✓ Credentials received!`);
            } else {
              console.log(`[${entry.phone}] Timeout: Still waiting for credentials from WhatsApp...`);
            }
          }, 60000);

          return;
        }
      } catch (error) {
        entry.error = error.message || 'Pair code error';
        console.error(`[${entry.phone}] ⚠ Attempt ${attemptCount}: ${error.message}`);

        if (attemptCount < maxAttempts) {
          entry.status = 'retrying';
          setTimeout(attemptPairingCode, 4000);
        } else {
          entry.status = 'error';
          console.error(`[${entry.phone}] ✗ Failed after ${maxAttempts} attempts`);
        }
      }
    };

    setTimeout(attemptPairingCode, 1500);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server on port ${PORT}`);
});

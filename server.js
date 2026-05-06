// Polyfill crypto for Baileys compatibility (Node 18 fallback)
if (!globalThis.crypto) {
  const { webcrypto } = require('crypto');
  globalThis.crypto = webcrypto;
}

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, downloadContentFromMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const cors = require('cors');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration (same env vars as whatsapp-web.js version)
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://wmzbqsegsyagcjgxefqs.supabase.co/functions/v1/webhook-whatsapp-personal';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-secret-key-here';
const MICROSERVICE_SECRET = process.env.MICROSERVICE_SECRET || 'your-secret-key-here';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ⚙️ OPTIMIZATION SETTINGS (same as before)
const MAX_CONCURRENT_SESSIONS = parseInt(process.env.MAX_CLIENTS || '100', 10);
const QR_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes to scan QR
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Cleanup every 5 minutes

// Baileys logger (silent to reduce noise)
const logger = pino({ level: 'silent' });

// Middleware
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

// Storage for clients, QR codes, timeouts, and stores
const clients = new Map();      // agentId -> { sock, store, saveCreds }
const qrCodes = new Map();      // agentId -> base64 QR image
const qrTimeouts = new Map();   // agentId -> timeout handle
const clientStates = new Map(); // agentId -> 'connecting' | 'open' | 'close'
const reconnectAttempts = new Map(); // agentId -> reconnect attempt count
const sentMessages = new Map();     // messageId -> { conversation: content } for retry decryption
const lastEdgeFunctionNotify = new Map(); // agentId -> timestamp of last edge function notification
const isFirstConnection = new Map();      // agentId -> boolean (true if QR was just scanned)
const lidToPhoneCache = new Map();        // agentId -> Map<lidJid, phoneJid> in-memory LID resolution cache

const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_SENT_MESSAGES_CACHE = 1000;
const RECONNECT_COOLDOWN_MS = 30000; // Min 30s between reconnections
const EDGE_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes between edge function notifications
const lastSuccessfulConnect = new Map(); // agentId -> timestamp

// Auth sessions directory
const AUTH_DIR = path.join(__dirname, 'auth_sessions');

// Ensure auth directory exists
if (!fsSync.existsSync(AUTH_DIR)) {
  fsSync.mkdirSync(AUTH_DIR, { recursive: true });
}

// Clear QR timeout for an agent
function clearQrTimeout(agentId) {
  const timeout = qrTimeouts.get(agentId);
  if (timeout) {
    clearTimeout(timeout);
    qrTimeouts.delete(agentId);
    console.log(`⏰ QR timeout cleared for ${agentId}`);
  }
}

// Helper: extract phone number from Baileys JID
function jidToPhone(jid) {
  if (!jid) return '';
  return jid.split('@')[0].split(':')[0];
}

// Helper: get or create LID cache for an agent
function getLidCache(agentId) {
  let cache = lidToPhoneCache.get(agentId);
  if (!cache) {
    cache = new Map();
    lidToPhoneCache.set(agentId, cache);
  }
  return cache;
}

// ─── PERSISTENCE OF LID↔PN MAPPINGS TO DISK ───
// Debounced (10s) to avoid I/O storm. Survives container restarts on Railway.
const persistLidMappingsTimers = new Map(); // agentId -> timeout
const PERSIST_LID_DEBOUNCE_MS = 10000;

async function persistLidMappingsNow(agentId) {
  try {
    const cache = lidToPhoneCache.get(agentId);
    if (!cache || cache.size === 0) return;
    const dir = path.join(AUTH_DIR, agentId);
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
    const obj = {};
    for (const [lid, pn] of cache.entries()) {
      if (lid && pn && !pn.includes('@lid')) obj[lid] = pn;
    }
    const filePath = path.join(dir, 'lid-mapping-runtime.json');
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(obj), 'utf8');
    await fs.rename(tmpPath, filePath);
    console.log(`💾 Persisted ${Object.keys(obj).length} LID mappings to disk for ${agentId}`);
  } catch (e) {
    console.warn(`⚠️ persistLidMappingsNow error for ${agentId}:`, e.message);
  }
}

function schedulePersistLidMappings(agentId) {
  if (!agentId) return;
  const existing = persistLidMappingsTimers.get(agentId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    persistLidMappingsTimers.delete(agentId);
    persistLidMappingsNow(agentId).catch(() => {});
  }, PERSIST_LID_DEBOUNCE_MS);
  persistLidMappingsTimers.set(agentId, t);
}

// Helper: load persisted lid-mapping-*.json files into in-memory cache
function loadLidMappingsFromDisk(agentId) {
  try {
    const dir = path.join(AUTH_DIR, agentId);
    if (!fsSync.existsSync(dir)) return 0;
    const files = fsSync.readdirSync(dir).filter(f => f.startsWith('lid-mapping-') && f.endsWith('.json'));
    const cache = getLidCache(agentId);
    let loaded = 0;
    for (const f of files) {
      try {
        const raw = fsSync.readFileSync(path.join(dir, f), 'utf8');
        const data = JSON.parse(raw);
        // Files are typically { "lidUser": "phoneUser" } or wrapped
        const entries = data && typeof data === 'object' ? Object.entries(data) : [];
        for (const [k, v] of entries) {
          if (typeof k === 'string' && typeof v === 'string') {
            const lidJid = k.includes('@') ? k : `${k}@lid`;
            const phoneJid = v.includes('@') ? v : `${v}@s.whatsapp.net`;
            cache.set(lidJid, phoneJid);
            loaded++;
          }
        }
      } catch (e) { /* ignore individual file parse errors */ }
    }
    if (loaded > 0) console.log(`📂 Loaded ${loaded} LID mappings from disk for ${agentId}`);
    return loaded;
  } catch (e) {
    console.warn(`⚠️ loadLidMappingsFromDisk error for ${agentId}:`, e.message);
    return 0;
  }
}

// Helper: resolve LID to real phone number — 4-layer strategy
// Returns the resolved JID (phone JID if found, original LID if not).
async function resolveContactId(jid, pushName, store, sock, agentId) {
  if (!jid) return jid;
  // Layer 1: already a phone JID
  if (!jid.includes('@lid')) return jid;

  // Layer 2: Baileys official LID mapping store (signal repository)
  try {
    const lidMapping = sock?.signalRepository?.lidMapping;
    if (lidMapping && typeof lidMapping.getPNForLID === 'function') {
      const pn = await lidMapping.getPNForLID(jid);
      if (pn && typeof pn === 'string' && !pn.includes('@lid')) {
        // cache for future
        if (agentId) getLidCache(agentId).set(jid, pn);
        return pn;
      }
    }
  } catch (e) {
    // silent — fall through to next layer
  }

  // Layer 3: store.contacts (legacy)
  if (store && store.contacts) {
    const contact = store.contacts[jid];
    if (contact && contact.id && !contact.id.includes('@lid')) {
      if (agentId) getLidCache(agentId).set(jid, contact.id);
      return contact.id;
    }
    for (const [contactJid, contactData] of Object.entries(store.contacts)) {
      if (contactData.lid === jid && !contactJid.includes('@lid')) {
        console.log(`✅ LID resolved via store.contacts.lid field: ${jid} -> ${contactJid}`);
        if (agentId) getLidCache(agentId).set(jid, contactJid);
        return contactJid;
      }
    }
  }

  // Layer 4: in-memory cache (populated by messaging-history.set + disk)
  if (agentId) {
    const cached = getLidCache(agentId).get(jid);
    if (cached && !cached.includes('@lid')) {
      return cached;
    }
  }

  console.log(`⚠️ LID unresolved after 4 layers: ${jid}, pushName: ${pushName}`);
  return jid;
}

// Helper: get contact name from store or message
function getContactName(jid, store, pushName) {
  if (store && store.contacts) {
    const contact = store.contacts[jid];
    if (contact) {
      return contact.name || contact.notify || contact.verifiedName || pushName || jidToPhone(jid);
    }
  }
  return pushName || jidToPhone(jid);
}

// Helper: extract message text from Baileys message object
function extractMessageText(message) {
  if (!message) return '';
  return message.conversation
    || message.extendedTextMessage?.text
    || message.imageMessage?.caption
    || message.videoMessage?.caption
    || message.documentMessage?.caption
    || '';
}

// Helper: unwrap nested Baileys message containers
function unwrapMessage(message) {
  if (!message) return message;
  if (message.ephemeralMessage) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension) return unwrapMessage(message.viewOnceMessageV2Extension.message);
  if (message.documentWithCaptionMessage) return unwrapMessage(message.documentWithCaptionMessage.message);
  if (message.editedMessage) return unwrapMessage(message.editedMessage.message);
  return message;
}

// Helper: detect message type from Baileys message (uses unwrapped content)
function detectMessageType(message) {
  if (!message) return { type: 'text', baileysType: null };
  
  // Unwrap nested containers first
  const unwrapped = unwrapMessage(message);
  
  if (unwrapped.imageMessage) return { type: 'media', baileysType: 'image' };
  if (unwrapped.videoMessage) return { type: 'media', baileysType: 'video' };
  if (unwrapped.audioMessage) {
    return unwrapped.audioMessage.ptt 
      ? { type: 'voice', baileysType: 'ptt' }
      : { type: 'media', baileysType: 'audio' };
  }
  if (unwrapped.documentMessage) return { type: 'media', baileysType: 'document' };
  if (unwrapped.stickerMessage) return { type: 'sticker', baileysType: 'sticker' };
  if (unwrapped.extendedTextMessage?.contextInfo?.quotedMessage) return { type: 'reply', baileysType: 'text' };
  
  return { type: 'text', baileysType: 'text' };
}

// Destroy client and clean up
async function destroyClient(agentId, deleteAuthData = true) {
  console.log(`🗑️ Destroying client for ${agentId} (deleteAuthData: ${deleteAuthData})`);
  
  clearQrTimeout(agentId);
  
  const clientData = clients.get(agentId);
  
  if (clientData && clientData.sock) {
    try {
      if (deleteAuthData) {
        await clientData.sock.logout();
        console.log(`✅ Client logged out`);
      } else {
        clientData.sock.end();
        console.log(`✅ Client socket closed (soft cleanup)`);
      }
    } catch (error) {
      console.error(`⚠️ Error closing client for ${agentId}:`, error.message);
      try {
        clientData.sock.end();
      } catch (e) {
        // ignore
      }
    }
  }
  
  // Only delete auth session data from disk if explicitly requested
  if (deleteAuthData) {
    const authPath = path.join(AUTH_DIR, agentId);
    try {
      if (fsSync.existsSync(authPath)) {
        console.log(`🗑️ Deleting auth session data at: ${authPath}`);
        fsSync.rmSync(authPath, { recursive: true, force: true });
        console.log(`✅ Auth session data deleted`);
      }
    } catch (error) {
      console.error(`⚠️ Error deleting auth session:`, error.message);
    }
  }
  
  clients.delete(agentId);
  qrCodes.delete(agentId);
  clientStates.delete(agentId);
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log(`⏱️ Cleanup complete for ${agentId}`);
}

// Auth middleware (identical to original)
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${MICROSERVICE_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Initialize WhatsApp client with Baileys
async function initializeClient(agentId, isReconnect = false) {
  console.log(`📱 Initializing Baileys client for agent: ${agentId} (isReconnect: ${isReconnect})`);
  
  const authPath = path.join(AUTH_DIR, agentId);
  
  // Only clean auth on fresh /init requests, NOT during automatic reconnections
  // During reconnections (e.g. after 515 error), partial pairing creds must be preserved
  if (!isReconnect && !clients.has(agentId)) {
    if (fsSync.existsSync(authPath)) {
      console.log(`🧹 Cleaning auth for fresh init: ${agentId}`);
      fsSync.rmSync(authPath, { recursive: true, force: true });
    }
  }
  
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  
  // Simple in-memory contacts store (makeInMemoryStore removed in newer Baileys)
  const store = { contacts: {} };
  
  // Pre-load any persisted LID mappings from previous sessions into in-memory cache
  loadLidMappingsFromDisk(agentId);
  
  // Fetch latest WA version for protocol compatibility
  let version;
  try {
    const versionInfo = await fetchLatestBaileysVersion();
    version = versionInfo.version;
    console.log(`📦 Using WA version: ${version.join('.')}`);
  } catch (e) {
    version = [2, 3000, 1027934701];
    console.log(`📦 Could not fetch latest version, using fallback: ${version.join('.')}`);
  }
  
  return new Promise((resolve, reject) => {
    const sock = makeWASocket({
      auth: state,
      logger,
      version,
      browser: ['insuranai', 'Desktop', '1.0.0'],
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 500,
      getMessage: async (key) => {
        const msg = sentMessages.get(key.id);
        if (msg) {
          console.log(`🔄 getMessage retry for ${key.id} — returning cached content`);
        }
        return msg || undefined;
      },
    });
    
    // Populate contacts store from socket events
    sock.ev.on('contacts.upsert', (contacts) => {
      let added = 0;
      for (const c of contacts) {
        store.contacts[c.id] = c;
        // Capture LID↔phone mappings exposed at upsert time (same as contacts.update)
        if (c?.id && c?.lid && c.id.includes('@s.whatsapp.net') && c.lid.includes('@lid')) {
          const cache = getLidCache(agentId);
          if (!cache.has(c.lid)) added++;
          cache.set(c.lid, c.id);
        }
      }
      if (added > 0) {
        console.log(`📚 Captured ${added} LID↔phone mappings from contacts.upsert for ${agentId}`);
        schedulePersistLidMappings(agentId);
      }
    });
    sock.ev.on('contacts.update', (updates) => {
      let added = 0;
      for (const u of updates) {
        if (store.contacts[u.id]) {
          Object.assign(store.contacts[u.id], u);
        }
        // Capture LID↔phone mappings exposed via contact updates
        if (u.id && u.lid && u.id.includes('@s.whatsapp.net') && u.lid.includes('@lid')) {
          const cache = getLidCache(agentId);
          if (!cache.has(u.lid)) added++;
          cache.set(u.lid, u.id);
        }
      }
      if (added > 0) schedulePersistLidMappings(agentId);
    });

    // Pre-populate store.contacts from chats.upsert (canonical chat ids — usually PNs, not LIDs)
    sock.ev.on('chats.upsert', (chats) => {
      try {
        if (!Array.isArray(chats)) return;
        for (const chat of chats) {
          if (!chat?.id) continue;
          if (chat.id.includes('@lid') || chat.id.endsWith('@g.us')) continue;
          if (!store.contacts[chat.id]) {
            store.contacts[chat.id] = { id: chat.id, name: chat.name || undefined };
          }
        }
      } catch (e) {
        console.warn('⚠️ chats.upsert handler error:', e.message);
      }
    });

    // Capture LID mappings from history sync (initial connection + ongoing)
    sock.ev.on('messaging-history.set', ({ contacts: histContacts }) => {
      try {
        if (!Array.isArray(histContacts)) return;
        const cache = getLidCache(agentId);
        let added = 0;
        for (const c of histContacts) {
          if (c?.id && c?.lid && c.id.includes('@s.whatsapp.net') && c.lid.includes('@lid')) {
            if (!cache.has(c.lid)) added++;
            cache.set(c.lid, c.id);
          }
          if (c?.id) store.contacts[c.id] = c;
        }
        if (added > 0) {
          console.log(`📚 Captured ${added} LID↔phone mappings from history for ${agentId}`);
          schedulePersistLidMappings(agentId);
        }
      } catch (e) {
        console.warn('⚠️ messaging-history.set handler error:', e.message);
      }
    });
    
    let qrResolved = false;
    
    // Connection update handler (QR, connection state)
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // QR Code generated
      if (qr) {
        console.log(`📲 QR Code generated for ${agentId}`);
        isFirstConnection.set(agentId, true); // Mark as new QR connection
        try {
          const qrImage = await QRCode.toDataURL(qr);
          qrCodes.set(agentId, qrImage);
          
          // Set QR timeout
          clearQrTimeout(agentId);
          const timeout = setTimeout(async () => {
            console.log(`⏰ QR timeout expired for ${agentId} - soft cleanup (preserving auth)`);
            await destroyClient(agentId, false);
          }, QR_TIMEOUT_MS);
          qrTimeouts.set(agentId, timeout);
          console.log(`⏰ QR timeout set for ${agentId} (${QR_TIMEOUT_MS / 1000}s)`);
          
          // Resolve promise on first QR
          if (!qrResolved) {
            qrResolved = true;
            resolve({ sock, store, saveCreds });
          }
        } catch (error) {
          console.error('Error generating QR:', error);
          if (!qrResolved) {
            qrResolved = true;
            reject(error);
          }
        }
      }
      
      // Connection opened
      if (connection === 'open') {
        console.log(`✅ WhatsApp client ready for ${agentId}`);
        clearQrTimeout(agentId);
        clientStates.set(agentId, 'open');
        reconnectAttempts.delete(agentId); // Reset reconnect counter on success
        lastSuccessfulConnect.set(agentId, Date.now());
        
        const phoneNumber = jidToPhone(sock.user?.id || '');
        
        // Determine if we should notify edge function
        const isNewConnection = isFirstConnection.get(agentId) === true;
        const lastNotify = lastEdgeFunctionNotify.get(agentId) || 0;
        const timeSinceLastNotify = Date.now() - lastNotify;
        const shouldNotify = isNewConnection || timeSinceLastNotify > EDGE_NOTIFY_COOLDOWN_MS;
        
        if (shouldNotify) {
          console.log(`📞 Phone number: ${phoneNumber} (notifying edge function, reason: ${isNewConnection ? 'new QR connection' : 'cooldown expired'})`);
          try {
            const response = await fetch('https://wmzbqsegsyagcjgxefqs.supabase.co/functions/v1/whatsapp-personal-connect', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'connected',
                agent_id: agentId,
                phone_number: phoneNumber,
                session_id: agentId
              })
            });
            
            if (!response.ok) {
              console.error('Failed to notify edge function:', await response.text());
            } else {
              console.log('✅ Edge function notified of connection');
              lastEdgeFunctionNotify.set(agentId, Date.now());
            }
          } catch (error) {
            console.error('Error notifying edge function:', error);
          }
          isFirstConnection.delete(agentId);
        } else {
          console.log(`✅ Reconnected ${agentId} (skipping edge function notify, last was ${Math.round(timeSinceLastNotify / 1000)}s ago)`);
        }
        
        qrCodes.delete(agentId);
        
        // If the promise hasn't been resolved yet (reconnection from stored creds)
        if (!qrResolved) {
          qrResolved = true;
          resolve({ sock, store, saveCreds });
        }
      }
      
      // Connection closed
      if (connection === 'close') {
        const error = lastDisconnect?.error;
        const statusCode = error?.output?.statusCode || error?.statusCode;
        const errorMessage = error?.message || error?.output?.payload?.message || 'Unknown';
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`🔌 Connection closed for ${agentId}. Status: ${statusCode}. Error: ${errorMessage}. Reconnect: ${shouldReconnect}`);
        console.log(`🔍 Full error:`, JSON.stringify(error, null, 2));
        clientStates.set(agentId, 'close');
        
        if (shouldReconnect) {
          const attempts = (reconnectAttempts.get(agentId) || 0) + 1;
          reconnectAttempts.set(agentId, attempts);
          
          // Cooldown: if last successful connect was very recent, wait longer
          const lastConnect = lastSuccessfulConnect.get(agentId) || 0;
          const timeSinceLastConnect = Date.now() - lastConnect;
          const cooldownDelay = timeSinceLastConnect < RECONNECT_COOLDOWN_MS 
            ? RECONNECT_COOLDOWN_MS - timeSinceLastConnect 
            : 0;
          
          if (attempts <= MAX_RECONNECT_ATTEMPTS) {
            const baseDelay = Math.min(attempts * 3000, 15000);
            const delay = Math.max(baseDelay, cooldownDelay);
            console.log(`🔄 Reconnect attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS} for ${agentId} in ${delay/1000}s (cooldown: ${cooldownDelay/1000}s)...`);
            await new Promise(r => setTimeout(r, delay));
            try {
              const reconnected = await initializeClient(agentId, true);
              clients.set(agentId, reconnected);
            } catch (reconnectError) {
              console.error(`❌ Reconnect failed for ${agentId}:`, reconnectError.message);
              clients.delete(agentId);
              clientStates.delete(agentId);
            }
          } else {
            console.log(`🛑 Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached for ${agentId}. Stopping.`);
            reconnectAttempts.delete(agentId);
            clients.delete(agentId);
            qrCodes.delete(agentId);
            clientStates.delete(agentId);
            
            // Notify Supabase to mark session as inactive
            try {
              const connectUrl = WEBHOOK_URL.replace('webhook-whatsapp-personal', 'whatsapp-personal-connect');
              await fetch(connectUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${MICROSERVICE_SECRET}`
                },
                body: JSON.stringify({ action: 'disconnect', agent_id: agentId })
              });
              console.log(`✅ Supabase notified: session inactive for ${agentId}`);
            } catch (e) {
              console.error(`⚠️ Could not notify Supabase:`, e.message);
            }
          }
        } else {
          // Logged out by user - clean up
          console.log(`🚪 User logged out for ${agentId}, cleaning up`);
          clearQrTimeout(agentId);
          clients.delete(agentId);
          qrCodes.delete(agentId);
          clientStates.delete(agentId);
          reconnectAttempts.delete(agentId);
          
          // Delete auth data since user logged out
          const authDir = path.join(AUTH_DIR, agentId);
          try {
            if (fsSync.existsSync(authDir)) {
              fsSync.rmSync(authDir, { recursive: true, force: true });
            }
          } catch (e) {
            console.error(`⚠️ Error cleaning auth for ${agentId}:`, e.message);
          }
        }
        
        if (!qrResolved) {
          qrResolved = true;
          reject(new Error(`Connection closed: ${statusCode} - ${errorMessage}`));
        }
      }
    });
    
    // Save credentials on update
    sock.ev.on('creds.update', saveCreds);
    
    // Message handler (incoming and outgoing)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return; // Only process real-time messages
      
      for (const msg of messages) {
        try {
          const fromMe = msg.key.fromMe || false;
          const remoteJid = msg.key.remoteJid;
          
          if (!remoteJid) continue;
          
          // Skip status broadcasts
          if (remoteJid === 'status@broadcast') continue;
          
          const messageContent = msg.message;
          if (!messageContent) continue; // Protocol messages, skip
          
          // Resolve conversation target (4-layer LID resolution, async)
          let conversationTarget = await resolveContactId(remoteJid, msg.pushName, store, sock, agentId);
          
          const isGroup = remoteJid.endsWith('@g.us');
          const participant = isGroup ? (msg.key.participant || null) : null;
          
          // Pre-resolve participant once (async) to avoid repeated calls
          const resolvedParticipant = participant
            ? await resolveContactId(participant, null, store, sock, agentId)
            : null;
          
          // Get contact/group name
          let contactName = 'Unknown';
          let senderName = null;
          
          if (isGroup) {
            contactName = getContactName(remoteJid, store, null) || 'Unknown Group';
            if (participant && !fromMe) {
              senderName = getContactName(participant, store, msg.pushName);
            }
          } else {
            contactName = getContactName(conversationTarget, store, msg.pushName);
          }

          // ─── ACTIVE FALLBACK: if remoteJid is LID and still unresolved, try one direct
          // call to the Baileys signal repository before sending to webhook. This catches
          // the race where contacts.upsert hasn't been processed yet on a client's first reply.
          if (!isGroup && remoteJid.includes('@lid') && conversationTarget === remoteJid) {
            try {
              const lidMapping = sock?.signalRepository?.lidMapping;
              if (lidMapping && typeof lidMapping.getPNForLID === 'function') {
                const pn = await lidMapping.getPNForLID(remoteJid);
                if (pn && typeof pn === 'string' && !pn.includes('@lid')) {
                  conversationTarget = pn;
                  contactName = getContactName(pn, store, msg.pushName);
                  getLidCache(agentId).set(remoteJid, pn);
                  schedulePersistLidMappings(agentId);
                  console.log(`✅ LID resolved via active signalRepository call: ${remoteJid} -> ${pn}`);
                }
              }
            } catch (_) { /* silent: keep original flow */ }
          }
          
          console.log(`📨 Message ${fromMe ? 'SENT' : 'RECEIVED'} ${fromMe ? 'to' : 'from'} ${contactName} (${jidToPhone(conversationTarget)})`);
          
          // Detect message type (using unwrapped content)
          const unwrappedContent = unwrapMessage(messageContent);
          const { type: messageType, baileysType } = detectMessageType(messageContent);
          
          // Always capture both original JID and resolved target
          const originalJid = remoteJid;
          const isLid = originalJid && originalJid.includes('@lid');
          const participantIsLid = participant && participant.includes('@lid');
          const participantResolvedDifferent = participantIsLid && resolvedParticipant && resolvedParticipant !== participant;
          
          // Build metadata - ALWAYS send both original_jid and phone info
          let messageMetadata = {
            timestamp: msg.messageTimestamp,
            from: conversationTarget,
            participant: participant,
            source: 'whatsapp_personal',
            from_me: fromMe,
            ...(senderName && { sender_name: senderName }),
            // Always send the original JID (could be phone@s.whatsapp.net or LID@lid)
            original_jid: originalJid,
            peer_jid: originalJid,
            // Always send the phone number (extracted from resolved target)
            // Only send phone_number if Baileys actually resolved the LID to a real phone
            phone_number: (isLid && conversationTarget === originalJid) ? null : jidToPhone(conversationTarget),
            // LID info (null if not a LID)
            lid: isLid ? jidToPhone(originalJid) : null,
            // If LID was resolved to a different JID, send the resolved phone
            resolved_from_lid: isLid && conversationTarget !== originalJid ? true : false,
            // Participant LID info for groups
            ...(participant && {
              participant_jid: participant,
              participant_phone: !participantIsLid
                ? jidToPhone(participant)
                : (participantResolvedDifferent ? jidToPhone(resolvedParticipant) : null),
              participant_lid: participantIsLid ? jidToPhone(participant) : null,
              participant_resolved_phone: participantIsLid && participantResolvedDifferent
                ? jidToPhone(resolvedParticipant)
                : null
            })
          };
          
          // Download multimedia (only for received messages)
          let mediaUrl = null;
          let mediaFileName = null;
          let mediaBuffer = null;
          
          if ((messageType === 'media' || messageType === 'voice' || messageType === 'sticker') && !fromMe) {
            let downloadStrategy = 'none';
            try {
              console.log(`📥 Downloading media (type: ${baileysType})...`);
              
              // Strategy 1: Standard downloadMediaMessage with buffer
              try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                  logger,
                  reuploadRequest: sock.updateMediaMessage
                });
                if (buffer && buffer.length > 0) {
                  mediaBuffer = buffer;
                  downloadStrategy = 'buffer';
                  console.log(`✅ Media downloaded via buffer strategy, size: ${buffer.length} bytes`);
                } else {
                  console.warn('⚠️ downloadMediaMessage returned empty buffer');
                }
              } catch (bufErr) {
                console.warn('⚠️ Buffer download failed:', bufErr.message);
              }

              // Strategy 2: Stream download (only for voice/audio if buffer failed)
              if (!mediaBuffer && (messageType === 'voice' || baileysType === 'audio')) {
                try {
                  console.log('🔄 Trying stream download strategy...');
                  const stream = await downloadMediaMessage(msg, 'stream', {}, {
                    logger,
                    reuploadRequest: sock.updateMediaMessage
                  });
                  if (stream) {
                    const chunks = [];
                    for await (const chunk of stream) {
                      chunks.push(chunk);
                    }
                    const combined = Buffer.concat(chunks);
                    if (combined.length > 0) {
                      mediaBuffer = combined;
                      downloadStrategy = 'stream';
                      console.log(`✅ Media downloaded via stream strategy, size: ${combined.length} bytes`);
                    }
                  }
                } catch (streamErr) {
                  console.warn('⚠️ Stream download failed:', streamErr.message);
                }
              }

              // Strategy 3: downloadContentFromMessage for voice/PTT
              if (!mediaBuffer && (messageType === 'voice' || baileysType === 'audio' || baileysType === 'ptt')) {
                try {
                  const audioMsg = unwrappedContent.audioMessage;
                  if (audioMsg) {
                    const mediaType = audioMsg.ptt ? 'ptt' : 'audio';
                    console.log(`🔄 Trying downloadContentFromMessage (${mediaType})...`);
                    const stream = await downloadContentFromMessage(audioMsg, mediaType);
                    const chunks = [];
                    for await (const chunk of stream) {
                      chunks.push(chunk);
                    }
                    const combined = Buffer.concat(chunks);
                    if (combined.length > 0) {
                      mediaBuffer = combined;
                      downloadStrategy = 'contentFromMessage';
                      console.log(`✅ Media downloaded via downloadContentFromMessage, size: ${combined.length} bytes`);
                    }
                  }
                } catch (contentErr) {
                  console.warn('⚠️ downloadContentFromMessage failed:', contentErr.message);
                }
              }

              // Upload to Storage if we got a buffer
              if (mediaBuffer) {
                const timestamp = Date.now();
                const mimeType = unwrappedContent.imageMessage?.mimetype
                  || unwrappedContent.videoMessage?.mimetype
                  || unwrappedContent.audioMessage?.mimetype
                  || unwrappedContent.documentMessage?.mimetype
                  || unwrappedContent.stickerMessage?.mimetype
                  || 'application/octet-stream';
                const extension = mimeType.split('/')[1]?.split(';')[0] || 'bin';
                mediaFileName = `whatsapp-${msg.key.id}-${timestamp}.${extension}`;
                
                // Upload to Supabase Storage
                const supabaseUrl = WEBHOOK_URL.replace('/functions/v1/webhook-whatsapp-personal', '');
                const storageUrl = `${supabaseUrl}/storage/v1/object/whatsapp-media/${mediaFileName}`;
                
                const storageResponse = await fetch(storageUrl, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY || WEBHOOK_SECRET}`,
                    'Content-Type': mimeType,
                  },
                  body: mediaBuffer
                });
                
                if (storageResponse.ok) {
                  mediaUrl = `${supabaseUrl}/storage/v1/object/public/whatsapp-media/${mediaFileName}`;
                  console.log(`✅ Media uploaded: ${mediaUrl}`);
                } else {
                  const errorText = await storageResponse.text();
                  console.error('❌ Failed to upload media:', errorText);
                }
              } else {
                console.error(`❌ All download strategies failed for ${messageType}/${baileysType}`);
              }
            } catch (error) {
              console.error('❌ Error downloading/uploading media:', error.message);
            }
          }
          
          // Add media metadata
          if (messageType === 'media' || messageType === 'voice' || messageType === 'sticker') {
            messageMetadata.media_type = baileysType;
            messageMetadata.media_mime_type = unwrappedContent.audioMessage?.mimetype
              || unwrappedContent.imageMessage?.mimetype
              || unwrappedContent.videoMessage?.mimetype
              || unwrappedContent.documentMessage?.mimetype
              || unwrappedContent.stickerMessage?.mimetype
              || null;
            // Include original filename for documents (PDFs etc.)
            if (baileysType === 'document') {
              messageMetadata.document_original_filename = unwrappedContent.documentMessage?.fileName || null;
            }
            // Always send filename + url for media
            if (mediaUrl) {
              messageMetadata.media_url = mediaUrl;
            }
            if (mediaFileName) {
              messageMetadata.media_filename = mediaFileName;
            }
            // Fallback: send base64 for voice notes when upload failed
            if (messageType === 'voice' && !mediaUrl && mediaBuffer) {
              try {
                const base64Audio = mediaBuffer.toString('base64');
                if (base64Audio.length < 5 * 1024 * 1024) { // Only if < 5MB base64
                  messageMetadata.media_base64 = base64Audio;
                  messageMetadata.media_size = mediaBuffer.length;
                  console.log(`📦 Voice base64 fallback attached, size: ${mediaBuffer.length} bytes`);
                } else {
                  console.warn('⚠️ Voice too large for base64 fallback:', mediaBuffer.length);
                }
              } catch (b64err) {
                console.error('❌ Failed to encode voice base64:', b64err.message);
              }
            }
            // Fallback: send base64 for PDF documents when upload failed
            if (messageType === 'media' && baileysType === 'document' && !mediaUrl && mediaBuffer) {
              try {
                const base64Doc = mediaBuffer.toString('base64');
                if (base64Doc.length < 8 * 1024 * 1024) { // Only if < 8MB base64
                  messageMetadata.media_base64 = base64Doc;
                  messageMetadata.media_size = mediaBuffer.length;
                  console.log(`📦 Document base64 fallback attached, size: ${mediaBuffer.length} bytes`);
                } else {
                  console.warn('⚠️ Document too large for base64 fallback:', mediaBuffer.length);
                }
              } catch (b64err) {
                console.error('❌ Failed to encode document base64:', b64err.message);
              }
            }
            console.log(`📋 Voice metadata: downloadStrategy=${typeof downloadStrategy !== 'undefined' ? downloadStrategy : 'n/a'}, has_buffer=${!!mediaBuffer}, has_url=${!!mediaUrl}, has_filename=${!!mediaFileName}, has_base64=${!!messageMetadata.media_base64}`);
          }
          
          // Handle quoted/reply messages
          if (messageType === 'reply') {
            const contextInfo = messageContent.extendedTextMessage?.contextInfo;
            if (contextInfo?.quotedMessage) {
              messageMetadata.quoted_message = {
                id: contextInfo.stanzaId || null,
                body: extractMessageText(contextInfo.quotedMessage)?.substring(0, 100),
                from: contextInfo.participant || remoteJid
              };
            }
          }
          
          if (messageType === 'voice') {
            messageMetadata.voice_duration = unwrappedContent.audioMessage?.seconds || null;
          }
          
          // Build message body (same format as original)
          let messageBody = extractMessageText(messageContent);
          if (messageType === 'voice') {
            messageBody = '🎤 Nota de voz';
          } else if (messageType === 'sticker') {
            messageBody = '🎨 Sticker';
          } else if (messageType === 'media') {
            const mediaTypeLabel = {
              'image': '📷 Imagen',
              'video': '🎥 Video',
              'audio': '🎵 Audio',
              'document': '📄 Documento'
            };
            const caption = extractMessageText(messageContent);
            messageBody = mediaTypeLabel[baileysType] || '📎 Archivo multimedia';
            if (caption) messageBody += `: ${caption}`;
          }
          
          // Send webhook to Supabase (identical payload to original)
          const webhookResponse = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${WEBHOOK_SECRET}`
            },
            body: JSON.stringify({
              agent_id: agentId,
              from: conversationTarget,
              to: fromMe ? remoteJid : sock.user?.id,
              participant: participant,
              body: messageBody,
              timestamp: msg.messageTimestamp,
              has_media: messageType === 'media' || messageType === 'voice' || messageType === 'sticker',
              contact_name: contactName,
              is_group: isGroup,
              sender_name: senderName,
              from_me: fromMe,
              message_type: messageType,
              message_metadata: messageMetadata,
              // ✅ Top-level message_id (Baileys msg.key.id) — needed by webhook to locate
              // outbound messages by external_message_id and seed LID↔PN mapping on aia-echo.
              message_id: msg.key?.id || null,
              remote_jid: remoteJid,
              // recipient_lid: when sending to a phone JID, Baileys sometimes exposes the
              // recipient's LID in remoteJidAlt. Forward it so the webhook can seed the map.
              recipient_lid: msg.key?.remoteJidAlt && String(msg.key.remoteJidAlt).includes('@lid')
                ? String(msg.key.remoteJidAlt).split('@')[0]
                : null
            })
          });
          
          if (!webhookResponse.ok) {
            console.error('Webhook error:', await webhookResponse.text());
          } else {
            console.log(`✅ Webhook sent (${fromMe ? 'outgoing' : 'incoming'}, type: ${messageType})`);
          }
        } catch (error) {
          console.error('Error processing message:', error);
        }
      }
    });
  });
}

// ========== ROUTES (identical signatures to original) ==========

// Root endpoint for Railway health check
app.get('/', (req, res) => {
  res.json({
    status: 'WhatsApp Baileys service running',
    version: '2.0.0',
    engine: 'baileys',
    activeClients: clients.size,
    maxClients: MAX_CONCURRENT_SESSIONS,
    qrTimeoutSeconds: QR_TIMEOUT_MS / 1000
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'baileys',
    activeClients: clients.size,
    maxClients: MAX_CONCURRENT_SESSIONS,
    pendingQRs: qrCodes.size,
    timestamp: new Date().toISOString()
  });
});

// Initialize connection
app.post('/init', authMiddleware, async (req, res) => {
  try {
    const { agent_id } = req.body;
    
    if (!agent_id) {
      return res.status(400).json({ error: 'agent_id is required' });
    }
    
    console.log(`🔄 Init request for agent: ${agent_id}`);
    
    // Check if already connected
    const existingClient = clients.get(agent_id);
    if (existingClient && existingClient.sock) {
      const currentState = clientStates.get(agent_id);
      if (currentState === 'open') {
        const phoneNumber = jidToPhone(existingClient.sock.user?.id || '');
        console.log(`✅ Agent ${agent_id} already connected`);
        return res.json({
          success: true,
          already_connected: true,
          phone_number: phoneNumber,
          state: 'CONNECTED'
        });
      }
    }
    
    // Check session limit
    const activeCount = countConnectedClients();
    if (activeCount >= MAX_CONCURRENT_SESSIONS && !existingClient) {
      console.log(`🚫 Session limit reached (${activeCount}/${MAX_CONCURRENT_SESSIONS})`);
      return res.status(503).json({
        error: 'Límite de sesiones alcanzado',
        active_clients: activeCount,
        max_clients: MAX_CONCURRENT_SESSIONS,
        hint: 'Desconecta otra cuenta de WhatsApp primero'
      });
    }
    
    // Destroy existing non-connected client
    if (existingClient) {
      console.log(`🔄 Destroying existing non-connected client for ${agent_id}`);
      await destroyClient(agent_id);
    }
    
    // Create fresh client
    console.log(`📱 Creating fresh Baileys client for ${agent_id}`);
    
    try {
      const clientData = await initializeClient(agent_id);
      clients.set(agent_id, clientData);
      clientStates.set(agent_id, 'connecting');
      
      const qrCode = qrCodes.get(agent_id);
      
      // If no QR but client is connected (restored from saved creds)
      if (!qrCode && clientStates.get(agent_id) === 'open') {
        const phoneNumber = jidToPhone(clientData.sock.user?.id || '');
        return res.json({
          success: true,
          already_connected: true,
          phone_number: phoneNumber,
          state: 'CONNECTED'
        });
      }
      
      if (!qrCode) {
        throw new Error('QR code not generated after initialization');
      }
      
      return res.json({
        success: true,
        qr_code: qrCode,
        session_id: agent_id,
        timeout_seconds: QR_TIMEOUT_MS / 1000
      });
    } catch (initError) {
      console.error(`❌ Error during client initialization for ${agent_id}:`, initError);
      await destroyClient(agent_id);
      throw initError;
    }
  } catch (error) {
    console.error('❌ Error in /init endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper to count connected clients
function countConnectedClients() {
  let count = 0;
  for (const [agentId] of clients) {
    if (clientStates.get(agentId) === 'open') {
      count++;
    }
  }
  return count;
}

// Check status
app.get('/status/:agent_id', authMiddleware, async (req, res) => {
  try {
    const { agent_id } = req.params;
    const clientData = clients.get(agent_id);
    
    if (!clientData || !clientData.sock) {
      return res.json({ connected: false });
    }
    
    const currentState = clientStates.get(agent_id);
    
    if (currentState === 'open') {
      const phoneNumber = jidToPhone(clientData.sock.user?.id || '');
      res.json({
        connected: true,
        phone_number: phoneNumber,
        state: 'CONNECTED'
      });
    } else {
      // Include latest QR code if available (for reconnection scenarios)
      const latestQr = qrCodes.get(agent_id);
      res.json({ connected: false, state: currentState || 'unknown', qr_code: latestQr || null });
    }
  } catch (error) {
    console.error('Error checking status:', error);
    res.json({ connected: false, error: error.message });
  }
});

// Send message
app.post('/send', authMiddleware, async (req, res) => {
  try {
    const { agent_id, to, content } = req.body;
    
    if (!agent_id || !to || !content) {
      return res.status(400).json({ error: 'agent_id, to, and content are required' });
    }
    
    const clientData = clients.get(agent_id);
    
    if (!clientData || !clientData.sock) {
      return res.status(404).json({ error: 'Client not found or not connected' });
    }
    
    const currentState = clientStates.get(agent_id);
    if (currentState !== 'open') {
      return res.status(400).json({ error: 'Client not connected' });
    }
    
    console.log(`📤 Sending message to ${to}`);
    
    // Format phone number
    let formattedNumber = to;
    if (!to.includes('@g.us') && !to.includes('@c.us')) {
      formattedNumber = to.replace(/\D/g, '') + '@s.whatsapp.net';
    } else if (to.includes('@c.us')) {
      // Baileys uses @s.whatsapp.net for individual chats
      formattedNumber = to.replace('@c.us', '@s.whatsapp.net');
    }
    
    // Verify number exists on WhatsApp and get correct JID
    if (!to.includes('@g.us')) {
      const rawNumber = formattedNumber.replace('@s.whatsapp.net', '');
      try {
        const [result] = await clientData.sock.onWhatsApp(rawNumber);
        
        if (!result || !result.exists) {
          console.log(`❌ Number not on WhatsApp: ${rawNumber}`);
          return res.status(400).json({ 
            error: `El número ${rawNumber} no está registrado en WhatsApp` 
          });
        }
        
        // Use the JID that WhatsApp returns (correct format)
        formattedNumber = result.jid;
        console.log(`✅ Number verified: ${rawNumber} → ${formattedNumber}`);
      } catch (verifyError) {
        console.warn(`⚠️ Could not verify number ${rawNumber}, sending anyway:`, verifyError.message);
      }
    }
    
    const result = await clientData.sock.sendMessage(formattedNumber, { text: content });
    
    // Cache sent message for decryption retry (mobile "waiting for message" fix)
    if (result?.key?.id) {
      sentMessages.set(result.key.id, { conversation: content });
      // Evict oldest entries if cache exceeds limit
      if (sentMessages.size > MAX_SENT_MESSAGES_CACHE) {
        const firstKey = sentMessages.keys().next().value;
        sentMessages.delete(firstKey);
      }
    }
    
    console.log('✅ Message sent:', result.key.id);

    // Expose recipient LID (if Baileys returned one in remoteJidAlt) so the
    // edge function can seed whatsapp_contact_map immediately on first send.
    let recipientLid = null;
    try {
      if (result?.key?.remoteJidAlt && String(result.key.remoteJidAlt).includes('@lid')) {
        recipientLid = String(result.key.remoteJidAlt).split('@')[0];
      }
    } catch (_) { /* ignore */ }

    res.json({
      success: true,
      message_id: result.key.id,
      remote_jid: result.key?.remoteJid || formattedNumber,
      recipient_lid: recipientLid
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all chats for an agent
app.get('/chats/:agent_id', authMiddleware, async (req, res) => {
  try {
    const { agent_id } = req.params;
    const clientData = clients.get(agent_id);
    
    if (!clientData || clientStates.get(agent_id) !== 'open') {
      return res.status(404).json({ error: 'Client not connected' });
    }
    
    console.log(`📋 Fetching chats for agent: ${agent_id}`);
    
    const chats = clientData.store.chats.all();
    
    const chatList = chats.map(chat => ({
      id: chat.id,
      name: chat.name || chat.subject || jidToPhone(chat.id),
      isGroup: chat.id.endsWith('@g.us'),
      lastMessageTime: chat.conversationTimestamp,
      unreadCount: chat.unreadCount || 0
    }));
    
    res.json({ chats: chatList });
  } catch (error) {
    console.error('Error getting chats:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get messages for a specific chat
app.get('/messages/:agent_id/:chat_id', authMiddleware, async (req, res) => {
  try {
    const { agent_id, chat_id } = req.params;
    const { limit = 100 } = req.query;
    
    const clientData = clients.get(agent_id);
    
    if (!clientData || clientStates.get(agent_id) !== 'open') {
      return res.status(404).json({ error: 'Client not connected' });
    }
    
    console.log(`💬 Fetching messages for ${agent_id} / ${chat_id}`);
    
    // Use store to get cached messages
    const messages = clientData.store.messages[chat_id]?.array?.slice(-parseInt(limit)) || [];
    
    const messageList = messages.map(msg => ({
      id: msg.key.id,
      body: extractMessageText(msg.message),
      timestamp: msg.messageTimestamp,
      fromMe: msg.key.fromMe || false,
      hasMedia: !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.audioMessage || msg.message?.documentMessage),
      from: msg.key.remoteJid,
      to: msg.key.fromMe ? msg.key.remoteJid : null
    }));
    
    res.json({ messages: messageList });
  } catch (error) {
    console.error('Error getting messages:', error);
    res.status(500).json({ error: error.message });
  }
});

// Resolve a LID to its real phone number on demand
app.post('/resolve-lid', authMiddleware, async (req, res) => {
  try {
    const { agentId, lid } = req.body || {};
    if (!agentId || !lid) {
      return res.status(400).json({ error: 'agentId and lid are required' });
    }
    const clientData = clients.get(agentId);
    if (!clientData || clientStates.get(agentId) !== 'open') {
      return res.status(404).json({ error: 'Client not connected', resolved: false });
    }
    const lidJid = lid.includes('@') ? lid : `${lid}@lid`;
    const resolved = await resolveContactId(lidJid, null, clientData.store, clientData.sock, agentId);
    if (resolved && !resolved.includes('@lid')) {
      const phone = jidToPhone(resolved);
      console.log(`🔎 /resolve-lid ${agentId} ${lidJid} -> ${phone}`);
      return res.json({ resolved: true, lid: lidJid, phone_number: phone, jid: resolved });
    }
    return res.json({ resolved: false, lid: lidJid });
  } catch (error) {
    console.error('Error in /resolve-lid:', error);
    res.status(500).json({ error: error.message, resolved: false });
  }
});

// Active lookup of a JID/LID via onWhatsApp (queries WhatsApp servers directly)
app.post('/lookup-jid', authMiddleware, async (req, res) => {
  try {
    const { agentId, lid } = req.body || {};
    if (!agentId || !lid) {
      return res.status(400).json({ error: 'agentId and lid are required', resolved: false });
    }

    const clientData = clients.get(agentId);
    if (!clientData || clientStates.get(agentId) !== 'open') {
      return res.status(404).json({ error: 'Client not connected', resolved: false });
    }

    const lidPure = String(lid).replace('@lid', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
    if (!lidPure) {
      return res.status(400).json({ error: 'invalid lid', resolved: false });
    }

    const lidJid = `${lidPure}@lid`;
    const resolvePhoneFromJid = (jid) => {
      if (!jid || typeof jid !== 'string' || jid.includes('@lid') || jid.endsWith('@g.us')) return null;
      const phone = jidToPhone(jid).replace(/\D/g, '');
      return phone.length >= 8 && phone.length <= 15 ? phone : null;
    };

    // 1) Fast in-memory cache populated from history/contact updates
    try {
      const cachedJid = getLidCache(agentId).get(lidJid);
      const phone = resolvePhoneFromJid(cachedJid);
      if (phone) {
        console.log(`🔎 /lookup-jid ${agentId} ${lidJid} -> ${phone} (memory_cache)`);
        return res.json({ resolved: true, phone_number: phone, source: 'memory_cache', jid: cachedJid });
      }
    } catch (_) {
      // ignore cache errors and continue
    }

    // 2) Baileys official LID mapping store (IMPORTANT: await getPNForLID)
    try {
      const pn = await clientData.sock?.signalRepository?.lidMapping?.getPNForLID?.(lidJid);
      const phone = resolvePhoneFromJid(pn);
      if (phone) {
        getLidCache(agentId).set(lidJid, pn);
        console.log(`🔎 /lookup-jid ${agentId} ${lidJid} -> ${phone} (signal_repository)`);
        return res.json({ resolved: true, phone_number: phone, source: 'signal_repository', jid: pn });
      }
    } catch (_) {
      // ignore mapping errors and fall through
    }

    // 3) Contacts store fallback
    try {
      const directContact = clientData.store?.contacts?.[lidJid];
      const directPhone = resolvePhoneFromJid(directContact?.id);
      if (directPhone) {
        getLidCache(agentId).set(lidJid, directContact.id);
        console.log(`🔎 /lookup-jid ${agentId} ${lidJid} -> ${directPhone} (store_direct)`);
        return res.json({ resolved: true, phone_number: directPhone, source: 'store_direct', jid: directContact.id });
      }

      for (const [contactJid, contactData] of Object.entries(clientData.store?.contacts || {})) {
        if (contactData?.lid === lidJid) {
          const mappedPhone = resolvePhoneFromJid(contactJid);
          if (mappedPhone) {
            getLidCache(agentId).set(lidJid, contactJid);
            console.log(`🔎 /lookup-jid ${agentId} ${lidJid} -> ${mappedPhone} (store_contacts)`);
            return res.json({ resolved: true, phone_number: mappedPhone, source: 'store_contacts', jid: contactJid });
          }
        }
      }
    } catch (_) {
      // ignore store errors and continue
    }

    // 4) Active query to WhatsApp servers
    for (const candidate of [lidJid, lidPure]) {
      try {
        const results = await clientData.sock.onWhatsApp(candidate);
        const hit = Array.isArray(results) ? results.find(r => r?.exists) || results[0] : null;
        const jid = hit?.jid || hit?.lid || null;
        const phone = resolvePhoneFromJid(jid);

        if (phone) {
          getLidCache(agentId).set(lidJid, jid);
          console.log(`🔎 /lookup-jid ${agentId} ${candidate} -> ${phone} (on_whatsapp)`);
          return res.json({ resolved: true, phone_number: phone, source: 'on_whatsapp', jid });
        }
      } catch (err) {
        console.warn(`⚠️ /lookup-jid onWhatsApp failed for ${candidate}: ${err.message}`);
      }
    }

    return res.json({ resolved: false, lid: lidJid });
  } catch (error) {
    console.error('Error in /lookup-jid:', error);
    res.status(500).json({ error: error.message, resolved: false });
  }
});

// Disconnect
app.post('/disconnect/:agent_id', authMiddleware, async (req, res) => {
  try {
    const { agent_id } = req.params;
    console.log(`🔌 Disconnect request for agent: ${agent_id}`);
    
    await destroyClient(agent_id);
    
    res.json({ success: true, message: 'Client disconnected and cleaned up' });
  } catch (error) {
    console.error(`❌ Error disconnecting client for ${agent_id}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// 🧹 Automatic cleanup of inactive/disconnected clients every 5 minutes
setInterval(async () => {
  console.log(`🧹 Running automatic cleanup check... (${clients.size} clients, ${qrCodes.size} pending QRs)`);
  
  let cleanedUp = 0;
  
  for (const [agentId] of clients) {
    const state = clientStates.get(agentId);
    
    if (state !== 'open' && state !== 'connecting' && !reconnectAttempts.has(agentId)) {
      console.log(`🗑️ Cleaning up disconnected client: ${agentId} (state: ${state || 'unknown'})`);
      await destroyClient(agentId, false); // Soft cleanup: preserve auth on disk
      cleanedUp++;
    }
  }
  
  if (cleanedUp > 0) {
    console.log(`✅ Cleaned up ${cleanedUp} inactive clients. Remaining: ${clients.size}`);
  } else {
    console.log(`✅ No inactive clients to clean up`);
  }
}, CLEANUP_INTERVAL_MS);

// Auto-restore saved sessions on boot
async function restoreSessions() {
  try {
    if (!fsSync.existsSync(AUTH_DIR)) return;
    
    const dirs = fsSync.readdirSync(AUTH_DIR).filter(d => {
      const fullPath = path.join(AUTH_DIR, d);
      return fsSync.statSync(fullPath).isDirectory()
        && fsSync.existsSync(path.join(fullPath, 'creds.json'));
    });

    if (dirs.length === 0) {
      console.log('📂 No saved sessions found to restore');
      return;
    }

    console.log(`🔄 Found ${dirs.length} saved session(s) to restore...`);

    for (const agentId of dirs) {
      if (clients.has(agentId)) {
        console.log(`⏭️ Session ${agentId} already active, skipping`);
        continue;
      }
      try {
        console.log(`🔄 Restoring session: ${agentId}`);
        const clientData = await initializeClient(agentId, true);
        clients.set(agentId, clientData);
        console.log(`✅ Session restored: ${agentId}`);
      } catch (err) {
        console.error(`❌ Failed to restore session ${agentId}:`, err.message);
      }
    }

    console.log(`🔄 Session restoration complete. Active sessions: ${clients.size}`);
  } catch (err) {
    console.error('❌ Error during session restoration:', err.message);
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Baileys Microservice running on port ${PORT}`);
  console.log(`📦 Engine: Baileys (WebSocket, no Chromium)`);
  console.log(`📍 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`🔐 Auth configured: ${MICROSERVICE_SECRET !== 'your-secret-key-here'}`);
  console.log(`⚙️ Max concurrent sessions: ${MAX_CONCURRENT_SESSIONS}`);
  console.log(`⏰ QR timeout: ${QR_TIMEOUT_MS / 1000} seconds`);
  console.log(`🧹 Cleanup interval: ${CLEANUP_INTERVAL_MS / 1000} seconds`);
  console.log(`💾 Auth sessions dir: ${AUTH_DIR}`);

  // Restore sessions after server is listening
  restoreSessions();
});

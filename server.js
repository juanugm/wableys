// Polyfill crypto for Baileys compatibility (Node 18 fallback)
if (!globalThis.crypto) {
  const { webcrypto } = require('crypto');
  globalThis.crypto = webcrypto;
}

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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

// ⚙️ OPTIMIZATION SETTINGS (same as before)
const MAX_CONCURRENT_SESSIONS = 5;
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

const MAX_RECONNECT_ATTEMPTS = 5;

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

// Helper: resolve LID to real phone number
function resolveContactId(jid, pushName, store) {
  // If it's a LID (@lid), try to get real number from store
  if (jid && jid.includes('@lid')) {
    // Try store contacts first
    if (store && store.contacts) {
      const contact = store.contacts[jid];
      if (contact && contact.id && !contact.id.includes('@lid')) {
        return contact.id;
      }
    }
    // Fallback: use pushName as identifier if available
    console.log(`⚠️ LID detected: ${jid}, pushName: ${pushName}`);
  }
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

// Helper: detect message type from Baileys message
function detectMessageType(message) {
  if (!message) return { type: 'text', baileysType: null };
  
  if (message.imageMessage) return { type: 'media', baileysType: 'image' };
  if (message.videoMessage) return { type: 'media', baileysType: 'video' };
  if (message.audioMessage) {
    return message.audioMessage.ptt 
      ? { type: 'voice', baileysType: 'ptt' }
      : { type: 'media', baileysType: 'audio' };
  }
  if (message.documentMessage) return { type: 'media', baileysType: 'document' };
  if (message.stickerMessage) return { type: 'sticker', baileysType: 'sticker' };
  if (message.extendedTextMessage?.contextInfo?.quotedMessage) return { type: 'reply', baileysType: 'text' };
  
  return { type: 'text', baileysType: 'text' };
}

// Destroy client and clean up
async function destroyClient(agentId) {
  console.log(`🗑️ Destroying client for ${agentId}`);
  
  clearQrTimeout(agentId);
  
  const clientData = clients.get(agentId);
  
  if (clientData && clientData.sock) {
    try {
      await clientData.sock.logout();
      console.log(`✅ Client logged out`);
    } catch (error) {
      console.error(`⚠️ Error logging out client for ${agentId}:`, error.message);
      // Try to close the socket even if logout fails
      try {
        clientData.sock.end();
      } catch (e) {
        // ignore
      }
    }
  }
  
  // Delete auth session data from disk
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
      browser: ['Baileys', 'Chrome', '4.0.0'],
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    
    // Populate contacts store from socket events
    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        store.contacts[c.id] = c;
      }
    });
    sock.ev.on('contacts.update', (updates) => {
      for (const u of updates) {
        if (store.contacts[u.id]) {
          Object.assign(store.contacts[u.id], u);
        }
      }
    });
    
    let qrResolved = false;
    
    // Connection update handler (QR, connection state)
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // QR Code generated
      if (qr) {
        console.log(`📲 QR Code generated for ${agentId}`);
        try {
          const qrImage = await QRCode.toDataURL(qr);
          qrCodes.set(agentId, qrImage);
          
          // Set QR timeout
          clearQrTimeout(agentId);
          const timeout = setTimeout(async () => {
            console.log(`⏰ QR timeout expired for ${agentId} - destroying client`);
            await destroyClient(agentId);
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
        
        const phoneNumber = jidToPhone(sock.user?.id || '');
        console.log(`📞 Phone number: ${phoneNumber}`);
        
        // Notify edge function about successful connection
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
          }
        } catch (error) {
          console.error('Error notifying edge function:', error);
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
          
          if (attempts <= MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(attempts * 2000, 10000);
            console.log(`🔄 Reconnect attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS} for ${agentId} in ${delay/1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            try {
              const reconnected = await initializeClient(agentId, true); // true = reconnect, preserve auth
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
          
          // Resolve conversation target (same logic as original)
          const conversationTarget = resolveContactId(remoteJid, msg.pushName, store);
          
          const isGroup = remoteJid.endsWith('@g.us');
          const participant = isGroup ? (msg.key.participant || null) : null;
          
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
          
          console.log(`📨 Message ${fromMe ? 'SENT' : 'RECEIVED'} ${fromMe ? 'to' : 'from'} ${contactName} (${jidToPhone(conversationTarget)})`);
          
          // Detect message type
          const { type: messageType, baileysType } = detectMessageType(messageContent);
          
          // Build metadata (same structure as original webhook)
          let messageMetadata = {
            timestamp: msg.messageTimestamp,
            from: conversationTarget,
            participant: participant,
            source: 'whatsapp_personal',
            from_me: fromMe,
            ...(senderName && { sender_name: senderName })
          };
          
          // Download multimedia (only for received messages)
          let mediaUrl = null;
          let mediaFileName = null;
          
          if ((messageType === 'media' || messageType === 'voice' || messageType === 'sticker') && !fromMe) {
            try {
              console.log(`📥 Downloading media (type: ${baileysType})...`);
              const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                logger,
                reuploadRequest: sock.updateMediaMessage
              });
              
              if (buffer) {
                const timestamp = Date.now();
                const mimeType = messageContent.imageMessage?.mimetype
                  || messageContent.videoMessage?.mimetype
                  || messageContent.audioMessage?.mimetype
                  || messageContent.documentMessage?.mimetype
                  || messageContent.stickerMessage?.mimetype
                  || 'application/octet-stream';
                const extension = mimeType.split('/')[1]?.split(';')[0] || 'bin';
                mediaFileName = `whatsapp-${msg.key.id}-${timestamp}.${extension}`;
                
                // Upload to Supabase Storage
                const supabaseUrl = WEBHOOK_URL.replace('/functions/v1/webhook-whatsapp-personal', '');
                const storageUrl = `${supabaseUrl}/storage/v1/object/whatsapp-media/${mediaFileName}`;
                
                const storageResponse = await fetch(storageUrl, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${WEBHOOK_SECRET}`,
                    'Content-Type': mimeType,
                  },
                  body: buffer
                });
                
                if (storageResponse.ok) {
                  mediaUrl = `${supabaseUrl}/storage/v1/object/public/whatsapp-media/${mediaFileName}`;
                  console.log(`✅ Media uploaded: ${mediaUrl}`);
                } else {
                  const errorText = await storageResponse.text();
                  console.error('❌ Failed to upload media:', errorText);
                }
              }
            } catch (error) {
              console.error('❌ Error downloading/uploading media:', error.message);
            }
          }
          
          // Add media metadata
          if (messageType === 'media' || messageType === 'voice' || messageType === 'sticker') {
            messageMetadata.media_type = baileysType;
            if (mediaUrl) {
              messageMetadata.media_url = mediaUrl;
              messageMetadata.media_filename = mediaFileName;
            }
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
            messageMetadata.voice_duration = messageContent.audioMessage?.seconds || null;
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
              message_metadata: messageMetadata
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
    
    const result = await clientData.sock.sendMessage(formattedNumber, { text: content });
    
    console.log('✅ Message sent:', result.key.id);
    
    res.json({
      success: true,
      message_id: result.key.id
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
    
    if (state !== 'open' && state !== 'connecting') {
      console.log(`🗑️ Cleaning up disconnected client: ${agentId} (state: ${state || 'unknown'})`);
      await destroyClient(agentId);
      cleanedUp++;
    }
  }
  
  if (cleanedUp > 0) {
    console.log(`✅ Cleaned up ${cleanedUp} inactive clients. Remaining: ${clients.size}`);
  } else {
    console.log(`✅ No inactive clients to clean up`);
  }
}, CLEANUP_INTERVAL_MS);

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
});

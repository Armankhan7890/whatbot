require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ============================================================
// LOAD CLIENTS
// Secrets come from Render environment variables
// Only prompt + business name stored in GitHub JSON files
// ============================================================
function loadClients() {
  const clientsDir = path.join(__dirname, 'clients');
  const files = fs.readdirSync(clientsDir).filter(f => f.endsWith('.json'));
  const clients = {};

  files.forEach(file => {
    const config = JSON.parse(
      fs.readFileSync(path.join(clientsDir, file), 'utf8')
    );

    const prefix = config.envPrefix;

    const phoneNumberId = process.env[`${prefix}_PHONE_ID`];
    const wabaToken     = process.env[`${prefix}_TOKEN`];
    const ownerPhone    = process.env[`${prefix}_OWNER`];

    if (!phoneNumberId || !wabaToken || !ownerPhone) {
      console.log(`⚠️  Skipping ${config.businessName} — missing env vars for prefix: ${prefix}`);
      return;
    }

    clients[phoneNumberId] = {
      businessName: config.businessName,
      envPrefix:    prefix,
      systemPrompt: config.systemPrompt,
      phoneNumberId,
      wabaToken,
      ownerPhone,
    };

    console.log(`✅ Loaded client: ${config.businessName}`);
  });

  return clients;
}

let CLIENTS = loadClients();

// Reload clients without restarting
app.get('/reload-clients', (req, res) => {
  CLIENTS = loadClients();
  res.json({
    message: 'Clients reloaded',
    loaded: Object.values(CLIENTS).map(c => c.businessName),
  });
});

// ============================================================
// SESSION STORE
// ============================================================
const sessions = {};

function getSession(phoneNumberId, customerPhone) {
  if (!sessions[phoneNumberId]) sessions[phoneNumberId] = {};
  if (!sessions[phoneNumberId][customerPhone]) {
    sessions[phoneNumberId][customerPhone] = { messages: [] };
  }
  return sessions[phoneNumberId][customerPhone];
}

function resetSession(phoneNumberId, customerPhone) {
  if (sessions[phoneNumberId]) {
    sessions[phoneNumberId][customerPhone] = { messages: [] };
  }
}

// ============================================================
// SEND WHATSAPP MESSAGE
// ============================================================
async function sendMessage(phoneNumberId, wabaToken, to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${wabaToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error(`❌ Send error [${phoneNumberId}]:`, err.response?.data || err.message);
  }
}

// ============================================================
// NOTIFY OWNER — full conversation brief like old code
// ============================================================
async function notifyOwner(client, customerPhone, messages) {
  const recentChat = messages
    .slice(-12)
    .map(m => `${m.role === 'user' ? '👤 Customer' : '🤖 Bot'}: ${m.content}`)
    .join('\n');

  const msg =
    `🔔 *NEW LEAD — ${client.businessName}*\n\n` +
    `📱 Customer: +${customerPhone}\n` +
    `⏰ Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n` +
    `📋 *Full Conversation:*\n\n${recentChat}`;

  await sendMessage(client.phoneNumberId, client.wabaToken, client.ownerPhone, msg);
  console.log(`✅ Owner notified [${client.businessName}] — customer: +${customerPhone}`);
}

// ============================================================
// HANDLE MESSAGE
// Supports both [ORDER_COMPLETE] and [LEAD_CAPTURED] triggers
// ============================================================
async function handleMessage(client, customerPhone, userText) {
  const session = getSession(client.phoneNumberId, customerPhone);

  // Allow customer to restart conversation
  if (['restart', 'cancel', 'reset'].includes(userText.toLowerCase())) {
    resetSession(client.phoneNumberId, customerPhone);
    await sendMessage(client.phoneNumberId, client.wabaToken, customerPhone,
      'Conversation restarted. How can I help you? 😊');
    return;
  }

  session.messages.push({ role: 'user', content: userText });

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: client.systemPrompt },
        ...session.messages,
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const botReply = response.choices[0].message.content;
    session.messages.push({ role: 'assistant', content: botReply });

    // ✅ Supports BOTH trigger words — works for all business types
    const isComplete =
      botReply.includes('[ORDER_COMPLETE]') ||
      botReply.includes('[LEAD_CAPTURED]');

    const cleanReply = botReply
      .replace('[ORDER_COMPLETE]', '')
      .replace('[LEAD_CAPTURED]', '')
      .trim();

    await sendMessage(client.phoneNumberId, client.wabaToken, customerPhone, cleanReply);

    if (isComplete) {
      await notifyOwner(client, customerPhone, session.messages);
      resetSession(client.phoneNumberId, customerPhone);
    }

  } catch (err) {
    console.error(`❌ Groq error [${client.businessName}]:`, err.message);
    await sendMessage(client.phoneNumberId, client.wabaToken, customerPhone,
      '🙏 Sorry, technical issue. Please try again in a moment.');
  }
}

// ============================================================
// WEBHOOK VERIFICATION
// ============================================================
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ============================================================
// RECEIVE MESSAGES
// ============================================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (value?.statuses) return;

    const message = value?.messages?.[0];
    if (!message) return;

    const phoneNumberId = value?.metadata?.phone_number_id;
    const client = CLIENTS[phoneNumberId];

    if (!client) {
      console.log(`⚠️ No client found for phone number ID: ${phoneNumberId}`);
      return;
    }

    const from = message.from;
    let userText = '';

    if (message.type === 'text') {
      userText = message.text.body;
    } else if (message.type === 'image' || message.type === 'document') {
      userText = 'Customer sent an image or document.';
    } else {
      return;
    }

    console.log(`📩 [${client.businessName}] From +${from}: ${userText}`);
    await handleMessage(client, from, userText);

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  const list = Object.values(CLIENTS).map(c => c.businessName).join(', ') || 'No clients loaded';
  res.send(`✅ Whatbot Running!\nLoaded clients: ${list}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot running on port ${PORT}`);
  console.log(`📦 Loaded ${Object.keys(CLIENTS).length} client(s)`);
});

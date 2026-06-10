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
// Only prompt + business name + bypass numbers stored in files
// Supports both .json and .js client files
// ============================================================
function loadClients() {
  const clientsDir = path.join(__dirname, 'clients');
  const files = fs.readdirSync(clientsDir)
    .filter(f => f.endsWith('.json') || f.endsWith('.js'));
  const clients = {};

  files.forEach(file => {
    let config;

    if (file.endsWith('.js')) {
      // Clear cache so changes take effect on reload
      delete require.cache[require.resolve(path.join(clientsDir, file))];
      config = require(path.join(clientsDir, file));
    } else {
      config = JSON.parse(
        fs.readFileSync(path.join(clientsDir, file), 'utf8')
      );
    }

    const prefix = config.envPrefix;

    const phoneNumberId = process.env[`${prefix}_PHONE_ID`];
    const wabaToken     = process.env[`${prefix}_TOKEN`];
    const ownerPhone    = process.env[`${prefix}_OWNER`];

    if (!phoneNumberId || !wabaToken || !ownerPhone) {
      console.log(`⚠️  Skipping ${config.businessName} — missing env vars for prefix: ${prefix}`);
      return;
    }

    clients[phoneNumberId] = {
      businessName:  config.businessName,
      envPrefix:     prefix,
      systemPrompt:  config.systemPrompt,
      bypassNumbers: config.bypassNumbers || [],
      phoneNumberId,
      wabaToken,
      ownerPhone,
    };

    console.log(`✅ Loaded client: ${config.businessName}`);
  });

  return clients;
}

let CLIENTS = loadClients();

// Reload clients without restarting server
app.get('/reload-clients', (req, res) => {
  CLIENTS = loadClients();
  res.json({
    message: 'Clients reloaded',
    loaded: Object.values(CLIENTS).map(c => c.businessName),
  });
});

// ============================================================
// BOT ON/OFF STATE — per client (in memory)
// ============================================================
const botState = {}; // { phoneNumberId: true/false }

function isBotActive(phoneNumberId) {
  if (botState[phoneNumberId] === undefined) return true; // default ON
  return botState[phoneNumberId];
}

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
// NOTIFY OWNER
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
// OWNER ADMIN COMMANDS
// Owner texts these from their personal number to bot number
// ============================================================
async function handleOwnerCommand(client, text) {
  const cmd  = text.trim().toLowerCase();
  const pid  = client.phoneNumberId;
  const tok  = client.wabaToken;
  const owner = client.ownerPhone;

  // !on — turn bot ON
  if (cmd === '!on') {
    botState[pid] = true;
    await sendMessage(pid, tok, owner,
      `🟢 Bot is now ON for ${client.businessName}.\nCustomers will receive bot replies.`);

  // !off — turn bot OFF
  } else if (cmd === '!off') {
    botState[pid] = false;
    await sendMessage(pid, tok, owner,
      `🔴 Bot is now OFF for ${client.businessName}.\nCustomers will get no reply until you turn it back on.`);

  // !status — check current state
  } else if (cmd === '!status') {
    const status  = isBotActive(pid) ? '🟢 ON' : '🔴 OFF';
    const bypassed = client.bypassNumbers.length > 0
      ? client.bypassNumbers.join(', ')
      : 'None';
    await sendMessage(pid, tok, owner,
      `📊 *Bot Status — ${client.businessName}*\n\n` +
      `Status: ${status}\n` +
      `Bypassed numbers: ${bypassed}`);

  // !reply NUMBER message — send manual message to customer
  } else if (text.trim().toLowerCase().startsWith('!reply ')) {
    const parts = text.trim().split(' ');
    const customerNumber = parts[1];
    const messageText    = parts.slice(2).join(' ');

    if (!customerNumber || !messageText) {
      await sendMessage(pid, tok, owner,
        `⚠️ Wrong format. Use:\n!reply 919XXXXXXXXX your message here`);
      return;
    }

    await sendMessage(pid, tok, customerNumber, messageText);

    // Save owner reply in session so bot has context later
    const session = getSession(pid, customerNumber);
    session.messages.push({
      role: 'assistant',
      content: `[Owner replied]: ${messageText}`
    });

    await sendMessage(pid, tok, owner,
      `✅ Message sent to +${customerNumber}`);

  // !help — show all commands
  } else if (cmd === '!help') {
    await sendMessage(pid, tok, owner,
      `📋 *Available Commands:*\n\n` +
      `!on → Turn bot ON\n` +
      `!off → Turn bot OFF\n` +
      `!status → Check bot status\n` +
      `!reply 91XXXXXXXXXX message → Send message to customer\n` +
      `!help → Show this list`);

  // Unknown command
  } else {
    await sendMessage(pid, tok, owner,
      `❓ Unknown command. Type *!help* to see all commands.`);
  }
}

// ============================================================
// HANDLE MESSAGE
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

    // Supports both trigger words with and without brackets
    const isComplete =
      botReply.includes('[ORDER_COMPLETE]') ||
      botReply.includes('[LEAD_CAPTURED]')  ||
      botReply.includes('ORDER_COMPLETE')   ||
      botReply.includes('LEAD_CAPTURED');

    const cleanReply = botReply
      .replace('[ORDER_COMPLETE]', '')
      .replace('[LEAD_CAPTURED]', '')
      .replace('ORDER_COMPLETE', '')
      .replace('LEAD_CAPTURED', '')
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

    // ✅ Owner sending admin commands from personal number
    if (from === client.ownerPhone && userText.startsWith('!')) {
      console.log(`🔧 [${client.businessName}] Owner command: ${userText}`);
      await handleOwnerCommand(client, userText);
      return;
    }

    // ✅ Per-client bypass list — personal/family numbers
    if (client.bypassNumbers.includes(from)) {
      console.log(`⏭️ [${client.businessName}] Bypassed: +${from}`);
      return;
    }

    // ✅ Check if bot is active for this client
    if (!isBotActive(phoneNumberId)) {
      console.log(`⛔ [${client.businessName}] Bot is OFF — message from +${from} ignored`);
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
  const list = Object.values(CLIENTS)
    .map(c => `${isBotActive(c.phoneNumberId) ? '🟢' : '🔴'} ${c.businessName}`)
    .join('\n') || 'No clients loaded';
  res.send(`<pre>✅ Whatbot Running!\n\nClients:\n${list}</pre>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot running on port ${PORT}`);
  console.log(`📦 Loaded ${Object.keys(CLIENTS).length} client(s)`);
});

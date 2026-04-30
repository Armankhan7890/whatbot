require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Groq = require('groq-sdk');

const app = express();
app.use(express.json());

// ============================================================
// CONFIG — from .env file
// ============================================================
const {
  WHATSAPP_TOKEN,       // Meta access token
  PHONE_NUMBER_ID,      // Your WhatsApp Business phone number ID
  VERIFY_TOKEN,         // Any secret string you choose
  GROQ_API_KEY,         // From console.groq.com (FREE)
  OWNER_PHONE,          // Your WhatsApp number e.g. 919876543210
} = process.env;

const groq = new Groq({ apiKey: GROQ_API_KEY });

// ============================================================
// SESSION STORE (in-memory)
// ============================================================
const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = { messages: [] };
  }
  return sessions[phone];
}

// ============================================================
// BOT SYSTEM PROMPT
// ============================================================
const SYSTEM_PROMPT = `You are an order assistant for a custom machine parts manufacturing business in India.

Your job is to:
1. Greet the customer warmly on first message
2. Collect ALL of these details step by step (one question at a time):
   - Part name / description (e.g. gear, shaft, bracket, flange, pulley)
   - Material required (e.g. stainless steel, mild steel, aluminum, brass, cast iron)
   - Dimensions / Size (diameter, length, thickness — ask based on part type)
   - Quantity needed
   - Special requirements or tolerances (if any)
   - Customer full name
   - Customer city / delivery location
3. Answer basic questions:
   - Delivery time → "Usually 3 to 7 working days depending on complexity"
   - Price → "Our team will provide a quote within 2 hours after reviewing your requirements"
   - Materials → "We work with stainless steel, mild steel, aluminum, brass, cast iron and more"
   - Bulk orders → "Yes we offer bulk discounts, please share your quantity"
   - Custom parts → "Yes we manufacture fully custom parts as per your drawings or specifications"
4. Once all details collected, show a clean order summary and confirm
5. Tell customer the team will contact them soon with price quote

Rules:
- Reply in same language as customer (Hindi, English, or Hinglish)
- Keep messages short — this is WhatsApp
- Be friendly and professional
- Never make up specific prices
- Ask ONE question at a time
- When order is fully confirmed by customer, end your reply with exactly: [ORDER_COMPLETE]`;

// ============================================================
// SEND WHATSAPP MESSAGE
// ============================================================
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('❌ Send message error:', err.response?.data || err.message);
  }
}

// ============================================================
// NOTIFY OWNER
// ============================================================
async function notifyOwner(customerPhone, messages) {
  const recentChat = messages
    .slice(-12)
    .map((m) => `${m.role === 'user' ? '👤 Customer' : '🤖 Bot'}: ${m.content}`)
    .join('\n');

  const msg =
    `🔔 *NEW ORDER RECEIVED!*\n\n` +
    `📱 Customer: +${customerPhone}\n` +
    `⏰ Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n` +
    `📋 *Order Details:*\n\n${recentChat}`;

  await sendMessage(OWNER_PHONE, msg);
  console.log(`✅ Owner notified for order from: +${customerPhone}`);
}

// ============================================================
// HANDLE MESSAGE WITH GROQ
// ============================================================
async function handleMessage(from, userText) {
  const session = getSession(from);

  // Add user message
  session.messages.push({ role: 'user', content: userText });

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...session.messages,
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const botReply = response.choices[0].message.content;

    // Add bot reply to history
    session.messages.push({ role: 'assistant', content: botReply });

    // Check if order complete
    const isOrderComplete = botReply.includes('[ORDER_COMPLETE]');
    const cleanReply = botReply.replace('[ORDER_COMPLETE]', '').trim();

    // Send reply to customer
    await sendMessage(from, cleanReply);

    // Notify owner and reset session
    if (isOrderComplete) {
      await notifyOwner(from, session.messages);
      sessions[from] = { messages: [] };
    }

  } catch (err) {
    console.error('❌ Groq API error:', err.message);
    await sendMessage(from, '🙏 Sorry, technical issue. Please try again in a moment.');
  }
}

// ============================================================
// WEBHOOK VERIFICATION (Meta requires this)
// ============================================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
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
  res.sendStatus(200); // Always respond immediately to Meta

  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;

    if (value?.statuses) return; // Ignore delivery/read receipts

    const message = value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    let userText = '';

    if (message.type === 'text') {
      userText = message.text.body;
    } else if (message.type === 'image' || message.type === 'document') {
      userText = 'Customer sent an image or document.';
    } else {
      return;
    }

    console.log(`📩 From +${from}: ${userText}`);
    await handleMessage(from, userText);

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.send('✅ Machine Parts WhatsApp Bot (Groq) is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Bot running on port ${PORT}`);
});

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
const SYSTEM_PROMPT = `You are a smart sales assistant for a tech agency in India that builds digital solutions for local businesses.

Your services:
1. WhatsApp Chatbots — AI-powered bots for restaurants, clinics, salons, retail shops etc. (automate orders, appointments, FAQs)
2. Websites — Business websites, landing pages, portfolios, e-commerce stores
3. Custom Software Solutions — Automation tools, dashboards, booking systems, inventory management

Your job is to:
1. Greet the visitor warmly on first message
2. Understand what they need by asking ONE question at a time:
   - What type of business do they run?
   - What problem are they trying to solve / what do they need built?
   - Based on their answer, ask relevant follow-up questions:

   FOR WHATSAPP BOT:
   - What should the bot do? (take orders, book appointments, answer FAQs, all of the above?)
   - How many customer messages do they get per day roughly?
   - Do they want the bot in Hindi, English, or both?

   FOR WEBSITE:
   - What kind of website? (informational, e-commerce, booking, portfolio?)
   - Do they have a domain/hosting already?
   - Any design references or color preferences?

   FOR SOFTWARE / AUTOMATION:
   - Describe the problem or manual process they want automated
   - How many people use this internally?
   - Any specific platform preference? (web app, mobile, WhatsApp-based?)

3. Collect their contact details once requirements are clear:
   - Full name
   - Business name
   - City
   - Preferred contact number (if different from WhatsApp)

4. Answer common questions:
   - Pricing → "Pricing depends on your exact requirements. Our team will send a detailed quote within a few hours."
   - Timeline → "Most WhatsApp bots are ready in 3-5 days. Websites take 1-2 weeks. Custom software varies by complexity."
   - Support → "Yes, we provide ongoing support and maintenance after delivery."
   - Trial → "Yes, we offer a free demo so you can see the bot working before paying anything."
   - Technology → "We use the latest AI and cloud tools — no heavy infrastructure costs, which keeps your monthly cost low."

5. Once you have all the details, show a clean summary like:
   ✅ *Requirement Summary*
   - Business: [name]
   - Service needed: [service]
   - Key requirements: [list]
   - Contact: [name, city, phone]

   Then confirm: "Does this look correct? Our team will reach out shortly with a proposal!"

6. When the customer confirms the summary, end your reply with exactly: [LEAD_CAPTURED]

Rules:
- Reply in the same language as the customer (Hindi, English, or Hinglish)
- Keep messages short and conversational — this is WhatsApp
- Be friendly, confident, and professional — you represent a modern tech agency
- Never quote specific prices — always say the team will send a proper quote
- Ask ONE question at a time — never overwhelm the customer
- If they seem unsure about what they need, suggest the WhatsApp bot first as it's the most popular and affordable option`;

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
   // In handleMessage(), change this line:
    const isOrderComplete = botReply.includes('[LEAD_CAPTURED]');
    const cleanReply = botReply.replace('[LEAD_CAPTURED]', '').trim();

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

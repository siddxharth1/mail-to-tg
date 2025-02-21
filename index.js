const express = require("express");
const Imap = require("imap");
const TelegramBot = require("node-telegram-bot-api");
const { simpleParser } = require("mailparser");
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

// Initialize Gemini AI
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not defined in environment variables");
}
const genAI = new GoogleGenerativeAI(apiKey);

const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
});

const generationConfig = {
  temperature: 1,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 8192,
  responseMimeType: "text/plain",
};

// Email configuration
const imapConfig = {
  user: process.env.EMAIL_USER,
  password: process.env.EMAIL_PASSWORD,
  host: process.env.EMAIL_HOST, // e.g., 'imap.gmail.com'
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
};

// Telegram configuration
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Function to interact with Gemini AI
async function run(email) {
  try {
    const chatSession = model.startChat({
      generationConfig,
      history: [],
    });

    const queryToSummarizeEmail = `Summarize the email and determine its intent:
        If the sender is asking about applying for a new job, provide a job description.
        If not, respond appropriately based on the email's content.
        If it's a motivational email, reply with the single word: 'Motivation.'
        If it contains general information, provide a concise summary
        or if this contain 21BCE11062 or vsssiddharth@gmail.com then send message "found 21BCE11062"`;

    const result = await chatSession.sendMessage(
      `email: ${email} ${queryToSummarizeEmail}`
    );
    console.log(result.response.text());
  } catch (error) {
    console.error("Error in AI processing:", error);
  }
}

// Email filter settings
const emailFilter = {
  senderEmails: [
    "placementoffice@vitbhopal.ac.in",
    "vitblions2025@vitbhopal.ac.in",
    "patqueries.bhopal@vitbhopal.ac.in",
  ], // Empty array means accept all sender emails
  subjects: [], // Empty array means accept all subjects
  excludedSubjects: ["spam", "promotion", "advertisement", "Congratulations"],
};

// Create IMAP instance
const imap = new Imap(imapConfig);

// Add reconnection logic
let reconnectTimeout;
const RECONNECT_DELAY = 5000; // 5 seconds

function connectToImap() {
  // Clear any existing timeout
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }

  // Connect to IMAP server
  try {
    imap.connect();
  } catch (err) {
    console.error('Connection error:', err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  console.log(`Scheduling reconnection in ${RECONNECT_DELAY/1000} seconds...`);
  reconnectTimeout = setTimeout(connectToImap, RECONNECT_DELAY);
}

// Function to process email messages
async function processEmail(msg) {
  try {
    const parsed = await simpleParser(msg);
    const { from, subject, text, html } = parsed;
    const sender = from?.value?.[0]?.address || "Unknown";

    if (shouldForwardEmail(sender, subject || "")) {
      const cleanContent = (text || html || "No content available")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .substring(0, 4000);

      // Get AI summary
      const aiResponse = await run(cleanContent);
      const summary = aiResponse?.response?.text() || "No summary available";

      const message = `📧 *New Email*\nFrom: ${from.text.replace(
        /[<>]/g,
        ""
      )}\nSubject: ${
        subject || "No Subject"
      }\n\n*AI Summary:*\n${summary}\n\n*Original Content:*\n${cleanContent}`;

      // Send to Telegram with Markdown formatting
      try {
        await bot.sendMessage(TELEGRAM_CHAT_ID, message, {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        });
        console.log("Email forwarded to Telegram successfully");
      } catch (error) {
        console.warn("Markdown failed, retrying in plain text...");
        await bot.sendMessage(TELEGRAM_CHAT_ID, message.replace(/\*/g, ""), {
          parse_mode: "None",
          disable_web_page_preview: true,
        });
      }
    }
  } catch (err) {
    console.error("Error processing email:", err);
  }
}

// Function to check if email matches filter criteria
function shouldForwardEmail(sender, subject) {
  const matchesSender =
    emailFilter.senderEmails.length === 0 ||
    emailFilter.senderEmails.includes(sender);

  const matchesSubject =
    emailFilter.subjects.length === 0 ||
    emailFilter.subjects.some((keyword) =>
      subject.toLowerCase().includes(keyword.toLowerCase())
    );
    if(!matchesSender || !matchesSubject){
      console.log("not useful");
      
    }
  return matchesSender && matchesSubject;
}

// Function to open inbox and start listening for new emails
function openInbox(cb) {
  imap.openBox("INBOX", false, cb);
}

// Connect to email server and start listening
imap.once("ready", () => {
  openInbox((err, box) => {
    if (err) {
      console.error("Error opening inbox:", err);
      return;
    }

    // Listen for new emails
    imap.on("mail", () => {
      const fetch = imap.seq.fetch(box.messages.total + ":*", {
        bodies: "",
        struct: true,
      });

      fetch.on("message", (msg) => {
        let buffer = "";
        msg.on("body", (stream) => {
          stream.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
          });
          stream.once("end", async () => {
            try {
              const parsed = await simpleParser(buffer);

              // Check for CSV attachments
              if (parsed.attachments && parsed.attachments.length > 0) {
                const csvAttachments = parsed.attachments.filter(
                  (att) =>
                    att.contentType === "text/csv" ||
                    att.filename?.toLowerCase().endsWith(".csv")
                );

                for (const attachment of csvAttachments) {
                  const csvContent = attachment.content.toString("utf8");
                  if (csvContent.includes("21bce11062")) {
                    await bot.sendMessage(
                      TELEGRAM_CHAT_ID,
                      `Found 21bce11062 in CSV file: ${attachment.filename}`
                    );
                  }
                }
              }

              // Process the email normally
              processEmail(buffer);
            } catch (error) {
              console.error("Error processing CSV:", error);
              processEmail(buffer);
            }
          });
        });
      });

      fetch.once("error", (err) => {
        console.error("Fetch error:", err);
      });
    });
  });
});

// Modify the error and end handlers
imap.once('error', (err) => {
  console.error('IMAP error:', err);
  scheduleReconnect();
});

imap.once('end', () => {
  console.log('IMAP connection ended');
  scheduleReconnect();
});

// Replace the direct imap.connect() call with our new function
connectToImap();

// Add a process termination handler to clean up
process.on('SIGINT', () => {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  if (imap && imap.state !== 'disconnected') {
    imap.end();
  }
  process.exit();
});

// Handle Telegram bot commands
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Email forwarding bot is running! You will receive filtered emails here."
  );
});

// Express server
app.get("/", (req, res) => {
  res.send("Hello World");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

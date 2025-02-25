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
  host: process.env.EMAIL_HOST,
  port: 993,
  tls: true,
  tlsOptions: {
    rejectUnauthorized: false,
    secureProtocol: "TLSv1_2_method", // Force TLS 1.2
  },
  connTimeout: 10000, // Connection timeout in milliseconds
  authTimeout: 5000, // Authentication timeout
  keepalive: {
    interval: 10000, // Interval in milliseconds
    idleInterval: 300000, // 5 minutes
    forceNoop: true, // Force keep-alive packets
  },
};

// Telegram configuration
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: {
    interval: 300, // Poll every 300ms
    autoStart: true,
    params: {
      timeout: 10
    }
  },
  request: {
    proxy: null,
    timeout: 60000, // Increase timeout to 60 seconds
    agent: null,    // Let Node.js handle the agent
    pool: {
      maxSockets: Infinity
    }
  },
  baseApiUrl: "https://api.telegram.org",
});
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Function to interact with Gemini AI
async function run(email) {
  try {
    const chatSession = model.startChat({
      generationConfig,
      history: [],
    });

    const queryToSummarizeEmail = `Summarize the email and determine its intent:
        If the sender is asking about applying for a new job, provide a job description and do check if the eligible criteria is below 75% or 7.5GPA in 10th class and below 80% or 8GPA in 12th class and 8.5CGPA or 85% in Graduation.
        If not, respond appropriately based on the email's content.
        If it's a motivational email, reply with the single word: 'Motivation.'
        If it contains general information, provide a concise summary
        or if this contain 21BCE11062 or vsssiddharth@gmail.com then send message "found 21BCE11062" 
        and if it have any link than mention that too.
        if none of the condition matches just response with single word "invalid"`;

    const result = await chatSession.sendMessage(
      `email: ${email} ${queryToSummarizeEmail}`
    );
    return result.response.text(); // Return the response text
  } catch (error) {
    console.error("Error in AI processing:", error);
    return "Error generating summary"; // Return error message instead of undefined
  }
}

// Email filter settings
const emailFilter = {
  senderEmails: [
    "placementoffice@vitbhopal.ac.in",
    "vitblions2025@vitbhopal.ac.in",
    "patqueries.bhopal@vitbhopal.ac.in",
  ],
  subjects: [],
  excludedSubjects: ["spam", "promotion", "advertisement", "Congratulations"],
};

// Create IMAP instance
let imap;

// Add reconnection logic
let reconnectTimeout;
let isConnecting = false;
const RECONNECT_DELAY = 5000; // 5 seconds
const MAX_RETRIES = 10;
let retryCount = 0;

function connectToImap() {
  if (isConnecting) {
    console.log("Already attempting to connect...");
    return;
  }

  // Clear any existing timeout
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }

  isConnecting = true;
  console.log("Attempting to connect to IMAP server...");

  // Create a new IMAP instance for each connection attempt
  imap = new Imap(imapConfig);

  // Set up event handlers for the new instance
  setupImapHandlers();

  // Connect to IMAP server
  try {
    imap.connect();
  } catch (err) {
    console.error("Connection error:", err);
    handleReconnect("connection error");
  }
}

function setupImapHandlers() {
  imap.once("ready", () => {
    console.log("IMAP connection established successfully");
    isConnecting = false;
    retryCount = 0;
    openInbox((err, box) => {
      if (err) {
        console.error("Error opening inbox:", err);
        handleReconnect("inbox error");
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
                await processEmail(buffer);
              } catch (error) {
                console.error("Error processing message:", error);
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

  imap.once("error", (err) => {
    console.error("IMAP error:", err);
    handleReconnect("imap error");
  });

  imap.once("end", () => {
    console.log("IMAP connection ended");
    handleReconnect("connection ended");
  });

  imap.once("close", (hadError) => {
    console.log(`IMAP connection closed${hadError ? " with error" : ""}`);
    handleReconnect("connection closed");
  });
}

function handleReconnect(reason) {
  if (isConnecting) {
    isConnecting = false;
  }

  if (retryCount >= MAX_RETRIES) {
    console.log(
      `Maximum retry attempts (${MAX_RETRIES}) reached. Waiting for 5 minutes before resetting...`
    );
    setTimeout(() => {
      retryCount = 0;
      connectToImap();
    }, 300000); // 5 minutes
    return;
  }

  retryCount++;
  const delay = RECONNECT_DELAY * Math.min(retryCount, 5); // Exponential backoff up to 5x
  console.log(
    `Scheduling reconnection attempt ${retryCount}/${MAX_RETRIES} in ${
      delay / 1000
    } seconds... (Reason: ${reason})`
  );

  reconnectTimeout = setTimeout(() => {
    // Destroy existing connection if it exists
    if (imap && imap.state !== "disconnected") {
      try {
        imap.end();
      } catch (err) {
        console.error("Error ending existing connection:", err);
      }
    }
    connectToImap();
  }, delay);
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
        .split("--")[0]
        .substring(0, 4000);

      // Get AI summary
      const summary = await run(cleanContent); // Directly assign the returned value

      if(summary === "invalid"){
        console.log("invalid mail");
        return; 
      }

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

  const excludedSubject =
    emailFilter.excludedSubjects.length === 0 ||
    emailFilter.excludedSubjects.some((keyword) =>
      subject.toLowerCase().includes(keyword.toLowerCase())
    );
  if (!matchesSender || !matchesSubject) {
    console.log("not useful");
  }
  return matchesSender && matchesSubject && !excludedSubject;
}

// Function to open inbox and start listening for new emails
function openInbox(cb) {
  imap.openBox("INBOX", false, cb);
}

// Replace the direct imap.connect() call with our new function
connectToImap();

// Improve process termination handler
process.on("SIGINT", () => {
  console.log("Shutting down...");
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  if (imap && imap.state !== "disconnected") {
    imap.end();
  }
  process.exit(0);
});

// Add additional process handlers for better cleanup
process.on("SIGTERM", () => {
  console.log("Received SIGTERM. Cleaning up...");
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  if (imap && imap.state !== "disconnected") {
    imap.end();
  }
  process.exit(0);
});

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  if (imap && imap.state !== "disconnected") {
    imap.end();
  }
  process.exit(1);
});

// Handle Telegram bot commands
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Email forwarding bot is running! You will receive filtered emails here."
  );
});

// Improve Telegram error handling
bot.on('polling_error', async (error) => {
  console.error('Telegram Polling Error:', error.message || error);
  
  // Wait for 30 seconds before attempting to restart polling
  await new Promise(resolve => setTimeout(resolve, 30000));
  
  try {
    await bot.stopPolling();
    console.log('Polling stopped, waiting before restart...');
    
    // Wait additional 10 seconds before restarting
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    await bot.startPolling();
    console.log('Polling restarted successfully');
  } catch (e) {
    console.error('Error during polling restart:', e.message);
    // Try again after 60 seconds
    setTimeout(() => {
      bot.startPolling();
    }, 60000);
  }
});

// Add error event handler
bot.on('error', (error) => {
  console.error('Telegram Bot Error:', error.message || error);
});

// Add webhook error handler
bot.on('webhook_error', (error) => {
  console.error('Telegram Webhook Error:', error.message || error);
});

// Express server
app.get("/", (req, res) => {
  res.send("Hello World");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

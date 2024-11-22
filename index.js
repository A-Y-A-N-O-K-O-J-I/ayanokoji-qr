const express = require("express");
const makeWASocket = require("@whiskeysockets/baileys").default;
const { MongoClient } = require("mongodb");
const useMongoDBAuthState = require("./mongoAuthState");
const { DisconnectReason } = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const config = require("./config");

// Set up Express for serving the QR code
const app = express();
const port = config.PORT; // Use the port from config.js
const mongoURL = config.MONGODB_URI; // Use MongoDB URI from config.js

// Variable to hold QR code data
let qrCodeData = "";

// Function to generate a unique session ID
function generateSessionId() {
  return `SOPHIA_MD-${uuidv4().replace(/-/g, "").toUpperCase()}`;
}

// Function to store session ID in MongoDB
async function storeSessionId(sessionId, collection) {
  const sessionData = { _id: "sessionId", sessionId, createdAt: new Date() };
  await collection.updateOne({ _id: "sessionId" }, { $set: sessionData }, { upsert: true });
  console.log(`Session ID stored: ${sessionId}`);
}

// Function to delete the current session ID from MongoDB
async function clearSessionId(collection) {
  await collection.deleteOne({ _id: "sessionId" });
  console.log("Session ID cleared from MongoDB.");
}

// MongoDB connection logic
async function connectionLogic() {
  const mongoClient = new MongoClient(mongoURL, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  await mongoClient.connect();

  const collection = mongoClient.db("whatsapp_api").collection("auth_info_baileys");
  const { state, saveCreds, getSessionId } = await useMongoDBAuthState(collection);

  // Retrieve existing session ID
  let sessionId = await getSessionId();

  const initiateSocket = () => {
    const sock = makeWASocket({ auth: state });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update || {};

      // Handle QR code generation
      if (qr) {
        qrCodeData = await QRCode.toDataURL(qr);
        console.log("QR code updated. Scan to log in.");
      }

      if (connection === "open") {
        if (!sessionId) {
          sessionId = generateSessionId();
          await storeSessionId(sessionId, collection);

          await sock.sendMessage(sock.user.id, {
            text: `Your session ID is: ${sessionId}`,
          });
          console.log("Session ID sent to user's DM.");
        } else {
          console.log("Reconnected successfully using existing session ID.");
        }
      }

      // Handle reconnections
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("Session logged out. Clearing session and prompting QR code login...");
          await clearSessionId(collection);
          connectionLogic();
        } else if (statusCode !== DisconnectReason.loggedOut) {
          console.log("Reconnecting...");
          initiateSocket();
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);
  };

  if (!sessionId) {
    console.log("No session ID found. Please scan the QR code to log in.");
    initiateSocket();
  } else {
    console.log(`Using existing session ID: ${sessionId}`);
    initiateSocket();
  }
}

// Start connection logic
connectionLogic();

// Serve the QR code at the root URL
app.get("/", (req, res) => {
  if (qrCodeData) {
    res.send(`
      <h2>Scan the QR Code below with WhatsApp:</h2>
      <img src="${qrCodeData}" alt="WhatsApp QR Code" />
    `);
  } else {
    res.send("<h2>QR Code not generated yet. Please wait...</h2>");
  }
});

// Start the web server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import makeWASocket from '@whiskeysockets/baileys';
import { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'fs';

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: { origin: "http://localhost:3000" },
    transports: ['websocket']
});

app.use(cors());
app.use(express.json());

let sock = null;
let isWhatsAppConnected = false;
let currentQR = null;
let qrSent = false;
const processedMessages = new Set();
const localMessages = [];

// Save local messages
if (!fs.existsSync('messages.json')) fs.writeFileSync('messages.json', JSON.stringify(localMessages));
else {
    const saved = fs.readFileSync('messages.json');
    try { localMessages.push(...JSON.parse(saved)); } catch(e) {}
}

// ---------- Version Caching ----------
let cachedVersion = null;
if (fs.existsSync('version.json')) {
    try { cachedVersion = JSON.parse(fs.readFileSync('version.json')); } catch(e) { cachedVersion = null; }
}

async function getBaileysVersion() {
    if (!cachedVersion) {
        const { version } = await fetchLatestBaileysVersion();
        cachedVersion = version;
        fs.writeFileSync('version.json', JSON.stringify(version));
    }
    return cachedVersion;
}

// ---------- WhatsApp Connection ----------
async function connectToWhatsApp() {
    try {
        console.log('\n Connecting to WhatsApp...\n');

        const version = await getBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            browser: ['Chrome', 'Chrome', '1.0.0'],
            connectTimeoutMs: 20000,
            defaultQueryTimeoutMs: 20000,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            if (qr) {
                console.log('QR Code generated');
                try {
                    const qrDataURL = await QRCode.toDataURL(qr);
                    currentQR = qrDataURL;
                    io.emit('qr_update', qrDataURL);
                    console.log('✓ QR Code sent to browser');
                } catch (err) {
                    console.error('QR generation error:', err);
                }
                qrSent = true;
            }

            if (connection === 'open') {
                isWhatsAppConnected = true;
                console.log(`\n WhatsApp Connected as ${sock.user.id}\n`);
                io.emit('whatsapp_connected', { status: true, number: sock.user.id });
            }

            if (connection === 'close') {
                isWhatsAppConnected = false;
                currentQR = null;
                qrSent = false;
                console.log('\n WhatsApp Disconnected\n');
                io.emit('whatsapp_connected', { status: false });

                // Reconnect smoothly
                setTimeout(connectToWhatsApp, 5000);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            if (processedMessages.has(msg.key.id)) return;

            processedMessages.add(msg.key.id);

            let messageText = '';
            if (msg.message.conversation) messageText = msg.message.conversation;
            else if (msg.message.extendedTextMessage?.text) messageText = msg.message.extendedTextMessage.text;
            else return;

            const sender = msg.key.remoteJid.replace('@s.whatsapp.net', '');
            const receivedMsg = { id: msg.key.id, type: 'whatsapp', from: sender, message: messageText, time: new Date(), isReceived: true };

            console.log(`${sender}: ${messageText}`);
            io.emit('new_whatsapp_message', receivedMsg);
        });

    } catch (error) {
        console.error('Connection error:', error);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Send QR immediately if available
    if (currentQR) socket.emit('qr_update', currentQR);

    // Send WhatsApp connection status
    socket.emit('whatsapp_connected', { status: isWhatsAppConnected });

    // Send local messages
    socket.emit('local_messages_history', localMessages);

    // Local messages
    socket.on('send_local_message', ({ username, message }) => {
        const newMessage = { id: Date.now(), type: 'local', username, message, time: new Date() };
        localMessages.push(newMessage);
        fs.writeFileSync('messages.json', JSON.stringify(localMessages));
        io.emit('new_local_message', newMessage);
    });

    // WhatsApp messages
    socket.on('send_whatsapp_message', async ({ number, message }) => {
        if (!sock || !isWhatsAppConnected) return socket.emit('message_error', 'WhatsApp not connected');
        try {
            const formattedNumber = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            await sock.sendMessage(formattedNumber, { text: message });
            const sentMsg = { id: Date.now(), type: 'whatsapp', to: number, message, time: new Date(), isSent: true };
            io.emit('new_whatsapp_message', sentMsg);
        } catch (err) {
            console.error('Send error:', err);
            socket.emit('message_error', err.message);
        }
    });

    socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// ---------- Start Server ----------
const PORT = 5000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    connectToWhatsApp();
});
const nodeCrypto = require('crypto');
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
    try {
        globalThis.crypto = nodeCrypto.webcrypto || nodeCrypto;
    } catch (e) {
        console.error('[WA-LOCAL] Crypto polyfill error:', e.message);
    }
}

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');

let sock = null;
let qrData = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, INITIALIZING, WAITING_QR, READY
let initTimestamp = 0;

async function initWhatsApp(pool) {
    const now = Date.now();
    // Prevent duplicate calls if currently initializing
    if (connectionStatus === 'INITIALIZING' && (now - initTimestamp) < 15000) {
        return;
    }
    initTimestamp = now;

    // Clean old socket if exists
    if (sock) {
        try {
            console.log('[WA-LOCAL] Closing existing socket connection...');
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('creds.update');
            sock.end();
        } catch (e) {}
        sock = null;
    }

    console.log('[WA-LOCAL] Initializing local WhatsApp client (Baileys)...');
    connectionStatus = 'INITIALIZING';

    try {
        const { state, saveCreds } = await useMultiFileAuthState('.baileys_auth');

        let version = [2, 3000, 1015901307];
        try {
            const vRes = await Promise.race([
                fetchLatestBaileysVersion(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
            ]);
            if (vRes && vRes.version) version = vRes.version;
        } catch (e) {}

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Ubuntu', 'Chrome', '22.04.4'],
            syncFullHistory: false,
            shouldSyncHistoryDevices: () => false,
            maxMsgRetryCount: 3
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('[WA-LOCAL] QR RECEIVED! Generating DataURL...');
                try {
                    qrData = await qrcode.toDataURL(qr);
                    connectionStatus = 'WAITING_QR';
                    console.log('[WA-LOCAL] QR DataURL ready.');
                } catch (err) {
                    console.error('[WA-LOCAL] QR DataURL Error:', err.message);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errMessage = lastDisconnect?.error?.message || lastDisconnect?.error;
                console.log(`[WA-LOCAL] Connection closed. Status: ${statusCode || 'none'} (${errMessage})`);

                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;

                if (isLoggedOut) {
                    console.log('[WA-LOCAL] Logged out. Clearing credentials folder...');
                    connectionStatus = 'DISCONNECTED';
                    qrData = null;
                    try {
                        fs.rmSync('.baileys_auth', { recursive: true, force: true });
                    } catch (e) {}
                    return;
                }

                // If QR was just scanned (status 515), reconnect ONCE immediately to finish authentication
                if (isRestartRequired) {
                    console.log('[WA-LOCAL] QR scanned! Reconnecting to finalize session...');
                    initTimestamp = 0;
                    setTimeout(() => initWhatsApp(pool), 1000);
                    return;
                }

                // If was previously connected (READY) and dropped due to network glitch, auto reconnect
                if (connectionStatus === 'READY') {
                    console.log('[WA-LOCAL] Active session disconnected. Auto-reconnecting in 15s...');
                    connectionStatus = 'INITIALIZING';
                    initTimestamp = 0;
                    setTimeout(() => initWhatsApp(pool), 15000);
                    return;
                }

                // If unauthenticated or QR timed out, stay DISCONNECTED (do NOT loop reconnect to save CPU)
                console.log('[WA-LOCAL] Client disconnected/idle. Stopping auto-reconnect to save CPU.');
                connectionStatus = 'DISCONNECTED';
                qrData = null;

            } else if (connection === 'connecting') {
                if (!qrData && connectionStatus !== 'READY') connectionStatus = 'INITIALIZING';
            } else if (connection === 'open') {
                console.log('[WA-LOCAL] CLIENT IS READY!');
                connectionStatus = 'READY';
                qrData = null;
            }
        });
    } catch (err) {
        console.error('[WA-LOCAL] Init Exception:', err.message);
        connectionStatus = 'DISCONNECTED';
    }
}

async function restartWhatsApp(pool) {
    console.log('[WA-LOCAL] Manual restart triggered. Clearing auth & re-initializing...');
    connectionStatus = 'DISCONNECTED';
    qrData = null;
    initTimestamp = 0;
    try {
        if (fs.existsSync('.baileys_auth')) {
            fs.rmSync('.baileys_auth', { recursive: true, force: true });
        }
    } catch (e) {}
    return await initWhatsApp(pool);
}

async function sendLocalWhatsApp(phone, message) {
    if (connectionStatus !== 'READY' || !sock) {
        return { success: false, message: 'WhatsApp tidak terhubung' };
    }
    try {
        let formatted = phone.replace(/\D/g, '');
        if (formatted.startsWith('0')) formatted = '62' + formatted.slice(1);
        const chatId = formatted + '@s.whatsapp.net';
        await sock.sendMessage(chatId, { text: message });
        return { success: true };
    } catch (e) {
        console.error('[WA-LOCAL] Error sending message:', e);
        return { success: false, message: e.message };
    }
}

function getStatus() {
    return { status: connectionStatus, qr: qrData };
}

module.exports = {
    initWhatsApp,
    restartWhatsApp,
    sendLocalWhatsApp,
    getStatus
};

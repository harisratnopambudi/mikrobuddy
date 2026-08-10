const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// Helper to encode RouterOS API words
function encodeString(str) {
    const buf = Buffer.from(str, 'utf-8');
    const len = buf.length;
    let lenBuf;
    if (len < 0x80) {
        lenBuf = Buffer.from([len]);
    } else if (len < 0x4000) {
        lenBuf = Buffer.from([(len >> 8) | 0x80, len & 0xFF]);
    } else if (len < 0x200000) {
        lenBuf = Buffer.from([(len >> 16) | 0xC0, (len >> 8) & 0xFF, len & 0xFF]);
    } else {
        lenBuf = Buffer.from([0xF0, (len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
    }
    return Buffer.concat([lenBuf, buf]);
}

function encodeSentence(words) {
    const buffers = words.map(encodeString);
    buffers.push(Buffer.from([0x00]));
    return Buffer.concat(buffers);
}

// RouterOS API helper function to query raw API socket (port 8728/1206 etc.)
function queryRouterOSAPI(host, port, username, password, command, args = {}) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let buffer = Buffer.alloc(0);
        let connected = false;

        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('Connection timeout to MikroTik API'));
        }, 10000);

        socket.connect(port, host, () => {
            connected = true;
            // Send login command (modern RouterOS login v6.43+)
            const loginSentence = encodeSentence([
                '/login',
                `=name=${username}`,
                `=password=${password || ''}`
            ]);
            socket.write(loginSentence);
        });

        socket.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
            processBuffer();
        });

        socket.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });

        socket.on('close', () => {
            clearTimeout(timer);
        });

        const sentences = [];
        let state = 'login'; // 'login', 'command'

        function processBuffer() {
            let offset = 0;
            while (offset < buffer.length) {
                const sentenceWords = [];
                let sentenceOffset = offset;
                let sentenceComplete = false;

                while (sentenceOffset < buffer.length) {
                    const firstByte = buffer[sentenceOffset];
                    let len = 0;
                    let lenBytes = 0;

                    if ((firstByte & 0x80) === 0x00) {
                        len = firstByte;
                        lenBytes = 1;
                    } else if ((firstByte & 0xC0) === 0x80) {
                        if (sentenceOffset + 1 >= buffer.length) break;
                        len = ((firstByte & 0x3F) << 8) | buffer[sentenceOffset + 1];
                        lenBytes = 2;
                    } else if ((firstByte & 0xE0) === 0xC0) {
                        if (sentenceOffset + 2 >= buffer.length) break;
                        len = ((firstByte & 0x1F) << 16) | (buffer[sentenceOffset + 1] << 8) | buffer[sentenceOffset + 2];
                        lenBytes = 3;
                    } else if ((firstByte & 0xF0) === 0xE0) {
                        if (sentenceOffset + 3 >= buffer.length) break;
                        len = ((firstByte & 0x0F) << 24) | (buffer[sentenceOffset + 1] << 16) | (buffer[sentenceOffset + 2] << 8) | buffer[sentenceOffset + 3];
                        lenBytes = 4;
                    }

                    if (len === 0 && lenBytes === 1) {
                        // End of sentence (null byte)
                        sentenceOffset += 1;
                        sentenceComplete = true;
                        break;
                    }

                    if (sentenceOffset + lenBytes + len > buffer.length) {
                        // Incomplete word, wait for more data
                        break;
                    }

                    const wordBuf = buffer.slice(sentenceOffset + lenBytes, sentenceOffset + lenBytes + len);
                    sentenceWords.push(wordBuf.toString('utf-8'));
                    sentenceOffset += lenBytes + len;
                }

                if (sentenceComplete) {
                    offset = sentenceOffset;
                    handleSentence(sentenceWords);
                } else {
                    break;
                }
            }
            // Slice the processed part out of buffer
            buffer = buffer.slice(offset);
        }

        function handleSentence(words) {
            const replyType = words[0]; // e.g. "!done", "!re", "!trap"
            
            if (state === 'login') {
                if (replyType === '!done') {
                    // Login successful! Now send the actual command
                    state = 'command';
                    const cmdWords = [command];
                    for (const [key, value] of Object.entries(args)) {
                        cmdWords.push(`=${key}=${value}`);
                    }
                    socket.write(encodeSentence(cmdWords));
                } else if (replyType === '!trap') {
                    socket.destroy();
                    reject(new Error('MikroTik Login Failed: ' + (words[1] || 'Invalid credentials')));
                }
            } else if (state === 'command') {
                if (replyType === '!re') {
                    // Data row received
                    const row = {};
                    for (let i = 1; i < words.length; i++) {
                        const word = words[i];
                        if (word.startsWith('=')) {
                            const parts = word.split('=');
                            if (parts.length >= 3) {
                                row[parts[1]] = parts.slice(2).join('=');
                            }
                        }
                    }
                    sentences.push(row);
                } else if (replyType === '!done') {
                    socket.destroy();
                    resolve(sentences);
                } else if (replyType === '!trap') {
                    socket.destroy();
                    reject(new Error('MikroTik API Command Failed: ' + (words[1] || 'Unknown error')));
                }
            }
        }
    });
}

const server = http.createServer((req, res) => {
    // Add CORS headers to all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Proxy endpoint
    if (req.url.startsWith('/api/proxy')) {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const targetUrl = payload.target; // e.g. "id1.mikhmon.web.id:1206"
                const endpoint = payload.endpoint; // e.g. "/system/resource" or "/ip/hotspot/active"
                const username = payload.username;
                const password = payload.password;
                const method = payload.method || 'GET';
                const postData = payload.data || null;

                if (!targetUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing target URL' }));
                    return;
                }

                console.log(`Proxying MikroTik request to: ${targetUrl}, endpoint: ${endpoint}, user: ${username}`);

                // Check if target is REST API (starts with http or uses port 80/443)
                const isRest = targetUrl.startsWith('http') || targetUrl.includes(':80') || targetUrl.includes(':443');

                if (isRest) {
                    // HTTP REST API proxy
                    const cleanTarget = targetUrl.replace(/\/$/, '');
                    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
                    const fullUrl = cleanTarget.startsWith('http') ? `${cleanTarget}${cleanEndpoint}` : `https://${cleanTarget}${cleanEndpoint}`;
                    
                    const urlObj = new URL(fullUrl);
                    const headers = {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    };

                    if (username) {
                        const auth = Buffer.from(`${username}:${password || ''}`).toString('base64');
                        headers['Authorization'] = `Basic ${auth}`;
                    }

                    const jsonStr = postData ? JSON.stringify(postData) : null;
                    if (jsonStr) {
                        headers['Content-Length'] = Buffer.byteLength(jsonStr);
                    }

                    const options = { method, headers };
                    const clientModule = urlObj.protocol === 'https:' ? https : http;

                    const proxyReq = clientModule.request(urlObj, options, (proxyRes) => {
                        let resData = '';
                        proxyRes.on('data', chunk => resData += chunk);
                        proxyRes.on('end', () => {
                            res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
                            res.end(resData);
                        });
                    });

                    proxyReq.on('error', (err) => {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Failed to connect to MikroTik', details: err.message }));
                    });

                    if (jsonStr) proxyReq.write(jsonStr);
                    proxyReq.end();
                } else {
                    // Raw TCP RouterOS API proxy (e.g. port 1206 or 8728)
                    const hostPort = targetUrl.replace(/^http(s)?:\/\//, '').split(':');
                    const host = hostPort[0];
                    const port = parseInt(hostPort[1] || '8728');

                    // Map REST endpoints to RouterOS API commands
                    let command = '';
                    let args = {};

                    if (endpoint.includes('/system/resource')) {
                        command = '/system/resource/print';
                    } else if (endpoint.includes('/ip/hotspot/active')) {
                        command = '/ip/hotspot/active/print';
                    } else if (endpoint.includes('/ip/dhcp-server/lease')) {
                        command = '/ip/dhcp-server/lease/print';
                    } else if (endpoint.includes('/interface')) {
                        command = '/interface/print';
                    } else if (endpoint.includes('/ip/dns')) {
                        if (method === 'PATCH' || method === 'POST') {
                            command = '/ip/dns/set';
                            if (postData && postData.servers) args['servers'] = postData.servers;
                            if (postData && postData['allow-remote-requests']) args['allow-remote-requests'] = postData['allow-remote-requests'];
                        } else {
                            command = '/ip/dns/print';
                        }
                    } else if (endpoint.includes('/ip/firewall/mangle')) {
                        if (method === 'POST') {
                            command = '/ip/firewall/mangle/add';
                            if (postData) {
                                for (const [k, v] of Object.entries(postData)) {
                                    args[k] = v;
                                }
                            }
                        } else {
                            command = '/ip/firewall/mangle/print';
                        }
                    } else {
                        // Generic command fallback
                        command = endpoint.replace(/^\//, '/').replace(/\/$/, '');
                    }

                    queryRouterOSAPI(host, port, username, password, command, args)
                        .then((data) => {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            // REST API expectations check: single object vs array
                            if (endpoint.includes('/system/resource') || endpoint.includes('/ip/dns')) {
                                res.end(JSON.stringify(data[0] || {}));
                            } else {
                                res.end(JSON.stringify(data));
                            }
                        })
                        .catch((err) => {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'MikroTik API Error', details: err.message }));
                        });
                }

            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid request payload', details: err.message }));
            }
        });
        return;
    }

    // Chat endpoint to 9router AI API
    if (req.url.startsWith('/api/chat')) {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const model = payload.model || 'gemini-1.5-flash';
                const messages = payload.messages || [];
                const apiKey = payload.apiKey;

                const postData = JSON.stringify({
                    model: model,
                    messages: messages
                });

                const urlObj = new URL('https://r7udfix.abc-tunnel.us/v1/chat/completions');
                
                const headers = {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                };

                if (apiKey) {
                    headers['Authorization'] = `Bearer ${apiKey}`;
                }

                const options = {
                    method: 'POST',
                    headers: headers
                };

                console.log(`Proxying chat request to 9router. Model: ${model}. API Key exists: ${!!apiKey}`);
                const proxyReq = https.request(urlObj, options, (proxyRes) => {
                    let resData = '';
                    proxyRes.on('data', (chunk) => {
                        resData += chunk;
                    });
                    proxyRes.on('end', () => {
                        console.log(`9router responded with status ${proxyRes.statusCode}`);
                        console.log(`Response data: ${resData}`);
                        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
                        res.end(resData);
                    });
                });

                proxyReq.on('error', (err) => {
                    console.error('9router request error:', err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to connect to 9router AI', details: err.message }));
                });

                proxyReq.write(postData);
                proxyReq.end();

            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid request payload', details: err.message }));
            }
        });
        return;
    }

    // Storage for Lynk.id subscribed emails
    const SUBSCRIBED_EMAILS_FILE = path.join(PUBLIC_DIR, 'subscribed_emails.json');

    function loadSubscribedEmails() {
        try {
            if (fs.existsSync(SUBSCRIBED_EMAILS_FILE)) {
                const data = fs.readFileSync(SUBSCRIBED_EMAILS_FILE, 'utf-8');
                return JSON.parse(data || '[]');
            }
        } catch (err) {
            console.error('Error loading subscribed emails:', err);
        }
        return [];
    }

    function saveSubscribedEmail(email) {
        try {
            const emails = loadSubscribedEmails();
            const cleanEmail = email.toLowerCase().trim();
            if (!emails.includes(cleanEmail)) {
                emails.push(cleanEmail);
                fs.writeFileSync(SUBSCRIBED_EMAILS_FILE, JSON.stringify(emails, null, 2), 'utf-8');
            }
            return true;
        } catch (err) {
            console.error('Error saving subscribed email:', err);
            return false;
        }
    }

    function decodeJwt(token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3) return null;
            const payload = Buffer.from(parts[1], 'base64').toString('utf-8');
            return JSON.parse(payload);
        } catch (err) {
            return null;
        }
    }

    // Webhook Lynk.id endpoint
    if (req.url.startsWith('/api/webhook/lynkid')) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                console.log('Received Lynk.id webhook payload:', payload);

                const email = payload.email || (payload.customer && payload.customer.email) || payload.customer_email || payload.purchaser_email;
                
                if (email) {
                    saveSubscribedEmail(email);
                    console.log(`Lynk.id Purchase Webhook: Email ${email} has been subscribed to PRO`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: `Email ${email} activated` }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Email missing from payload' }));
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid payload', details: err.message }));
            }
        });
        return;
    }

    // Google Auth verification endpoint
    if (req.url.startsWith('/api/auth/google')) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const credential = payload.credential;
                
                if (!credential) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing credential' }));
                    return;
                }

                const decoded = decodeJwt(credential);
                if (!decoded || !decoded.email) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid Google token' }));
                    return;
                }

                const email = decoded.email.toLowerCase().trim();
                const emails = loadSubscribedEmails();
                const isSubscribed = emails.includes(email);

                console.log(`Google Authentication Request: ${email}, verified PRO status: ${isSubscribed}`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    email: email,
                    name: decoded.name || '',
                    picture: decoded.picture || '',
                    isSubscribed: isSubscribed
                }));

            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Auth failed', details: err.message }));
            }
        });
        return;
    }

    // Check subscription status endpoint (GET)
    if (req.url.startsWith('/api/auth/check-subscription')) {
        try {
            const urlObj = new URL(req.url, `http://${req.headers.host}`);
            const email = (urlObj.searchParams.get('email') || '').toLowerCase().trim();
            const emails = loadSubscribedEmails();
            const isSubscribed = emails.includes(email);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ isSubscribed }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Check failed', details: err.message }));
        }
        return;
    }

    // Static Files Server
    let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
    const ext = path.extname(filePath);
    let contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

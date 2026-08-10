// Cloudflare Worker: Unified Backend for MikroBuddy AI
// Handles:
// 1. POST /api/webhook/lynkid -> Receives webhook from Lynk.id, stores paid email in Cloudflare KV.
// 2. GET  /api/auth/check-subscription -> Checks paid status of an email in Cloudflare KV.
// 3. POST /api/auth/google -> Decodes Google JWT and checks paid status in Cloudflare KV.
// 4. POST /api/proxy -> Serverless RouterOS TCP API & REST API proxy using cloudflare:sockets!
// 5. POST / -> Securely proxies chat request to Google Gemini API (hiding GEMINI_API_KEY).

import { connect } from 'cloudflare:sockets';

// Helper to encode RouterOS API words using Web APIs (TextEncoder)
function encodeString(str, encoder) {
  const buf = encoder.encode(str);
  const len = buf.length;
  let lenBuf;
  if (len < 0x80) {
    lenBuf = new Uint8Array([len]);
  } else if (len < 0x4000) {
    lenBuf = new Uint8Array([(len >> 8) | 0x80, len & 0xFF]);
  } else if (len < 0x200000) {
    lenBuf = new Uint8Array([(len >> 16) | 0xC0, (len >> 8) & 0xFF, len & 0xFF]);
  } else {
    lenBuf = new Uint8Array([0xF0, (len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
  }
  const result = new Uint8Array(lenBuf.length + buf.length);
  result.set(lenBuf, 0);
  result.set(buf, lenBuf.length);
  return result;
}

function encodeSentence(words, encoder) {
  const parts = words.map(w => encodeString(w, encoder));
  let totalLen = parts.reduce((sum, p) => sum + p.length, 0) + 1;
  const sentence = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    sentence.set(part, offset);
    offset += part.length;
  }
  sentence[offset] = 0x00;
  return sentence;
}

// Outbound TCP Socket Client for RouterOS API protocol
async function executeRouterOSCommand(host, port, username, password, command, args = {}) {
  const socket = connect({ hostname: host, port: parseInt(port) });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');

  // Send Modern RouterOS Login handshake
  const loginSentence = encodeSentence([
    '/login',
    `=name=${username}`,
    `=password=${password || ''}`
  ], encoder);
  await writer.write(loginSentence);

  let buffer = new Uint8Array(0);
  const appendToBuffer = (newChunk) => {
    const tmp = new Uint8Array(buffer.length + newChunk.length);
    tmp.set(buffer, 0);
    tmp.set(newChunk, buffer.length);
    buffer = tmp;
  };

  const sentences = [];
  let state = 'login';
  let finished = false;
  let commandError = null;

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      appendToBuffer(value);

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
            sentenceOffset += 1;
            sentenceComplete = true;
            break;
          }

          if (sentenceOffset + lenBytes + len > buffer.length) break;

          const wordBuf = buffer.subarray(sentenceOffset + lenBytes, sentenceOffset + lenBytes + len);
          sentenceWords.push(decoder.decode(wordBuf));
          sentenceOffset += lenBytes + len;
        }

        if (sentenceComplete) {
          offset = sentenceOffset;
          const replyType = sentenceWords[0];

          if (state === 'login') {
            if (replyType === '!done') {
              state = 'command';
              const cmdWords = [command];
              for (const [key, value] of Object.entries(args)) {
                cmdWords.push(`=${key}=${value}`);
              }
              await writer.write(encodeSentence(cmdWords, encoder));
            } else if (replyType === '!trap') {
              throw new Error('MikroTik Login Failed: ' + (sentenceWords[1] || 'Invalid credentials'));
            }
          } else if (state === 'command') {
            if (replyType === '!re') {
              const row = {};
              for (let i = 1; i < sentenceWords.length; i++) {
                const word = sentenceWords[i];
                if (word.startsWith('=')) {
                  const parts = word.split('=');
                  if (parts.length >= 3) {
                    row[parts[1]] = parts.slice(2).join('=');
                  }
                }
              }
              sentences.push(row);
            } else if (replyType === '!done') {
              finished = true;
              break;
            } else if (replyType === '!trap') {
              throw new Error('MikroTik API Command Failed: ' + (sentenceWords[1] || 'Unknown error'));
            }
          }
        } else {
          break;
        }
      }
      buffer = buffer.subarray(offset);
    }
  } catch (err) {
    commandError = err;
  } finally {
    try {
      reader.releaseLock();
      writer.releaseLock();
      await socket.close();
    } catch (e) {}
  }

  if (commandError) throw commandError;
  return sentences;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Standard CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. Webhook Lynk.id Endpoint
    if (url.pathname === "/api/webhook/lynkid" && request.method === "POST") {
      try {
        const payload = await request.json();
        const email = payload.email || (payload.customer && payload.customer.email) || payload.customer_email || payload.purchaser_email;

        const db = env["lynk-webhook-receiver"] || env.M_BUDDY_KV;
        if (email && db) {
          const cleanEmail = email.toLowerCase().trim();
          await db.put(cleanEmail, "PRO");
          return new Response(JSON.stringify({ success: true, message: `Email ${cleanEmail} registered to PRO` }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ error: "Missing email payload or KV binding not configured" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "Invalid webhook payload", details: err.message }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // 2. Check Subscription status (GET)
    if (url.pathname === "/api/auth/check-subscription" && request.method === "GET") {
      const email = (url.searchParams.get("email") || "").toLowerCase().trim();
      let isSubscribed = false;
      const db = env["lynk-webhook-receiver"] || env.M_BUDDY_KV;
      if (email && db) {
        const status = await db.get(email);
        isSubscribed = (status === "PRO");
      }
      return new Response(JSON.stringify({ isSubscribed }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 3. Google Sign-In Verification (POST)
    if (url.pathname === "/api/auth/google" && request.method === "POST") {
      try {
        const payload = await request.json();
        const credential = payload.credential;
        if (!credential) {
          return new Response(JSON.stringify({ error: "Missing credential token" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const parts = credential.split('.');
        if (parts.length !== 3) {
          return new Response(JSON.stringify({ error: "Invalid token format" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const base64Url = parts[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(
          atob(base64)
            .split('')
            .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
        );

        const decoded = JSON.parse(jsonPayload);
        if (!decoded || !decoded.email) {
          return new Response(JSON.stringify({ error: "Invalid email in token" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const email = decoded.email.toLowerCase().trim();
        let isSubscribed = false;
        const db = env["lynk-webhook-receiver"] || env.M_BUDDY_KV;
        if (db) {
          const status = await db.get(email);
          isSubscribed = (status === "PRO");
        }

        return new Response(JSON.stringify({
          success: true,
          email: email,
          name: decoded.name || '',
          picture: decoded.picture || '',
          isSubscribed: isSubscribed
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: "Auth failed", details: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // 4. Serverless RouterOS TCP & REST Proxy (POST)
    if (url.pathname === "/api/proxy" && request.method === "POST") {
      try {
        const payload = await request.json();
        const targetUrl = payload.target; // e.g. "id1.mikhmon.web.id:1206"
        const endpoint = payload.endpoint;
        const username = payload.username;
        const password = payload.password;
        const method = payload.method || 'GET';
        const postData = payload.data || null;

        if (!targetUrl) {
          return new Response(JSON.stringify({ error: "Missing target URL" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const isRest = targetUrl.startsWith('http') || targetUrl.includes(':80') || targetUrl.includes(':443');

        if (isRest) {
          const cleanTarget = targetUrl.replace(/\/$/, '');
          const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
          const fullUrl = cleanTarget.startsWith('http') ? `${cleanTarget}${cleanEndpoint}` : `https://${cleanTarget}${cleanEndpoint}`;
          
          const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          };
          if (username) {
            headers['Authorization'] = `Basic ${btoa(`${username}:${password || ''}`)}`;
          }

          const fetchOptions = { method, headers };
          if (postData) {
            fetchOptions.body = JSON.stringify(postData);
          }

          const restResponse = await fetch(fullUrl, fetchOptions);
          const restJson = await restResponse.json();
          return new Response(JSON.stringify(restJson), {
            status: restResponse.status,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } else {
          // Parse Host and Port
          let host = targetUrl;
          let port = 8728;
          if (targetUrl.includes(':')) {
            const parts = targetUrl.split(':');
            host = parts[0];
            port = parseInt(parts[1]);
          }

          const result = await executeRouterOSCommand(host, port, username, password, endpoint, postData || {});
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: "Router connection failed", details: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // 5. Google Gemini Chat Proxy (POST /)
    if (request.method === "POST") {
      try {
        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "GEMINI_API_KEY environment variable is not configured" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const payload = await request.json();
        const model = payload.model || "gemini-1.5-flash";
        const contents = payload.contents || [];
        const systemInstruction = payload.systemInstruction || null;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const geminiResponse = await fetch(geminiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: contents,
            systemInstruction: systemInstruction,
          }),
        });

        const responseData = await geminiResponse.json();

        return new Response(JSON.stringify(responseData), {
          status: geminiResponse.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: "Worker Chat Proxy Error", details: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  },
};

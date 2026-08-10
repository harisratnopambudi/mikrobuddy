// Cloudflare Worker: Unified Backend for MikroBuddy AI
// Handles:
// 1. POST /api/webhook/lynkid -> Receives webhook from Lynk.id, stores paid email in Cloudflare KV.
// 2. GET  /api/auth/check-subscription -> Checks paid status of an email in Cloudflare KV.
// 3. POST /api/auth/google -> Decodes Google JWT and checks paid status in Cloudflare KV.
// 4. POST / -> Securely proxies chat request to Google Gemini API (hiding GEMINI_API_KEY).
//
// Setup Checklist in Cloudflare Dashboard:
// 1. Add Environment Variable: GEMINI_API_KEY (your Google Gemini API Key).
// 2. Create a KV Namespace named: M_BUDDY_KV and bind it to this Worker with the variable name: M_BUDDY_KV.

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

        if (email && env.M_BUDDY_KV) {
          const cleanEmail = email.toLowerCase().trim();
          // Save email to Cloudflare KV database permanently
          await env.M_BUDDY_KV.put(cleanEmail, "PRO");
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
      if (email && env.M_BUDDY_KV) {
        const status = await env.M_BUDDY_KV.get(email);
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

        // Base64 decode Google JWT token payload safely
        const parts = credential.split('.');
        if (parts.length !== 3) {
          return new Response(JSON.stringify({ error: "Invalid token format" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        // Decode Base64url to UTF-8 string
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
        if (env.M_BUDDY_KV) {
          const status = await env.M_BUDDY_KV.get(email);
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

    // 4. Default: Gemini API Chat Proxy
    // Accepts POST requests to query Gemini API securely.
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

    // Fallback response for unhandled routes
    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  },
};

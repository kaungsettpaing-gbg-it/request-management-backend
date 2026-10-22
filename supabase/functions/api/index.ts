// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

console.log("Hello from Functions!");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// This endpoint uses 'publishable' | 'secret' access, apiKey is required.
// Use publishable for Client-facing, key-validated endpoints
// Use secret for Server-to-server, internal calls
const supabaseHandler = withSupabase(
  { auth: ["publishable", "secret"] },
  async (req, ctx) => {
    // Called by another service with a secret key
    // ctx.supabaseAdmin bypasses RLS — use for privileged operations
    /*
    if (ctx.authMode === "secret") {
      const { user_id } = await req.json();
      const { data } = await ctx.supabaseAdmin.auth.admin.getUserById(user_id);

      return Response.json({
        email: data?.user?.email,
      });
    }
    */

    const { name } = await req.json();

    return Response.json({
      message: `Hello ${name}!`,
    });
  },
);

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    if (req.method === "GET") {
      return Response.json(
        {
          status: "ok",
          telegram_active: true,
          webhook_active: true,
          message: "Supabase Edge Function is running",
        },
        { headers: corsHeaders },
      );
    }

    const response = await supabaseHandler(req);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(corsHeaders)) {
      headers.set(name, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/api' \
    --header 'apiKey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
    --data '{"name":"Functions"}'

*/
// Telegram ထံမှ ဝင်လာသော Data ကို လက်ခံခြင်း
const update = await req.json();

if (update.message) {
  const chatId = update.message.chat.id;
  const text = update.message.text;

  // Bot ကနေ စာပြန်ပို့ရန် Telegram API သို့ fetch လုပ်ခြင်း
  const botToken = "8535213758:AAEv0He3IUAKAPMtEHq8n7Ts3W8LQF9YSDA";
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `Hello! You said: ${text}` // ကိုယ်ပြန်ချင်တဲ့ စာသား
    }),
  });
}
import "@supabase/functions-js/edge-runtime.d.ts";

const BOT_TOKEN = "8535213758:AAEv0He3IUAKAPMtEHq8n7Ts3W8LQF9YSDA";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Telegram သို့ စာပြန်ပို့ပေးသော Helper Function
async function sendTelegramMessage(chatId: number | string, text: string) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error("Error sending message to Telegram:", err);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  // CORS Preflight Request များအတွက်
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // GET Request (Health Check/Status Check)
  if (req.method === "GET") {
    return Response.json(
      {
        ok: true,
        status: "ok",
        telegram_active: true,
        webhook_active: true,
        message: "Supabase Edge Function is running",
      },
      { headers: corsHeaders, status: 200 }
    );
  }

  // POST Request များအတွက်
  if (req.method === "POST") {
    try {
      const update = await req.json();
      console.log("Incoming Telegram Update:", JSON.stringify(update));

      // Dashboard သို့မဟုတ် System ရဲ့ Health check / ping test ဝင်လာပါက
      if (update && update.action === "ping") {
        return Response.json({ ok: true, webhook_active: true }, { headers: corsHeaders, status: 200 });
      }

      // ၁။ Message ဝင်လာပါက
      if (update && update.message && update.message.chat) {
        const chatId = update.message.chat.id;
        const text = update.message.text || "";

        if (text === "/start") {
          await sendTelegramMessage(chatId, "မင်္ဂလာပါ! Bot က အောင်မြင်စွာ အလုပ်လုပ်နေပါပြီ။");
        } else {
          await sendTelegramMessage(chatId, `သင်ပို့လိုက်သော စာတို: "${text}" ကို လက်ခံရရှိပါသည်။`);
        }
      }

      // ၂။ Inline Keyboard Button နှိပ်လိုက်ပါက
      if (update && update.callback_query && update.callback_query.message) {
        const chatId = update.callback_query.message.chat.id;
        const callbackData = update.callback_query.data;

        await sendTelegramMessage(chatId, `Button နှိပ်လိုက်သော Data: ${callbackData}`);
      }

      // အမြဲတမ်း 200 OK Response ပြန်ပေးရန်
      return Response.json({ ok: true, status: "success" }, { headers: corsHeaders, status: 200 });

    } catch (error: any) {
      console.error("Webhook Handling Error:", error);
      return Response.json({ ok: true, error: error.message }, { headers: corsHeaders, status: 200 });
    }
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
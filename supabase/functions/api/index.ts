// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";

const BOT_TOKEN = "8535213758:AAEv0He3IUAKAPMtEHq8n7Ts3W8LQF9YSDA";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};


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
  
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  )
  if (req.method === "GET") {
    return Response.json(
      {
        status: "ok",
        telegram_active: true,
        webhook_active: true,
        message: "Supabase Edge Function is running",
      },
      { headers: corsHeaders }
    );
  }

  
  if (req.method === "POST") {
    try {
      const update = await req.json();
      console.log("Incoming Telegram Update:", JSON.stringify(update));

      
      if (update.message) {
        const chatId = update.message.chat.id;
        const text = update.message.text || "";

        if (text === "/start") {
          await sendTelegramMessage(chatId, "မင်္ဂလာပါ! မဂ်လာပါ ပို့ပေးလို့ ကျေးဇူးတင်ပါတယ်။ Bot က အလုပ်လုပ်နေပါပြီ။");
        } else {
          await sendTelegramMessage(chatId, `သင်ပို့လိုက်သော စာတို: "${text}" ကို လက်ခံရရှိပါသည်။`);
        }
      }

      
      if (update.callback_query) {
        const chatId = update.callback_query.message.chat.id;
        const callbackData = update.callback_query.data;

        await sendTelegramMessage(chatId, `Button နှိပ်လိုက်သော Data: ${callbackData}`);
      }

      
      return Response.json({ status: "success" }, { headers: corsHeaders, status: 200 });

    } catch (error) {
      console.error("Webhook Handling Error:", error);
    
      return Response.json({ error: error.message }, { headers: corsHeaders, status: 200 });
    }
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
});
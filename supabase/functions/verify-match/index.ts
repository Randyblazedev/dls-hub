// Supabase Edge Function: verify-match
// AI scans the DLS screenshot, detects the winner from the team names

import { createClient } from "jsr:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const groqKey = Deno.env.get("GROQ_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const {
      matchId,
      screenshotUrl,
      playerOneName,
      playerTwoName,
      proposedWinnerName,
      player1Score,
      player2Score,
      winnerId,
      winnerName,
    } = await req.json();

    if (!matchId || !screenshotUrl) return json({ error: "matchId and screenshotUrl required" }, 400);

    const prompt = `You verify a football match result (DLS - Dream League Soccer).
Two teams played: "${playerOneName}" and "${playerTwoName}".
The screenshot is the post-match result screen; the winning team's name is on it.
Detect which of the two team names is the winner.
Reply ONLY with JSON: {"winner": "<exact team name>", "score": "<full score text>", "confidence": <0-100>}`;

    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: "llama-3.2-11b-vision-preview",
        max_tokens: 256,
        messages: [
          { role: "user", content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: screenshotUrl } },
          ]},
        ],
      }),
    });

    if (!resp.ok) return json({ error: "AI verification request failed" }, 502);

    const data = await resp.json();
    const parsed = extractJson(data.choices[0].message.content) as any;

    const aiWinner = parsed.winner?.trim().toLowerCase() || "";
    const proposed = proposedWinnerName?.trim().toLowerCase() || "";
    const confidence = Number(parsed.confidence) || 0;
    const verified = aiWinner === proposed && confidence >= 80;

    const supabase = createClient(supabaseUrl, supabaseKey);

    const update: Record<string, unknown> = {
      ai_detected_winner: parsed.winner,
      ai_detected_score: parsed.score,
      ai_confidence: confidence,
      ai_verified_at: new Date().toISOString(),
      verification_status: verified ? "locked" : "pending",
    };

    if (verified) {
      update.status = "completed";
      update.winner_id = winnerId;
      update.winner_name = winnerName;
      update.player1_score = player1Score;
      update.player2_score = player2Score;
      update.screenshot_url = screenshotUrl;
    }

    const { error } = await supabase.from("tournament_matches").update(update).eq("id", matchId);
    if (error) return json({ error: error.message }, 500);

    return json({ verified, aiWinner: parsed.winner, confidence });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Groq sometimes wraps JSON in markdown fences or adds prose — extract it robustly
function extractJson(text: string): Record<string, unknown> {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error("AI did not return valid JSON");
}

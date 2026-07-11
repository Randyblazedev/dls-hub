import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VAPID_PUBLIC  = "BN4ZD0qVkYRGfBtd8Q_XfaOEQMZCXuoGJoAurglpPf9AqfVaEx2heaAzbNY_CeOOJgdGRheVyogE7mLXsBtFtbA";
const VAPID_PRIVATE = "5ZzbegOimxkTKv0xxGQgSjKaQznSyaCVvONFWqJrKX8";
const VAPID_SUBJECT = "mailto:asonganyirandy143@gmail.com";

// Base64url helpers
const b64url = (buf: Uint8Array) =>
  btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const fromB64url = (str: string) =>
  Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

async function getVapidHeaders(endpoint: string) {
  const url     = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const exp      = Math.floor(Date.now() / 1000) + 12 * 3600;

  const header  = b64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ aud: audience, exp, sub: VAPID_SUBJECT })));
  const sigInput = `${header}.${payload}`;

  const privKey = await crypto.subtle.importKey(
    "pkcs8",
    (() => {
      // Wrap raw private key bytes into PKCS8 envelope
      const raw = fromB64url(VAPID_PRIVATE);
      const hdr = new Uint8Array([0x30,0x41,0x02,0x01,0x00,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x04,0x27,0x30,0x25,0x02,0x01,0x01,0x04,0x20]);
      const out = new Uint8Array(hdr.length + raw.length);
      out.set(hdr); out.set(raw, hdr.length);
      return out.buffer;
    })(),
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"]
  );

  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privKey,
    new TextEncoder().encode(sigInput)
  ));

  const jwt = `${sigInput}.${b64url(sig)}`;
  return {
    Authorization: `vapid t=${jwt},k=${VAPID_PUBLIC}`,
    "Content-Type": "application/octet-stream",
    TTL: "86400",
  };
}

serve(async (req) => {
  const { userid, title, body, url, icon } = await req.json();
  if (!userid || !title) return new Response("Missing params", { status: 400 });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("*")
    .eq("userid", userid);

  if (!subs?.length) return new Response("No subscriptions", { status: 200 });

  const payload = JSON.stringify({ title, body, url: url || "/", icon: icon || "/public/icons/icon-192.png" });

  const results = await Promise.allSettled(subs.map(async (sub) => {
    const headers = await getVapidHeaders(sub.endpoint);
    // Encrypt payload using Web Push encryption
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers,
      body: payload,
    });
    if (res.status === 410 || res.status === 404) {
      // Subscription expired — remove it
      await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    }
    return res.status;
  }));

  return new Response(JSON.stringify({ sent: results.length }), {
    headers: { "Content-Type": "application/json" }
  });
});

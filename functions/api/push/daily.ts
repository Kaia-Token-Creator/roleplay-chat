export const onRequestPost: PagesFunction<{
  ONESIGNAL_APP_ID: string;
  ONESIGNAL_REST_API_KEY: string;
}> = async ({ request, env }) => {
  // (선택) 외부에서 아무나 호출 못 하게 간단 토큰 보호
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${env.CRON_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = {
    app_id: env.ONESIGNAL_APP_ID,
    included_segments: ["Subscribed Users"],
    target_channel: "push",
    headings: { en: "roleplay-chat" },
    contents: { en: "Your character is here whenever you are 💬" },
    url: "https://roleplay-chat.com/",
  };

  const res = await fetch("https://api.onesignal.com/notifications?c=push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${env.ONESIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  return new Response(text, { status: res.status, headers: { "Content-Type": "application/json" } });
};
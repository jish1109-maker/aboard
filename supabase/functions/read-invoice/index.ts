// 인보이스 파일(PDF·이미지·엑셀에서 뽑은 텍스트)을 Claude로 읽어 입력 초안을 돌려준다.
// 필요한 비밀값: ANTHROPIC_API_KEY (Supabase 대시보드 → Edge Functions → Secrets)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk/helpers/zod";
import { z } from "npm:zod@3";

const COMPANY_DOMAIN = "@interohrigin.com";
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const InvoiceDraft = z.object({
  invoice_date: z.string().describe("인보이스 발행일 YYYY-MM-DD. 모르면 빈 문자열"),
  invoice_no: z.string().describe("인보이스 번호. 모르면 빈 문자열"),
  country: z.string().describe("바이어(수입자) 국가의 한국어 이름. 예: 미국, 일본, 중국"),
  buyer: z.string().describe("바이어(수입자) 회사명. 원문 표기 유지"),
  brand: z.string().describe("주요 브랜드명. 알려진 브랜드 목록에 있으면 그 표기 그대로"),
  channel: z.string().describe("판매 채널. 알려진 채널 목록에서 고르고, 일반 수출 인보이스면 B2B"),
  qty: z.number().nullable().describe("총 수량(품목 수량 합계). 모르면 null"),
  currency: z.string().describe("통화 ISO 코드. 예: USD, JPY, KRW"),
  amount_foreign: z.number().nullable().describe("인보이스 총액(해당 통화 기준). 모르면 null"),
  source_language: z.string().describe("인보이스 원문 언어의 한국어 이름. 예: 영어, 일본어"),
  notes: z.string().describe("한국어 2~3문장: 읽은 내용 요약과 불확실한 항목(사람이 확인해야 할 부분)"),
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // 회사 메일 계정만 사용
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user?.email?.toLowerCase().endsWith(COMPANY_DOMAIN)) return json({ error: "회사 메일 계정만 사용할 수 있습니다." }, 403);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다. 관리자에게 문의하세요." }, 500);

  const { file_base64, media_type, text, file_name, known } = await req.json();
  const content: Anthropic.ContentBlockParam[] = [];
  if (media_type === "application/pdf" && file_base64) {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: file_base64 } });
  } else if (IMAGE_TYPES.includes(media_type) && file_base64) {
    content.push({ type: "image", source: { type: "base64", media_type, data: file_base64 } });
  } else if (typeof text === "string" && text.trim()) {
    content.push({ type: "text", text: `<invoice_sheet file="${file_name ?? ""}">\n${text.slice(0, 200000)}\n</invoice_sheet>` });
  } else {
    return json({ error: "PDF·이미지(JPG·PNG·GIF·WEBP) 또는 엑셀 내용을 보내 주세요." }, 400);
  }
  const lists = known ?? {};
  content.push({
    type: "text",
    text:
      "위 파일은 해외 수출 인보이스입니다. 어떤 언어로 되어 있든 내용을 해석해 매출 입력 초안을 만들어 주세요.\n" +
      `알려진 국가: ${(lists.country ?? []).join(", ") || "없음"}\n` +
      `알려진 채널: ${(lists.channel ?? []).join(", ") || "없음"}\n` +
      `알려진 브랜드: ${(lists.brand ?? []).join(", ") || "없음"}\n` +
      `알려진 바이어: ${(lists.buyer ?? []).join(", ") || "없음"}\n` +
      "목록에 같은 대상이 있으면 목록의 표기를 그대로 쓰세요. 문서에 없는 값은 지어내지 말고 빈 문자열이나 null로 두고, notes에 확인이 필요하다고 적으세요.",
  });

  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(InvoiceDraft) },
      messages: [{ role: "user", content }],
    });
    if (res.stop_reason === "refusal") return json({ error: "이 파일은 읽을 수 없습니다." }, 422);
    if (!res.parsed_output) return json({ error: "인보이스 내용을 해석하지 못했습니다." }, 422);
    return json({ draft: res.parsed_output });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "요청이 많습니다. 잠시 후 다시 시도하세요." }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: `AI 호출 실패 (${e.status ?? "-"})` }, 502);
    return json({ error: "처리 중 오류: " + (e as Error).message }, 500);
  }
});

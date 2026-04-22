import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../index.ts";

export async function handleSignup(
  req: Request,
  supabase: SupabaseClient,
): Promise<Response> {
  const { email, password, hcaptchaToken, redirectTo } = await req.json();

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      captchaToken: hcaptchaToken ?? undefined,
      emailRedirectTo: redirectTo ?? undefined,
    },
  });

  if (error) {
    return Response.json({ message: error.message }, {
      status: error.status ?? 400,
      headers: corsHeaders,
    });
  }

  return new Response(null, { status: 201, headers: corsHeaders });
}

export async function handleResetPassword(
  req: Request,
  supabase: SupabaseClient,
): Promise<Response> {
  const { email, hcaptchaToken, redirectTo } = await req.json();

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    captchaToken: hcaptchaToken ?? undefined,
    redirectTo: redirectTo ?? undefined,
  });

  if (error) {
    return Response.json({ message: error.message }, {
      status: error.status ?? 400,
      headers: corsHeaders,
    });
  }

  return Response.json({}, { headers: corsHeaders });
}

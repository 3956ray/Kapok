import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Principal } from "../lib/contracts";
import { safeReturnTo } from "../lib/server/domain";
import { actorKey } from "../lib/server/identity";
import { authMode, scopedPrincipal } from "../lib/server/request-identity";

export { authMode };

export type ChatGPTUser = {
  userId: string;
  principal: Principal;
  displayName: string;
  email: string;
  fullName: string | null;
};

const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";
const SIGN_IN_PATH = "/signin-with-chatgpt";
const SIGN_OUT_PATH = "/signout-with-chatgpt";

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const principal = scopedPrincipal(requestHeaders);
  if (!principal) return null;
  const userId = await actorKey(principal);
  if (principal.provider === 'access') {
    const email = principal.verifiedEmail;
    return { userId, principal, displayName: email, email, fullName: null };
  }

  const email = requestHeaders.get(USER_EMAIL_HEADER)!;
  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const fullName =
    encodedFullName &&
    requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
      ? safeDecodeURIComponent(encodedFullName)
      : null;

  return {
    userId,
    principal,
    displayName: fullName ?? email,
    email,
    fullName,
  };
}

export async function requireChatGPTUser(
  returnTo: string,
): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;

  redirect(chatGPTSignInPath(returnTo));
}

export function chatGPTSignInPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return authMode() === 'site' ? `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo)}` : safeReturnTo;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return authMode() === 'site' ? `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeReturnTo)}` : '/cdn-cgi/access/logout';
}

function safeRelativeReturnPath(value: string): string {
  return safeReturnTo(value);
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

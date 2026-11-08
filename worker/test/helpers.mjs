// Test helpers: throwaway RSA keys and signed Access-style JWTs.
// These keys exist only in memory during the tests; production trusts only
// the keys published by Cloudflare for the team domain.

export const TEAM = "test-team.cloudflareaccess.com";
export const ISSUER = `https://${TEAM}`;
export const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;
export const AUD = "a".repeat(64);
export const ADMIN = "admin@example.com";
export const SITE = "https://library.mh-ibrahim.com";

export const config = { teamDomain: TEAM, audience: AUD, adminEmail: ADMIN, issuer: ISSUER };

const encoder = new TextEncoder();
export const b64url = (data) =>
  Buffer.from(typeof data === "string" ? encoder.encode(data) : data).toString("base64url");

export async function createSigningKey(kid) {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const { n, e } = await crypto.subtle.exportKey("jwk", publicKey);
  return { kid, privateKey, jwk: { kid, kty: "RSA", alg: "RS256", use: "sig", n, e } };
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Claims of a valid admin token, overridable per test. */
export const validClaims = (overrides = {}) => ({
  aud: [AUD],
  email: ADMIN,
  exp: nowSeconds() + 3600,
  iat: nowSeconds() - 10,
  nbf: nowSeconds() - 10,
  iss: ISSUER,
  type: "app",
  sub: "00000000-0000-0000-0000-000000000000",
  ...overrides,
});

/** A JWT signed with `key` (RS256 unless the header says otherwise). */
export async function signToken(claims, key, headerOverrides = {}) {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...headerOverrides }));
  const payload = b64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

/** A fake key fetcher that counts calls. */
export function keyFetcher(...keys) {
  const fetcher = async () => {
    fetcher.calls += 1;
    if (fetcher.fail) throw new Error("network down");
    return fetcher.jwks;
  };
  fetcher.calls = 0;
  fetcher.fail = false;
  fetcher.jwks = keys.map((key) => key.jwk);
  return fetcher;
}

/**
 * Source-address allowlist (IPv4 and IPv6 CIDR ranges) for the endpoints only
 * Claude's servers call: /mcp and /token (MCP requests, authorization-code
 * exchange, refresh, revocation). Claude.ai connects from Anthropic's published
 * outbound ranges (https://platform.claude.com/docs/en/api/ip-addresses:
 * 160.79.104.0/21 and 153.61.208.0/20, IPv4 only). This is defence in depth;
 * OAuth is the authentication.
 *
 * ALLOWED_CLIENT_CIDRS: comma-separated ranges, or "*" to switch the check off
 * explicitly (local development). Missing or invalid -> nothing is allowed.
 */

function parseIPv4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = (value << 8n) | BigInt(part);
  }
  return { version: 4, value, bits: 32 };
}

function parseIPv6(text) {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || text.split("::").length > 2) return null;
  let [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const groups = (part) => (part ? part.split(":") : []);
  let left = groups(head);
  let right = tail === undefined ? [] : groups(tail);
  // An embedded IPv4 address at the end (e.g. ::ffff:1.2.3.4) counts as two groups.
  const last = (tail === undefined ? left : right).at(-1);
  if (last?.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    const words = [Number(v4.value >> 16n).toString(16), Number(v4.value & 0xffffn).toString(16)];
    if (tail === undefined) left = [...left.slice(0, -1), ...words];
    else right = [...right.slice(0, -1), ...words];
  }
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const all = [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right];
  let value = 0n;
  for (const group of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return { version: 6, value, bits: 128 };
}

export function parseIp(text) {
  const value = String(text ?? "").trim();
  return value.includes(":") ? parseIPv6(value) : parseIPv4(value);
}

/** Parsed ranges, or null when the setting is "*" (check disabled). Invalid entries are dropped. */
export function parseCidrs(setting) {
  const text = String(setting ?? "").trim();
  if (text === "*") return null;
  const ranges = [];
  for (const entry of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [address, prefixText] = entry.split("/");
    const ip = parseIp(address);
    if (!ip || !/^\d{1,3}$/.test(prefixText ?? "")) continue;
    const prefix = Number(prefixText);
    if (prefix > ip.bits) continue;
    const shift = BigInt(ip.bits - prefix);
    ranges.push({ version: ip.version, network: ip.value >> shift, shift });
  }
  return ranges;
}

/** true when the address is inside one of the ranges (ranges === null: check disabled). */
export function ipAllowed(address, ranges) {
  if (ranges === null) return true;
  const ip = parseIp(address);
  if (!ip) return false;
  return ranges.some((r) => r.version === ip.version && ip.value >> r.shift === r.network);
}

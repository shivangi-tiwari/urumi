import { promises as dns } from "node:dns";
import { isIP } from "node:net";

const allowlistedHosts = new Set(
  (process.env.SSRF_ALLOWED_HOSTS ?? "")
    .split(",")
    .map(normalizeHostname)
    .filter(Boolean),
);

const blockedIpv4Ranges: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export class UnsafeServerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeServerUrlError";
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function ipv4ToNumber(address: string): number {
  return address.split(".").reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function isInIpv4Range(address: string, network: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(network) & mask);
}

function isUnsafeIpv4(address: string): boolean {
  return blockedIpv4Ranges.some(([network, prefix]) => isInIpv4Range(address, network, prefix));
}

function ipv6ToBigInt(address: string): bigint | undefined {
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    if (separator === -1) return undefined;
    const ipv4 = normalized.slice(separator + 1);
    if (isIP(ipv4) !== 4) return undefined;
    const octets = ipv4.split(".").map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, separator)}:${high}:${low}`;
  }

  const sections = normalized.split("::");
  if (sections.length > 2) return undefined;
  const left = sections[0] ? sections[0].split(":") : [];
  const right = sections.length === 2 && sections[1] ? sections[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((sections.length === 1 && missing !== 0) || (sections.length === 2 && missing < 1)) return undefined;

  const groups = [...left, ...Array(sections.length === 2 ? missing : 0).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function isInIpv6Range(address: bigint, network: bigint, prefix: number): boolean {
  return (address >> BigInt(128 - prefix)) === (network >> BigInt(128 - prefix));
}

function isUnsafeIpv6(address: string): boolean {
  const value = ipv6ToBigInt(address);
  if (value === undefined) return true;

  const globalUnicast = 0x20000000000000000000000000000000n;
  const documentation = 0x20010db8000000000000000000000000n;
  const teredo = 0x20010000000000000000000000000000n;
  const sixToFour = 0x20020000000000000000000000000000n;

  return !isInIpv6Range(value, globalUnicast, 3) ||
    isInIpv6Range(value, documentation, 32) ||
    isInIpv6Range(value, teredo, 32) ||
    isInIpv6Range(value, sixToFour, 16);
}

function isUnsafeAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isUnsafeIpv4(address);
  if (version === 6) return isUnsafeIpv6(address);
  return true;
}

export async function assertSafeServerUrl(value: string): Promise<void> {
  const url = new URL(value);
  const hostname = normalizeHostname(url.hostname);
  if (allowlistedHosts.has(hostname)) return;

  const version = isIP(hostname);
  let addresses: string[];
  if (version) {
    addresses = [hostname];
  } else {
    try {
      addresses = (await dns.lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
    } catch {
      throw new UnsafeServerUrlError(
        `Server hostname "${hostname}" could not be resolved; verify the hostname or add an exact in-cluster service hostname to SSRF_ALLOWED_HOSTS.`,
      );
    }
  }

  if (addresses.length === 0) {
    throw new UnsafeServerUrlError(`Server hostname "${hostname}" resolved to no IP addresses.`);
  }
  if (addresses.some(isUnsafeAddress)) {
    throw new UnsafeServerUrlError(
      `Server hostname "${hostname}" resolves to a loopback, private, link-local, or reserved IP address and is not allowed.`,
    );
  }
}

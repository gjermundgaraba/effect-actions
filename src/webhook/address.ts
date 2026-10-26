import { Effect, Result } from "effect";
import type { Dns } from "effect/net";
import { Host, IpNetwork, NetAddress } from "effect/net";

// Why: The ranges of IANA's IPv4 and IPv6 special-purpose registries that are not globally
// reachable, as SEP-3415 asks a server to refuse: private, loopback, link-local, shared (CGNAT),
// benchmarking, documentation, reserved, multicast, and IPv6's mapped form of IPv4. NAT64's
// `64:ff9b::/96` is refused too, since the IPv4 address it embeds may be private: an IPv6-only
// server behind NAT64 cannot deliver to an IPv4-only callback, a gotcha on `Webhook.layer`.
const notGlobal = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/127",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
].map(IpNetwork.fromStringUnsafe);

/** Whether `address` is globally reachable, in no special-purpose range. */
const isGlobal = (address: NetAddress.IpAddress): boolean =>
  !notGlobal.some((network) => IpNetwork.contains(network, address));

/**
 * Checks the host of `url`, failing unless every address it names is globally reachable: a
 * literal address is checked as it is, a name through `dns`, or passed where there is none, and a
 * scoped IPv6 literal refused.
 */
export const checkedHost = (
  url: URL,
  dns: Dns.Dns["Service"] | undefined,
): Effect.Effect<void, void> => {
  const host = Result.getOrUndefined(
    Host.hostFromString(url.hostname.replace(/^\[(.*)\]$/u, "$1")),
  );

  const addresses: Effect.Effect<
    ReadonlyArray<NetAddress.IpAddress>,
    unknown
  > = NetAddress.isIpAddress(host)
    ? Effect.succeed([host])
    : Host.isDomainName(host)
      ? dns === undefined
        ? Effect.succeed([])
        : dns.lookup(host)
      : Effect.fail(undefined);

  return Effect.flatMap(
    Effect.mapError(addresses, () => undefined),
    (resolved) => (resolved.every(isGlobal) ? Effect.void : Effect.fail(undefined)),
  );
};

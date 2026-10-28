import { Effect, Function, Result } from "effect";
import type { Dns } from "effect/net";
import { Host, IpNetwork, NetAddress } from "effect/net";

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

const isGlobal = (address: NetAddress.IpAddress): boolean =>
  !notGlobal.some((network) => IpNetwork.contains(network, address));

export const checkedHost = (
  url: URL,
  dns: Dns.Dns["Service"] | undefined
): Effect.Effect<void, void> => {
  const host = Result.getOrUndefined(
    Host.hostFromString(
      url.hostname.replace(/^\[(?<address>.*)\]$/u, "$<address>")
    )
  );

  if (NetAddress.isIpAddress(host)) {
    return isGlobal(host) ? Effect.void : Effect.fail(undefined);
  }

  if (!Host.isDomainName(host)) {
    return Effect.fail(undefined);
  }

  if (dns === undefined) {
    return Effect.void;
  }

  return Effect.flatMap(
    Effect.mapError(dns.lookup(host), Function.constUndefined),
    (resolved) =>
      resolved.every(isGlobal) ? Effect.void : Effect.fail(undefined)
  );
};

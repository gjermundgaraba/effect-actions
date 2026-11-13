interface Received {
  readonly url: string;
  readonly at: number;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const received: Received[] = [];

const answers = new Map<string, { status: number; times: number }>();

const challengeOf = (body: string) =>
  /"type":"verification"/u.test(body)
    ? /"challenge":"(?<challenge>[^"]+)"/u.exec(body)?.groups?.challenge
    : undefined;

const control = (url: URL) => {
  if (url.pathname === "/received") {
    return Response.json(received);
  }

  if (url.pathname === "/answer") {
    answers.set(url.searchParams.get("path") ?? "", {
      status: Number(url.searchParams.get("status") ?? "200"),
      times: Number(url.searchParams.get("times") ?? "Infinity"),
    });

    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 404 });
};

const receiverHost = "receiver.test";

export const receiver = async (request: Request) => {
  const url = new URL(request.url);

  if (url.host === receiverHost) {
    return control(url);
  }

  const body = await request.text();
  const challenge = challengeOf(body);
  const answering = answers.get(url.pathname);

  const status =
    challenge === undefined && answering !== undefined && answering.times > 0
      ? answering.status
      : 200;

  if (challenge === undefined && answering !== undefined) {
    answering.times -= 1;
  }

  received.push({
    url: request.url,
    at: Date.now(),
    status,
    headers: Object.fromEntries(request.headers),
    body,
  });

  return challenge === undefined
    ? new Response(null, { status })
    : Response.json({ challenge });
};

import { Tracer } from "effect";

export const recordSpans = () => {
  const spans: Tracer.Span[] = [];

  const tracer = Tracer.make({
    span(options) {
      const span = Tracer.nativeTracer.span(options);
      spans.push(span);

      return span;
    },
  });

  const named = (name: string): Tracer.Span | undefined =>
    spans.findLast((span) => span.name === name);

  return { named, spans, tracer };
};

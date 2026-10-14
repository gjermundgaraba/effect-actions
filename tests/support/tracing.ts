import { Tracer } from "effect";

export const recordSpans = () => {
  const spans = new Map<string, Tracer.Span>();

  const tracer = Tracer.make({
    span(options) {
      const span = Tracer.nativeTracer.span(options);
      spans.set(options.name, span);

      return span;
    },
  });

  return { spans, tracer };
};

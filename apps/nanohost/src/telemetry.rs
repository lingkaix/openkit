//! Optional, content-free local observations and W3C native effect carriage.

use opentelemetry::propagation::{Extractor, Injector, TextMapPropagator};
use opentelemetry::trace::{Link, SpanContext, Status, TraceContextExt, Tracer};
use opentelemetry::{Context, KeyValue, global};
use opentelemetry_sdk::propagation::TraceContextPropagator;

/// One bounded local operation; early returns close it with a safe failure status.
pub(crate) struct Observation {
    context: Context,
    finished: bool,
}

impl Observation {
    /// Starts a fixed-name observation with only caller-allowlisted attributes.
    pub(crate) fn start(
        name: &'static str,
        parent: &Context,
        attributes: Vec<KeyValue>,
        startup: Option<&SpanContext>,
    ) -> Self {
        let tracer = global::tracer("nanohost");
        let mut builder = tracer.span_builder(name).with_attributes(attributes);
        if let Some(startup) = startup.filter(|context| context.is_valid()) {
            builder = builder.with_links(vec![Link::new(startup.clone(), Vec::new(), 0)]);
        }
        Self {
            context: parent.with_span(tracer.build_with_context(builder, parent)),
            finished: false,
        }
    }

    /// Returns a context that can outlive the ended observation for result delivery.
    pub(crate) fn context(&self) -> Context {
        self.context.clone()
    }

    /// Ends at the local result, without waiting for transport or Core acceptance.
    pub(crate) fn finish(&mut self, succeeded: bool) {
        if self.finished {
            return;
        }
        let span = self.context.span();
        span.set_attribute(KeyValue::new(
            "openkit.outcome",
            if succeeded { "success" } else { "failure" },
        ));
        span.set_status(if succeeded {
            Status::Ok
        } else {
            Status::error("local operation failed")
        });
        span.end();
        self.finished = true;
    }
}

impl Drop for Observation {
    fn drop(&mut self) {
        self.finish(false);
    }
}

/// Adapts only stock W3C trace fields, never arbitrary native metadata or baggage.
struct TraceHeaders<'a>(&'a http::HeaderMap);

impl Extractor for TraceHeaders<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key)?.to_str().ok()
    }

    fn keys(&self) -> Vec<&str> {
        vec!["traceparent", "tracestate"]
    }
}

/// Writes only the fields emitted by the stock W3C trace-context propagator.
struct TraceHeadersMut<'a>(&'a mut http::HeaderMap);

impl Injector for TraceHeadersMut<'_> {
    fn set(&mut self, key: &str, value: String) {
        if let (Ok(name), Ok(value)) = (
            http::header::HeaderName::from_bytes(key.as_bytes()),
            http::HeaderValue::from_str(&value),
        ) {
            self.0.insert(name, value);
        }
    }
}

/// Extracts from an empty base so a poll cannot supply unrelated ambient parentage.
pub(crate) fn extract(headers: &http::HeaderMap) -> Context {
    TraceContextPropagator::new().extract_with_context(&Context::new(), &TraceHeaders(headers))
}

/// Injects diagnostic context without changing the command/result body or identity.
pub(crate) fn inject(context: &Context, headers: &mut http::HeaderMap) {
    TraceContextPropagator::new().inject_context(context, &mut TraceHeadersMut(headers));
}

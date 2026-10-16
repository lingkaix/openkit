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
            // Startup precedes the command; one link preserves that direction.
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
    pub(crate) fn finish(&mut self, returned: bool) {
        if self.finished {
            return;
        }
        let span = self.context.span();
        span.set_attribute(KeyValue::new(
            "openkit.outcome",
            if returned { "returned" } else { "failure" },
        ));
        // A returned value can describe a refusal or a non-ready observation.
        if !returned {
            span.set_status(Status::error("local operation failed"));
        }
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

/// Reads only the existing standard exporter controls at normal service entry.
pub(crate) fn initialize() -> Option<opentelemetry_sdk::trace::SdkTracerProvider> {
    let environment = [
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_SDK_DISABLED",
        "OTEL_EXPORTER_OTLP_HEADERS",
        "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    ]
    .into_iter()
    .filter_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| (name.to_string(), value))
    })
    .collect();
    let endpoint = match export_endpoint(&environment) {
        Ok(Some(endpoint)) => endpoint,
        Ok(None) => return None,
        Err(()) => {
            eprintln!("nanohost telemetry configuration unsupported; export disabled");
            return None;
        }
    };
    match provider_for_endpoint(&endpoint) {
        Ok(provider) => {
            global::set_tracer_provider(provider.clone());
            Some(provider)
        }
        Err(_) => {
            eprintln!("nanohost telemetry export could not start; service continues");
            None
        }
    }
}

/// Validates the standard base endpoint before the stock exporter can consume it.
fn export_endpoint(
    environment: &std::collections::BTreeMap<String, String>,
) -> Result<Option<String>, ()> {
    if environment
        .get("OTEL_SDK_DISABLED")
        .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        return Ok(None);
    }
    let Some(endpoint) = environment
        .get("OTEL_EXPORTER_OTLP_ENDPOINT")
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(None);
    };
    if [
        "OTEL_EXPORTER_OTLP_HEADERS",
        "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    ]
    .iter()
    .any(|name| {
        environment
            .get(*name)
            .is_some_and(|value| !value.trim().is_empty())
    }) {
        return Err(());
    }
    let mut endpoint = reqwest::Url::parse(endpoint).map_err(|_| ())?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(());
    }
    endpoint.set_path(&format!(
        "{}/v1/traces",
        endpoint.path().trim_end_matches('/')
    ));
    Ok(Some(endpoint.to_string()))
}

/// Builds the stock bounded in-memory pipeline with no ambient resource capture.
fn provider_for_endpoint(
    endpoint: &str,
) -> Result<opentelemetry_sdk::trace::SdkTracerProvider, opentelemetry_otlp::ExporterBuildError> {
    use opentelemetry_otlp::{Protocol, RetryPolicy, WithExportConfig, WithHttpConfig};
    use opentelemetry_sdk::trace::{
        BatchConfigBuilder, BatchSpanProcessor, IdGenerator, RandomIdGenerator, SdkTracerProvider,
    };
    use std::time::Duration;

    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_endpoint(endpoint)
        .with_protocol(Protocol::HttpBinary)
        .with_timeout(Duration::from_secs(1))
        .with_retry_policy(RetryPolicy::disabled())
        .build()?;
    let processor = BatchSpanProcessor::builder(exporter)
        .with_batch_config(
            BatchConfigBuilder::default()
                .with_max_queue_size(512)
                .with_max_export_batch_size(128)
                .build(),
        )
        .build();
    let mut resource = opentelemetry_sdk::Resource::builder_empty()
        .with_service_name("nanohost")
        .with_attribute(KeyValue::new("service.version", env!("CARGO_PKG_VERSION")))
        .with_attribute(KeyValue::new(
            "service.instance.id",
            RandomIdGenerator::default().new_trace_id().to_string(),
        ));
    if cfg!(test) {
        resource = resource.with_attribute(KeyValue::new("deployment.environment.name", "test"));
    }
    Ok(SdkTracerProvider::builder()
        .with_resource(resource.build())
        .with_span_processor(processor)
        .build())
}

/// Starts a bounded best-effort flush without extending any product shutdown bound.
pub(crate) fn shutdown(provider: Option<opentelemetry_sdk::trace::SdkTracerProvider>) {
    if let Some(provider) = provider {
        let _ = std::thread::Builder::new()
            .name("nanohost-telemetry-shutdown".into())
            .spawn(move || {
                let _ = provider.shutdown_with_timeout(std::time::Duration::from_secs(1));
            });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn exporter_configuration_is_explicit_and_content_free() {
        assert_eq!(export_endpoint(&BTreeMap::new()), Ok(None));
        for endpoint in [
            "bad",
            "file:///tmp/collector",
            "http://user:secret@localhost:4318",
            "http://localhost:4318?q=secret",
            "http://localhost:4318#secret",
        ] {
            assert_eq!(
                export_endpoint(&BTreeMap::from([(
                    "OTEL_EXPORTER_OTLP_ENDPOINT".into(),
                    endpoint.into()
                )])),
                Err(())
            );
        }
        let mut environment = BTreeMap::from([(
            "OTEL_EXPORTER_OTLP_ENDPOINT".into(),
            "http://localhost:4318/base/".into(),
        )]);
        assert_eq!(
            export_endpoint(&environment),
            Ok(Some("http://localhost:4318/base/v1/traces".into()))
        );
        for name in [
            "OTEL_EXPORTER_OTLP_HEADERS",
            "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
        ] {
            environment.insert(name.into(), "key=secret".into());
            assert_eq!(export_endpoint(&environment), Err(()));
            environment.remove(name);
        }
        environment.insert("OTEL_SDK_DISABLED".into(), "TRUE".into());
        assert_eq!(export_endpoint(&environment), Ok(None));

        let mut valid = http::HeaderMap::new();
        valid.insert(
            "traceparent",
            "00-11111111111111111111111111111111-2222222222222222-01"
                .parse()
                .unwrap(),
        );
        let _active = extract(&valid).attach();
        assert!(Context::current().span().span_context().is_valid());
        for value in [
            None,
            Some("invalid"),
            Some("00-00000000000000000000000000000000-2222222222222222-01"),
        ] {
            let mut headers = http::HeaderMap::new();
            if let Some(value) = value {
                headers.insert("traceparent", value.parse().unwrap());
            }
            assert!(
                !extract(&headers).span().span_context().is_valid(),
                "invalid or absent remote context must ignore the ambient span"
            );
        }
    }

    #[test]
    fn failed_stock_export_does_not_change_local_storage_result() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        // A fixture-owned listener accepts no HTTP response. Stock export times out.
        let provider = provider_for_endpoint(&format!(
            "http://{}/v1/traces",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        global::set_tracer_provider(provider.clone());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let root =
            std::env::temp_dir().join(format!("nanohost-telemetry-export-{}", std::process::id()));
        let (mut coordinator, _) = runtime.block_on(async {
            crate::epoch_coordinator::EpochCoordinator::collection_fixture(&root)
        });
        let mut command = crate::nanocore_session::PolledEffectCommand {
            kind: crate::epoch_coordinator::RuntimeEffectKind::InspectStorage,
            request_id: "a".repeat(64),
            input: serde_json::json!({"storageRef": "storage-one", "attachmentGeneration": 1}),
            file_data: None,
            trace_context: Context::new(),
        };
        let mut before =
            match crate::execute_effect_command(&mut coordinator, &mut command).unwrap() {
                crate::ExecutedEffectResult::Json(value) => value,
                _ => panic!("inspection returns JSON"),
            };
        assert!(
            provider.force_flush().is_err(),
            "the actual stock exporter must observe the unavailable collector"
        );
        let mut after = match crate::execute_effect_command(&mut coordinator, &mut command).unwrap()
        {
            crate::ExecutedEffectResult::Json(value) => value,
            _ => panic!("inspection returns JSON"),
        };
        assert_eq!(before["state"], "attached");
        // Live host capacity changes independently of exporter and association state.
        before.as_object_mut().unwrap().remove("capacity");
        after.as_object_mut().unwrap().remove("capacity");
        assert_eq!(before, after);
        global::set_tracer_provider(opentelemetry::trace::noop::NoopTracerProvider::new());
        let _ = provider.shutdown_with_timeout(std::time::Duration::from_millis(20));
        drop(coordinator);
        std::fs::remove_dir_all(root).unwrap();
    }
}

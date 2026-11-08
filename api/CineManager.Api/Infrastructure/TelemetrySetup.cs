using Microsoft.AspNetCore.HttpLogging;
using Npgsql;
using OpenTelemetry;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace CineManager.Api.Infrastructure;

public static class TelemetrySetup
{
    public const string DefaultServiceName = "cinemanager-api";

    /// <summary>
    /// Una riga di log per richiesta (metodo, percorso senza query, stato, durata) su console e,
    /// se attivo, su OTLP. Niente header né corpi: Authorization e cookie non finiscono nei log.
    /// </summary>
    public static void AddCineRequestLogging(this WebApplicationBuilder builder) =>
        builder.Services.AddHttpLogging(o =>
        {
            o.LoggingFields = HttpLoggingFields.RequestMethod | HttpLoggingFields.RequestPath |
                              HttpLoggingFields.ResponseStatusCode | HttpLoggingFields.Duration;
            o.CombineLogs = true;
        });

    /// <summary>
    /// OpenTelemetry (log, tracce, metriche) verso un collector OTLP (Alloy, otel-lgtm…).
    /// Attivo solo se c'è <c>OTEL_EXPORTER_OTLP_ENDPOINT</c>; endpoint, protocollo
    /// (<c>OTEL_EXPORTER_OTLP_PROTOCOL</c>, default grpc), header e nome del servizio
    /// (<c>OTEL_SERVICE_NAME</c>) seguono le variabili standard di OpenTelemetry.
    /// </summary>
    public static void AddCineTelemetry(this WebApplicationBuilder builder)
    {
        if (string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"])) return;

        var version = typeof(TelemetrySetup).Assembly.GetName().Version?.ToString();
        builder.Services.AddOpenTelemetry()
            .ConfigureResource(r => r
                .AddService(builder.Configuration["OTEL_SERVICE_NAME"] ?? DefaultServiceName, serviceVersion: version)
                .AddAttributes([new("deployment.environment.name", builder.Environment.EnvironmentName)]))
            .WithTracing(t => t
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddNpgsql())
            .WithMetrics(m => m
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddRuntimeInstrumentation()
                .AddMeter("Microsoft.AspNetCore.RateLimiting", "Npgsql"))
            .WithLogging(_ => { }, o =>
            {
                o.IncludeFormattedMessage = true;
                o.IncludeScopes = true;
            })
            .UseOtlpExporter();
    }
}

using System.Net;
using System.Security.Cryptography.X509Certificates;
using System.Threading.RateLimiting;
using CineManager.Api.Data;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;

namespace CineManager.Api.Infrastructure;

public static class HostingSetup
{
    /// <summary>
    /// Chiavi Data Protection nel DB, cifrate con un certificato che nel DB non sta (§4.1).
    /// Fuori da Development il certificato è obbligatorio.
    /// </summary>
    public static void AddCineDataProtection(this WebApplicationBuilder builder)
    {
        var dp = builder.Services.AddDataProtection()
            .SetApplicationName("CineManager")
            .PersistKeysToDbContext<CinemaDbContext>();

        var b64 = builder.Configuration["DataProtection:CertificateBase64"];
        if (string.IsNullOrWhiteSpace(b64))
        {
            if (!builder.Environment.IsDevelopment())
                throw new InvalidOperationException(
                    "DataProtection__CertificateBase64 mancante: fuori da Development le chiavi Data " +
                    "Protection devono essere cifrate con un certificato (PFX in base64).");
            return; // sviluppo: chiavi in chiaro nel DB locale
        }

        X509Certificate2 cert;
        try
        {
            // EphemeralKeySet: nessuna scrittura su disco (container read_only).
            cert = X509CertificateLoader.LoadPkcs12(Convert.FromBase64String(b64.Trim()),
                builder.Configuration["DataProtection:CertificatePassword"],
                X509KeyStorageFlags.EphemeralKeySet);
        }
        catch (Exception ex) when (ex is FormatException or System.Security.Cryptography.CryptographicException)
        {
            throw new InvalidOperationException(
                "DataProtection__CertificateBase64 non è un PFX valido o la password è errata.", ex);
        }
        if (!cert.HasPrivateKey)
            throw new InvalidOperationException("Il certificato Data Protection deve contenere la chiave privata.");

        dp.ProtectKeysWithCertificate(cert).UnprotectKeysWithAnyCertificate(cert);
    }

    /// <summary>
    /// Solo <c>X-Forwarded-For</c>, proxy fidati da configurazione (<c>Proxy__KnownNetworks</c>,
    /// <c>Proxy__KnownProxies</c>, separati da virgola), al massimo due salti: Caddy → nginx → api.
    /// Serve al rate limit e ai log, non all'autenticazione.
    /// </summary>
    public static void AddCineForwardedHeaders(this WebApplicationBuilder builder)
    {
        var networks = Split(builder.Configuration["Proxy:KnownNetworks"]);
        var proxies = Split(builder.Configuration["Proxy:KnownProxies"]);
        builder.Services.Configure<ForwardedHeadersOptions>(o =>
        {
            o.ForwardedHeaders = ForwardedHeaders.XForwardedFor;
            o.ForwardLimit = 2;
            foreach (var n in networks)
            {
                if (!System.Net.IPNetwork.TryParse(n, out var net))
                    throw new InvalidOperationException($"Proxy__KnownNetworks: rete non valida '{n}'.");
                o.KnownIPNetworks.Add(net);
            }
            foreach (var p in proxies)
            {
                if (!IPAddress.TryParse(p, out var ip))
                    throw new InvalidOperationException($"Proxy__KnownProxies: indirizzo non valido '{p}'.");
                o.KnownProxies.Add(ip);
            }
        });
    }

    /// <summary>Rate limit generale per IP reale (§6, Limiti): <c>RateLimit__PerMinute</c>, default 300.</summary>
    public static void AddCineRateLimiter(this WebApplicationBuilder builder)
    {
        var perMinute = builder.Configuration.GetValue("RateLimit:PerMinute", 300);
        builder.Services.AddRateLimiter(o =>
        {
            o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = perMinute,
                        Window = TimeSpan.FromMinutes(1),
                        QueueLimit = 0,
                    }));
            o.OnRejected = async (ctx, ct) =>
            {
                if (ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retry))
                    ctx.HttpContext.Response.Headers.RetryAfter = ((int)retry.TotalSeconds).ToString();
                await Results.Problem(statusCode: StatusCodes.Status429TooManyRequests,
                    title: "Troppe richieste", detail: "Riprova tra poco.").ExecuteAsync(ctx.HttpContext);
            };
        });
    }

    private static string[] Split(string? s) =>
        (s ?? "").Split([',', ';', ' '], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}

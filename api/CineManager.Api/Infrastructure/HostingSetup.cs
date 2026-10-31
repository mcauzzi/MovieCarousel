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

    /// <summary>
    /// Rate limit (§6, Limiti), tutti come limitatore globale a catena, sull'IP reale:
    /// generale <c>RateLimit__PerMinute</c> (300) per IP; <c>/api/app/pair</c> anche 10/min per IP
    /// (<c>RateLimit__PairPerIp</c>) e 30/min in totale (<c>RateLimit__PairGlobal</c>);
    /// <c>/api/app/lookup</c> e <c>/api/app/search</c> 60/min per dispositivo (<c>RateLimit__LookupPerDevice</c>).
    /// Il dispositivo è il <c>kid</c> letto dal token senza verificarlo: serve solo da chiave del
    /// secchio, la firma la controlla l'autenticazione (e il limite per IP resta comunque).
    /// </summary>
    public static void AddCineRateLimiter(this WebApplicationBuilder builder)
    {
        var cfg = builder.Configuration;
        var perMinute = cfg.GetValue("RateLimit:PerMinute", 300);
        var pairPerIp = cfg.GetValue("RateLimit:PairPerIp", 10);
        var pairGlobal = cfg.GetValue("RateLimit:PairGlobal", 30);
        var lookupPerDevice = cfg.GetValue("RateLimit:LookupPerDevice", 60);

        static FixedWindowRateLimiterOptions PerMinute(int n) => new()
        {
            PermitLimit = n, Window = TimeSpan.FromMinutes(1), QueueLimit = 0,
        };
        static string Ip(HttpContext ctx) => ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        static bool IsPair(HttpContext ctx) =>
            ctx.Request.Path.Equals("/api/app/pair", StringComparison.OrdinalIgnoreCase);
        static bool IsLookup(HttpContext ctx) =>
            ctx.Request.Path.StartsWithSegments("/api/app/lookup", StringComparison.OrdinalIgnoreCase) ||
            ctx.Request.Path.StartsWithSegments("/api/app/search", StringComparison.OrdinalIgnoreCase);

        builder.Services.AddRateLimiter(o =>
        {
            o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            o.GlobalLimiter = PartitionedRateLimiter.CreateChained(
                PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
                    RateLimitPartition.GetFixedWindowLimiter("ip:" + Ip(ctx), _ => PerMinute(perMinute))),
                PartitionedRateLimiter.Create<HttpContext, string>(ctx => IsPair(ctx)
                    ? RateLimitPartition.GetFixedWindowLimiter("pair-ip:" + Ip(ctx), _ => PerMinute(pairPerIp))
                    : RateLimitPartition.GetNoLimiter("")),
                PartitionedRateLimiter.Create<HttpContext, string>(ctx => IsPair(ctx)
                    ? RateLimitPartition.GetFixedWindowLimiter("pair", _ => PerMinute(pairGlobal))
                    : RateLimitPartition.GetNoLimiter("")),
                PartitionedRateLimiter.Create<HttpContext, string>(ctx => IsLookup(ctx)
                    ? RateLimitPartition.GetFixedWindowLimiter("lookup:" + (UnverifiedDeviceKey(ctx) ?? "ip:" + Ip(ctx)),
                        _ => PerMinute(lookupPerDevice))
                    : RateLimitPartition.GetNoLimiter("")));
            o.OnRejected = async (ctx, ct) =>
            {
                if (ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retry))
                    ctx.HttpContext.Response.Headers.RetryAfter = ((int)retry.TotalSeconds).ToString();
                await Results.Problem(statusCode: StatusCodes.Status429TooManyRequests,
                    title: "Troppe richieste", detail: "Riprova tra poco.").ExecuteAsync(ctx.HttpContext);
            };
        });
    }

    /// <summary><c>kid</c> dall'header del token <c>CM-Device</c>, senza verifica (solo chiave di rate limit).</summary>
    private static string? UnverifiedDeviceKey(HttpContext ctx)
    {
        var auth = ctx.Request.Headers.Authorization.ToString();
        if (!auth.StartsWith(Auth.DeviceTokens.AuthorizationPrefix, StringComparison.Ordinal)) return null;
        var token = auth.AsSpan(Auth.DeviceTokens.AuthorizationPrefix.Length).Trim();
        var dot = token.IndexOf('.');
        if (dot <= 0 || dot > 512) return null;
        var header = Auth.Base64Url.TryDecode(token[..dot].ToString());
        if (header is null) return null;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(header);
            return doc.RootElement.TryGetProperty("kid", out var kid) && Guid.TryParse(kid.GetString(), out var id)
                ? "dev:" + id.ToString("N") : null;
        }
        catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    private static string[] Split(string? s) =>
        (s ?? "").Split([',', ';', ' '], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}

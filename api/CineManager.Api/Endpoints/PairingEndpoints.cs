using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CineManager.Api.Auth;
using CineManager.Api.Data;
using CineManager.Api.Infrastructure;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace CineManager.Api.Endpoints;

public sealed record PairingResponse(string Code, DateTimeOffset ExpiresAt, string QrSvg);

public sealed record PairRequest(string? Code, string? DeviceName, string? PublicKey, string? Proof);

public sealed record PairUser(string Name);

public sealed record PairResponse(Guid DeviceId, PairUser User);

/// <summary>Abbinamento dei telefoni tramite QR (§4.2) e QR di download dell'APK (§10.1).</summary>
public static class PairingEndpoints
{
    public static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(5);
    public const string PairRateLimitPath = "/api/app/pair";
    public const int MaxDeviceName = 100;

    public static void MapPairingEndpoints(this IEndpointRouteBuilder app)
    {
        // 1. Il sito chiede un codice: 128 bit casuali, monouso, 5 minuti; nel DB solo lo SHA-256.
        app.MapPost("/api/pairing", async (HttpContext ctx, ClaimsPrincipal user, CinemaDbContext db, TimeProvider clock,
            CancellationToken ct) =>
        {
            var baseUrl = PublicUrls.Base(ctx);
            if (baseUrl is null) return PublicUrls.NotConfigured();

            var now = clock.GetUtcNow();
            // Pulizia dei codici scaduti o usati (qui basta: i codici nascono solo da questo endpoint).
            await db.PairingCodes.Where(p => p.ExpiresAt < now || p.UsedAt != null).ExecuteDeleteAsync(ct);

            var code = Base64Url.Encode(RandomNumberGenerator.GetBytes(16));
            var expires = now + CodeLifetime;
            db.PairingCodes.Add(new PairingCode
            {
                CodeHash = Hash(code), UserSub = user.Sub(), ExpiresAt = expires,
            });
            await db.SaveChangesAsync(ct);

            var qr = JsonSerializer.Serialize(new { v = 1, api = baseUrl + "/api", code });
            return Results.Ok(new PairingResponse(code, expires, PublicUrls.QrSvg(qr)));
        }).RequireAuthorization(Policies.User);

        // 2. Il telefono si abbina: codice valido + prova di possesso della chiave privata.
        app.MapPost(PairRateLimitPath, async (PairRequest? req, CinemaDbContext db, TimeProvider clock,
            ILoggerFactory lf, CancellationToken ct) =>
        {
            if (req is null || string.IsNullOrEmpty(req.Code) || req.DeviceName is null ||
                string.IsNullOrEmpty(req.PublicKey) || string.IsNullOrEmpty(req.Proof))
                return Bad("invalid_request", "Servono code, deviceName, publicKey e proof.");
            var name = req.DeviceName.Trim();
            if (name.Length is 0 or > MaxDeviceName || name.Any(char.IsControl))
                return Bad("invalid_request", $"deviceName: da 1 a {MaxDeviceName} caratteri, senza caratteri di controllo.");
            if (req.Code.Length > 64) return Bad("invalid_code", "Codice di abbinamento non valido, scaduto o già usato.");

            var spki = DecodeKey(req.PublicKey);
            using var key = spki is null ? null : DeviceTokens.ImportP256(spki);
            if (key is null) return Bad("invalid_key", "publicKey deve essere una chiave pubblica EC P-256 (SPKI DER in base64).");

            var proof = Base64Url.TryDecode(req.Proof);
            if (proof is not { Length: 64 } ||
                !key.VerifyData(Encoding.UTF8.GetBytes("pair:" + req.Code), proof, HashAlgorithmName.SHA256,
                    DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
                return Bad("invalid_proof", "Prova di possesso non valida: serve la firma ES256 (R||S, base64url) di \"pair:\" + code.");

            var hash = Hash(req.Code);
            var now = clock.GetUtcNow();
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            // Consumo atomico (un codice vale una sola volta anche con richieste simultanee) che
            // restituisce anche l'utente, senza una seconda lettura.
            var sub = (await db.Database.SqlQuery<string>($"""
                UPDATE pairing_codes SET used_at = {now}
                WHERE code_hash = {hash} AND used_at IS NULL AND expires_at > {now}
                RETURNING user_sub AS "Value"
                """).ToListAsync(ct)).SingleOrDefault();
            if (sub is null) return Bad("invalid_code", "Codice di abbinamento non valido, scaduto o già usato.");
            var device = new Device
            {
                Id = Guid.CreateVersion7(), UserSub = sub, Name = name, PublicKey = spki!, CreatedAt = now,
            };
            db.Devices.Add(device);
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);

            var owner = await db.Users.AsNoTracking().Where(u => u.Sub == sub)
                .Select(u => u.DisplayName ?? u.Username).SingleAsync(ct);
            lf.CreateLogger("CineManager.Pairing").LogInformation("Nuovo dispositivo {Device} ({Name}) per {Sub}", device.Id, name, sub);
            return Results.Ok(new PairResponse(device.Id, new PairUser(owner)));
        }).AllowAnonymous().WithMetadata(new RequestSizeLimitAttribute(DeviceAuthHandler.MaxBodyBytes));

        // QR con l'URL assoluto dell'APK (§10.1).
        app.MapGet("/api/app-download-qr.svg", (HttpContext ctx) =>
        {
            var baseUrl = PublicUrls.Base(ctx);
            if (baseUrl is null) return PublicUrls.NotConfigured();
            ctx.Response.Headers.CacheControl = "no-cache";
            return Results.Text(PublicUrls.QrSvg(baseUrl + "/app/cinemanager.apk"), "image/svg+xml; charset=utf-8");
        }).RequireAuthorization(Policies.User);
    }

    internal static byte[] Hash(string code) => SHA256.HashData(Encoding.UTF8.GetBytes(code));

    /// <summary>SPKI DER in base64 (accettato anche base64url).</summary>
    private static byte[]? DecodeKey(string s)
    {
        if (s.Length > 1024) return null;
        try { return Convert.FromBase64String(s.Trim()); }
        catch (FormatException) { return Base64Url.TryDecode(s.Trim()); }
    }

    private static IResult Bad(string reason, string detail) => Results.Problem(
        statusCode: StatusCodes.Status400BadRequest, title: "Abbinamento non riuscito", detail: detail,
        extensions: new Dictionary<string, object?> { ["reason"] = reason });
}

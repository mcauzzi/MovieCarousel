using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using CineManager.Api.Data;
using CineManager.Api.Devices;
using CineManager.Api.Infrastructure;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CineManager.Api.Auth;

/// <summary>
/// Richieste firmate dell'app (§4.2): <c>Authorization: CM-Device &lt;jwt&gt;</c>. I controlli
/// seguono l'ordine del documento: dispositivo non revocato, firma, tempi, metodo/percorso/corpo,
/// <c>jti</c> monouso, proprietario ancora autorizzato, versione minima dell'app, <c>last_seen_at</c>.
/// Il principal ha <c>sub</c> = proprietario e <c>cm_device</c> = id del dispositivo, nessun ruolo:
/// con questa identità si raggiungono solo gli endpoint <c>/api/app/*</c>.
/// </summary>
public sealed class DeviceAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    TimeProvider clock,
    ReplayCache replay,
    AppVersionProvider versions,
    IOptions<OidcOptions> oidc,
    IOptions<DevicesOptions> devices) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "CM-Device";

    /// <summary>Tolleranza sull'orologio del telefono (± secondi).</summary>
    public const int ClockSkewSeconds = 30;
    /// <summary>Durata massima di un token (<c>exp - iat</c>).</summary>
    public const int MaxLifetimeSeconds = 60;
    /// <summary>Corpo massimo delle chiamate dell'app (§6, Limiti).</summary>
    public const int MaxBodyBytes = 256 * 1024;

    private const string FailureKey = "cm.device.failure";
    private const string MinVersionKey = "cm.device.minVersion";
    private const string ReasonKey = "cm.device.reason";

    private enum Failure { Unauthorized, OwnerInactive, UpgradeRequired, TooLarge }

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        string auth = Request.Headers.Authorization.ToString();
        if (!auth.StartsWith(DeviceTokens.AuthorizationPrefix, StringComparison.Ordinal))
            return AuthenticateResult.NoResult();

        var token = DeviceTokens.TryParse(auth[DeviceTokens.AuthorizationPrefix.Length..].Trim(), out var formatError);
        if (token is null) return Reject(formatError);

        var db = Context.RequestServices.GetRequiredService<CinemaDbContext>();
        var ct = Context.RequestAborted;

        // 1. dispositivo esistente e non revocato
        var device = await db.Devices.AsNoTracking().FirstOrDefaultAsync(d => d.Id == token.DeviceId, ct);
        if (device is null || device.RevokedAt is not null) return Reject("device_revoked");

        // 2. firma
        if (!DeviceTokens.VerifySignature(device.PublicKey, token.SigningInput, token.Signature))
            return Reject("bad_signature");

        // 3. tempi, metodo, percorso, corpo
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        if (token.Exp <= token.Iat || token.Exp - token.Iat > MaxLifetimeSeconds) return Reject("bad_lifetime");
        if (token.Iat > now + ClockSkewSeconds || token.Exp < now - ClockSkewSeconds) return Reject("expired");
        if (!string.Equals(token.Htm, Request.Method, StringComparison.Ordinal)) return Reject("htm_mismatch");
        if (!string.Equals(token.Htu, RequestTarget(), StringComparison.Ordinal)) return Reject("htu_mismatch");

        var body = await ReadBodyAsync(ct);
        if (body is null) return Fail(Failure.TooLarge, "body_too_large");
        if (body.Length > 0 && token.Bh is null) return Reject("bh_missing");
        if (token.Bh is not null &&
            !CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(token.Bh),
                Encoding.ASCII.GetBytes(DeviceTokens.BodyHash(body))))
            return Reject("bh_mismatch");

        // 4. jti monouso (registrato solo dopo la firma: un token falso non può "bruciare" un jti)
        if (!replay.TryRegister(device.Id, token.Jti, token.Exp)) return Reject("replay");

        // 5. proprietario ancora autorizzato (§4.3)
        var owner = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Sub == device.UserSub, ct);
        if (owner is null || !OwnerAuthorized(owner, clock.GetUtcNow()))
        {
            Logger.LogInformation("Dispositivo {Device}: proprietario {Sub} non più autorizzato", device.Id, device.UserSub);
            return Fail(Failure.OwnerInactive, "owner_inactive");
        }

        // 6. versione minima dell'app (§11.1)
        if (await versions.GetMinSupportedCodeAsync(ct) is { } min && token.Av < min)
        {
            Context.Items[MinVersionKey] = min;
            return Fail(Failure.UpgradeRequired, "upgrade_required");
        }

        // 7. ultimo utilizzo
        await db.Devices.Where(d => d.Id == device.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(d => d.LastSeenAt, clock.GetUtcNow()), ct);

        var id = new ClaimsIdentity(SchemeName, CmClaims.Name, CmClaims.Role);
        id.AddClaim(new Claim(CmClaims.Sub, owner.Sub));
        id.AddClaim(new Claim(CmClaims.Name, owner.DisplayName ?? owner.Username));
        id.AddClaim(new Claim(CmClaims.Device, device.Id.ToString()));
        id.AddClaim(new Claim(CmClaims.DeviceName, device.Name));
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(id), SchemeName));
    }

    /// <summary>
    /// Ultimo login con il gruppo utenti (se <c>Oidc__UserGroup</c> è impostato) e non più vecchio di
    /// <c>Devices__MaxOwnerInactiveDays</c> giorni.
    /// </summary>
    internal bool OwnerAuthorized(User owner, DateTimeOffset now)
    {
        var group = oidc.Value.UserGroup?.Trim();
        if (!string.IsNullOrEmpty(group) && !owner.Groups.Contains(group, StringComparer.Ordinal)) return false;
        return owner.LastLoginAt >= now.AddDays(-Math.Max(0, devices.Value.MaxOwnerInactiveDays));
    }

    /// <summary>Percorso + query come ricevuti (request-target), con ripiego sui valori ricostruiti.</summary>
    private string RequestTarget()
    {
        var raw = Context.Features.Get<IHttpRequestFeature>()?.RawTarget;
        if (!string.IsNullOrEmpty(raw) && raw[0] == '/') return raw;
        return Request.PathBase.ToUriComponent() + Request.Path.ToUriComponent() + Request.QueryString.ToUriComponent();
    }

    /// <summary>Corpo completo (bufferizzato e riavvolto per l'endpoint); null oltre il limite.</summary>
    private async Task<byte[]?> ReadBodyAsync(CancellationToken ct)
    {
        if (Request.ContentLength is > MaxBodyBytes) return null;
        if (Request.ContentLength == 0) return [];
        Request.EnableBuffering(64 * 1024, MaxBodyBytes + 1);
        using var ms = new MemoryStream();
        var buffer = new byte[16 * 1024];
        try
        {
            int n;
            while ((n = await Request.Body.ReadAsync(buffer, ct)) > 0)
            {
                if (ms.Length + n > MaxBodyBytes) return null;
                ms.Write(buffer, 0, n);
            }
        }
        catch (IOException) when (!ct.IsCancellationRequested)
        {
            return null; // limite del buffer superato
        }
        Request.Body.Position = 0;
        return ms.ToArray();
    }

    private AuthenticateResult Reject(string reason)
    {
        Logger.LogInformation("Richiesta firmata rifiutata: {Reason}", reason);
        return Fail(Failure.Unauthorized, reason);
    }

    private AuthenticateResult Fail(Failure kind, string reason)
    {
        Context.Items[FailureKey] = kind;
        Context.Items[ReasonKey] = reason;
        return AuthenticateResult.Fail(reason);
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        var failure = Context.Items.TryGetValue(FailureKey, out var f) && f is Failure kind ? kind : Failure.Unauthorized;
        var ext = new Dictionary<string, object?>();
        if (failure == Failure.UpgradeRequired) ext["minSupportedCode"] = Context.Items[MinVersionKey];
        ext["reason"] = Context.Items.TryGetValue(ReasonKey, out var r) && r is string s ? s : "missing_token";
        if (failure == Failure.Unauthorized) Response.Headers.WWWAuthenticate = "CM-Device";
        var (status, title, detail) = failure switch
        {
            Failure.OwnerInactive => (StatusCodes.Status403Forbidden, "Proprietario non autorizzato",
                "Il proprietario del dispositivo deve accedere di nuovo al sito."),
            Failure.UpgradeRequired => (StatusCodes.Status426UpgradeRequired, "Aggiornamento necessario",
                "Questa versione dell'app non è più supportata: installa l'aggiornamento."),
            Failure.TooLarge => (StatusCodes.Status413PayloadTooLarge, "Corpo troppo grande", $"Massimo {MaxBodyBytes / 1024} KB."),
            _ => (StatusCodes.Status401Unauthorized, "Richiesta firmata non valida",
                "Firma del dispositivo mancante, non valida, scaduta o già usata; o dispositivo revocato."),
        };
        return Results.Problem(statusCode: status, title: title, detail: detail, extensions: ext).ExecuteAsync(Context);
    }
}

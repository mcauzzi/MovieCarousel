using System.Security.Claims;
using System.Text.Json;
using CineManager.Api.Infrastructure;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

namespace CineManager.Api.Auth;

/// <summary>Modalità di autenticazione scelta all'avvio.</summary>
public sealed record AuthMode(bool DevAuth, bool OidcEnabled);

public static class AuthSetup
{
    public const string CookieName = "__Host-cm_session";
    public const string CallbackPath = "/api/auth/callback";
    public static readonly TimeSpan SessionLifetime = TimeSpan.FromHours(12);

    /// <summary>
    /// Cookie di sessione + OIDC (sito) oppure, in Development con <c>Auth__DevUser</c>,
    /// autenticazione finta. Le API rispondono 401/403, mai con redirect HTML.
    /// </summary>
    public static AuthMode AddCineAuth(this WebApplicationBuilder builder)
    {
        var cfg = builder.Configuration;
        var env = builder.Environment;
        var oidc = cfg.GetSection(OidcOptions.Section).Get<OidcOptions>() ?? new OidcOptions();
        var dev = cfg.GetSection(DevAuthOptions.Section).Get<DevAuthOptions>() ?? new DevAuthOptions();

        var devAuth = !string.IsNullOrWhiteSpace(dev.DevUser);
        if (devAuth && !env.IsDevelopment())
            throw new InvalidOperationException(
                "Auth__DevUser è impostato ma l'ambiente non è Development: l'autenticazione finta " +
                "è ammessa solo in sviluppo. Rimuovi la variabile.");

        var oidcEnabled = !devAuth && oidc.IsConfigured;
        if (!devAuth && !oidcEnabled && !env.IsDevelopment())
            throw new InvalidOperationException(
                "OIDC non configurato: servono Oidc__Authority, Oidc__ClientId e Oidc__ClientSecret.");

        var publicBaseUrl = cfg["PublicBaseUrl"]?.TrimEnd('/');
        if (oidcEnabled && !Uri.TryCreate(publicBaseUrl, UriKind.Absolute, out _))
            throw new InvalidOperationException(
                "PublicBaseUrl mancante o non valido: serve per il redirect_uri OIDC (es. https://<host-sito>).");

        builder.Services.Configure<OidcOptions>(cfg.GetSection(OidcOptions.Section));
        builder.Services.Configure<DevAuthOptions>(cfg.GetSection(DevAuthOptions.Section));
        builder.Services.AddScoped<UserSync>();

        var auth = builder.Services.AddAuthentication(o =>
        {
            var main = devAuth ? DevAuthHandler.SchemeName : CookieAuthenticationDefaults.AuthenticationScheme;
            o.DefaultScheme = main;
            o.DefaultChallengeScheme = main;
            o.DefaultForbidScheme = main;
            o.DefaultSignInScheme = CookieAuthenticationDefaults.AuthenticationScheme;
        });

        auth.AddCookie(o =>
        {
            o.Cookie.Name = CookieName;
            o.Cookie.HttpOnly = true;
            o.Cookie.SecurePolicy = CookieSecurePolicy.Always;
            o.Cookie.SameSite = SameSiteMode.Lax;
            o.Cookie.Path = "/";
            // Durata assoluta: senza rinnovo i gruppi vengono riletti almeno ogni 12 ore (§4.1).
            o.ExpireTimeSpan = SessionLifetime;
            o.SlidingExpiration = false;
            // Solo lo stato: il corpo problem+json di 401/403 lo scrive UseStatusCodePages.
            static Func<RedirectContext<CookieAuthenticationOptions>, Task> Status(int code) =>
                ctx => { ctx.Response.StatusCode = code; return Task.CompletedTask; };
            o.Events.OnRedirectToLogin = Status(StatusCodes.Status401Unauthorized);
            o.Events.OnRedirectToAccessDenied = Status(StatusCodes.Status403Forbidden);
            o.Events.OnRedirectToLogout = Status(StatusCodes.Status204NoContent);
            o.Events.OnRedirectToReturnUrl = Status(StatusCodes.Status204NoContent);
            o.Events.OnSigningIn = OnSigningIn;
            o.Events.OnValidatePrincipal = OnValidatePrincipal;
        });

        // Richieste firmate dell'app (§4.2): schema usato solo dalla policy "device".
        builder.Services.Configure<DevicesOptions>(cfg.GetSection(DevicesOptions.Section));
        builder.Services.AddSingleton<ReplayCache>();
        auth.AddScheme<AuthenticationSchemeOptions, DeviceAuthHandler>(DeviceAuthHandler.SchemeName, _ => { });

        if (devAuth)
        {
            builder.Services.AddSingleton<DevUserSyncState>();
            auth.AddScheme<AuthenticationSchemeOptions, DevAuthHandler>(DevAuthHandler.SchemeName, _ => { });
        }

        if (oidcEnabled)
        {
            auth.AddOpenIdConnect(o =>
            {
                o.Authority = oidc.Authority;
                o.ClientId = oidc.ClientId;
                o.ClientSecret = oidc.ClientSecret;
                o.RequireHttpsMetadata = oidc.RequireHttpsMetadata;
                o.ResponseType = OpenIdConnectResponseType.Code;
                o.ResponseMode = OpenIdConnectResponseMode.Query;
                o.UsePkce = true;
                // Flusso classico come configurato in Authelia (§4.1), senza PAR.
                o.PushedAuthorizationBehavior = PushedAuthorizationBehavior.Disable;
                o.CallbackPath = CallbackPath;
                o.SignInScheme = CookieAuthenticationDefaults.AuthenticationScheme;
                o.SaveTokens = false;
                o.MapInboundClaims = false;
                o.GetClaimsFromUserInfoEndpoint = true;
                o.Scope.Clear();
                foreach (var s in new[] { "openid", "profile", "groups" }) o.Scope.Add(s);
                o.ClaimActions.MapJsonKey(CmClaims.Groups, CmClaims.Groups);
                o.ClaimActions.MapUniqueJsonKey(CmClaims.Username, CmClaims.Username);
                o.TokenValidationParameters.NameClaimType = CmClaims.Name;
                o.TokenValidationParameters.RoleClaimType = CmClaims.Role;
                o.CorrelationCookie.SameSite = SameSiteMode.Lax;
                o.CorrelationCookie.SecurePolicy = CookieSecurePolicy.Always;
                o.NonceCookie.SameSite = SameSiteMode.Lax;
                o.NonceCookie.SecurePolicy = CookieSecurePolicy.Always;
                // client_secret_post: l'handler invia il segreto nel corpo della richiesta al token endpoint.
                o.Events.OnRedirectToIdentityProvider = ctx =>
                {
                    // redirect_uri da configurazione, non dagli header della richiesta (§4.1).
                    ctx.ProtocolMessage.RedirectUri = publicBaseUrl + CallbackPath;
                    return Task.CompletedTask;
                };
                o.Events.OnRemoteFailure = async ctx =>
                {
                    ctx.HttpContext.RequestServices.GetRequiredService<ILoggerFactory>()
                        .CreateLogger("CineManager.Auth").LogWarning(ctx.Failure, "Login OIDC non riuscito");
                    ctx.HandleResponse();
                    // Nessun redirect: il frontend rifarebbe subito il login, in un ciclo infinito.
                    await Results.Problem(statusCode: StatusCodes.Status401Unauthorized,
                        title: "Login non riuscito",
                        detail: "Il provider di identità ha rifiutato o interrotto l'accesso.").ExecuteAsync(ctx.HttpContext);
                };
            });
        }

        builder.Services.AddAuthorizationBuilder()
            .AddPolicy(Policies.User, p => p.RequireAuthenticatedUser().RequireRole(Roles.User))
            .AddPolicy(Policies.Admin, p => p.RequireAuthenticatedUser().RequireRole(Roles.Admin))
            .AddPolicy(Policies.Device, p => p.AddAuthenticationSchemes(DeviceAuthHandler.SchemeName)
                .RequireAuthenticatedUser().RequireClaim(CmClaims.Device));

        var mode = new AuthMode(devAuth, oidcEnabled);
        builder.Services.AddSingleton(mode);
        return mode;
    }

    /// <summary>
    /// Al login OIDC: ruoli dai gruppi, upsert in <c>users</c>, timbro di sicurezza nel cookie.
    /// Nel cookie restano solo i claim che servono.
    /// </summary>
    private static async Task OnSigningIn(CookieSigningInContext ctx)
    {
        var src = ctx.Principal;
        var sub = src?.FindFirst(CmClaims.Sub)?.Value;
        if (src is null || string.IsNullOrEmpty(sub))
            throw new InvalidOperationException("Login senza claim 'sub'.");

        var groups = ReadGroups(src);
        var name = src.FindFirst(CmClaims.Name)?.Value;
        var username = src.FindFirst(CmClaims.Username)?.Value;
        var oidc = ctx.HttpContext.RequestServices.GetRequiredService<IOptions<OidcOptions>>().Value;
        var roles = Roles.Resolve(groups, oidc.UserGroup, oidc.AdminGroup);

        var sync = ctx.HttpContext.RequestServices.GetRequiredService<UserSync>();
        var stamp = await sync.UpsertAsync(sub, username, name, groups, ctx.HttpContext.RequestAborted);

        var id = new ClaimsIdentity(CookieAuthenticationDefaults.AuthenticationScheme, CmClaims.Name, CmClaims.Role);
        id.AddClaim(new Claim(CmClaims.Sub, sub));
        id.AddClaim(new Claim(CmClaims.Name, name ?? username ?? sub));
        if (username is not null) id.AddClaim(new Claim(CmClaims.Username, username));
        foreach (var g in groups) id.AddClaim(new Claim(CmClaims.Groups, g));
        foreach (var r in roles) id.AddClaim(new Claim(CmClaims.Role, r));
        id.AddClaim(new Claim(CmClaims.Stamp, stamp.ToString()));
        ctx.Principal = new ClaimsPrincipal(id);

        ctx.Properties.IsPersistent = true;
        ctx.Properties.AllowRefresh = false;
        ctx.Properties.ExpiresUtc = DateTimeOffset.UtcNow.Add(SessionLifetime);
    }

    /// <summary>
    /// Il claim <c>groups</c> può arrivare come più claim separati o come un unico array JSON,
    /// a seconda di come lo mappa <c>MapJsonKey</c>.
    /// </summary>
    internal static List<string> ReadGroups(ClaimsPrincipal p)
    {
        var result = new List<string>();
        foreach (var c in p.FindAll(CmClaims.Groups))
        {
            var v = c.Value.Trim();
            if (v.StartsWith('['))
            {
                try
                {
                    result.AddRange(JsonSerializer.Deserialize<string[]>(v) ?? []);
                    continue;
                }
                catch (JsonException) { /* valore letterale */ }
            }
            if (v.Length > 0) result.Add(v);
        }
        return result.Distinct(StringComparer.Ordinal).ToList();
    }

    /// <summary>Sessioni revocabili: il timbro nel cookie deve coincidere con quello nel DB (§4.1).</summary>
    private static async Task OnValidatePrincipal(CookieValidatePrincipalContext ctx)
    {
        var sub = ctx.Principal?.FindFirst(CmClaims.Sub)?.Value;
        var stampClaim = ctx.Principal?.FindFirst(CmClaims.Stamp)?.Value;
        var dev = ctx.HttpContext.RequestServices.GetRequiredService<IOptions<DevAuthOptions>>().Value;
        var cacheFor = TimeSpan.FromSeconds(Math.Max(0, dev.StampCacheSeconds));
        Guid? current = sub is null
            ? null
            : await ctx.HttpContext.RequestServices.GetRequiredService<UserSync>()
                .GetStampAsync(sub, cacheFor, ctx.HttpContext.RequestAborted);
        if (current is null || !Guid.TryParse(stampClaim, out var stamp) || stamp != current)
        {
            ctx.RejectPrincipal();
            await ctx.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
        }
    }

    /// <summary>
    /// <c>/api/auth/login</c>, <c>/api/auth/logout</c>.
    /// </summary>
    public static void MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/auth/login", Results<RedirectHttpResult, ChallengeHttpResult, ProblemHttpResult> (
            string? returnUrl, AuthMode mode) =>
        {
            var target = LocalUrl.Sanitize(returnUrl);
            if (mode.DevAuth) return TypedResults.Redirect(target);
            if (!mode.OidcEnabled)
                return TypedResults.Problem(statusCode: StatusCodes.Status503ServiceUnavailable,
                    title: "Login non configurato",
                    detail: "Configura Oidc__* oppure, in sviluppo, Auth__DevUser.");
            return TypedResults.Challenge(new AuthenticationProperties { RedirectUri = target },
                [OpenIdConnectDefaults.AuthenticationScheme]);
        }).AllowAnonymous();

        app.MapPost("/api/auth/logout", async (HttpContext ctx) =>
        {
            await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return Results.NoContent();
        }).AllowAnonymous();
    }
}

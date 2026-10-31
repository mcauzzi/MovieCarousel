using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Nodes;
using CineManager.Api.Auth;
using CineManager.Api.Tests.Support;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

namespace CineManager.Api.Tests;

/// <summary>Host in modalità "produzione": cookie + OIDC (configurazione statica, nessuna rete) + Data Protection cifrata.</summary>
public sealed class ProductionFactory : ApiFactory
{
    public const string PublicBaseUrl = "https://cinema.example.test";
    public const string AuthorizeEndpoint = "https://auth.example.test/api/oidc/authorization";

    public ProductionFactory()
    {
        Environment = "Production";
        UseTestAuth = false;
        Settings["PublicBaseUrl"] = PublicBaseUrl + "/";
        Settings["Oidc:Authority"] = "https://auth.example.test";
        Settings["Oidc:ClientId"] = "cinemanager";
        Settings["Oidc:ClientSecret"] = "segreto-di-test";
        Settings["Oidc:UserGroup"] = "cinema";
        Settings["Oidc:AdminGroup"] = "cinema-admin";
        Settings["Auth:StampCacheSeconds"] = "0";
        Settings["Proxy:KnownNetworks"] = "172.31.91.0/24";
        Settings["Proxy:KnownProxies"] = "192.0.2.10";
        (Settings["DataProtection:CertificateBase64"], Settings["DataProtection:CertificatePassword"]) = TestCertificate();
    }

    public static (string, string) TestCertificate()
    {
        using var rsa = RSA.Create(2048);
        var req = new CertificateRequest("CN=cinemanager-dp-test", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var cert = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1));
        return (Convert.ToBase64String(cert.Export(X509ContentType.Pfx, "pw")), "pw");
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureTestServices(s => s.PostConfigure<OpenIdConnectOptions>(OpenIdConnectDefaults.AuthenticationScheme, o =>
        {
            var cfg = new OpenIdConnectConfiguration
            {
                Issuer = "https://auth.example.test",
                AuthorizationEndpoint = AuthorizeEndpoint,
                TokenEndpoint = "https://auth.example.test/api/oidc/token",
                UserInfoEndpoint = "https://auth.example.test/api/oidc/userinfo",
            };
            o.Configuration = cfg;
            o.ConfigurationManager = new StaticConfigurationManager<OpenIdConnectConfiguration>(cfg);
        }));
    }

    /// <summary>Cookie di sessione valido per <paramref name="sub"/>, come lo emetterebbe il login.</summary>
    public string SessionCookie(string sub, Guid stamp, IEnumerable<string> roles, DateTimeOffset? expires = null)
    {
        var id = new ClaimsIdentity(CookieAuthenticationDefaults.AuthenticationScheme, CmClaims.Name, CmClaims.Role);
        id.AddClaim(new Claim(CmClaims.Sub, sub));
        id.AddClaim(new Claim(CmClaims.Name, "Nome " + sub));
        id.AddClaim(new Claim(CmClaims.Stamp, stamp.ToString()));
        foreach (var r in roles) id.AddClaim(new Claim(CmClaims.Role, r));
        var props = new AuthenticationProperties
        {
            IssuedUtc = DateTimeOffset.UtcNow, ExpiresUtc = expires ?? DateTimeOffset.UtcNow.AddHours(12), IsPersistent = true,
        };
        var ticket = new AuthenticationTicket(new ClaimsPrincipal(id), props, CookieAuthenticationDefaults.AuthenticationScheme);
        var opts = Services.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>()
            .Get(CookieAuthenticationDefaults.AuthenticationScheme);
        return $"{AuthSetup.CookieName}={opts.TicketDataFormat.Protect(ticket)}";
    }
}

public sealed class ProductionFixture : IDisposable
{
    private readonly Lazy<ProductionFactory> _f = new(() =>
    {
        var f = new ProductionFactory();
        f.CreateClient().Dispose();
        return f;
    });
    public ProductionFactory Factory => _f.Value;
    public void Dispose() { if (_f.IsValueCreated) _f.Value.Dispose(); }
}

public class ProductionAuthTests(ProductionFixture fx) : IClassFixture<ProductionFixture>
{
    private ProductionFactory F => fx.Factory;

    private HttpClient Client() =>
        F.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = false });

    [DbFact]
    public async Task Me_senza_cookie_401_senza_redirect()
    {
        using var c = Client();
        var res = await c.GetAsync("/api/me");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Null(res.Headers.Location);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
    }

    [DbFact]
    public async Task Login_reindirizza_ad_Authelia_con_PKCE_e_redirect_uri_da_PublicBaseUrl()
    {
        using var c = Client();
        var res = await c.GetAsync("/api/auth/login?returnUrl=/intel");
        Assert.Equal(HttpStatusCode.Redirect, res.StatusCode);
        var loc = res.Headers.Location!;
        Assert.StartsWith(ProductionFactory.AuthorizeEndpoint, loc.ToString());
        var q = QueryHelpers.ParseQuery(loc.Query);
        Assert.Equal(ProductionFactory.PublicBaseUrl + "/api/auth/callback", q["redirect_uri"]);
        Assert.Equal("code", q["response_type"]);
        Assert.Equal("openid profile groups", q["scope"]);
        Assert.Equal("S256", q["code_challenge_method"]);
        Assert.Equal("cinemanager", q["client_id"]);
        Assert.False(q.ContainsKey("client_secret"));
        Assert.Equal("/intel", ReturnUrlInState(q["state"]!));

        var cookies = res.Headers.GetValues("Set-Cookie").ToList();
        Assert.Contains(cookies, s => s.Contains(".AspNetCore.Correlation", StringComparison.Ordinal) &&
                                      s.Contains("samesite=lax", StringComparison.OrdinalIgnoreCase) &&
                                      s.Contains("secure", StringComparison.OrdinalIgnoreCase));
    }

    [DbTheory]
    [InlineData("https://evil.example/")]
    [InlineData("//evil.example/x")]
    [InlineData("/\\evil.example")]
    public async Task ReturnUrl_non_locale_diventa_radice(string returnUrl)
    {
        using var c = Client();
        var res = await c.GetAsync("/api/auth/login?returnUrl=" + Uri.EscapeDataString(returnUrl));
        Assert.Equal(HttpStatusCode.Redirect, res.StatusCode);
        var q = QueryHelpers.ParseQuery(res.Headers.Location!.Query);
        Assert.Equal("/", ReturnUrlInState(q["state"]!));
    }

    private string? ReturnUrlInState(string state)
    {
        var o = F.Services.GetRequiredService<IOptionsMonitor<OpenIdConnectOptions>>().Get(OpenIdConnectDefaults.AuthenticationScheme);
        return o.StateDataFormat.Unprotect(state)?.RedirectUri;
    }

    [DbFact]
    public void Cookie_di_sessione_configurato_come_da_design()
    {
        var o = F.Services.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>()
            .Get(CookieAuthenticationDefaults.AuthenticationScheme);
        Assert.Equal("__Host-cm_session", o.Cookie.Name);
        Assert.True(o.Cookie.HttpOnly);
        Assert.Equal(Microsoft.AspNetCore.Http.CookieSecurePolicy.Always, o.Cookie.SecurePolicy);
        Assert.Equal(Microsoft.AspNetCore.Http.SameSiteMode.Lax, o.Cookie.SameSite);
        Assert.Equal(TimeSpan.FromHours(12), o.ExpireTimeSpan);
        Assert.False(o.SlidingExpiration);
    }

    [DbFact]
    public async Task Timbro_di_sicurezza_rigenerato_invalida_la_sessione()
    {
        var stamp = await F.WithDbAsync(db => new UserSync(db, new Microsoft.Extensions.Caching.Memory.MemoryCache(
            new Microsoft.Extensions.Caching.Memory.MemoryCacheOptions()), TimeProvider.System)
            .UpsertAsync("gino", "gino", "Gino", ["cinema"]));
        var cookie = F.SessionCookie("gino", stamp, ["user"]);

        using var c = Client();
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/me");
        req.Headers.Add("Cookie", cookie);
        var res = await c.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var me = JsonNode.Parse(await res.Content.ReadAsStringAsync())!;
        Assert.Equal("gino", me["sub"]!.GetValue<string>());
        Assert.Equal(["user"], me["roles"]!.AsArray().Select(r => r!.GetValue<string>()));

        // Ruolo utente senza admin: 403 sugli endpoint di amministrazione.
        req = new HttpRequestMessage(HttpMethod.Post, "/api/import/tellico") { Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json") };
        req.Headers.Add("Cookie", cookie);
        req.Headers.Add("X-CM-Request", "1");
        Assert.Equal(HttpStatusCode.Forbidden, (await c.SendAsync(req)).StatusCode);

        await F.WithDbAsync(db => db.Users.Where(u => u.Sub == "gino")
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.SecurityStamp, Guid.NewGuid())));
        req = new HttpRequestMessage(HttpMethod.Get, "/api/me");
        req.Headers.Add("Cookie", cookie);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.SendAsync(req)).StatusCode);
    }

    [DbFact]
    public async Task Cookie_scaduto_rifiutato()
    {
        var stamp = Guid.NewGuid();
        await F.WithDbAsync(async db =>
        {
            db.Users.Add(new Data.User { Sub = "vecchio", Username = "vecchio", SecurityStamp = stamp, LastLoginAt = DateTimeOffset.UtcNow });
            await db.SaveChangesAsync();
        });
        using var c = Client();
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/me");
        req.Headers.Add("Cookie", F.SessionCookie("vecchio", stamp, ["user"], DateTimeOffset.UtcNow.AddMinutes(-1)));
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.SendAsync(req)).StatusCode);
    }

    [DbFact]
    public async Task Chiavi_Data_Protection_cifrate_nel_DB()
    {
        F.SessionCookie("x", Guid.NewGuid(), []); // forza la creazione di una chiave
        var xml = await F.WithDbAsync(db => db.DataProtectionKeys.Select(k => k.Xml).ToListAsync());
        Assert.NotEmpty(xml);
        Assert.All(xml, x => Assert.Contains("EncryptedData", x!));
    }
}

/// <summary>Autenticazione di sviluppo e controlli all'avvio.</summary>
public class StartupTests
{
    [DbFact]
    public async Task Auth_di_sviluppo_autentica_l_utente_configurato_e_login_reindirizza_in_locale()
    {
        using var f = new ApiFactory { UseTestAuth = false };
        f.Settings["Auth:DevUser"] = "sviluppatore";
        f.Settings["Auth:DevRoles"] = "user,admin";
        using var c = f.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

        var me = JsonNode.Parse(await c.GetStringAsync("/api/me"))!;
        Assert.Equal("sviluppatore", me["sub"]!.GetValue<string>());
        Assert.Equal(["user", "admin"], me["roles"]!.AsArray().Select(r => r!.GetValue<string>()));
        Assert.True(await f.WithDbAsync(db => db.Users.AnyAsync(u => u.Sub == "sviluppatore")));

        var res = await c.GetAsync("/api/auth/login?returnUrl=https%3A%2F%2Fevil.example");
        Assert.Equal("/", res.Headers.Location?.ToString());
        res = await c.GetAsync("/api/auth/login?returnUrl=%2F%3Ffile%3Dx");
        Assert.Equal("/?file=x", res.Headers.Location?.ToString());
    }

    [DbFact]
    public async Task Development_senza_OIDC_e_senza_DevUser_parte_e_risponde_401()
    {
        using var f = new ApiFactory { UseTestAuth = false };
        using var c = f.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/me")).StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await c.GetAsync("/api/auth/login")).StatusCode);
    }

    [Fact]
    public void DevUser_fuori_da_Development_impedisce_l_avvio()
    {
        using var f = new ProductionFactory();
        f.Settings["Auth:DevUser"] = "intruso";
        AssertStartupFails(f, "Auth__DevUser");
    }

    [Fact]
    public void Produzione_senza_OIDC_impedisce_l_avvio()
    {
        using var f = new ProductionFactory();
        f.Settings["Oidc:ClientSecret"] = "";
        AssertStartupFails(f, "OIDC non configurato");
    }

    [Fact]
    public void Produzione_senza_certificato_Data_Protection_impedisce_l_avvio()
    {
        using var f = new ProductionFactory();
        f.Settings["DataProtection:CertificateBase64"] = "";
        AssertStartupFails(f, "DataProtection__CertificateBase64");
    }

    private static void AssertStartupFails(ApiFactory f, string messagePart)
    {
        var ex = Assert.ThrowsAny<Exception>(() => f.CreateClient());
        var all = string.Join(" | ", Flatten(ex).Select(e => e.Message));
        Assert.Contains(messagePart, all);
    }

    private static IEnumerable<Exception> Flatten(Exception? e)
    {
        for (; e is not null; e = e.InnerException)
        {
            yield return e;
            if (e is AggregateException ag) foreach (var i in ag.InnerExceptions.SelectMany(Flatten)) yield return i;
        }
    }
}
